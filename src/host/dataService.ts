/**
 * dataService.ts — 主进程侧最小、可跑通的数据宿主服务（无 vscode 依赖）。
 *
 * 职责：把 rpc 协议里的请求与「行偏移索引 + 按需惰性解析」接起来——
 *   - getOverview    ：首见时构建整文件行偏移索引（流式扫描），返回统计。
 *   - readRecords    ：按需读取并解析一批行（虚拟滚动请求可视区）。
 *   - readRecord     ：读取并解析单行（JSON 树详情面板用）。
 *
 * 惰性性：索引只构建一次并在本次生命周期内缓存；任何时刻都不会把整行之外
 * 的数据驻留在内存。搜索/筛选/字段推断由后续任务叠加到同一服务。
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { LineIndex } from '../indexer/lineIndex.ts';
import type { ByteReader, ReadRecordOpts } from '../parser/jsonParser.ts';
import {
  openFileReader,
  readBatch,
  readRecord as readRecordAt,
} from '../parser/jsonParser.ts';
import { inferFields } from '../infer/inferFields.ts';
import { filterLines, searchLines } from './searchEngine.ts';
import type { FieldCondition } from '../webview/queryLogic.ts';
import type { FilterLinesResult, SearchLinesResult } from './searchEngine.ts';
import { INDEX_CHUNK_SIZE, INDEX_REPORT_INTERVAL, SEARCH_MAX_RESULTS, FILTER_MAX_RESULTS } from '../constants.ts';
import { buildRecordsPayload } from '../protocol/rpc.ts';
import type {
  OverviewPayload,
  RecordsPayload,
  SampleFieldsPayload,
} from '../protocol/rpc.ts';

/** 检测文件是否已变更（size/mtime）的最小快照。 */
export interface FileSnapshot {
  size: number;
  mtimeMs: number;
}

/** 文件变更检测结果。null 表示索引尚未构建、无法判断。 */
export type StaleCheckResult =
  | { changed: false }
  | { changed: true; deleted: boolean; message: string }
  | null;

/**
 * 宿主侧默认的搜索 / 过滤结果上限（防御内存失控）。
 * - 搜索：命中行号数组不会无限增长，超限后以 truncated 标记「未列尽」；
 * - 过滤：匹配行号同样封顶，避免「全行命中」的过滤把整文件行号载进 webview。
 * 可视区只展示前若干条，导航基于手头这批足够用；真正的全量行号需要时再按范围续取。
 */

export interface DataServiceOptions {
  onProgress?: (info: { bytesRead: number; lines: number; done: boolean }) => void;
  readLine?: ReadRecordOpts;
  /** 抽样行数上限（字段推断 / 坏行集合查询用）。默认 200。 */
  sampleLines?: number;
}

export class DataService {
  private index: LineIndex | undefined;
  private reader: ByteReader | undefined;
  private building: Promise<LineIndex> | undefined;
  /** 已检查范围中的坏行 lineId 集合（内存只与「已确认的坏行数」成正比）。 */
  private readonly knownBadLines = new Set<number>();
  /** 构建索引时的文件快照（用来检测文件是否已变更）。 */
  private snapshot: FileSnapshot | undefined;
  /**
   * 生命周期代际：dispose/reload 时递增，使在途索引构建失效
   * （构建完成检测到代际变化即丢弃结果，不写回成员，防止 fd 泄漏与索引复活）。
   */
  private generation = 0;

  private readonly uri: string;
  private readonly path: string;
  private readonly opts: DataServiceOptions;

  // 注意：不用参数属性语法（Node 类型擦除运行 TS 单测时不支持）。
  constructor(uri: string, path: string, opts: DataServiceOptions = {}) {
    this.uri = uri;
    this.path = path;
    this.opts = opts;
  }

  /** 惰性构建（并发安全：多次同时调用只构建一次；失败后允许重试）。 */
  private ensureIndex(): Promise<LineIndex> {
    if (this.index) return Promise.resolve(this.index);
    if (!this.building) {
      const gen = this.generation;
      this.building = (async () => {
        const stream = createReadStream(this.path);
        try {
          const li = await LineIndex.build(stream, {
            chunkSize: INDEX_CHUNK_SIZE,
            reportInterval: INDEX_REPORT_INTERVAL,
            onProgress: this.opts.onProgress,
          });
          if (gen !== this.generation) return li; // 已被 dispose/reload 废弃
          const reader = await openFileReader(this.path);
          if (gen !== this.generation) {
            // 打开读取器期间再次被废弃：关闭自己打开的句柄后放弃。
            if (reader.close) await reader.close().catch(() => {});
            return li;
          }
          this.reader = reader;
          this.index = li;
          // 记下本次索引对应的磁盘快照，供后续「文件变更」检测作基线。
          this.snapshot = await this.currentSnapshot();
          return li;
        } catch (e) {
          // 失败后允许重试：清空 building，否则后续所有请求会永久 reject。
          this.building = undefined;
          throw e;
        } finally {
          stream.destroy();
        }
      })();
    }
    return this.building;
  }

  /** 读取当前磁盘快照；文件不存在（被删除）时返回 undefined。 */
  private async currentSnapshot(): Promise<FileSnapshot | undefined> {
    try {
      const s = await stat(this.path);
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return undefined;
    }
  }

  /**
   * 检测文件是否已变更（size / mtime，或已被删除）。
   * 返回 null 表示索引尚未构建、无从比较（扩展宿主应跳过推送）。
   * 幂等：多次调用返回同一基线下的「当前是否已走样」判断。
   */
  async checkStale(): Promise<StaleCheckResult> {
    if (!this.snapshot) return null;
    const cur = await this.currentSnapshot();
    if (!cur) {
      return { changed: true, deleted: true, message: '文件已被删除，索引可能已失效，请重新加载。' };
    }
    if (cur.size !== this.snapshot.size || cur.mtimeMs !== this.snapshot.mtimeMs) {
      return { changed: true, deleted: false, message: '文件已更改，行索引可能过期，请重新加载。' };
    }
    return { changed: false };
  }

  async getOverview(): Promise<OverviewPayload> {
    const li = await this.ensureIndex();
    return {
      uri: this.uri,
      totalLines: li.totalLines,
      totalBytes: li.totalBytes,
      buildMs: li.buildMs,
      eof: li.eof,
    };
  }

  async readRecords(
    startLine: number,
    count: number,
    shouldCancel?: () => boolean
  ): Promise<RecordsPayload> {
    const li = await this.ensureIndex();
    const reader = this.reader!;
    // M3：入口整数化校验——脏行号（NaN/小数/负数）不进入读批，也不污染 knownBadLines。
    if (!Number.isInteger(startLine) || startLine < 0 || !Number.isInteger(count) || count <= 0) {
      return buildRecordsPayload(0, [], li.totalLines);
    }
    // 真正的可中断：CancelToken 置位时逐行检测并提前停，宿主不再把剩余窗口扫完。
    const items = await readBatch(startLine, count, li, reader, {
      ...this.opts.readLine,
      shouldCancel,
    });
    for (const it of items) {
      if (!it.ok) this.knownBadLines.add(it.line);
    }
    return buildRecordsPayload(startLine, items, li.totalLines);
  }

  async readRecord(line: number): Promise<{ value?: unknown; error?: string; ok: boolean }> {
    const li = await this.ensureIndex();
    const reader = this.reader!;
    if (!Number.isInteger(line) || line < 0) {
      return { value: undefined, error: '无效行号', ok: false };
    }
    const r = await readRecordAt(line, li, reader, this.opts.readLine);
    if (!r.ok) this.knownBadLines.add(line);
    return { value: r.value, error: r.error, ok: r.ok };
  }

  /** 抽样前 N 行推断字段（只扫前 sampleLines/count 行，绝不全文件）。 */
  async getSampleFields(count?: number): Promise<SampleFieldsPayload> {
    const li = await this.ensureIndex();
    const reader = this.reader!;
    const n = count ?? this.opts.sampleLines ?? 200;
    const res = await inferFields(reader, li, { sampleLines: n });
    for (const line of res.errorLines) this.knownBadLines.add(line);
    return { fields: res.fields, total: res.total, scanned: res.scanned };
  }

  /**
   * Task 6 全文/字段搜索：宿主流式顺序扫描匹配行。
   * - 全文搜索不做 JSON.parse（纯文本匹配，大文件成本可控）；
   * - 字段限定搜索才对行做单行解析取值。
   * scope 为字符串（'all' 默认；未来可扩展为区间），未识别当作全范围。
   */
  async search(
    query: string,
    field?: string,
    scope?: string,
    shouldCancel?: () => boolean
  ): Promise<SearchLinesResult> {
    const li = await this.ensureIndex();
    const reader = this.reader!;
    const range =
      scope && /^\d+:\d+$/.test(scope)
        ? { startLine: Number(scope.split(':')[0]), endLine: Number(scope.split(':')[1]) }
        : undefined;
    return searchLines(reader, li, {
      query,
      field,
      scope: range,
      shouldCancel,
      // 防御内存失控：命中行号数组封顶，超限由 searchLines 标记 truncated。
      maxResults: SEARCH_MAX_RESULTS,
    });
  }

  /** Task 6 字段值过滤：宿主对流解析并评估，返回匹配行号（结果行号数组有上限）。 */
  async filter(
    cond: FieldCondition | null,
    shouldCancel?: () => boolean
  ): Promise<FilterLinesResult> {
    const li = await this.ensureIndex();
    const reader = this.reader!;
    return filterLines(reader, li, cond, {
      shouldCancel,
      maxResults: FILTER_MAX_RESULTS,
    });
  }

  /**
   * 重建索引（文件被检测到变更后由 webview 点「重新加载」触发）。
   * 释放旧句柄/索引并重新构建；返回重建后的概览。
   */
  async reload(): Promise<OverviewPayload> {
    await this.dispose();
    const li = await this.ensureIndex();
    return {
      uri: this.uri,
      totalLines: li.totalLines,
      totalBytes: li.totalBytes,
      buildMs: li.buildMs,
      eof: li.eof,
    };
  }

  get totalLines(): number {
    return this.index?.totalLines ?? 0;
  }

  /** 返回当前索引（尚未构建则 undefined），用于惰性进度/概要栏。 */
  peekIndex(): LineIndex | undefined {
    return this.index;
  }

  async dispose(): Promise<void> {
    // 递增代际，使在途索引构建失效（其检测代际变化后丢弃结果，不写回成员）。
    this.generation++;
    const building = this.building;
    this.building = undefined;
    if (building) {
      // 等待在途构建结束，避免其自开文件句柄在完成后无人关闭。
      await building.catch(() => {});
    }
    if (this.reader && this.reader.close) {
      await this.reader.close().catch(() => {});
    }
    this.reader = undefined;
    this.index = undefined;
    this.snapshot = undefined;
    this.knownBadLines.clear();
  }
}