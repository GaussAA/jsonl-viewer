/**
 * historyReplay.ts — 会话历史的回放：把撤销 / 重做 / 回退到某点真正写回磁盘。
 *
 * 从 dataService.ts 拆出的写路径之一。`EditHistory` 只管「记录与光标」，不执行；
 * 执行（调用各写操作的**锁内实现**）集中在这里。
 *
 * 死锁纪律：本文件所有函数都运行在 DataService 对外入口已持有的写锁内，
 * 一律调用各模块的 *Internal / 无锁版本 —— 走对外入口会第二次索取同一把锁，那是必然的自死锁。
 */

import type { HistoryEntry, HistoryOp, HistoryStepResult } from './editHistory.ts';
import { deleteRecordInternal, editRecordInternal, insertRecordInternal } from './recordWriter.ts';
import { applyLineTexts } from './textReplacer.ts';
import { deleteRecordsInternal, insertRangesInternal } from './rangeWriter.ts';
import type { WriteContext } from './writeSupport.ts';

type StepDirection = 'undo' | 'redo';

/** 单步历史操作的失败回执（`steps: 0` 表示这一步没有生效）。 */
function stepFailure(ctx: WriteContext, error: string | undefined): HistoryStepResult {
  return {
    ok: false,
    steps: 0,
    cursor: ctx.history.cursorPos,
    total: ctx.history.total,
    error,
  };
}

/**
 * 撤销 / 重做一步（光标移动一格并执行对应方向的操作）。
 *
 * 失败时必须把光标**退回去**：`history.undo()` / `redo()` 在取出条目时就已经移动了光标，
 * 若不复位，光标会停在一条「并未真正生效」的记录之后，此后所有回退都建立在错误的位置上。
 */
async function stepOnce(ctx: WriteContext, dir: StepDirection): Promise<HistoryStepResult> {
  const entry = dir === 'undo' ? ctx.history.undo() : ctx.history.redo();
  if (!entry) return stepFailure(ctx, dir === 'undo' ? '没有可撤销的操作' : '没有可重做的操作');

  const applied = await runHistoryOp(ctx, entry, dir === 'redo');
  if (!applied.ok) {
    if (dir === 'undo') ctx.history.stepForward();
    else ctx.history.stepBack();
    return stepFailure(ctx, applied.error);
  }
  return {
    ok: true,
    steps: 1,
    cursor: ctx.history.cursorPos,
    total: ctx.history.total,
    label: entry.label,
  };
}

/** 撤销一步（光标前移）。 */
export function undoStepInternal(ctx: WriteContext): Promise<HistoryStepResult> {
  return stepOnce(ctx, 'undo');
}

/** 重做一步（光标后移）。 */
export function redoStepInternal(ctx: WriteContext): Promise<HistoryStepResult> {
  return stepOnce(ctx, 'redo');
}

/**
 * 把光标移到指定位置（历史浮层的「回退到此处」）。
 *
 * **逐条执行**而非「一步到位」：写操作之间有依赖（行号与偏移），跳着回退会让中间
 * 条目的回退数据失效。只能沿着历史一步步走 —— 这正是它们被记成一条链的原因。
 * 中途失败即停，并如实报告已走了几步（不假装全部成功）。
 */
export async function setHistoryCursorInternal(
  ctx: WriteContext,
  target: number
): Promise<HistoryStepResult> {
  const history = ctx.history;
  const clamped = Math.max(0, Math.min(target, history.total));
  const shrinking = clamped < history.cursorPos;
  let steps = 0;
  let error: string | undefined;

  while (history.cursorPos !== clamped) {
    const r = await stepOnce(ctx, history.cursorPos > clamped ? 'undo' : 'redo');
    if (!r.ok) {
      error = r.error;
      break;
    }
    steps++;
  }

  return {
    ok: history.cursorPos === clamped,
    steps,
    cursor: history.cursorPos,
    total: history.total,
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
export async function revertToInternal(ctx: WriteContext, id: string): Promise<HistoryStepResult> {
  const idx = ctx.history.indexOfId(id);
  if (idx < 0) return stepFailure(ctx, '该历史记录已不存在（可能因超出上限被丢弃）');
  return setHistoryCursorInternal(ctx, idx + 1);
}

/** 执行一条历史操作的正向或反向；期间 `history.execute` 自动失效。 */
async function runHistoryOp(
  ctx: WriteContext,
  entry: HistoryEntry,
  forward: boolean
): Promise<{ ok: boolean; error?: string }> {
  ctx.history.applying = true;
  try {
    return await applyHistoryOp(ctx, entry.op, forward);
  } finally {
    ctx.history.applying = false;
  }
}

/** 历史操作的双向执行（正向 = 用户当初的操作，反向 = 回退）。 */
async function applyHistoryOp(
  ctx: WriteContext,
  op: HistoryOp,
  forward: boolean
): Promise<{ ok: boolean; error?: string }> {
  const wrap = (r: { ok: boolean; error?: string }): { ok: boolean; error?: string } =>
    r.ok ? { ok: true } : { ok: false, ...(r.error ? { error: r.error } : {}) };

  switch (op.kind) {
    case 'edit':
      // 走无单行约束的 internal：op.before/after 是当初磁盘上真实存在过的原文，
      // 多行记录的原样写回必须允许（写后验证与回滚仍在，安全性不受影响）。
      return wrap(await editRecordInternal(ctx, op.line, forward ? op.after : op.before));
    case 'insert':
      return wrap(
        forward
          ? await insertRecordInternal(ctx, op.line, op.text)
          : await deleteRecordInternal(ctx, op.line)
      );
    case 'delete':
      return wrap(
        forward
          ? await deleteRecordInternal(ctx, op.line)
          : await insertRecordInternal(ctx, op.line, op.before)
      );
    case 'deleteMany': {
      const lines = op.ranges.flatMap((r) => r.lines);
      return wrap(
        forward
          ? await deleteRecordsInternal(ctx, lines)
          : await insertRangesInternal(ctx, op.ranges)
      );
    }
    case 'replaceAll':
      return wrap(
        await applyLineTexts(
          ctx,
          op.changes.map((c) => ({ line: c.line, text: forward ? c.after : c.before }))
        )
      );
  }
}
