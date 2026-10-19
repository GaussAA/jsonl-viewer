/**
 * dataServiceHelpers.ts — DataService 用到的无状态辅助函数与选项类型。
 *
 * 从 dataService.ts 拆出：这些函数不碰 DataService 的任何私有状态（锁、索引、句柄），
 * 单独成文件后既缩小了主文件，也便于独立测试。
 */

import type { LineIndex } from '../indexer/lineIndex.ts';
import type { ByteReader } from '../parser/types.ts';
import { detectLineEnding } from './fileWriter.ts';
import type { LineEnding } from './fileWriter.ts';
import type { FilterLinesResult, SearchLinesResult } from './searchEngine.ts';
import { PROGRESS_THROTTLE_MS } from '../constants.ts';

/**
 * 探测某行的字节区间与行尾风格。
 *
 * **失败原因必须区分**（越界 / 行过大 / 索引与磁盘不一致）：三者的处置完全不同，
 * 混成一句「无法定位该行」会让排查走弯路 —— 这正是此前踩过的坑。
 */
export async function probeLine(
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
export function describeProbeFailure(
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
export function throttleProgress(
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

/**
 * 复制一份搜索结果再交出去。
 *
 * 缓存里的对象是**共享**的，直接交出去等于把内部状态借给调用方：调用方一旦往
 * `matches` 里 push（或排序），缓存就被污染，下一次同样的查询会拿到错答案。
 * 复制 5 万个数字约 1ms，远比一次全文件扫描便宜。
 */
export function cloneSearchResult(r: SearchLinesResult): SearchLinesResult {
  return { ...r, matches: [...r.matches] };
}

/** 同上；过滤结果的 `matches` 可能为 null（=不过滤），须分别处理。 */
export function cloneFilterResult(r: FilterLinesResult): FilterLinesResult {
  return { ...r, matches: r.matches === null ? null : [...r.matches] };
}

/** 二分统计升序数组中小于 `x` 的元素个数（用于批量删除后的行号映射）。 */
export function countLessThan(sorted: readonly number[], x: number): number {
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
export function toReplaceOpts(opts: EditRecordOpts): {
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

/** 归一化行号：去重、滤越界、升序（宿主对前端的最后一道防线）。 */
export function normalizeLines(lines: readonly number[], totalLines: number): number[] {
  const seen = new Set<number>();
  for (const l of lines) {
    if (Number.isInteger(l) && l >= 0 && l < totalLines) seen.add(l);
  }
  return [...seen].toSorted((a, b) => a - b);
}

/**
 * 记录号 → 物理行集合（多行记录展开为连续行区间；紧凑文件下 == 记录号本身）。
 *
 * 同时给出覆盖全部目标的物理行区间 `[firstLine, lastLine]`（闭区间），
 * 调用方据此做**一次**顺序 scan，而不是逐条随机读。
 * 要求 `targets` 已经 `normalizeLines`（非空、升序、无越界）。
 */
export function expandRecordLines(
  li: LineIndex,
  targets: readonly number[]
): { wanted: Set<number>; firstLine: number; lastLine: number } {
  const wanted = new Set<number>();
  for (const no of targets) {
    const rr = li.recordRange(no);
    for (let l = rr.startLine; l <= rr.endLine; l++) wanted.add(l);
  }
  return {
    wanted,
    firstLine: li.recordRange(targets[0]).startLine,
    lastLine: li.recordRange(targets[targets.length - 1]).endLine,
  };
}

/** 行尾风格 → 文本形式（批量复制 / 批量删除要原样保留磁盘上的行尾）。 */
export function eolText(ending: LineEnding): string {
  return ending === 'crlf' ? '\r\n' : ending === 'lf' ? '\n' : '';
}

/**
 * 单行编辑的可选行为。
 *
 * 只有「需要搬移尾部」的变长编辑才会用到它们：等长替换是单次 IO、末尾行无需搬移，
 * 两者都在毫秒级完成，轮询取消与上报进度都只是噪音。
 */
export interface EditRecordOpts {
  /** 调用方视图的期望总行数（乐观锁的调用方一侧；详见 detectWriteConflict）。 */
  expectedTotalLines?: number;
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
