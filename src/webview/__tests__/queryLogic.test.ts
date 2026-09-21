import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultFieldLayout,
  fieldTypeOf,
  matchesFilter,
  mergePersistedState,
  nextMatchIndex,
  normalizeFieldLayout,
  prevMatchIndex,
  rawLineMatches,
  recordFieldValue,
  stringifyValue,
  summarizeWithLayout,
  toPersistedState,
  visibleFieldKeys,
} from '../queryLogic.ts';

/* ------------------------- 搜索匹配规则 ------------------------- */

test('rawLineMatches: 大小写不敏感默认开，忽略空查询', () => {
  assert.equal(rawLineMatches('Hello World', 'world'), true);
  assert.equal(rawLineMatches('Hello World', 'WORLD'), true);
  assert.equal(rawLineMatches('hello', 'world'), false);
  assert.equal(rawLineMatches('Hello', '', true), false);
  assert.equal(rawLineMatches('Hello', 'hello', false), false); // 大小写敏感
  assert.equal(rawLineMatches('Hello', 'Hello', false), true);
});

test('matchesFilter: 包含 / 等于 / 存在 / 类型 + 取反', () => {
  assert.equal(matchesFilter('hello world', { field: 'b', op: 'contains', value: 'world' }), true);
  assert.equal(matchesFilter('hello world', { field: 'b', op: 'contains', value: 'xyz' }), false);
  assert.equal(matchesFilter(42, { field: 'a', op: 'eq', value: '42' }), true); // 数值按字符串比
  assert.equal(matchesFilter(42, { field: 'a', op: 'eq', value: '43' }), false);
  assert.equal(matchesFilter(null, { field: 'a', op: 'exists', value: '' }), false);
  assert.equal(matchesFilter(undefined, { field: 'a', op: 'exists', value: '' }), false);
  assert.equal(matchesFilter(0, { field: 'a', op: 'exists', value: '' }), true);
  assert.equal(matchesFilter('x', { field: 'a', op: 'type', value: 'string' }), true);
  assert.equal(matchesFilter(1, { field: 'a', op: 'type', value: 'string' }), false);
  assert.equal(matchesFilter('x', { field: 'a', op: 'contains', value: 'x', negate: true }), false);
  // 空值包含 → 恒真（作为“任意值”）
  assert.equal(matchesFilter('anything', { field: 'a', op: 'contains', value: '' }), true);
});

test('fieldTypeOf / stringifyValue / recordFieldValue', () => {
  assert.equal(fieldTypeOf({}), 'object');
  assert.equal(fieldTypeOf([]), 'array');
  assert.equal(fieldTypeOf(null), 'null');
  assert.equal(fieldTypeOf('s'), 'string');
  assert.equal(stringifyValue(null), 'null');
  assert.equal(stringifyValue(undefined), '');
  assert.equal(stringifyValue({ a: 1 }), '{"a":1}');
  const rec = { name: 'alice', arr: [1, 2] };
  assert.equal(recordFieldValue(rec, 'name'), 'alice');
  assert.equal(recordFieldValue(rec, 'missing'), undefined);
  assert.deepEqual(recordFieldValue(rec, 'arr'), [1, 2]);
  const arrRec = [1, 2, 3];
  assert.equal(recordFieldValue(arrRec, '$array'), arrRec);
  assert.equal(recordFieldValue(5, '$value'), 5); // 标量记录
});

/* ---------------- 字段定制：布局 + 对 summarize 的映射 ---------------- */

const FIELDS = [
  { key: 'id', type: 'number' },
  { key: 'name', type: 'string' },
  { key: 'age', type: 'number' },
  { key: 'secret', type: 'string' },
];

test('defaultFieldLayout: 全可见、按推断顺序', () => {
  const l = defaultFieldLayout(FIELDS);
  assert.deepEqual(l.order, ['id', 'name', 'age', 'secret']);
  assert.deepEqual(l.pinned, []);
  assert.deepEqual(l.hidden, []);
  assert.equal(l.maxKeys, 4);
});

test('normalizeFieldLayout: 裁剪脏数据 / 去重 / hidden 优先', () => {
  const known = new Set(FIELDS.map((f) => f.key));
  const l = normalizeFieldLayout(
    {
      pinned: ['id', 'id'],
      order: ['missing', 'name', 'secret'],
      hidden: ['secret'],
      maxKeys: 99,
      bogus: true,
    },
    known
  );
  assert.deepEqual(l.pinned, ['id']);
  assert.deepEqual(l.order, ['name']); // missing 被剔除，secret 因 hidden 剔除
  assert.deepEqual(l.hidden, ['secret']);
  assert.equal(l.maxKeys, 20); // 上限归位
  // 非对象 / 非法输入回退默认
  const d = normalizeFieldLayout('nope', known);
  assert.deepEqual(d.order, []);
});

test('visibleFieldKeys: pinned 优先 -> order，隐藏剔除，截断到 maxKeys', () => {
  const layout = {
    pinned: ['age'],
    order: ['name', 'id', 'secret'] as string[],
    hidden: ['secret'],
    maxKeys: 2,
  };
  assert.deepEqual(visibleFieldKeys(FIELDS, layout), ['age', 'name']);
});

test('summarizeWithLayout: 定制驱动摘要卡片（顺序 + 隐藏 + 上限 + 缺失回退）', () => {
  const rec = { id: 1, name: 'alice', age: 30, secret: 'x', extra: true };
  const layout = { pinned: ['id'], order: ['age', 'name'], hidden: ['secret'], maxKeys: 3 };
  const out = summarizeWithLayout(rec, FIELDS, layout);
  assert.deepEqual(
    out.map((x) => [x.key, x.display]),
    [
      ['id', '1'],
      ['age', '30'],
      ['name', 'alice'],
    ]
  );
  // 无可用定制字段时回退顶层 key
  const emptyLayout = defaultFieldLayout(null);
  emptyLayout.order = [];
  emptyLayout.hidden = [];
  emptyLayout.maxKeys = 20;
  const fallback = summarizeWithLayout(rec, FIELDS, emptyLayout);
  assert.deepEqual(fallback.map((x) => x.key).toSorted(), ['age', 'extra', 'id', 'name', 'secret']);
});

/* ------------------------- 搜索导航 ------------------------- */

test('nextMatchIndex / prevMatchIndex 循环', () => {
  const m = [10, 20, 30];
  assert.equal(nextMatchIndex(m, 10), 1);
  assert.equal(nextMatchIndex(m, 30), 0); // 末尾回到开头
  assert.equal(nextMatchIndex(m, -1), 0);
  assert.equal(prevMatchIndex(m, 30), 1);
  assert.equal(prevMatchIndex(m, 10), 2); // 开头回到末尾
  assert.equal(nextMatchIndex([], 1), -1);
});

/* -------------------- 偏好持久化：合并 + 校验 -------------------- */

test('toPersistedState: 序列化当前偏好', () => {
  const p = toPersistedState({
    fieldLayout: { pinned: [], order: ['a'], hidden: [], maxKeys: 4 },
    filter: null,
  });
  assert.deepEqual(p, {
    fieldLayout: { pinned: [], order: ['a'], hidden: [], maxKeys: 4 },
    filter: null,
  });
});

test('mergePersistedState: 仅接受合法布局与过滤，非法丢弃', () => {
  const known = new Set(['a', 'b']);
  const current = { fieldLayout: defaultFieldLayout(FIELDS), filter: null };
  const merged = mergePersistedState(
    {
      fieldLayout: { pinned: ['a'], order: ['b', 'ghost'], hidden: ['b'], maxKeys: 9 },
      filter: { field: 'a', op: 'contains', value: 'x', caseInsensitive: true },
      searchQuery: 'hello',
    },
    current,
    known
  );
  assert.deepEqual(merged.fieldLayout, { pinned: ['a'], order: [], hidden: ['b'], maxKeys: 9 });
  assert.deepEqual(merged.filter, {
    field: 'a',
    op: 'contains',
    value: 'x',
    negate: false,
    caseInsensitive: true,
  });
  assert.equal(merged.searchQuery, 'hello');

  // 非法 filter 丢弃
  const bad = mergePersistedState({ filter: { field: 'a', op: 'regex' } }, current, known);
  assert.equal(bad.filter, null);
  // 无法解析的 saved 直接返回当前
  const none = mergePersistedState('garbage', current, known);
  assert.deepEqual(none.fieldLayout, current.fieldLayout);
  assert.equal(none.filter, current.filter);
});
