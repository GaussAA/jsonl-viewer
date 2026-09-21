import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFetchWindow,
  formatValue,
  LRUCache,
  segmentSortedLines,
  summarizeRecord,
  ThrottleQueue,
} from '../logic.ts';

const tick = () => new Promise<void>((res) => setImmediate(res));

/* ------------------------------ LRU ------------------------------ */

test('LRU: 容量上限 + 命中提升 recency + 正确逐出', () => {
  const c = new LRUCache<string, number>(3);
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  assert.equal(c.size, 3);
  // 命中 'a' 提升其 recency
  assert.equal(c.get('a'), 1);
  // 写入 'd' -> 最久未用的 'b' 被逐出（a 刚被命中过）
  c.set('d', 4);
  assert.equal(c.has('b'), false);
  assert.equal(c.has('a'), true);
  assert.equal(c.has('c'), true);
  assert.equal(c.has('d'), true);
  assert.equal(c.size, 3);
});

test('LRU: 覆盖已有键不改变 recency 顺序且不超容量', () => {
  const c = new LRUCache<string, number>(2);
  c.set('a', 1);
  c.set('b', 2);
  c.set('a', 10); // 覆盖 a，a 仍保留（size 不超）
  assert.equal(c.size, 2);
  // 再写 'c' -> 逐出 'b'
  c.set('c', 3);
  assert.equal(c.has('b'), false);
  assert.equal(c.get('a'), 10);
  assert.equal(c.has('c'), true);
});

/* --------------------------- fetch 窗口 --------------------------- */

test('computeFetchWindow: 全部已缓存 -> null（不重复请求）', () => {
  const win = computeFetchWindow(0, 5, (l) => l >= 0 && l < 5);
  assert.equal(win, null);
});

test('computeFetchWindow: 全部缺失 -> 请求整个窗口', () => {
  const win = computeFetchWindow(10, 20, () => false);
  assert.deepEqual(win, { start: 10, count: 10 });
});

test('computeFetchWindow: 两端已缓存 -> 只请求中间缺失段', () => {
  const loaded = new Set([0, 1, 2, 7, 8, 9]);
  const win = computeFetchWindow(0, 10, (l) => loaded.has(l));
  assert.deepEqual(win, { start: 3, count: 4 }); // 行 3..6
});

test('computeFetchWindow: 中间一块已缓存 -> 请求左右两段（连续缺失取最大区间）', () => {
  // 缺失呈两段；本实现取「连续缺失」的窗口 = 起点到终点去掉两端连续已缓存
  const loaded = new Set([0, 1, 5, 6, 9]);
  const win = computeFetchWindow(0, 10, (l) => loaded.has(l));
  // 去掉左端已缓存 0,1 与右端已缓存 9 -> 请求 2..8
  assert.deepEqual(win, { start: 2, count: 7 });
});

test('computeFetchWindow: wantEnd<=wantStart -> null', () => {
  assert.equal(
    computeFetchWindow(5, 5, () => false),
    null
  );
  assert.equal(
    computeFetchWindow(8, 3, () => false),
    null
  );
});

test('segmentSortedLines: 连续命中 -> 单个连续段', () => {
  const map = [100, 101, 102, 103];
  assert.deepEqual(segmentSortedLines(map, 0, 4), [{ first: 100, lastExclusive: 104 }]);
});

test('segmentSortedLines: 稀疏命中 -> 按相邻性分段', () => {
  const map = [100, 5000000, 5000001, 9000000];
  assert.deepEqual(segmentSortedLines(map, 0, 4), [
    { first: 100, lastExclusive: 101 },
    { first: 5000000, lastExclusive: 5000002 },
    { first: 9000000, lastExclusive: 9000001 },
  ]);
});

test('segmentSortedLines: 只取 [start,end) 子范围', () => {
  const map = [10, 11, 100, 101, 102, 500];
  assert.deepEqual(segmentSortedLines(map, 2, 5), [{ first: 100, lastExclusive: 103 }]);
});

test('segmentSortedLines: 边界防御（空/越界）', () => {
  assert.deepEqual(segmentSortedLines([], 0, 0), []);
  assert.deepEqual(segmentSortedLines([5, 6], 1, 1), []);
  assert.deepEqual(segmentSortedLines([5, 6], -1, 1), []);
  assert.deepEqual(segmentSortedLines([5, 6], 0, 3), []);
});

/* ----------------------- 节流 + 合并调度 ----------------------- */

test('ThrottleQueue: 同窗口多次 push 只执行一次（取最新）', async () => {
  const calls: string[] = [];
  const q = new ThrottleQueue<string>(0, (v) => {
    calls.push(v);
  });
  q.push('a');
  q.push('b');
  q.push('c');
  q.flushNow();
  await tick();
  assert.deepEqual(calls, ['c']); // 早期 a/b 被合并跳过
  q.dispose();
});

test('ThrottleQueue: 执行期间新值只作为尾随一次处理，不并行', async () => {
  const calls: string[] = [];
  const gates: Array<() => void> = [];
  const q = new ThrottleQueue<string>(0, async (v) => {
    calls.push(v);
    await new Promise<void>((res) => gates.push(res));
  });
  q.push('a');
  q.flushNow();
  assert.deepEqual(calls, ['a']); // 第一个 worker 已开始
  q.push('b');
  q.push('c'); // 执行中 -> 只合并为最新 'c'
  gates[0]!();
  await tick(); // drain 续跑，会取 latest='c'
  assert.deepEqual(calls, ['a', 'c']); // 'b' 被跳过
  gates[1]?.();
  await tick();
  q.dispose();
});

/* --------------------- 缺失拉取窗口 --------------------- */

test('summarizeRecord: 优先使用字段推断，缺少时回退顶层 key', () => {
  const rec = { name: 'alice', age: 30, tags: ['a', 'b'], note: 'x' };
  const byFields = summarizeRecord(rec, [
    { key: 'age', type: 'number' },
    { key: 'name', type: 'string' },
  ]);
  // 先取字段推断的 age/name，再用顶层 key 补齐到上限
  assert.deepEqual(
    byFields.map((x) => x.key),
    ['age', 'name', 'tags', 'note']
  );
  const fallback = summarizeRecord(rec, null);
  assert.equal(fallback.length, 4); // 顶层 4 个 key
  assert.deepEqual(fallback.map((x) => x.key).sort(), ['age', 'name', 'note', 'tags']);
});

test('summarizeRecord: 非对象值 / 标量直接展示', () => {
  assert.deepEqual(summarizeRecord('hi', null), [{ key: '', display: 'hi' }]);
  assert.deepEqual(summarizeRecord(42, null), [{ key: '', display: '42' }]);
  assert.deepEqual(summarizeRecord(null, null), [{ key: '', display: 'null' }]);
});

test('formatValue: 对象/数组/长字符串折叠展示', () => {
  assert.equal(formatValue({ a: 1, b: 2 }), '{…} (2 fields)');
  assert.equal(formatValue([1, 2, 3]), '[…] (3 items)');
  assert.equal(formatValue([]), '[…] (0 items)');
  assert.equal(formatValue('a'.repeat(200)).length <= 130, true);
  assert.equal(formatValue(true), 'true');
});
