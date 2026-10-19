/**
 * rangeWriter.ts — 多选批量操作：批量删除 / 按字节区间插回（批量删除的撤销、重做）。
 *
 * 从 dataService.ts 拆出的写路径之一。全部是**锁内实现**：加锁只发生在 DataService 对外入口。
 * 二者互为逆操作，共用同一组 `DeletedRange`，且都是**一次原子重写**而非 N 次逐行编辑。
 */

import type { IndexDeltaOp } from '../indexer/lineIndex.ts';
import { MAX_SELECTION_LINES } from '../constants.ts';
import { detectLineEnding } from './fileWriter.ts';
import type { ByteEdit } from './fileWriter.ts';
import { countLessThan, eolText, expandRecordLines, normalizeLines } from './dataServiceHelpers.ts';
import type { DeleteManyResultPayload, DeletedRange } from '../protocol/rpc.ts';
import {
  deleteManyErrorResult,
  deleteManyFailure,
  guardedWrite,
  recordHistory,
  roundMs,
  type ReplaceOpts,
  type WriteContext,
} from './writeSupport.ts';

/** 批量删除的「冲突」口径回执（没有单一行号，换成 DeleteManyResultPayload 形状）。 */
async function deleteManyConflict(
  ctx: WriteContext,
  opts: ReplaceOpts
): Promise<DeleteManyResultPayload | undefined> {
  const conflict = await ctx.detectWriteConflict(-1, opts.expectedTotalLines);
  if (!conflict) return undefined;
  return deleteManyFailure(conflict.error ?? '文件已被外部修改', { conflict: true });
}

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
 * 索引必须**倒序**应用 `delete` op：其语义是「在现有索引上删第 line 行」，
 * 倒序才能保证每次的行号都还未被后面的删除影响。
 */
export async function deleteRecordsInternal(
  ctx: WriteContext,
  lines: readonly number[],
  opts: ReplaceOpts = {}
): Promise<DeleteManyResultPayload> {
  const li = await ctx.ensureIndex();
  const reader = ctx.reader();

  const conflict = await deleteManyConflict(ctx, opts);
  if (conflict) return conflict;

  const targets = normalizeLines(lines, li.totalRecords);
  if (targets.length === 0) return deleteManyFailure('没有可删除的记录');
  if (targets.length > MAX_SELECTION_LINES) {
    return deleteManyFailure(
      `一次最多删除 ${MAX_SELECTION_LINES} 行，当前选中 ${targets.length} 行。`
    );
  }

  // 记录号 → 物理行集合（多行记录展开为连续行区间；紧凑文件下 == 记录号本身）
  const { wanted, firstLine, lastLine } = expandRecordLines(li, targets);

  // 一次顺序扫过目标区间，取每行的字节范围与原文（含行尾 —— 撤销要原样插回）
  const rows: { line: number; start: number; end: number; bytes: number; content: string }[] = [];
  let skipped = 0;
  for await (const r of li.scan(reader, firstLine, lastLine + 1)) {
    if (!wanted.has(r.line)) continue;
    // 超长行（scan 以 error 标记）无法安全取出内容：跳过而非删一半。
    if (r.error) {
      skipped++;
      continue;
    }
    const ending = detectLineEnding({ start: r.start, end: r.end }, r.bytes.length);
    rows.push({
      line: r.line,
      start: r.start,
      end: r.end,
      bytes: r.end - r.start,
      content: r.bytes.toString('utf8') + eolText(ending),
    });
  }
  if (rows.length === 0) return deleteManyFailure('没有可删除的行（目标行过大）');

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

  return guardedWrite(ctx, deleteManyErrorResult, async () => {
    const res = await ctx.rewriteAtomic(edits, opts);
    if (li.multiline) {
      // 多行文件：删除改变行号结构，recordEndLines 无法增量平移 —— 全量重建。
      await ctx.rebuildIndex();
    } else {
      // 倒序应用索引删除（见函数文档）
      const ops: IndexDeltaOp[] = [];
      for (let i = rows.length - 1; i >= 0; i--) {
        ops.push({ kind: 'delete', line: rows[i].line, bytes: rows[i].end - rows[i].start });
      }
      await ctx.commitIndex(li, ops);
      ctx.badLines.remapAfterDeletes(wanted);
    }
    recordHistory(ctx, { kind: 'deleteMany', ranges }, res.bytesDelta);

    return {
      ok: true,
      deleted: rows.length,
      ranges: ranges.length,
      bytesDelta: res.bytesDelta,
      costMs: roundMs(res.costMs),
      skipped,
      changes: ranges,
    };
  });
}

/**
 * 按字节区间批量插回内容（批量删除的**撤销 / 重做**专用）。
 *
 * 传入的区间来自 `deleteRecords` 回传的 `changes`。之所以能直接复用同一组 `start`：
 * 删除不改变「删除点之前」的任何偏移，故原 `start` 在删除后的文件里仍是有效插入点。
 * 于是撤销与删除完全对称 —— 都是一次原子重写，而不是 N 次逐行插入。
 *
 * 插入行号用 `原首行号 − 在此之前被删的行数` 推出，并**倒序**应用 `insert` op：
 * 倒序时后面的插入不会影响前面待处理区间的行号。
 */
export async function insertRangesInternal(
  ctx: WriteContext,
  ranges: readonly DeletedRange[],
  opts: ReplaceOpts = {}
): Promise<DeleteManyResultPayload> {
  const li = await ctx.ensureIndex();

  if (ranges.length === 0) return deleteManyFailure('没有需要恢复的内容');

  const conflict = await deleteManyConflict(ctx, opts);
  if (conflict) return conflict;

  const sorted = [...ranges].toSorted((a, b) => a.start - b.start);
  const allLines = sorted.flatMap((r) => r.lines).toSorted((a, b) => a - b);

  const edits: ByteEdit[] = [];
  // 此前各段已被删掉的字节数。`DeletedRange.start` 记的是**删除前**文件里的偏移，
  // 而本次要在**删除后**的文件上插入：第 k 段的真正插入点 = start − 前 k−1 段的字节数。
  // 只对第一段恰好等于 start，漏掉这个扣除会让后面的区间被插到更靠后的位置，
  // 返回 ok、行数也对，记录顺序却被静默打乱。
  let removedBefore = 0;
  for (const r of sorted) {
    const at = r.start - removedBefore;
    if (!Number.isInteger(r.start) || at < 0 || at > li.totalBytes) {
      // 偏移越界说明文件已被别的编辑改动过：宁可拒绝，也不要在错误位置插入。
      return deleteManyFailure('撤销数据已失效（文件已被其它编辑改动），请重新加载。', {
        conflict: true,
      });
    }
    if (r.lines.length === 0 || !r.content) continue;
    const replacement = Buffer.from(r.content, 'utf8');
    edits.push({ start: at, end: at, replacement });
    removedBefore += replacement.length;
  }
  if (edits.length === 0) return deleteManyFailure('没有需要恢复的内容');

  return guardedWrite(ctx, deleteManyErrorResult, async () => {
    const res = await ctx.rewriteAtomic(edits, opts);
    let restored = 0;
    const ops: IndexDeltaOp[] = [];
    // 倒序：先插后面的区间，前面区间的行号推导才不受影响。
    for (let i = sorted.length - 1; i >= 0; i--) {
      const r = sorted[i];
      if (r.lines.length === 0 || !r.content) continue;
      const at = r.lines[0] - countLessThan(allLines, r.lines[0]);
      // 逐行插入并**逐行给出精确字节数** —— 用平均字节平移检查点会错位（见 DeletedRange.lineBytes）。
      for (let k = 0; k < r.lines.length; k++) {
        ops.push({ kind: 'insert', line: at + k, bytes: r.lineBytes[k] ?? 0 });
        restored++;
      }
    }
    await ctx.commitIndex(li, ops);
    // 恢复的行内容已知合法（原本就在文件里），故从坏行集合中摘除。
    ctx.badLines.deleteMany(allLines);

    return {
      ok: true,
      deleted: restored,
      ranges: edits.length,
      bytesDelta: res.bytesDelta,
      costMs: roundMs(res.costMs),
      skipped: 0,
    };
  });
}
