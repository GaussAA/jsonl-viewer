/**
 * writeSupport.test.ts — 写路径共享 helper 的单元测试（无需临时文件）。
 *
 * 这些函数是 5 个写入口共用的收口：回执形状、「取消 vs 失败」映射、
 * 「编辑中」标志的复位、入历史的字段推导。任何一处漂移都会同时波及所有写操作。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EditHistory } from '../editHistory.ts';
import { WriteCancelledError } from '../fileWriter.ts';
import {
  deleteManyErrorResult,
  deleteManyFailure,
  editErrorResult,
  editFailure,
  guardedWrite,
  newReplacePlan,
  pushLineEdit,
  recordHistory,
  replaceErrorResult,
  replaceFailure,
  replaceOk,
  roundMs,
  type WriteContext,
} from '../writeSupport.ts';

/** 只实现 guardedWrite / recordHistory 用到的两项；其余成员测试中不会被碰。 */
function fakeCtx(): { ctx: WriteContext; editing: () => boolean; history: EditHistory } {
  let editing = false;
  const history = new EditHistory();
  const ctx = {
    history,
    async withEditing<T>(body: () => Promise<T>): Promise<T> {
      editing = true;
      try {
        return await body();
      } finally {
        editing = false;
      }
    },
  } as unknown as WriteContext;
  return { ctx, editing: () => editing, history };
}

describe('roundMs', () => {
  it('保留两位小数', () => {
    assert.equal(roundMs(1.23456), 1.23);
    assert.equal(roundMs(0), 0);
    assert.equal(roundMs(2.005 + 0.0001), 2.01);
  });
});

describe('回执构造器', () => {
  it('editFailure：默认字段齐全，extra 可覆盖', () => {
    assert.deepEqual(editFailure(3, 'boom'), {
      ok: false,
      line: 3,
      bytesDelta: 0,
      inPlace: false,
      movedBytes: 0,
      costMs: 0,
      error: 'boom',
    });
    const r = editFailure(3, 'boom', { conflict: true });
    assert.equal(r.conflict, true);
    assert.equal(r.error, 'boom');
  });

  it('replaceFailure / replaceOk：形状一致，ok 与 undoable 口径正确', () => {
    const f = replaceFailure('bad', { conflict: true });
    assert.equal(f.ok, false);
    assert.equal(f.undoable, false);
    assert.equal(f.conflict, true);
    assert.equal(f.error, 'bad');

    const ok = replaceOk(2, 1, 3, 6, 10, true);
    assert.deepEqual(ok, {
      ok: true,
      replaced: 2,
      skippedInvalid: 1,
      unchanged: 3,
      total: 6,
      bytesDelta: 10,
      costMs: 0,
      undoable: true,
    });
  });

  it('deleteManyFailure：计数全部归零', () => {
    const r = deleteManyFailure('x', { cancelled: true });
    assert.equal(r.ok, false);
    assert.equal(r.deleted, 0);
    assert.equal(r.ranges, 0);
    assert.equal(r.skipped, 0);
    assert.equal(r.cancelled, true);
  });
});

describe('「取消 vs 失败」映射', () => {
  it('取消必须带 cancelled 标记，且不能报成普通失败', () => {
    const cancel = new WriteCancelledError('用户取消');

    const e = editErrorResult(7, cancel);
    assert.equal(e.cancelled, true);
    assert.equal(e.line, 7);
    assert.equal(e.error, '用户取消', '编辑沿用异常自带的说明（可能含「回滚未完成」警告）');

    const d = deleteManyErrorResult(cancel);
    assert.equal(d.cancelled, true);
    assert.equal(d.error, '已取消');

    const r = replaceErrorResult(cancel);
    assert.equal(r.cancelled, true);
    assert.equal(r.error, '已取消');
  });

  it('普通异常：Error 取 message，非 Error 转字符串，且不带 cancelled', () => {
    const e = editErrorResult(1, new Error('磁盘满'));
    assert.equal(e.error, '磁盘满');
    assert.equal(e.cancelled, undefined);

    assert.equal(deleteManyErrorResult('裸字符串').error, '裸字符串');
    assert.equal(replaceErrorResult(42).error, '42');
    assert.equal(replaceErrorResult(new Error('x')).cancelled, undefined);
  });
});

describe('guardedWrite', () => {
  it('成功：返回 body 结果，编辑标志执行期间为真、结束后复位', async () => {
    const { ctx, editing } = fakeCtx();
    let during = false;
    const out = await guardedWrite(
      ctx,
      () => 'failed',
      async () => {
        during = editing();
        return 'done';
      }
    );
    assert.equal(out, 'done');
    assert.equal(during, true);
    assert.equal(editing(), false);
  });

  it('body 抛错：交给 onError 映射，标志仍然复位（否则 checkStale 永远停摆）', async () => {
    const { ctx, editing } = fakeCtx();
    const out = await guardedWrite(
      ctx,
      (e) => `mapped:${(e as Error).message}`,
      async () => {
        throw new Error('boom');
      }
    );
    assert.equal(out, 'mapped:boom');
    assert.equal(editing(), false);
  });
});

describe('recordHistory', () => {
  it('label / lines / bytes 全部由 op 推出，并移动历史光标', () => {
    const { ctx, history } = fakeCtx();
    recordHistory(ctx, { kind: 'edit', line: 4, before: 'ab', after: 'cde' }, 3);
    const snap = history.snapshot();
    assert.equal(snap.cursor, 1);
    assert.equal(snap.entries.length, 1);
    assert.equal(snap.entries[0].label, '编辑第 5 行');
    assert.equal(snap.entries[0].lines, 1);
    assert.equal(snap.entries[0].bytesDelta, 3);
    assert.equal(snap.entries[0].kind, 'edit');
  });

  it('回放期间（applying）不入栈，否则每撤销一次就生成一条新记录', () => {
    const { ctx, history } = fakeCtx();
    history.applying = true;
    recordHistory(ctx, { kind: 'delete', line: 0, before: 'x' }, -2);
    history.applying = false;
    assert.equal(history.total, 0);
  });
});

describe('ReplacePlan / pushLineEdit', () => {
  it('LF 行：字节差 = 新旧内容长度差；登记 edit / delta / change 三份数据', () => {
    const plan = newReplacePlan();
    // 磁盘区间 [10, 16) 共 6 字节：5 字节内容 + 1 字节 LF
    pushLineEdit(plan, { line: 2, start: 10, end: 16, bytes: { length: 5 } }, 'hello', 'hi');
    assert.equal(plan.edits.length, 1);
    assert.deepEqual(
      { start: plan.edits[0].start, end: plan.edits[0].end },
      { start: 10, end: 16 }
    );
    assert.equal(plan.edits[0].replacement.toString('utf8'), 'hi\n');
    assert.deepEqual(plan.deltas, [{ line: 2, delta: 3 - 6 }]);
    assert.deepEqual(plan.changes, [{ line: 2, before: 'hello', after: 'hi' }]);
  });

  it('CRLF 行：行尾按磁盘原样保留，不被规范化成 LF', () => {
    const plan = newReplacePlan();
    // 5 字节内容 + 2 字节 CRLF
    pushLineEdit(plan, { line: 0, start: 0, end: 7, bytes: { length: 5 } }, 'hello', 'hey');
    assert.equal(plan.edits[0].replacement.toString('utf8'), 'hey\r\n');
    assert.equal(plan.deltas[0].delta, 5 - 7);
  });

  it('文件末行无行尾：不擅自补换行', () => {
    const plan = newReplacePlan();
    pushLineEdit(plan, { line: 9, start: 100, end: 105, bytes: { length: 5 } }, 'hello', 'hi!');
    assert.equal(plan.edits[0].replacement.toString('utf8'), 'hi!');
    assert.equal(plan.deltas[0].delta, 3 - 5);
  });

  it('newReplacePlan：统计从零开始', () => {
    const plan = newReplacePlan();
    assert.equal(plan.skippedInvalid, 0);
    assert.equal(plan.unchanged, 0);
    assert.equal(plan.edits.length + plan.deltas.length + plan.changes.length, 0);
  });
});
