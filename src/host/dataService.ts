/**
 * dataService.ts — 主进程侧最小、可跑通的数据宿主服务（无 vscode 依赖）。
 *
 * 职责：把 rpc 协议里的请求与「行偏移索引 + 按需惰性解析」接起来——
 *   - getOverview    ：首见时构建整文件行偏移索引（流式扫描），返回统计；
 *   - readRecords    ：按需读取并解析一批行（虚拟滚动请求可视区）；
 *   - readRecord     ：读取并解析单行（JSON 树详情面板用）。
 *
 * 2b 接管：索引构建 + 全文/字段搜索 + 字段过滤三类重活，统一委托给 `IndexHost`
 * （worker 下沉实现 / 主线程兜底实现，见 indexHost.ts）。未传 `workerScriptPath`
 * 时走主线程，行为与旧实现等价（单测零回归）；运行时走 worker，扫大文件主线程不阻塞。
 * 随机读/单行读/字段推断仍在主线程，基于 worker 回传的稀疏检查点重建的 LineIndex，
 * 轻量且频繁，不值得跨线程。惰性性与内存有界原则不变。
 */

import { stat } from 'node:fs/promises';
import { LineIndex } from '../indexer/lineIndex.ts';
import type { ByteReader, ReadRecordOpts } from '../parser/jsonParser.ts';
import { openFileReader, parseJsonLine, readRecord as readRecordAt } from '../parser/jsonParser.ts';
import { inferFields } from '../infer/inferFields.ts';
import { detectLineEnding, replaceLine } from './fileWriter.ts';
import type { FieldCondition } from '../core/query.ts';
import type { FilterLinesResult, SearchLinesResult } from './searchEngine.ts';
import {
  SAMPLE_SCAN_LINES,
  RECORDS_MAX_COUNT,
  SEARCH_MAX_RESULTS,
  FILTER_MAX_RESULTS,
} from '../constants.ts';
import { buildIndexWithFallback, type IndexHost } from './indexHost.ts';
import { buildRecordsPayload } from '../protocol/rpc.ts';
import type {
  EditResultPayload,
  OverviewPayload,
  RecordsPayload,
  RecordsPayloadItem,
  SampleFieldsPayload,
} from '../protocol/rpc.ts';
import {
  isOversized,
  jsonCountOf,
  jsonKindOf,
  makeSummary,
  summarizeRawLine,
} from './recordSummary.ts';

/** 检测文件是否已变更（size/mtime）的最小快照。 */
export interface FileSnapshot {
  size: number;
  mtimeMs: number;
}

/** 文件变更检测结果。null 表示索引尚未构建、无法判断。 */
export type StaleCheckResult =
  { changed: false } | { changed: true; deleted: boolean; message: string } | null;

export interface DataServiceOptions {
  onProgress?: (info: { bytesRead: number; lines: number; done: boolean }) => void;
  readLine?: ReadRecordOpts;
  /** 抽样行数上限（字段推断 / 坏行集合查询用）。默认 200。 */
  sampleLines?: number;
  /**
   * 索引 Worker 脚本的绝对路径（运行时由 extension 传入 dist/indexWorker.js）。
   * 传入则「索引构建 + 搜索 + 过滤」下沉 worker；省略或 spawn 失败则回退主线程。
   */
  workerScriptPath?: string;
}

export class DataService {
  private index: LineIndex | undefined;
  private reader: ByteReader | undefined;
  private building: Promise<LineIndex> | undefined;
  /** 索引宿主（worker 或主线程兜底），承担 build/search/filter。 */
  private host: IndexHost | undefined;
  /** 构建统计（来自 host.build，供 getOverview/reload）。 */
  private buildStats: { buildMs: number; eof: boolean } | undefined;
  /** 已检查范围中的坏行 lineId 集合（内存只与「已确认的坏行数」成正比）。 */
  private readonly knownBadLines = new Set<number>();
  /** 构建索引时的文件快照（用来检测文件是否已变更）。 */
  private snapshot: FileSnapshot | undefined;
  /**
   * 生命周期代际：dispose/reload 时递增，使在途索引构建失效
   * （构建完成检测到代际变化即丢弃结果，不写回成员，防止 fd 泄漏与索引复活）。
   */
  private generation = 0;
  /**
   * 编辑进行中标志。期间 `checkStale` 不判定 —— 文件正被本进程改写、基线随后同步，
   * 此刻判定只会产生「自己改自己」的误报横幅。
   */
  private editing = false;

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
        // 选宿主：优先 worker；**worker 失败时内部自动回退主线程重试**（见 buildIndexWithFallback），
        // 保证「打得开」这条底线不被 worker 加载异常击穿。
        let host: IndexHost | undefined;
        try {
          const built = await buildIndexWithFallback(
            this.opts.workerScriptPath,
            this.path,
            this.opts.onProgress
          );
          host = built.host;
          const { index, stats } = built.result;
          if (gen !== this.generation) {
            // 已被 dispose/reload 废弃：释放 worker/reader 后放弃。
            await host.dispose().catch(() => {});
            return index;
          }
          const reader = await openFileReader(this.path);
          if (gen !== this.generation) {
            // 打开读取器期间再次被废弃：关闭自己打开的句柄后放弃。
            if (reader.close) await reader.close().catch(() => {});
            await host.dispose().catch(() => {});
            return index;
          }
          this.host = host;
          this.index = index;
          this.reader = reader;
          this.buildStats = stats;
          // 记下本次索引对应的磁盘快照，供后续「文件变更」检测作基线。
          this.snapshot = await this.currentSnapshot();
          return index;
        } catch (e) {
          // 失败后允许重试：清空 building，否则后续所有请求会永久 reject。
          if (host) await host.dispose().catch(() => {});
          this.building = undefined;
          throw e;
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
    // 编辑进行中：不判定（见 editing 字段说明）。
    if (this.editing) return null;
    if (!this.snapshot) return null;
    const cur = await this.currentSnapshot();
    if (!cur) {
      return {
        changed: true,
        deleted: true,
        message: '文件已被删除，索引可能已失效，请重新加载。',
      };
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
      buildMs: this.buildStats?.buildMs ?? li.buildMs,
      eof: this.buildStats?.eof ?? li.eof,
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
    // 协议层硬上限：防御异常输入 / 未来改动一次拉取整个文件（解析 + 序列化双重内存风险）。
    const n = Math.min(count, RECORDS_MAX_COUNT, Math.max(0, li.totalLines - startLine));
    if (n <= 0) return buildRecordsPayload(startLine, [], li.totalLines);

    // 阶段三（UI 热路径）：列表态不整条解析、不缓存整条巨物。
    // - 普通行（≤ 内联阈值，见 constants.ts 的 RECORD_INLINE_MAX_BYTES）：JSON.parse 后附带「有界摘要」；
    // - 超大行（> 阈值）：跳过整条 parse，浅扫描得类型/顶层条目数/预览并标记 truncated，
    //   完整值仍由 readRecord 按需拉取。如此 list 内存只与「可见窗口 + 有界摘要」成正比。
    const items: RecordsPayloadItem[] = [];
    for await (const r of li.scan(reader, startLine, startLine + n)) {
      // 真正的可中断：CancelToken 置位时逐行检测并提前停（不扫剩余行）。
      if (shouldCancel?.()) break;
      if (r.error) {
        items.push({ line: r.line, ok: false, error: r.error });
        this.knownBadLines.add(r.line);
        continue;
      }
      const byteLen = r.bytes.length;
      if (isOversized(byteLen)) {
        const raw = summarizeRawLine(r.bytes);
        items.push({
          line: r.line,
          ok: true,
          value: undefined,
          truncated: true,
          kind: raw.kind,
          count: raw.count,
          summary: [{ key: '', display: raw.preview }],
        });
        continue;
      }
      const parsed = parseJsonLine(r.bytes.toString('utf8'));
      if (!parsed.ok) {
        items.push({ line: r.line, ok: false, error: parsed.error });
        this.knownBadLines.add(r.line);
        continue;
      }
      const value = parsed.value;
      items.push({
        line: r.line,
        ok: true,
        value,
        summary: makeSummary(value),
        kind: jsonKindOf(value),
        count: jsonCountOf(value),
      });
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

  /** 编辑失败的统一回执（避免多处重复填充字段）。 */
  private static editFailure(
    line: number,
    error: string,
    extra?: Partial<EditResultPayload>
  ): EditResultPayload {
    return {
      ok: false,
      line,
      bytesDelta: 0,
      inPlace: false,
      movedBytes: 0,
      costMs: 0,
      error,
      ...extra,
    };
  }

  /**
   * 就地替换第 `line` 行（行数不变；行尾按磁盘原样保留，不擅自规范化）。
   *
   * 安全与一致性要点（**顺序即正确性**）：
   *   1. **写前冲突检测**：stat 与索引基线比对（size/mtime）。不一致说明文件已被外部
   *      改动，拒绝写入并返回 conflict —— 避免基于过期视图覆写他人改动；
   *   2. **乐观锁**：`expectedBytes` 非空时须与磁盘上该行内容字节长度一致；
   *   3. **JSON 校验**：非法 JSON 默认拒绝（保持文件语义），返回 invalid；
   *   4. **写盘**：委托 `replaceLine`（等长原位覆写 / 变长尾部搬移）；
   *   5. **索引与基线同步**：写盘成功后先换上新索引，再立刻刷新基线快照。二者若不同步，
   *      5s 轮询的 `checkStale` 会把「自写」误判为外部变更并弹「重新加载」横幅。
   */
  async editRecord(line: number, text: string, expectedBytes?: number): Promise<EditResultPayload> {
    const li = await this.ensureIndex();
    const reader = this.reader!;

    if (!Number.isInteger(line) || line < 0 || line >= li.totalLines) {
      return DataService.editFailure(line, `无效行号：${line}`);
    }

    // ① 写前冲突检测
    const before = await this.currentSnapshot();
    if (!before) return DataService.editFailure(line, '文件不存在或无法访问', { conflict: true });
    if (
      this.snapshot &&
      (before.size !== this.snapshot.size || before.mtimeMs !== this.snapshot.mtimeMs)
    ) {
      return DataService.editFailure(line, '文件已被外部修改，请先重新加载再编辑。', {
        conflict: true,
      });
    }

    // ② 定位该行区间与旧内容长度
    let range: { start: number; end: number } | undefined;
    let oldContentBytes = 0;
    for await (const r of li.scan(reader, line, line + 1)) {
      if (r.error) return DataService.editFailure(line, `该行过大，暂不支持编辑：${r.error}`);
      range = { start: r.start, end: r.end };
      oldContentBytes = r.bytes.length;
      break;
    }
    if (!range) return DataService.editFailure(line, `行不存在：${line}`);

    // ③ 乐观锁
    if (expectedBytes != null && expectedBytes !== oldContentBytes) {
      return DataService.editFailure(line, '该行内容已变化（与编辑前视图不一致），请重新加载。', {
        conflict: true,
      });
    }

    // ④ JSON 校验
    const parsed = parseJsonLine(text);
    if (!parsed.ok) {
      return DataService.editFailure(line, `JSON 校验未通过：${parsed.error}`, { invalid: true });
    }

    // ⑤⑥ 写盘 + 同步索引与基线
    this.editing = true;
    try {
      const res = await replaceLine(
        this.path,
        range,
        Buffer.from(text, 'utf8'),
        detectLineEnding(range, oldContentBytes)
      );
      this.index = li.applyLineReplace(line, res.bytesDelta);
      const after = await this.currentSnapshot();
      if (after) this.snapshot = after;
      this.knownBadLines.delete(line);
      return {
        ok: true,
        line,
        bytesDelta: res.bytesDelta,
        inPlace: res.inPlace,
        movedBytes: res.movedBytes,
        costMs: Math.round(res.costMs * 100) / 100,
      };
    } catch (e) {
      return DataService.editFailure(line, e instanceof Error ? e.message : String(e));
    } finally {
      this.editing = false;
    }
  }

  /** 抽样前 N 行推断字段（只扫前 sampleLines/count 行，绝不全文件）。 */
  async getSampleFields(count?: number): Promise<SampleFieldsPayload> {
    const li = await this.ensureIndex();
    const reader = this.reader!;
    const n = count ?? this.opts.sampleLines ?? SAMPLE_SCAN_LINES;
    const res = await inferFields(reader, li, { sampleLines: n });
    for (const line of res.errorLines) this.knownBadLines.add(line);
    return { fields: res.fields, total: res.total, scanned: res.scanned };
  }

  /**
   * Task 6 全文/字段搜索：委托 IndexHost（worker 或主线程）流式顺序扫描匹配行。
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
    await this.ensureIndex();
    const range =
      scope && /^\d+:\d+$/.test(scope)
        ? { startLine: Number(scope.split(':')[0]), endLine: Number(scope.split(':')[1]) }
        : undefined;
    return this.host!.search(query, field, range, SEARCH_MAX_RESULTS, shouldCancel);
  }

  /** Task 6 字段值过滤：委托 IndexHost 对流解析并评估，返回匹配行号（结果行号数组有上限）。 */
  async filter(
    cond: FieldCondition | null,
    shouldCancel?: () => boolean
  ): Promise<FilterLinesResult> {
    await this.ensureIndex();
    return this.host!.filter(cond, FILTER_MAX_RESULTS, shouldCancel);
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
      buildMs: this.buildStats?.buildMs ?? li.buildMs,
      eof: this.buildStats?.eof ?? li.eof,
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
    // 释放索引宿主（worker 则终止 worker，主线程则关 reader）。
    if (this.host) await this.host.dispose().catch(() => {});
    this.reader = undefined;
    this.index = undefined;
    this.host = undefined;
    this.buildStats = undefined;
    this.snapshot = undefined;
    this.knownBadLines.clear();
  }
}
