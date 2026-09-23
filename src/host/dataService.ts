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
import {
  openFileReader,
  parseJsonLine,
  readLineAt,
  readRecord as readRecordAt,
} from '../parser/jsonParser.ts';
import { inferFields } from '../infer/inferFields.ts';
import {
  detectLineEnding,
  lineEndingBytes,
  replaceLine,
  replaceRange,
  rewriteWithEdits,
  WriteCancelledError,
} from './fileWriter.ts';
import type { ByteEdit, LineEnding } from './fileWriter.ts';
import { planLineReplace } from '../core/replaceLogic.ts';
import type { FieldCondition } from '../core/query.ts';
import type { FilterLinesResult, SearchLinesResult } from './searchEngine.ts';
import {
  SAMPLE_SCAN_LINES,
  RECORDS_MAX_COUNT,
  SEARCH_MAX_RESULTS,
  FILTER_MAX_RESULTS,
  MAX_REPLACE_UNDO_LINES,
  MAX_REPLACE_UNDO_BYTES,
  MAX_SELECTION_LINES,
  COPY_MAX_BYTES,
  MAX_HISTORY_ENTRIES,
  MAX_HISTORY_BYTES,
  MAX_BAD_LINES,
  PROGRESS_THROTTLE_MS,
} from '../constants.ts';
import { buildIndexWithFallback, type IndexHost } from './indexHost.ts';
import { buildRecordsPayload } from '../protocol/rpc.ts';
import type {
  BadLinesPayload,
  CopyLinesResultPayload,
  DeleteManyResultPayload,
  DeletedRange,
  EditResultPayload,
  HistoryPayload,
  OverviewPayload,
  RecordsPayload,
  RecordsPayloadItem,
  ReplaceChange,
  ReplaceResultPayload,
  SampleFieldsPayload,
} from '../protocol/rpc.ts';
import {
  isOversized,
  jsonCountOf,
  jsonKindOf,
  makeSummary,
  summarizeRawLine,
} from './recordSummary.ts';

/**
 * 探测某行的字节区间与行尾风格。
 *
 * **失败原因必须区分**（越界 / 行过大 / 索引与磁盘不一致）：三者的处置完全不同，
 * 混成一句「无法定位该行」会让排查走弯路 —— 这正是此前踩过的坑。
 */
async function probeLine(
  li: LineIndex,
  reader: ByteReader,
  line: number
): Promise<
  | { ok: true; start: number; end: number; ending: LineEnding }
  | { ok: false; reason: 'out-of-range' | 'too-large' | 'not-found' }
> {
  if (!Number.isInteger(line) || line < 0 || line >= li.totalLines) {
    return { ok: false, reason: 'out-of-range' };
  }
  for await (const r of li.scan(reader, line, line + 1)) {
    if (r.error) return { ok: false, reason: 'too-large' };
    return {
      ok: true,
      start: r.start,
      end: r.end,
      ending: detectLineEnding({ start: r.start, end: r.end }, r.bytes.length),
    };
  }
  // scan 未产出任何行：索引与磁盘不一致（索引说该行存在，却读不出来）。
  return { ok: false, reason: 'not-found' };
}

/** 探测失败原因 → 可操作的中文提示。 */
function describeProbeFailure(
  line: number,
  reason: 'out-of-range' | 'too-large' | 'not-found'
): string {
  switch (reason) {
    case 'out-of-range':
      return `行号越界：${line}`;
    case 'too-large':
      return `该行过大，暂不支持编辑：${line}`;
    case 'not-found':
      return `无法定位该行（索引可能已过期），请重新加载后再试：${line}`;
  }
}

/**
 * 把底层按分块触发的进度**节流**为「≥`PROGRESS_THROTTLE_MS` 一次 + 终态必发」。
 *
 * 终态刻意不节流：否则进度条会永远停在 96% 之类的位置，用户以为卡住了 ——
 * 一个停在 96% 的进度条比没有进度条更糟。
 */
function throttleProgress(
  cb?: (info: { processedBytes: number; totalBytes: number }) => void
): ((info: { processedBytes: number; totalBytes: number }) => void) | undefined {
  if (!cb) return undefined;
  let last = 0;
  return (info) => {
    const now = performance.now();
    const done = info.totalBytes > 0 && info.processedBytes >= info.totalBytes;
    if (!done && now - last < PROGRESS_THROTTLE_MS) return;
    last = now;
    cb(info);
  };
}

/** 二分统计升序数组中小于 `x` 的元素个数（用于批量删除后的行号映射）。 */
function countLessThan(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 把宿主侧的编辑选项适配成写入层选项。
 *
 * 顺带做字段名映射：写入层上报的是「已搬移字节」（movedBytes），而协议层统一用
 * 「已处理字节」（processedBytes）—— 三者（替换/扫描/编辑）在前端是同一条进度通道。
 */
function toReplaceOpts(opts: EditRecordOpts): {
  shouldCancel?: () => boolean;
  onProgress?: (info: { movedBytes: number; totalBytes: number }) => void;
} {
  return {
    ...(opts.shouldCancel ? { shouldCancel: opts.shouldCancel } : {}),
    ...(opts.onProgress
      ? {
          onProgress: (info: { movedBytes: number; totalBytes: number }) =>
            opts.onProgress?.({ processedBytes: info.movedBytes, totalBytes: info.totalBytes }),
        }
      : {}),
  };
}

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

/* ---------------------- 会话编辑历史 ---------------------- */

/**
 * 一次可撤销的写操作。
 *
 * 每条都能**双向**执行：`forward` 是用户当初做的操作，反向即回退 —— 这正是
 * 「Ctrl+Z 单步撤销」与「历史面板回退到某点」能共用同一份数据的原因。
 */
type HistoryOp =
  | { kind: 'edit'; line: number; before: string; after: string }
  | { kind: 'insert'; line: number; text: string }
  | { kind: 'delete'; line: number; before: string }
  | { kind: 'deleteMany'; ranges: DeletedRange[] }
  | { kind: 'replaceAll'; changes: ReplaceChange[] };

/** 历史条目（含回退数据，仅供宿主内部使用）。 */
interface HistoryEntry {
  id: string;
  op: HistoryOp;
  label: string;
  /** 影响的行数。 */
  lines: number;
  bytesDelta: number;
  at: number;
  /** 该条目占用的近似字节数（用于总体积上限）。 */
  bytes: number;
}

/** 单步 / 多步历史操作的结果。 */
export interface HistoryStepResult {
  ok: boolean;
  /** 本次实际执行的步数（回退跨多条时为多步）。 */
  steps: number;
  /** 执行后的光标位置。 */
  cursor: number;
  total: number;
  /** 被操作条目的描述（单步时给出）。 */
  label?: string;
  /** 失败原因（中途失败时 steps 表示已成功的步数，便于如实告知）。 */
  error?: string;
}

/** 历史条目占用的近似字节数（正向与反向数据都要留着才能双向执行）。 */
function historyOpBytes(op: HistoryOp): number {
  switch (op.kind) {
    case 'edit':
      return op.before.length + op.after.length;
    case 'insert':
      return op.text.length;
    case 'delete':
      return op.before.length;
    case 'deleteMany':
      return op.ranges.reduce((a, r) => a + r.content.length, 0);
    case 'replaceAll':
      return op.changes.reduce((a, c) => a + c.before.length + c.after.length, 0);
  }
}

/** 由操作推出「描述 + 影响行数」。 */
function historyLabel(op: HistoryOp): { label: string; lines: number } {
  switch (op.kind) {
    case 'edit':
      return { label: `编辑第 ${op.line + 1} 行`, lines: 1 };
    case 'insert':
      return { label: `在第 ${op.line + 1} 行前插入`, lines: 1 };
    case 'delete':
      return { label: `删除第 ${op.line + 1} 行`, lines: 1 };
    case 'deleteMany': {
      const n = op.ranges.reduce((a, r) => a + r.lines.length, 0);
      return { label: `删除 ${n} 行`, lines: n };
    }
    case 'replaceAll':
      return { label: `替换 ${op.changes.length} 行`, lines: op.changes.length };
  }
}

/** 批量改写（查找替换 / 撤销 / 重做）的可选行为。 */
export interface ReplaceOpts {
  /** 是否大小写不敏感（与搜索保持一致；默认 true）。 */
  caseInsensitive?: boolean;
  /**
   * 全文件重写阶段的进度回调（已按 `PROGRESS_THROTTLE_MS` 节流，终态必发）。
   * 1GB 文件底层会按 4MB 分块回调 250 次，全量上报只是无意义的 IPC 压力。
   */
  onProgress?: (info: { processedBytes: number; totalBytes: number }) => void;
  /**
   * 取消回调：返回 true 则中止本次改写。
   *
   * 批量重写在 `rename` **之前**中止是**零风险**的 —— 临时文件被清理，目标文件从未被触碰。
   * 这正是选择「全量重写 + 原子 rename」而非逐处搬移换来的额外红利：可取消且不留残迹。
   */
  shouldCancel?: () => boolean;
}

/** 坏行全文件扫描的可选行为。 */
export interface ScanBadLinesOpts {
  /** 进度回调（已按 `PROGRESS_THROTTLE_MS` 节流，终态必发）。 */
  onProgress?: (info: { processedBytes: number; totalBytes: number }) => void;
  /**
   * 取消回调：返回 true 则中止本次扫描。
   *
   * 扫描是**纯读**操作，取消的代价只是白读了一些字节 —— 且取消时**不**替换已发现的
   * 坏行集合（半份扫描结果比没有结果更容易误导）。
   */
  shouldCancel?: () => boolean;
}

/**
 * 单行编辑的可选行为。
 *
 * 只有「需要搬移尾部」的变长编辑才会用到它们：等长替换是单次 IO、末尾行无需搬移，
 * 两者都在毫秒级完成，轮询取消与上报进度都只是噪音。
 */
export interface EditRecordOpts {
  /** 搬移进度回调（仅在真有搬移时触发）。 */
  onProgress?: (info: { processedBytes: number; totalBytes: number }) => void;
  /**
   * 取消回调：在分块边界中止搬移。
   *
   * 取消会**自动回滚**（用备份把文件恢复原样），故与批量替换一样是零风险的 ——
   * 上层可放心让用户看到「已取消，文件未被修改」。
   */
  shouldCancel?: () => boolean;
}

export class DataService {
  private index: LineIndex | undefined;
  private reader: ByteReader | undefined;
  private building: Promise<LineIndex> | undefined;
  /** 索引宿主（worker 或主线程兜底），承担 build/search/filter。 */
  private host: IndexHost | undefined;
  /** 构建统计（来自 host.build，供 getOverview/reload）。 */
  private buildStats: { buildMs: number; eof: boolean } | undefined;
  /**
   * 已检查范围中的坏行 lineId 集合（内存只与「已确认的坏行数」成正比）。
   *
   * **它不是全文件坏行集**：只覆盖用户读过/抽样过的行。要拿全量必须显式
   * `scanBadLines()`。二者在前端必须可区分（`BadLinesPayload.partial`）——
   * 把「已发现 3 个坏行」当成「文件只有 3 个坏行」，在数据清洗场景下是危险的误判。
   */
  private readonly knownBadLines = new Set<number>();
  /**
   * `knownBadLines` 是否已是**全文件全量**（最近一次 `scanBadLines` 成功、且之后
   * 没有任何改变文件内容的操作）。
   *
   * 为何写操作后要降级：行号与行内容都变了，「全量」这一结论不再有依据。但已发现的
   * 坏行列表仍有价值（行号已同步位移），故只降级完整性标记、不清空列表。
   */
  private badLinesComplete = false;
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

  /* ---------- 会话编辑历史（单一光标模型，见 pushHistory 说明） ---------- */
  private readonly history: HistoryEntry[] = [];
  /** 已应用条数：之前的为「已应用」，之后的为「已撤销」。 */
  private historyCursor = 0;
  private historySeq = 0;
  /** 是否因超出上限丢弃过更早的记录（UI 需如实告知，否则用户以为看到的是完整历史）。 */
  private historyDropped = false;
  /** 正在执行历史回退：期间的写操作**不再入栈**（否则撤销会生成新记录）。 */
  private applyingHistory = false;

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

  /**
   * 读取并解析单行。除解析结果外还回**该行原文**（`rawText` / `rawBytes`）——
   * 编辑功能据此把「磁盘上原样」填进编辑框，并作为乐观锁断言（`expectedBytes`）。
   */
  async readRecord(line: number): Promise<{
    value?: unknown;
    error?: string;
    ok: boolean;
    rawText?: string;
    rawBytes?: number;
  }> {
    const li = await this.ensureIndex();
    const reader = this.reader!;
    if (!Number.isInteger(line) || line < 0) {
      return { value: undefined, error: '无效行号', ok: false };
    }
    const r = await readRecordAt(line, li, reader, this.opts.readLine);
    if (!r.ok) this.knownBadLines.add(line);
    return {
      value: r.value,
      error: r.error,
      ok: r.ok,
      rawText: r.rawText,
      rawBytes: r.rawBytes,
    };
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
  async editRecord(
    line: number,
    text: string,
    expectedBytes?: number,
    opts: EditRecordOpts = {}
  ): Promise<EditResultPayload> {
    const li = await this.ensureIndex();
    const reader = this.reader!;

    if (!Number.isInteger(line) || line < 0 || line >= li.totalLines) {
      return DataService.editFailure(line, `无效行号：${line}`);
    }

    // ① 写前冲突检测
    const conflict = await this.detectWriteConflict(line);
    if (conflict) return conflict;

    // ② 定位该行区间、旧内容长度与旧文本（旧文本供撤销/重做使用）
    let range: { start: number; end: number } | undefined;
    let oldContentBytes = 0;
    let beforeText = '';
    for await (const r of li.scan(reader, line, line + 1)) {
      if (r.error) return DataService.editFailure(line, `该行过大，暂不支持编辑：${r.error}`);
      range = { start: r.start, end: r.end };
      oldContentBytes = r.bytes.length;
      beforeText = r.bytes.toString('utf8');
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
        detectLineEnding(range, oldContentBytes),
        toReplaceOpts(opts)
      );
      this.index = li.applyLineReplace(line, res.bytesDelta);
      await this.refreshSnapshot();
      this.knownBadLines.delete(line);
      this.pushHistory({ kind: 'edit', line, before: beforeText, after: text }, res.bytesDelta);
      return {
        ok: true,
        line,
        bytesDelta: res.bytesDelta,
        inPlace: res.inPlace,
        movedBytes: res.movedBytes,
        costMs: Math.round(res.costMs * 100) / 100,
        beforeText,
      };
    } catch (e) {
      // 取消与失败必须分开报：取消会自动回滚（文件原样），报成「失败」会让用户
      // 以为文件可能损坏 —— 那是与事实相反的恐慌。
      if (e instanceof WriteCancelledError) {
        return DataService.editFailure(line, e.message, { cancelled: true });
      }
      return DataService.editFailure(line, e instanceof Error ? e.message : String(e));
    } finally {
      this.editing = false;
    }
  }

  /** 写前冲突检测：文件被外部改动过则返回失败回执，否则返回 undefined。 */
  private async detectWriteConflict(line: number): Promise<EditResultPayload | undefined> {
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
    return undefined;
  }

  /** 写后刷新基线快照 —— 不做这一步，5s 轮询会把「自写」误判成外部变更。 */
  private async refreshSnapshot(): Promise<void> {
    const after = await this.currentSnapshot();
    if (after) this.snapshot = after;
    // 文件内容已变 ⇒「坏行已全量扫过」这一结论不再有依据（行号与内容都动了）。
    // 放在这个统一收口点而非 7 个写方法里各写一遍 —— 漏掉任何一处都会让前端
    // 拿一份过期的「全量」结论去说服用户，那比不支持扫描更危险。
    // 注意只降级完整性标记，**不清空**已发现列表（其行号位移已被各处正确维护）。
    this.badLinesComplete = false;
  }

  /** 删除行之后：行号整体前移，坏行集合里的行号必须同步位移，否则红标会错位。 */
  private shiftKnownBadLinesAfterDelete(removedLine: number): void {
    const next = new Set<number>();
    for (const l of this.knownBadLines) {
      if (l < removedLine) next.add(l);
      else if (l > removedLine) next.add(l - 1);
      // l === removedLine：该行已不存在，丢弃
    }
    this.knownBadLines.clear();
    for (const l of next) this.knownBadLines.add(l);
  }

  /** 插入行之后：行号整体后移（同上）。 */
  private shiftKnownBadLinesAfterInsert(at: number): void {
    const next = new Set<number>();
    for (const l of this.knownBadLines) next.add(l >= at ? l + 1 : l);
    this.knownBadLines.clear();
    for (const l of next) this.knownBadLines.add(l);
  }

  /**
   * 删除第 `line` 行（含行尾）。行数减一，其后所有行的行号**前移一位**。
   *
   * 前置保护与 `editRecord` 一致（写前冲突检测）；落盘复用写入层同一原语
   * `replaceRange`（空 replacement 即区间删除），随后同步索引与基线快照。
   */
  async deleteRecord(line: number, opts: EditRecordOpts = {}): Promise<EditResultPayload> {
    const li = await this.ensureIndex();
    const reader = this.reader!;

    if (!Number.isInteger(line) || line < 0 || line >= li.totalLines) {
      return DataService.editFailure(line, `无效行号：${line}`);
    }
    const conflict = await this.detectWriteConflict(line);
    if (conflict) return conflict;

    const probed = await probeLine(li, reader, line);
    if (!probed.ok) {
      return DataService.editFailure(line, describeProbeFailure(line, probed.reason));
    }
    const removedBytes = probed.end - probed.start;
    // 旧原文用于撤销：删除的逆操作就是把这段文本插回去。
    const removedText = await readLineAt(reader, probed.start, probed.end).catch(() => '');

    this.editing = true;
    try {
      const res = await replaceRange(
        this.path,
        { start: probed.start, end: probed.end },
        Buffer.alloc(0),
        toReplaceOpts(opts)
      );
      this.index = li.applyLineDelete(line, removedBytes);
      await this.refreshSnapshot();
      this.shiftKnownBadLinesAfterDelete(line);
      this.pushHistory({ kind: 'delete', line, before: removedText }, res.bytesDelta);
      return {
        ok: true,
        line,
        bytesDelta: res.bytesDelta,
        inPlace: res.inPlace,
        movedBytes: res.movedBytes,
        costMs: Math.round(res.costMs * 100) / 100,
        beforeText: removedText,
      };
    } catch (e) {
      if (e instanceof WriteCancelledError) {
        return DataService.editFailure(line, e.message, { cancelled: true });
      }
      return DataService.editFailure(line, e instanceof Error ? e.message : String(e));
    } finally {
      this.editing = false;
    }
  }

  /**
   * 在第 `at` 行**之前**插入一行（`at === totalLines` 表示追加到文件末尾）。
   *
   * 新行的行尾风格取「参考行」——优先前一行，其次插入点所在行；二者皆无（空文件）用 LF。
   * 这样在 CRLF 文件里插入的行同样是 CRLF，不会把行尾风格搅乱。
   */
  async insertRecord(
    at: number,
    text: string,
    opts: EditRecordOpts = {}
  ): Promise<EditResultPayload> {
    const li = await this.ensureIndex();
    const reader = this.reader!;

    if (!Number.isInteger(at) || at < 0 || at > li.totalLines) {
      return DataService.editFailure(at, `无效插入位置：${at}`);
    }
    const conflict = await this.detectWriteConflict(at);
    if (conflict) return conflict;

    const parsed = parseJsonLine(text);
    if (!parsed.ok) {
      return DataService.editFailure(at, `JSON 校验未通过：${parsed.error}`, { invalid: true });
    }

    // 插入点 = 第 at 行的起始偏移；追加到末尾则用文件末尾。
    let insertAt = li.totalBytes;
    let nextEnding: LineEnding | undefined;
    if (at < li.totalLines) {
      const p = await probeLine(li, reader, at);
      if (!p.ok) return DataService.editFailure(at, describeProbeFailure(at, p.reason));
      insertAt = p.start;
      nextEnding = p.ending;
    }
    const prev = at > 0 ? await probeLine(li, reader, at - 1) : undefined;
    const refEnding = (prev?.ok ? prev.ending : undefined) ?? nextEnding ?? 'lf';
    // 参考行若位于文件末尾且原本无换行，插入的新行仍须自带行尾（否则会与下一行粘连）。
    const ending: LineEnding = refEnding === 'none' ? 'lf' : refEnding;
    const newLineBytes = Buffer.concat([Buffer.from(text, 'utf8'), lineEndingBytes(ending)]);

    this.editing = true;
    try {
      const res = await replaceRange(
        this.path,
        { start: insertAt, end: insertAt },
        newLineBytes,
        toReplaceOpts(opts)
      );
      this.index = li.applyLineInsert(at, newLineBytes.length);
      await this.refreshSnapshot();
      this.shiftKnownBadLinesAfterInsert(at);
      this.pushHistory({ kind: 'insert', line: at, text }, res.bytesDelta);
      return {
        ok: true,
        line: at,
        bytesDelta: res.bytesDelta,
        inPlace: res.inPlace,
        movedBytes: res.movedBytes,
        costMs: Math.round(res.costMs * 100) / 100,
      };
    } catch (e) {
      if (e instanceof WriteCancelledError) {
        return DataService.editFailure(at, e.message, { cancelled: true });
      }
      return DataService.editFailure(at, e instanceof Error ? e.message : String(e));
    } finally {
      this.editing = false;
    }
  }

  /* ------------------------- 查找替换（批量改写） ------------------------- */

  /**
   * 全文查找替换：把每一命中行中的 `query` 字面量替换为 `replacement`，一次性落盘。
   *
   * 流程即正确性：
   *   1. **复用搜索定位命中行** —— 搜索即预览，不另造一套预览机制（用户在工具栏已看到命中数）；
   *   2. **一次顺序扫过命中区间取原文** —— 成本 O(命中区间)，与整体重写同阶，不做逐行随机读；
   *   3. **逐行校验替换后的 JSON** —— 非法则该行跳过（个别行失败不该拖垮整批，但必须如实统计）；
   *   4. **原子重写** —— 写同目录临时文件再 rename，失败时用户拿到的仍是完整旧文件；
   *   5. **索引增量 + 基线快照** —— 行数不变，逐行平移其后检查点即可，无需重建。
   *
   * 查询为空直接拒绝：空串会匹配每一行的每个位置，那不是「替换」而是毁文件。
   * 命中数达到搜索上限（truncated）时同样拒绝 —— 我们无法确认待改行的全集，
   * 在此基础上的「批量替换」是不可控的。
   */
  async replaceText(
    query: string,
    replacement: string,
    opts: ReplaceOpts = {}
  ): Promise<ReplaceResultPayload> {
    if (!query) return DataService.replaceFailure('查找内容不能为空');

    const li = await this.ensureIndex();
    const reader = this.reader!;

    const conflict = await this.detectWriteConflict(-1);
    if (conflict) {
      return DataService.replaceFailure(conflict.error ?? '文件已被外部修改', { conflict: true });
    }

    // ① 搜索定位（走 host：worker 或主线程兜底）
    const found = await this.search(query, undefined, 'all');
    if (found.truncated) {
      return DataService.replaceFailure(
        `命中行超过 ${SEARCH_MAX_RESULTS} 行，无法确认待改行的全集，已拒绝批量替换；请缩小查找范围。`
      );
    }
    if (found.matches.length === 0) {
      return DataService.replaceOk(0, 0, 0, 0, 0, false);
    }

    // ② 一次顺序扫过命中行区间，取出原文并规划替换
    const hitSet = new Set(found.matches);
    const first = found.matches[0];
    const last = found.matches[found.matches.length - 1];
    const edits: ByteEdit[] = [];
    const deltas: { line: number; delta: number }[] = [];
    const changes: ReplaceChange[] = [];
    let skippedInvalid = 0;
    let unchanged = 0;

    const validate = (t: string): boolean => parseJsonLine(t).ok;

    for await (const r of li.scan(reader, first, last + 1)) {
      if (!hitSet.has(r.line)) continue;
      // 超长行（scan 以 error 标记）无法安全取出与改回，计入跳过而非静默略过。
      if (r.error) {
        skippedInvalid++;
        continue;
      }
      const raw = r.bytes.toString('utf8');
      const plan = planLineReplace(raw, query, replacement, {
        caseInsensitive: opts.caseInsensitive,
        validate,
      });
      if (!plan.text) {
        if (plan.skip === 'invalid-json') skippedInvalid++;
        else unchanged++;
        continue;
      }
      // 行尾按磁盘原样保留：替换只动行内容，不擅自把 CRLF 规范化成 LF。
      const ending = detectLineEnding({ start: r.start, end: r.end }, r.bytes.length);
      const next = Buffer.concat([Buffer.from(plan.text, 'utf8'), lineEndingBytes(ending)]);
      edits.push({ start: r.start, end: r.end, replacement: next });
      deltas.push({ line: r.line, delta: next.length - (r.end - r.start) });
      changes.push({ line: r.line, before: raw, after: plan.text });
    }

    const total = found.matches.length;
    if (edits.length === 0) {
      return DataService.replaceOk(0, skippedInvalid, unchanged, total, 0, false);
    }
    return this.applyEdits(li, edits, deltas, changes, total, skippedInvalid, unchanged, opts);
  }

  /**
   * 按行号批量写回指定文本（批量替换的撤销 / 重做走这条路）。
   *
   * 与 `replaceText` 的区别只在「规划」阶段：这里不做查询匹配，直接接受「这些行该是什么」。
   * 撤销必须走批量重写而非逐行 `editRecord` —— 后者是 N 次尾部搬移（成本 Σ(改动点距 EOF)），
   * 撤销一次 5000 行的替换可能要几分钟；批量重写恒为 O(文件大小)。
   */
  async applyLineTexts(
    entries: readonly { line: number; text: string }[],
    opts: ReplaceOpts = {}
  ): Promise<ReplaceResultPayload> {
    const li = await this.ensureIndex();
    const reader = this.reader!;

    // 目标行 → 期望文本（重复行号后者覆盖前者，避免同一区间被规划两次）
    const wanted = new Map<number, string>();
    for (const e of entries) {
      if (Number.isInteger(e.line) && e.line >= 0 && e.line < li.totalLines) {
        wanted.set(e.line, e.text);
      }
    }
    if (wanted.size === 0) return DataService.replaceFailure('没有可写回的行');

    const conflict = await this.detectWriteConflict(-1);
    if (conflict) {
      return DataService.replaceFailure(conflict.error ?? '文件已被外部修改', { conflict: true });
    }

    const lines = [...wanted.keys()].toSorted((a, b) => a - b);
    const edits: ByteEdit[] = [];
    const deltas: { line: number; delta: number }[] = [];
    const changes: ReplaceChange[] = [];
    let skippedInvalid = 0;
    let unchanged = 0;

    for await (const r of li.scan(reader, lines[0], lines[lines.length - 1] + 1)) {
      const text = wanted.get(r.line);
      if (text === undefined) continue;
      if (r.error) {
        skippedInvalid++;
        continue;
      }
      const raw = r.bytes.toString('utf8');
      if (raw === text) {
        unchanged++;
        continue;
      }
      // 写回的内容同样要过 JSON 校验：撤销的是「曾经合法的内容」，但磁盘可能已被
      // 外部改过，此处不能假设它一定还合法。
      if (!parseJsonLine(text).ok) {
        skippedInvalid++;
        continue;
      }
      const ending = detectLineEnding({ start: r.start, end: r.end }, r.bytes.length);
      const next = Buffer.concat([Buffer.from(text, 'utf8'), lineEndingBytes(ending)]);
      edits.push({ start: r.start, end: r.end, replacement: next });
      deltas.push({ line: r.line, delta: next.length - (r.end - r.start) });
      changes.push({ line: r.line, before: raw, after: text });
    }

    if (edits.length === 0) {
      return DataService.replaceOk(0, skippedInvalid, unchanged, wanted.size, 0, false);
    }
    return this.applyEdits(
      li,
      edits,
      deltas,
      changes,
      wanted.size,
      skippedInvalid,
      unchanged,
      opts
    );
  }

  /* ---------------------- 会话编辑历史 ---------------------- */

  /**
   * 记录一次成功的写操作。
   *
   * **单一光标模型**：`historyCursor` 之前的条目是「已应用」、之后是「已撤销」。
   * 于是：
   *   · Ctrl+Z（`undoStep`）就是光标 −1；
   *   · 历史面板「回退到此处」（`setHistoryCursor`）就是把光标移到目标位置；
   *   · 两者**共用同一份状态**，不可能各说各话。
   *
   * 之所以不做成「VS Code 撤销栈 + 独立历史面板」两套：那必然不一致 ——
   * 用户按 Ctrl+Z 撤销了，面板却还标着「已应用」。
   *
   * 在光标处发生新操作时，光标之后的记录**作废**（标准撤销栈语义）。
   */
  private pushHistory(op: HistoryOp, bytesDelta: number): void {
    if (this.applyingHistory) return;
    if (this.historyCursor < this.history.length) {
      this.history.length = this.historyCursor;
    }
    const { label, lines } = historyLabel(op);
    this.history.push({
      id: `h${++this.historySeq}`,
      op,
      label,
      lines,
      bytesDelta,
      at: Date.now(),
      bytes: historyOpBytes(op),
    });
    this.historyCursor = this.history.length;
    this.trimHistory();
  }

  /**
   * 从**最旧**的一端丢弃，直到条数与总体积都在上限内（丢弃即同步回退光标）。
   *
   * 保留「至少一条」：否则一条就超限的巨型操作会被自己的上限立刻丢掉 ——
   * 那等于刚做的事无法撤销。
   */
  private trimHistory(): void {
    let bytes = this.history.reduce((a, e) => a + e.bytes, 0);
    while (
      this.history.length > MAX_HISTORY_ENTRIES ||
      (bytes > MAX_HISTORY_BYTES && this.history.length > 1)
    ) {
      const dropped = this.history.shift();
      if (!dropped) break;
      bytes -= dropped.bytes;
      if (this.historyCursor > 0) this.historyCursor--;
      this.historyDropped = true;
    }
  }

  /** 历史快照（对外视图，**不含**回退数据 —— 那是宿主内部事务）。 */
  getHistory(): HistoryPayload {
    return {
      entries: this.history.map((e) => ({
        id: e.id,
        kind: e.op.kind,
        label: e.label,
        lines: e.lines,
        bytesDelta: e.bytesDelta,
        at: e.at,
      })),
      cursor: this.historyCursor,
      dropped: this.historyDropped,
    };
  }

  /** 撤销一步（光标前移）。 */
  async undoStep(): Promise<HistoryStepResult> {
    if (this.historyCursor === 0) {
      return {
        ok: false,
        steps: 0,
        cursor: 0,
        total: this.history.length,
        error: '没有可撤销的操作',
      };
    }
    const entry = this.history[this.historyCursor - 1];
    const applied = await this.runHistoryOp(entry, false);
    if (!applied.ok) {
      return {
        ok: false,
        steps: 0,
        cursor: this.historyCursor,
        total: this.history.length,
        error: applied.error,
      };
    }
    this.historyCursor--;
    return {
      ok: true,
      steps: 1,
      cursor: this.historyCursor,
      total: this.history.length,
      label: entry.label,
    };
  }

  /** 重做一步（光标后移）。 */
  async redoStep(): Promise<HistoryStepResult> {
    if (this.historyCursor >= this.history.length) {
      return {
        ok: false,
        steps: 0,
        cursor: this.historyCursor,
        total: this.history.length,
        error: '没有可重做的操作',
      };
    }
    const entry = this.history[this.historyCursor];
    const applied = await this.runHistoryOp(entry, true);
    if (!applied.ok) {
      return {
        ok: false,
        steps: 0,
        cursor: this.historyCursor,
        total: this.history.length,
        error: applied.error,
      };
    }
    this.historyCursor++;
    return {
      ok: true,
      steps: 1,
      cursor: this.historyCursor,
      total: this.history.length,
      label: entry.label,
    };
  }

  /**
   * 把光标移到指定位置（历史浮层的「回退到此处」）。
   *
   * **逐条执行**而非「一步到位」：写操作之间有依赖（行号与偏移），跳着回退会让中间
   * 条目的回退数据失效。只能沿着历史一步步走 —— 这正是它们被记成一条链的原因。
   * 中途失败即停，并如实报告已走了几步（不假装全部成功）。
   */
  async setHistoryCursor(target: number): Promise<HistoryStepResult> {
    const clamped = Math.max(0, Math.min(target, this.history.length));
    const shrinking = clamped < this.historyCursor;
    let steps = 0;
    let error: string | undefined;

    while (this.historyCursor > clamped) {
      const r = await this.undoStep();
      if (!r.ok) {
        error = r.error;
        break;
      }
      steps++;
    }
    while (this.historyCursor < clamped) {
      const r = await this.redoStep();
      if (!r.ok) {
        error = r.error;
        break;
      }
      steps++;
    }

    return {
      ok: this.historyCursor === clamped,
      steps,
      cursor: this.historyCursor,
      total: this.history.length,
      ...(error ? { error: `${error}（已${shrinking ? '撤销' : '重做'} ${steps} 步后中止）` } : {}),
    };
  }

  /**
   * 让某条历史成为**最新已应用**的操作（光标移到它之后）。
   *
   * 语义选「停在这一步」而非「撤销该条本身」：后者会让「点最新那一条」变成一次撤销，
   * 与直觉相反 —— 点最上面那条应该什么都不发生。UI 的文案、按钮禁用态都依赖这个语义，
   * 宿主与前端必须一致（差一步就会「想保留的那步被撤掉」）。
   */
  async revertTo(id: string): Promise<HistoryStepResult> {
    const idx = this.history.findIndex((e) => e.id === id);
    if (idx < 0) {
      return {
        ok: false,
        steps: 0,
        cursor: this.historyCursor,
        total: this.history.length,
        error: '该历史记录已不存在（可能因超出上限被丢弃）',
      };
    }
    return this.setHistoryCursor(idx + 1);
  }

  /** 执行一条历史操作的正向或反向；期间 `pushHistory` 自动失效。 */
  private async runHistoryOp(
    entry: HistoryEntry,
    forward: boolean
  ): Promise<{ ok: boolean; error?: string }> {
    this.applyingHistory = true;
    try {
      return await this.applyHistoryOp(entry.op, forward);
    } finally {
      this.applyingHistory = false;
    }
  }

  /** 历史操作的双向执行（正向 = 用户当初的操作，反向 = 回退）。 */
  private async applyHistoryOp(
    op: HistoryOp,
    forward: boolean
  ): Promise<{ ok: boolean; error?: string }> {
    const wrap = (r: { ok: boolean; error?: string }): { ok: boolean; error?: string } =>
      r.ok ? { ok: true } : { ok: false, ...(r.error ? { error: r.error } : {}) };

    switch (op.kind) {
      case 'edit':
        return wrap(await this.editRecord(op.line, forward ? op.after : op.before));
      case 'insert':
        return wrap(
          forward ? await this.insertRecord(op.line, op.text) : await this.deleteRecord(op.line)
        );
      case 'delete':
        return wrap(
          forward ? await this.deleteRecord(op.line) : await this.insertRecord(op.line, op.before)
        );
      case 'deleteMany': {
        const lines = op.ranges.flatMap((r) => r.lines);
        return wrap(forward ? await this.deleteRecords(lines) : await this.insertRanges(op.ranges));
      }
      case 'replaceAll':
        return wrap(
          await this.applyLineTexts(
            op.changes.map((c) => ({ line: c.line, text: forward ? c.after : c.before }))
          )
        );
    }
  }

  /* ------------------------- 多选批量操作（M2） ------------------------- */

  /**
   * 批量删除多行，一次原子落盘。
   *
   * 两个关键设计：
   *   1. **相邻行合并成连续区间** —— 框选一整段连续行是最常见的多选场景，合并后
   *      编辑数从 N 降到 1。这是本功能最有价值的优化（否则「框选 500 行删除」
   *      会变成 500 个区间编辑）。
   *   2. **回传区间（start/end/content）** —— 撤销正是「在同一组 start 处插入 content」。
   *      删除不会改变「删除点之前」的任何偏移，故删除与撤销共用同一组区间，
   *      完全可逆，且撤销同样是**一次原子重写**而非 N 次逐行插入。
   *
   * 索引必须**倒序**应用 `applyLineDelete`：其语义是「在现有索引上删第 line 行」，
   * 倒序才能保证每次的行号都还未被后面的删除影响。
   */
  async deleteRecords(
    lines: readonly number[],
    opts: ReplaceOpts = {}
  ): Promise<DeleteManyResultPayload> {
    const li = await this.ensureIndex();
    const reader = this.reader!;

    const conflict = await this.detectWriteConflict(-1);
    if (conflict) {
      return DataService.deleteManyFailure(conflict.error ?? '文件已被外部修改', {
        conflict: true,
      });
    }

    const targets = DataService.normalizeLines(lines, li.totalLines);
    if (targets.length === 0) return DataService.deleteManyFailure('没有可删除的行');
    if (targets.length > MAX_SELECTION_LINES) {
      return DataService.deleteManyFailure(
        `一次最多删除 ${MAX_SELECTION_LINES} 行，当前选中 ${targets.length} 行。`
      );
    }

    // 一次顺序扫过目标区间，取每行的字节范围与原文（含行尾 —— 撤销要原样插回）
    const wanted = new Set(targets);
    const rows: { line: number; start: number; end: number; bytes: number; content: string }[] = [];
    let skipped = 0;
    for await (const r of li.scan(reader, targets[0], targets[targets.length - 1] + 1)) {
      if (!wanted.has(r.line)) continue;
      // 超长行（scan 以 error 标记）无法安全取出内容：跳过而非删一半。
      if (r.error) {
        skipped++;
        continue;
      }
      const ending = detectLineEnding({ start: r.start, end: r.end }, r.bytes.length);
      const eol = ending === 'crlf' ? '\r\n' : ending === 'lf' ? '\n' : '';
      rows.push({
        line: r.line,
        start: r.start,
        end: r.end,
        bytes: r.end - r.start,
        content: r.bytes.toString('utf8') + eol,
      });
    }
    if (rows.length === 0) return DataService.deleteManyFailure('没有可删除的行（目标行过大）');

    // 合并相邻行为连续区间（每行字节数逐行记录 —— 撤销要精确平移检查点）
    const ranges: DeletedRange[] = [];
    for (const row of rows) {
      const tail = ranges[ranges.length - 1];
      if (tail && tail.lines[tail.lines.length - 1] + 1 === row.line) {
        tail.end = row.end;
        tail.lines.push(row.line);
        tail.lineBytes.push(row.bytes);
        tail.content += row.content;
      } else {
        ranges.push({
          start: row.start,
          end: row.end,
          content: row.content,
          lines: [row.line],
          lineBytes: [row.bytes],
        });
      }
    }

    const edits: ByteEdit[] = ranges.map((r) => ({
      start: r.start,
      end: r.end,
      replacement: Buffer.alloc(0),
    }));

    this.editing = true;
    try {
      const res = await this.rewriteAtomic(edits, opts);
      // 倒序应用索引删除（见方法文档）
      let idx = li;
      for (let i = rows.length - 1; i >= 0; i--) {
        idx = idx.applyLineDelete(rows[i].line, rows[i].end - rows[i].start);
      }
      this.index = idx;
      this.remapBadLinesAfterDeletes(wanted);
      await this.refreshSnapshot();
      this.pushHistory({ kind: 'deleteMany', ranges }, res.bytesDelta);

      return {
        ok: true,
        deleted: rows.length,
        ranges: ranges.length,
        bytesDelta: res.bytesDelta,
        costMs: Math.round(res.costMs * 100) / 100,
        skipped,
        changes: ranges,
      };
    } catch (e) {
      if (e instanceof WriteCancelledError) {
        return DataService.deleteManyFailure('已取消', { cancelled: true });
      }
      return DataService.deleteManyFailure(e instanceof Error ? e.message : String(e));
    } finally {
      this.editing = false;
    }
  }

  /**
   * 按字节区间批量插回内容（批量删除的**撤销 / 重做**专用）。
   *
   * 传入的区间来自 `deleteRecords` 回传的 `changes`。之所以能直接复用同一组 `start`：
   * 删除不改变「删除点之前」的任何偏移，故原 `start` 在删除后的文件里仍是有效插入点。
   * 于是撤销与删除完全对称 —— 都是一次原子重写，而不是 N 次逐行插入。
   *
   * 插入行号用 `原首行号 − 在此之前被删的行数` 推出，并**倒序**应用
   * `applyLineInsert`：倒序时后面的插入不会影响前面待处理区间的行号。
   */
  async insertRanges(
    ranges: readonly DeletedRange[],
    opts: ReplaceOpts = {}
  ): Promise<DeleteManyResultPayload> {
    const li = await this.ensureIndex();

    if (ranges.length === 0) return DataService.deleteManyFailure('没有需要恢复的内容');

    const conflict = await this.detectWriteConflict(-1);
    if (conflict) {
      return DataService.deleteManyFailure(conflict.error ?? '文件已被外部修改', {
        conflict: true,
      });
    }

    const sorted = [...ranges].toSorted((a, b) => a.start - b.start);
    const allLines = sorted.flatMap((r) => r.lines).toSorted((a, b) => a - b);

    const edits: ByteEdit[] = [];
    for (const r of sorted) {
      if (!Number.isInteger(r.start) || r.start < 0 || r.start > li.totalBytes) {
        // 偏移越界说明文件已被别的编辑改动过：宁可拒绝，也不要在错误位置插入。
        return DataService.deleteManyFailure(
          '撤销数据已失效（文件已被其它编辑改动），请重新加载。',
          {
            conflict: true,
          }
        );
      }
      if (r.lines.length === 0 || !r.content) continue;
      edits.push({ start: r.start, end: r.start, replacement: Buffer.from(r.content, 'utf8') });
    }
    if (edits.length === 0) return DataService.deleteManyFailure('没有需要恢复的内容');

    this.editing = true;
    try {
      const res = await this.rewriteAtomic(edits, opts);
      let idx = li;
      let restored = 0;
      // 倒序：先插后面的区间，前面区间的行号推导才不受影响。
      for (let i = sorted.length - 1; i >= 0; i--) {
        const r = sorted[i];
        if (r.lines.length === 0 || !r.content) continue;
        const at = r.lines[0] - countLessThan(allLines, r.lines[0]);
        // 逐行插入并**逐行给出精确字节数** —— 用平均字节平移检查点会错位（见 DeletedRange.lineBytes）。
        for (let k = 0; k < r.lines.length; k++) {
          idx = idx.applyLineInsert(at + k, r.lineBytes[k] ?? 0);
        }
        restored += r.lines.length;
      }
      this.index = idx;
      // 恢复的行内容已知合法（原本就在文件里），故从坏行集合中摘除。
      for (const l of allLines) this.knownBadLines.delete(l);
      await this.refreshSnapshot();

      return {
        ok: true,
        deleted: restored,
        ranges: edits.length,
        bytesDelta: res.bytesDelta,
        costMs: Math.round(res.costMs * 100) / 100,
        skipped: 0,
      };
    } catch (e) {
      if (e instanceof WriteCancelledError) {
        return DataService.deleteManyFailure('已取消', { cancelled: true });
      }
      return DataService.deleteManyFailure(e instanceof Error ? e.message : String(e));
    } finally {
      this.editing = false;
    }
  }

  /** 释放句柄 → 原子重写 → 拿回句柄（批量删除与批量重写共用同一时序）。 */
  private async rewriteAtomic(
    edits: ByteEdit[],
    opts: ReplaceOpts
  ): Promise<{ bytesDelta: number; costMs: number }> {
    await this.releaseFileHandles();
    try {
      const res = await rewriteWithEdits(this.path, edits, {
        onProgress: throttleProgress(opts.onProgress),
        ...(opts.shouldCancel ? { shouldCancel: opts.shouldCancel } : {}),
      });
      return { bytesDelta: res.bytesDelta, costMs: res.costMs };
    } finally {
      // 无论成败都必须把句柄拿回来，否则后续所有读取都会失败。
      await this.acquireFileHandles();
    }
  }

  /**
   * 批量删除后重映射坏行行号。
   *
   * 逐次调用 `shiftKnownBadLinesAfterDelete` 是 O(删除数 × 坏行数)；此处二分统计
   * 「该行之前被删了几行」，降到 O((坏行数 + 删除数) log 删除数)。
   */
  private remapBadLinesAfterDeletes(deleted: ReadonlySet<number>): void {
    if (this.knownBadLines.size === 0) return;
    const sorted = [...deleted].toSorted((a, b) => a - b);
    const next = new Set<number>();
    for (const l of this.knownBadLines) {
      if (deleted.has(l)) continue; // 该行已删除，丢弃
      next.add(l - countLessThan(sorted, l));
    }
    this.knownBadLines.clear();
    for (const l of next) this.knownBadLines.add(l);
  }

  /** 归一化行号：去重、滤越界、升序（宿主对前端的最后一道防线）。 */
  private static normalizeLines(lines: readonly number[], totalLines: number): number[] {
    const seen = new Set<number>();
    for (const l of lines) {
      if (Number.isInteger(l) && l >= 0 && l < totalLines) seen.add(l);
    }
    return [...seen].toSorted((a, b) => a - b);
  }

  private static deleteManyFailure(
    error: string,
    extra?: Partial<DeleteManyResultPayload>
  ): DeleteManyResultPayload {
    return {
      ok: false,
      deleted: 0,
      ranges: 0,
      bytesDelta: 0,
      costMs: 0,
      skipped: 0,
      error,
      ...extra,
    };
  }

  /**
   * 读取多行的**磁盘原文**并拼接，供批量复制。
   *
   * 与列表摘要不同：这里要的是可直接粘贴的原始文本，故走一次顺序 scan 取原文，
   * 不做 JSON 解析、不重排、不改行尾。超过 `COPY_MAX_BYTES` 时截断并标记 ——
   * 静默截断会让用户以为复制全了，粘出来的东西却不完整。
   *
   * 返回体额外带 `text`（正文很可能是 MB 级，不宜再经 RPC 回传一遍；
   * 调用方取其写剪贴板后，回执里不带正文）。
   */
  async readLinesText(
    lines: readonly number[]
  ): Promise<CopyLinesResultPayload & { text: string }> {
    const li = await this.ensureIndex();
    const reader = this.reader!;
    const empty = (error: string): CopyLinesResultPayload & { text: string } => ({
      ok: false,
      count: 0,
      bytes: 0,
      truncated: false,
      skipped: 0,
      error,
      text: '',
    });

    const targets = DataService.normalizeLines(lines, li.totalLines);
    if (targets.length === 0) return empty('没有可复制的行');
    if (targets.length > MAX_SELECTION_LINES) {
      return empty(`一次最多复制 ${MAX_SELECTION_LINES} 行，当前选中 ${targets.length} 行。`);
    }

    const wanted = new Set(targets);
    const parts: string[] = [];
    let bytes = 0;
    let skipped = 0;
    let truncated = false;

    for await (const r of li.scan(reader, targets[0], targets[targets.length - 1] + 1)) {
      if (!wanted.has(r.line)) continue;
      if (r.error) {
        skipped++;
        continue;
      }
      const rawBytes = r.end - r.start;
      if (bytes + rawBytes > COPY_MAX_BYTES) {
        truncated = true;
        break;
      }
      const ending = detectLineEnding({ start: r.start, end: r.end }, r.bytes.length);
      const eol = ending === 'crlf' ? '\r\n' : ending === 'lf' ? '\n' : '';
      parts.push(r.bytes.toString('utf8') + eol);
      bytes += rawBytes;
    }

    return { ok: true, count: parts.length, bytes, truncated, skipped, text: parts.join('') };
  }

  /**
   * 把规划好的编辑一次落盘，并同步索引与基线快照。
   *
   * 这是批量改写的**唯一落盘路径**：查找替换、撤销、重做都走它，避免各写一份
   * 「释放句柄 → 原子重写 → 拿回句柄 → 更新索引 → 刷新基线」的时序（那是最易漏步的地方）。
   */
  private async applyEdits(
    li: LineIndex,
    edits: ByteEdit[],
    deltas: { line: number; delta: number }[],
    changes: ReplaceChange[],
    total: number,
    skippedInvalid: number,
    unchanged: number,
    opts: ReplaceOpts
  ): Promise<ReplaceResultPayload> {
    this.editing = true;
    try {
      const res = await this.rewriteAtomic(edits, opts);
      // 索引增量更新：行数不变，逐行平移其后检查点（各 delta 相互独立，顺序无关）
      let idx = li;
      for (const { line, delta } of deltas) idx = idx.applyLineReplace(line, delta);
      this.index = idx;
      for (const { line } of deltas) this.knownBadLines.delete(line);
      await this.refreshSnapshot();

      const undoBytes = changes.reduce((a, c) => a + c.before.length + c.after.length, 0);
      const undoable =
        changes.length <= MAX_REPLACE_UNDO_LINES && undoBytes <= MAX_REPLACE_UNDO_BYTES;

      // 注：本方法也被 applyLineTexts 调用（历史回退的原语），那时的 `applyingHistory`
      // 为真，pushHistory 会自动跳过 —— 否则每撤销一次就会生成一条新记录。
      this.pushHistory({ kind: 'replaceAll', changes }, res.bytesDelta);

      return {
        ok: true,
        replaced: edits.length,
        skippedInvalid,
        unchanged,
        total,
        bytesDelta: res.bytesDelta,
        costMs: Math.round(res.costMs * 100) / 100,
        changes: undoable ? changes : undefined,
        undoable,
      };
    } catch (e) {
      // 取消与失败必须分开报：批量重写在 rename 之前中止是**零风险**的，
      // 把它报成「失败」会让用户以为文件可能损坏 —— 那与事实相反。
      if (e instanceof WriteCancelledError) {
        return { ...DataService.replaceFailure('已取消'), cancelled: true };
      }
      return DataService.replaceFailure(e instanceof Error ? e.message : String(e));
    } finally {
      this.editing = false;
    }
  }

  /**
   * 重写文件前释放**两侧**的文件句柄。
   *
   * 主线程 reader 与索引宿主的 reader 都要松手：Windows 下 rename 覆盖一个仍被打开的
   * 文件会 EPERM（worker 是独立线程但同进程，句柄一样拦人）。
   */
  private async releaseFileHandles(): Promise<void> {
    const r = this.reader;
    this.reader = undefined;
    if (r?.close) await r.close().catch(() => {});
    await this.host?.releaseFile().catch(() => {});
  }

  /** 重新获取文件句柄 —— 与 releaseFileHandles 严格配对（放在 finally 里）。 */
  private async acquireFileHandles(): Promise<void> {
    if (!this.reader) {
      try {
        this.reader = await openFileReader(this.path);
      } catch {
        // 拿不回来就只能让后续读取显式报错，不在此处遮蔽真实原因。
      }
    }
    await this.host?.reacquireFile(this.path).catch(() => {});
  }

  /** 查找替换的失败回执（统一填充字段，避免多处重复）。 */
  private static replaceFailure(
    error: string,
    extra?: Partial<ReplaceResultPayload>
  ): ReplaceResultPayload {
    return {
      ok: false,
      replaced: 0,
      skippedInvalid: 0,
      unchanged: 0,
      total: 0,
      bytesDelta: 0,
      costMs: 0,
      undoable: false,
      error,
      ...extra,
    };
  }

  private static replaceOk(
    replaced: number,
    skippedInvalid: number,
    unchanged: number,
    total: number,
    bytesDelta: number,
    undoable: boolean
  ): ReplaceResultPayload {
    return {
      ok: true,
      replaced,
      skippedInvalid,
      unchanged,
      total,
      bytesDelta,
      costMs: 0,
      undoable,
    };
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

  /* ------------------------- 坏行诊断（M3 收尾） ------------------------- */

  /**
   * 读取「已发现」的坏行集合。
   *
   * 该集合只覆盖宿主**已检查过**的范围（用户读过的行 + 抽样行 + 上次扫描结果），
   * 故未完成全量扫描时 `partial` 恒为 true —— 前端据此决定文案，绝不把它说成
   * 「文件共有 N 个坏行」。把它当全量用在数据清洗里会得出相反结论（「文件挺干净」）。
   */
  getBadLines(): BadLinesPayload {
    const all = [...this.knownBadLines].toSorted((a, b) => a - b);
    const truncated = all.length > MAX_BAD_LINES;
    return {
      lines: truncated ? all.slice(0, MAX_BAD_LINES) : all,
      partial: !this.badLinesComplete,
      // 未做过范围扫描时无「已扫描行数」可言，填 0（与 partial=true 一致）。
      scanned: this.badLinesComplete ? (this.index?.totalLines ?? 0) : 0,
      totalLines: this.index?.totalLines ?? 0,
      truncated,
      costMs: 0,
    };
  }

  /**
   * 全文件扫描坏行（流式、可取消、带进度）。
   *
   * 为何需要：`knownBadLines` 只覆盖已检查范围，据它判断「文件干净与否」是危险误判；
   * 而数据清洗的第一步恰恰是「这文件到底有多少坏行、都在哪」。
   *
   * 判定口径**必须与列表红标完全一致**，否则会出现「列表说好、扫描说坏」这种
   * 最难解释的不一致：超长行按 `isOversized` 视作合法（列表同样不解析它），
   * 只有 scan 的 `error`（触到 maxLineBytes）与 JSON 解析失败才算坏行。
   *
   * 位置选择：与 `getSampleFields` 一样在主线程做（只读流式扫描，逐行 await 让出
   * 事件循环，webview 在独立进程不受影响）。未下沉 worker 是因为那要扩 worker
   * 协议，而扫描是低频的显式用户动作；若日后成为瓶颈，可平移至 `IndexHost`
   * （接口形状已与 search/filter 一致）。
   */
  async scanBadLines(opts: ScanBadLinesOpts = {}): Promise<BadLinesPayload> {
    const li = await this.ensureIndex();
    const reader = this.reader!;
    const started = performance.now();
    const totalBytes = li.totalBytes;
    const lines: number[] = [];
    let scanned = 0;
    let truncated = false;
    let processedBytes = 0;
    let lastTick = 0;

    for await (const r of li.scan(reader, 0, li.totalLines)) {
      if (opts.shouldCancel?.()) {
        // 取消即**不**替换已发现集合：半份结果看起来像「文件很干净」，比没有结果更糟。
        return {
          lines: [],
          partial: true,
          scanned,
          totalLines: li.totalLines,
          truncated: false,
          cancelled: true,
          costMs: Math.round(performance.now() - started),
        };
      }
      scanned++;
      processedBytes += r.end - r.start;

      // 进度按字节节流；**终态必发**（停在 96% 的进度条比没有进度条更糟）。
      const now = performance.now();
      if (scanned >= li.totalLines || now - lastTick >= PROGRESS_THROTTLE_MS) {
        lastTick = now;
        opts.onProgress?.({ processedBytes, totalBytes });
      }

      const bad = r.error
        ? true
        : isOversized(r.bytes.length)
          ? false // 与列表口径一致：超大行不解析，视作合法
          : !parseJsonLine(r.bytes.toString('utf8')).ok;
      if (!bad) continue;

      // 超上限后只标记不记录 —— 载荷与前端 DOM 都不该随坏行数无界增长。
      if (lines.length >= MAX_BAD_LINES) truncated = true;
      else lines.push(r.line);
    }

    // 扫描成功即权威全量，**整体替换**而非合并：合并会让「已被改好的行」永远留在列表里。
    this.knownBadLines.clear();
    for (const l of lines) this.knownBadLines.add(l);
    this.badLinesComplete = true;

    return {
      lines,
      partial: false,
      scanned,
      totalLines: li.totalLines,
      truncated,
      costMs: Math.round(performance.now() - started),
    };
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
    this.badLinesComplete = false;
    // 会话编辑历史必须一并作废：行号与偏移在重载后已整体失效，用旧历史回退
    // 会**改到错误的行**上 —— 这比「不能撤销」危险得多。
    this.history.length = 0;
    this.historyCursor = 0;
    this.historyDropped = false;
  }
}
