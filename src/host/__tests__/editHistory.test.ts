/**
 * editHistory.test.ts — 会话编辑历史状态机单测。
 *
 * 从 dataService 迁出后，这些规则无需构造临时文件即可直接验证：
 * 入栈 / 单一光标 / 新操作截断重做分支 / 回退期间不入栈 / 双上限裁剪 / dropped 标记。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditHistory, historyLabel } from '../editHistory.ts';
import { MAX_HISTORY_BYTES, MAX_HISTORY_ENTRIES } from '../../constants.ts';

const edit = (line: number, before: string, after: string) =>
  ({ kind: 'edit', line, before, after }) as const;

test('push：入栈并推进光标；快照不含回退数据', () => {
  const h = new EditHistory();
  h.push(edit(0, '{"a":1}', '{"a":2}'), 0);
  h.push(edit(1, '{"b":1}', '{"b":2}'), 0);

  assert.equal(h.total, 2);
  assert.equal(h.cursorPos, 2, '两条都已应用');

  const snap = h.snapshot();
  assert.equal(snap.entries.length, 2);
  assert.equal(snap.cursor, 2);
  assert.equal(snap.dropped, false);
  // 对外视图只暴露展示字段，回退数据（before/after）留在宿主内部
  assert.equal('op' in snap.entries[0], false);
  assert.deepEqual(Object.keys(snap.entries[0]).toSorted(), [
    'at',
    'bytesDelta',
    'id',
    'kind',
    'label',
    'lines',
  ]);
});

test('新操作截断「已撤销」的重做分支（标准撤销栈语义）', () => {
  const h = new EditHistory();
  h.push(edit(0, 'a', 'b'), 0);
  h.push(edit(1, 'c', 'd'), 0);
  h.stepBack(); // 撤销第二条
  assert.equal(h.cursorPos, 1);

  h.push(edit(2, 'e', 'f'), 0); // 在已撤销状态下做新操作
  assert.equal(h.total, 2, '旧的重做分支作废');
  assert.equal(h.cursorPos, 2);
  assert.equal(h.snapshot().entries[1].label, historyLabel(edit(2, 'e', 'f')).label);
});

test('回退执行期间（applying）不入栈 —— 否则撤销会生成新记录', () => {
  const h = new EditHistory();
  h.push(edit(0, 'a', 'b'), 0);
  h.applying = true;
  h.push(edit(1, 'c', 'd'), 0);
  assert.equal(h.total, 1, '回退期间的写操作不入栈');
  h.applying = false;
  h.push(edit(1, 'c', 'd'), 0);
  assert.equal(h.total, 2, '恢复正常后照常入栈');
});

test('条数上限：超出即从最旧一端丢弃，并标记 dropped', () => {
  const h = new EditHistory();
  for (let i = 0; i < MAX_HISTORY_ENTRIES + 5; i++) h.push(edit(i, 'a', 'b'), 0);

  assert.equal(h.total, MAX_HISTORY_ENTRIES, '条数封顶');
  assert.equal(h.snapshot().dropped, true, '丢弃必须如实标记');
  assert.equal(h.cursorPos, MAX_HISTORY_ENTRIES, '光标随裁剪同步');
});

test('体积上限：巨型操作触发裁剪，但至少保留一条（否则刚做的事无法撤销）', () => {
  const h = new EditHistory();
  const huge = 'x'.repeat(MAX_HISTORY_BYTES);
  h.push(edit(0, huge, huge), 0);
  assert.equal(h.total, 1, '单条即便超限也必须保留');

  h.push(edit(1, huge, huge), 0);
  assert.equal(h.total, 1, '第二条进来才把最旧的挤掉');
  assert.equal(h.snapshot().dropped, true);
});

test('光标移动与定位：prevEntry / entryAt / indexOfId / clear', () => {
  const h = new EditHistory();
  h.push(edit(0, 'a', 'b'), 0);
  h.push(edit(1, 'c', 'd'), 0);

  const id = h.snapshot().entries[0].id;
  assert.equal(h.indexOfId(id), 0);
  assert.equal(h.indexOfId('不存在'), -1);

  assert.equal(h.prevEntry()?.label, '编辑第 2 行', '光标前一条 = 下一步要撤销的');
  h.stepBack();
  assert.equal(h.cursorPos, 1);
  assert.equal(h.entryAt(1)?.label, '编辑第 2 行', '光标处 = 下一步要重做的');
  h.stepForward();
  assert.equal(h.cursorPos, 2);

  // 边界：光标已在两端时移动不越界
  h.stepForward();
  assert.equal(h.cursorPos, 2, '末尾之后再前进无效');
  h.stepBack();
  h.stepBack();
  h.stepBack();
  assert.equal(h.cursorPos, 0, '开头之后再后退无效');

  h.clear();
  assert.equal(h.total, 0);
  assert.equal(h.cursorPos, 0);
  assert.equal(h.snapshot().dropped, false);
});

test('historyLabel：各操作类型的描述与行数', () => {
  assert.equal(historyLabel(edit(2, 'a', 'b')).label, '编辑第 3 行');
  assert.equal(historyLabel({ kind: 'insert', line: 0, text: 'x' }).lines, 1);
  assert.equal(
    historyLabel({
      kind: 'deleteMany',
      ranges: [{ start: 0, end: 1, content: 'a', lines: [0, 1, 2], lineBytes: [1, 1, 1] }],
    }).lines,
    3
  );
  assert.equal(
    historyLabel({ kind: 'replaceAll', changes: [{ line: 0, before: 'a', after: 'b' }] }).label,
    '替换 1 行'
  );
});
