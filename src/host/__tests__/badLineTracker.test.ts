/**
 * badLineTracker.test.ts — 坏行集合与完整性标记单测。
 *
 * 重点是**行号位移**：单行增删、批量删除各有各的规则，算错的表现是「红标指向别的行」，
 * 而用户会据此删行 —— 那是不可逆的错删。故这些规则必须逐条钉死。
 *
 * 另一条同样要紧的语义：`partial`（是否已全量扫过）与「已发现列表」是两件事 ——
 * 内容变化只降级前者，绝不清空后者（清空等于把用户的排查进度丢掉）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadLineTracker } from '../badLineTracker.ts';

test('增删查与升序快照', () => {
  const t = new BadLineTracker();
  t.addMany([5, 1, 3, 1]);
  assert.equal(t.size, 3, '重复行号只算一次');
  assert.equal(t.has(3), true);
  assert.deepEqual(t.toSortedArray(), [1, 3, 5], '对外快照按行号升序');

  t.delete(3);
  assert.equal(t.has(3), false);
  t.deleteMany([1, 999]);
  assert.deepEqual(t.toSortedArray(), [5], '删不存在的行号无副作用');

  // 快照是副本：外部改动不影响内部状态
  const snap = t.toSortedArray();
  snap.push(999);
  assert.deepEqual(t.toSortedArray(), [5]);
});

test('replaceAll 整体替换（不是合并）并置为权威全量', () => {
  const t = new BadLineTracker();
  t.addMany([1, 2, 3]);
  t.replaceAll([7, 8]);

  assert.deepEqual(t.toSortedArray(), [7, 8]);
  assert.equal(t.isComplete, true, '全量扫描成功 → partial 应为 false');
  assert.equal(t.has(1), false, '被改好的行不得残留在列表里');
});

test('invalidate 只降级完整性标记，保留已发现列表', () => {
  const t = new BadLineTracker();
  t.replaceAll([4, 9]);
  t.invalidate();

  assert.equal(t.isComplete, false, '内容已变 → 「全量」结论失去依据');
  assert.deepEqual(t.toSortedArray(), [4, 9], '已发现的坏行仍然有价值，不得清空');
});

test('reset 整体作废（reload / dispose / 重建索引）', () => {
  const t = new BadLineTracker();
  t.replaceAll([1, 2]);
  t.reset();
  assert.equal(t.size, 0);
  assert.equal(t.isComplete, false);
});

test('shiftAfterDelete：其后行号前移一位，被删行本身丢弃', () => {
  const t = new BadLineTracker();
  t.addMany([1, 3, 5]);
  t.shiftAfterDelete(3);
  assert.deepEqual(t.toSortedArray(), [1, 4], '5 → 4；3 已不存在故丢弃；1 不受影响');
});

test('shiftAfterInsert：插入点及其后行号后移一位', () => {
  const t = new BadLineTracker();
  t.addMany([1, 3, 5]);
  t.shiftAfterInsert(3);
  assert.deepEqual(t.toSortedArray(), [1, 4, 6], '3→4、5→6；插入点之前的 1 不动');

  const atZero = new BadLineTracker();
  atZero.addMany([0, 2]);
  atZero.shiftAfterInsert(0);
  assert.deepEqual(atZero.toSortedArray(), [1, 3], '在第 0 行前插入 → 全部后移');
});

test('remapAfterDeletes：按被删集合重映射（含边界与空集合早返回）', () => {
  const t = new BadLineTracker();
  t.addMany([2, 4, 6, 8]);
  t.remapAfterDeletes(new Set([1, 4, 7]));
  assert.deepEqual(t.toSortedArray(), [1, 4, 5], '各行减去「自己之前被删的行数」；被删的 4 丢弃');

  const empty = new BadLineTracker();
  empty.addMany([1, 2]);
  empty.remapAfterDeletes(new Set());
  assert.deepEqual(empty.toSortedArray(), [1, 2], '没有删除时保持原样');
});

test('remapAfterDeletes 与逐次 shiftAfterDelete 结果一致（同语义的两种实现）', () => {
  const removed = [1, 4, 7, 8];
  const bulk = new BadLineTracker();
  bulk.addMany([2, 4, 6, 8, 9]);
  bulk.remapAfterDeletes(new Set(removed));

  // 逐次删除必须**倒序**（先删大行号，否则小行号的下标会漂移）
  const oneByOne = new BadLineTracker();
  oneByOne.addMany([2, 4, 6, 8, 9]);
  for (const line of [...removed].toSorted((a, b) => b - a)) oneByOne.shiftAfterDelete(line);

  assert.deepEqual(
    bulk.toSortedArray(),
    oneByOne.toSortedArray(),
    '批量重映射不得与逐次位移产生分歧'
  );
});
