/**
 * writeSupport.ts — 写路径各模块共享的上下文契约、结果构造器与收口 helper。
 *
 * 从 dataService.ts 拆出写路径（recordWriter / textReplacer / rangeWriter / historyReplay）
 * 之后，这些模块需要一份**共同的最小依赖面**：
 *   - `WriteContext`：DataService 暴露给写路径的受控接口。写路径只能经它读索引 / 句柄、
 *     提交索引变更、取得写锁内的「编辑中」标志 —— 不能直接碰 `this.index` 等私有字段，
 *     「索引只能经 commitIndex 变更」这条不变量因此仍由 DataService 独家守护。
 *   - 失败 / 成功回执的统一构造器，以及「取消 vs 失败」的统一映射（此前在 5 处各抄一遍）。
 *   - `recordHistory`：入历史的 5 处重复样板。
 *
 * 本文件不 import `dataService.ts`（避免环依赖）；`ReplaceOpts` 定义在这里，
 * 由 dataService.ts 重新导出以保持对外 API 不变。
 */

import type { IndexDeltaOp, LineIndex } from '../indexer/lineIndex.ts';
import type { ByteReader } from '../parser/types.ts';
import { detectLineEnding, lineEndingBytes, WriteCancelledError } from './fileWriter.ts';
import type { ByteEdit } from './fileWriter.ts';
import { historyLabel, historyOpBytes } from './editHistory.ts';
import type { EditHistory, HistoryOp } from './editHistory.ts';
import type { BadLineTracker } from './badLineTracker.ts';
import type { SearchLinesResult } from './searchEngine.ts';
import type {
  DeleteManyResultPayload,
  EditResultPayload,
  ReplaceChange,
  ReplaceResultPayload,
} from '../protocol/rpc.ts';

/** 批量改写（查找替换 / 撤销 / 重做）的可选行为。 */
export interface ReplaceOpts {
  /** 是否大小写不敏感（与搜索保持一致；默认 true）。 */
  caseInsensitive?: boolean;
  /** 调用方视图的期望总行数（乐观锁的调用方一侧；详见 detectWriteConflict）。 */
  expectedTotalLines?: number;
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

/**
 * DataService 暴露给写路径的受控接口。
 *
 * 为何用「方法」而非直接给字段：写路径在多处 `await` 之后需要读到**最新**的索引 / 句柄
 * （`rebuildIndex` / `rewriteAtomic` 会替换它们），缓存一个旧引用就是用已释放的句柄读文件。
 * 每次调用 `index()` / `reader()` 都是现取，与此前 `this.index!` / `this.reader!` 的时机完全一致。
 */
export interface WriteContext {
  readonly path: string;
  readonly history: EditHistory;
  readonly badLines: BadLineTracker;
  /** 惰性构建（并发安全）；写路径入口先调它，之后才可使用 `index()` / `reader()`。 */
  ensureIndex(): Promise<LineIndex>;
  /** 当前索引。仅可在 `ensureIndex()` 完成之后调用。 */
  index(): LineIndex;
  /** 当前主线程读句柄。仅可在 `ensureIndex()` 完成之后调用。 */
  reader(): ByteReader;
  /**
   * 写盘成功后维护索引的**唯一分流点**（多行文件重建，紧凑文件增量平移）。
   * 细节与「为何必须收口」见 DataService.commitIndex。
   */
  commitIndex(li: LineIndex, ops: IndexDeltaOp[]): Promise<void>;
  /** 结构变更后的索引全量重建（会 dispose 旧宿主，见 DataService.rebuildIndex）。 */
  rebuildIndex(): Promise<void>;
  /** 写前冲突检测：文件被外部改动 / 调用方视图过期则返回失败回执，否则 undefined。 */
  detectWriteConflict(
    line: number,
    expectedTotalLines?: number
  ): Promise<EditResultPayload | undefined>;
  /** 释放句柄 → 原子重写 → 拿回句柄（批量删除与批量重写共用同一时序）。 */
  rewriteAtomic(
    edits: ByteEdit[],
    opts: ReplaceOpts
  ): Promise<{ bytesDelta: number; costMs: number }>;
  /**
   * 在「编辑进行中」标志的保护下执行 `body`（成败都会复位）。
   *
   * 期间 `checkStale` 不判定 —— 文件正被本进程改写、基线随后同步，此刻判定只会产生
   * 「自己改自己」的误报横幅。
   */
  withEditing<T>(body: () => Promise<T>): Promise<T>;
  /** 全文搜索（走宿主索引 + 查询缓存）；批量替换用它定位命中行。 */
  search(query: string, field?: string, scope?: string): Promise<SearchLinesResult>;
}

/* ------------------------------ 回执构造器 ------------------------------ */

/** 耗时取两位小数（回执里的 costMs 口径）。 */
export function roundMs(ms: number): number {
  return Math.round(ms * 100) / 100;
}

/** 编辑失败的统一回执（避免多处重复填充字段）。 */
export function editFailure(
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

/** 查找替换的失败回执（统一填充字段，避免多处重复）。 */
export function replaceFailure(
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

export function replaceOk(
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

export function deleteManyFailure(
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

/* ---------------------- 「取消 vs 失败」的统一映射 ---------------------- */

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 取消与失败必须分开报：取消会自动回滚（文件原样），报成「失败」会让用户
 * 以为文件可能损坏 —— 那是与事实相反的恐慌。以下三个映射器各对应一种回执形状。
 */
export function editErrorResult(line: number, e: unknown): EditResultPayload {
  if (e instanceof WriteCancelledError) return editFailure(line, e.message, { cancelled: true });
  return editFailure(line, errorMessage(e));
}

export function deleteManyErrorResult(e: unknown): DeleteManyResultPayload {
  if (e instanceof WriteCancelledError) return deleteManyFailure('已取消', { cancelled: true });
  return deleteManyFailure(errorMessage(e));
}

export function replaceErrorResult(e: unknown): ReplaceResultPayload {
  if (e instanceof WriteCancelledError) return { ...replaceFailure('已取消'), cancelled: true };
  return replaceFailure(errorMessage(e));
}

/**
 * 「编辑中」标志保护 + 异常映射的统一外壳。
 *
 * 写路径各入口原先各自手写 `editing = true; try {…} catch {…} finally { editing = false }`，
 * 漏掉 finally 会让 `checkStale` 永远停摆；统一到这里，入口只剩业务本身。
 */
export function guardedWrite<T>(
  ctx: WriteContext,
  onError: (e: unknown) => T,
  // NoInfer：T 只由 onError 的回执类型决定。否则 body 里的字面量 `ok: true`
  // 会把 T 收窄成成功分支，导致失败回执无法赋值。
  body: () => Promise<NoInfer<T>>
): Promise<T> {
  return ctx.withEditing(async () => {
    try {
      return await body();
    } catch (e) {
      return onError(e);
    }
  });
}

/* ------------------------------ 历史记录 ------------------------------ */

/**
 * 把一次成功的写操作记入会话历史。
 *
 * label / lines / bytes 全部由 op 推出（`historyLabel` / `historyOpBytes`），调用方只给
 * 「磁盘字节变化」。回退执行期间 `history.applying` 为真，`execute` 会自动忽略 ——
 * 否则每撤销一次就会生成一条新记录。
 */
export function recordHistory(ctx: WriteContext, op: HistoryOp, bytesDelta: number): void {
  const { label, lines } = historyLabel(op);
  ctx.history.execute({
    id: ctx.history.nextId(),
    op,
    label,
    lines,
    bytesDelta,
    at: Date.now(),
    bytes: historyOpBytes(op),
  });
}

/* ---------------------- 批量改写的规划结果 ---------------------- */

/** 批量改写的「规划」产物：待写的字节编辑 + 索引平移量 + 撤销数据 + 统计。 */
export interface ReplacePlan {
  edits: ByteEdit[];
  deltas: { line: number; delta: number }[];
  changes: ReplaceChange[];
  skippedInvalid: number;
  unchanged: number;
}

export function newReplacePlan(): ReplacePlan {
  return { edits: [], deltas: [], changes: [], skippedInvalid: 0, unchanged: 0 };
}

/**
 * 把「某一行改成 `text`」登记进规划。
 *
 * 行尾按磁盘原样保留：替换只动行内容，不擅自把 CRLF 规范化成 LF。
 * 查找替换与按行号写回（撤销 / 重做）共用，避免两处各算一遍字节差。
 */
export function pushLineEdit(
  plan: ReplacePlan,
  r: { line: number; start: number; end: number; bytes: { length: number } },
  raw: string,
  text: string
): void {
  const ending = detectLineEnding({ start: r.start, end: r.end }, r.bytes.length);
  const next = Buffer.concat([Buffer.from(text, 'utf8'), lineEndingBytes(ending)]);
  plan.edits.push({ start: r.start, end: r.end, replacement: next });
  plan.deltas.push({ line: r.line, delta: next.length - (r.end - r.start) });
  plan.changes.push({ line: r.line, before: raw, after: text });
}
