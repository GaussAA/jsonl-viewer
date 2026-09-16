import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFetchWindow,
  formatValue,
  LRUCache,
  summarizeRecord,
  ThrottleQueue,
  VirtualListLayout,
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
  assert.equal(computeFetchWindow(5, 5, () => false), null);
  assert.equal(computeFetchWindow(8, 3, () => false), null);
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

/* --------------------- 虚拟列表位置数学 --------------------- */

function invariant(L: VirtualListLayout, scrollTop: number): void {
  const i = L.findStartIndex(scrollTop);
  assert.ok(L.getItemOffset(i) <= scrollTop + 1, `offset(i)<=scrollTop (i=${i}, scrollTop=${scrollTop})`);
  assert.ok(
    i === 0 || L.getItemOffset(i - 1) <= scrollTop,
    `previous row starts at or before scrollTop (i-1=${i - 1})`
  );
}

test('VirtualListLayout: 默认等高下累计偏移与 scrollTop->line', () => {
  const L = new VirtualListLayout(50);
  assert.equal(L.getItemOffset(0), 0);
  assert.equal(L.getItemOffset(1), 50);
  assert.equal(L.getItemOffset(2), 100);
  assert.equal(L.findStartIndex(0), 0);
  assert.equal(L.findStartIndex(25), 0);
  assert.equal(L.findStartIndex(50), 1);
  assert.equal(L.findStartIndex(120), 2);
});

test('VirtualListLayout: 可变行高由实测覆盖并作废后续偏移', () => {
  const L = new VirtualListLayout(50);
  L.setSize(0, 20);
  L.setSize(1, 30);
  // 偏移基于实测 + 默认补齐
  assert.equal(L.getItemOffset(0), 0);
  assert.equal(L.getItemOffset(1), 20);
  assert.equal(L.getItemOffset(2), 50); // 20+30
  assert.equal(L.totalSize(3), 50 + 50); // 最后一行(2) 用默认 50
  assert.equal(L.findStartIndex(30), 1); // 偏移 0,20,50 -> 30 落于行1
  assert.equal(L.findStartIndex(20), 1);
  assert.equal(L.findStartIndex(19), 0);
  invariant(L, 30);
});

test('VirtualListLayout: 修改高度后反向修正（setSize 使后续偏移重算）', () => {
  const L = new VirtualListLayout(40);
  L.setSize(0, 100); // 行 0 变高
  L.getItemOffset(1); // 100
  L.setSize(0, 40); // 改回
  assert.equal(L.getItemOffset(1), 40); // 作废后重算
  assert.equal(L.getItemOffset(2), 80);
});

test('VirtualListLayout: 可视区裁剪（默认 overscan 参与）', () => {
  const L = new VirtualListLayout(50);
  // 视口 120px、overscan 2
  const { first, lastExclusive } = L.getVisibleRange(0, 120, 2);
  assert.equal(first, 0);
  assert.ok(lastExclusive >= 2); // 至少盖住可视（行0,1,2）
  // lastExclusive 为 5（0..3 扫描 + overscan2）
});

test('VirtualListLayout: scrollTop<->line 双向映射一致性', () => {
  const L = new VirtualListLayout(47);
  // 不规则高度
  L.setSize(3, 90);
  L.setSize(7, 12);
  for (const off of [0, 47, 100, 200, 47 * 5 + 40]) {
    invariant(L, off);
    const line = L.findStartIndex(off);
    const start = L.getItemOffset(line);
    assert.ok(start <= off);
  }
});

test('VirtualListLayout: totalSize 返回整列表末行结束偏移', () => {
  const L = new VirtualListLayout(30);
  assert.equal(L.totalSize(0), 0);
  L.setSize(0, 60);
  assert.equal(L.totalSize(1), 60);
  L.setSize(2, 10);
  assert.equal(L.totalSize(4), 60 + 30 + 10 + 30);
});

/* --------------------- 摘要 / 格式化 --------------------- */

test('summarizeRecord: 优先使用字段推断，缺少时回退顶层 key', () => {
  const rec = { name: 'alice', age: 30, tags: ['a', 'b'], note: 'x' };
  const byFields = summarizeRecord(rec, [
    { key: 'age', type: 'number' },
    { key: 'name', type: 'string' },
  ]);
  // 先取字段推断的 age/name，再用顶层 key 补齐到上限
  assert.deepEqual(byFields.map((x) => x.key), ['age', 'name', 'tags', 'note']);
  const fallback = summarizeRecord(rec, null);
  assert.equal(fallback.length, 4); // 顶层 4 个 key
  assert.deepEqual(
    fallback.map((x) => x.key).sort(),
    ['age', 'name', 'note', 'tags']
  );
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