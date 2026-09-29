/**
 * query.test.ts — 字段过滤求值 + **命中区间**（高亮的单一来源）。
 *
 * findRanges 放在 core 的理由：宿主搜索（searchEngine 的 Buffer 折叠）与前端高亮必须
 * 用同一套匹配语义，否则会出现「搜索说命中、高亮标不出来」这类自相矛盾的界面。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findRanges,
  matchesFilter,
  matchesCondition,
  hasAnyRealCondition,
  normalizeCondition,
  conditionSummary,
  isConditionGroup,
  recordFieldValue,
  ARRAY_RECORD_KEY,
} from '../query.ts';
import type { Condition } from '../query.ts';

/* ------------------------------ findRanges ------------------------------ */

test('findRanges：找出全部非重叠命中（左到右）', () => {
  assert.deepEqual(findRanges('aXbXc', 'X'), [
    [1, 2],
    [3, 4],
  ]);
  // 非重叠：「aa」在「aaaa」里只有 2 处（不是 3 处）
  assert.deepEqual(findRanges('aaaa', 'aa'), [
    [0, 2],
    [2, 4],
  ]);
});

test('findRanges：大小写不敏感只折 ASCII，且区间对应原文', () => {
  const text = 'Hello HELLO hill';
  const ranges = findRanges(text, 'hello');
  assert.equal(ranges.length, 2);
  // 区间必须能原样切回原文（长度不变，故索引一一对应）
  assert.equal(text.slice(ranges[0][0], ranges[0][1]), 'Hello');
  assert.equal(text.slice(ranges[1][0], ranges[1][1]), 'HELLO');
});

test('findRanges：大小写敏感模式不折 ASCII', () => {
  assert.equal(findRanges('Hello hello', 'Hello', false).length, 1);
});

test('findRanges：空 needle 返回空（空串会匹配每个位置，必须拒绝）', () => {
  assert.deepEqual(findRanges('abc', ''), []);
});

test('findRanges：中文与多字节文本的区间按 UTF-16 下标，可精确切回', () => {
  const text = '{"错误":"超时"}';
  const ranges = findRanges(text, '超时');
  assert.equal(ranges.length, 1);
  assert.equal(text.slice(ranges[0][0], ranges[0][1]), '超时');
});

test('findRanges：未命中返回空数组', () => {
  assert.deepEqual(findRanges('abc', 'zzz'), []);
});

/* --------------------- 既有求值逻辑的守门（改动不得破坏） --------------------- */

test('matchesFilter / recordFieldValue：基本语义不变', () => {
  assert.equal(matchesFilter('hello', { field: 'x', op: 'contains', value: 'ELL' }), true);
  assert.equal(matchesFilter(undefined, { field: 'x', op: 'exists', value: '' }), false);
  assert.deepEqual(recordFieldValue([1, 2], ARRAY_RECORD_KEY), [1, 2]);
});

/* --------------------- 组合条件匹配（F3：AND / OR / NOT） --------------------- */

const rec = { level: 'error', msg: 'request timeout', retries: 0, ok: false };

test('matchesCondition：and 需全部满足，or 只需一个', () => {
  const and: Condition = {
    kind: 'and',
    items: [
      { field: 'level', op: 'eq', value: 'error' },
      { field: 'msg', op: 'contains', value: 'timeout' },
    ],
  };
  assert.equal(matchesCondition(rec, and), true);

  // 同一组里再加一条不满足的 → and 整体为假
  assert.equal(
    matchesCondition(rec, {
      kind: 'and',
      items: [...and.items, { field: 'ok', op: 'eq', value: 'true' }],
    }),
    false
  );
  // or：只要有一条满足即为真
  assert.equal(
    matchesCondition(rec, {
      kind: 'or',
      items: [{ field: 'ok', op: 'eq', value: 'true' }, ...and.items],
    }),
    true
  );
});

test('matchesCondition：not 的语义是「全都不满足」（与 ES must_not 一致）', () => {
  assert.equal(
    matchesCondition(rec, { kind: 'not', items: [{ field: 'level', op: 'eq', value: 'warn' }] }),
    true
  );
  assert.equal(
    matchesCondition(rec, {
      kind: 'not',
      items: [
        { field: 'level', op: 'eq', value: 'warn' },
        { field: 'msg', op: 'contains', value: 'timeout' },
      ],
    }),
    false,
    '只要有一项满足，not 整体即为假'
  );
});

test('matchesCondition：空组的量词语义（空 and 真 / 空 or 假；空 not 真）', () => {
  assert.equal(matchesCondition(rec, { kind: 'and', items: [] }), true);
  assert.equal(matchesCondition(rec, { kind: 'or', items: [] }), false);
  assert.equal(matchesCondition(rec, { kind: 'not', items: [] }), true);
});

test('matchesCondition：空叶子视为不约束（加了一行还没填完不该清空结果集）', () => {
  assert.equal(matchesCondition(rec, { field: '', op: 'eq', value: 'x' }), true);
  assert.equal(matchesCondition(rec, null), true);
  assert.equal(
    matchesCondition(rec, {
      kind: 'and',
      items: [
        { field: 'level', op: 'eq', value: 'error' },
        { field: '', op: 'eq', value: '' },
      ],
    }),
    true,
    '组里的空叶子不该把整组判假'
  );
});

test('matchesCondition：叶子的 negate 与组的否定各自独立生效', () => {
  const inner: Condition = { field: 'level', op: 'eq', value: 'error' };
  assert.equal(matchesCondition(rec, inner), true);
  assert.equal(
    matchesCondition(rec, { field: 'level', op: 'eq', value: 'error', negate: true }),
    false
  );
  // not(非(命中)) → not(不命中) → 命中：两处否定都各自参与求值，谁也没被忽略。
  assert.equal(
    matchesCondition(rec, { kind: 'not', items: [{ ...inner, negate: true } as never] }),
    true
  );
});

test('hasAnyRealCondition：只看树里有没有「填过」的叶子', () => {
  assert.equal(hasAnyRealCondition(null), false);
  assert.equal(hasAnyRealCondition({ field: '', op: 'eq', value: 'x' }), false);
  assert.equal(hasAnyRealCondition({ kind: 'and', items: [] }), false);
  assert.equal(
    hasAnyRealCondition({ kind: 'or', items: [{ field: '', op: 'eq', value: '' }] }),
    false
  );
  assert.equal(
    hasAnyRealCondition({
      kind: 'and',
      items: [
        { field: '', op: 'eq', value: '' },
        { field: 'a', op: 'exists', value: '' },
      ],
    }),
    true,
    '只要有一个真条件就算启用了过滤'
  );
});

test('normalizeCondition：丢弃非法节点，保留可用部分', () => {
  assert.equal(normalizeCondition(null), null);
  assert.equal(normalizeCondition('不是对象'), null);
  assert.equal(normalizeCondition({ field: 'a', op: '不存在', value: 'x' }), null);
  assert.equal(normalizeCondition({ kind: 'xor', items: [] }), null);

  const norm = normalizeCondition({
    kind: 'and',
    items: [
      { field: 'a', op: 'eq', value: '1' },
      { field: 'b', op: 'bogus', value: '2' },
      { kind: 'or', items: [{ field: 'c', op: 'exists', value: '' }] },
      null,
    ],
  });
  assert.deepEqual(norm, {
    kind: 'and',
    items: [
      { field: 'a', op: 'eq', value: '1', negate: false, caseInsensitive: true },
      {
        kind: 'or',
        items: [{ field: 'c', op: 'exists', value: '', negate: false, caseInsensitive: true }],
      },
    ],
  });
});

test('normalizeCondition：items 非数组时按空组处理（不抛错）', () => {
  assert.deepEqual(normalizeCondition({ kind: 'and', items: 'nope' }), { kind: 'and', items: [] });
});

test('normalizeCondition：超过深度上限的分支被丢弃（防损坏数据造成深递归）', () => {
  let deep: unknown = { field: 'a', op: 'eq', value: '1' };
  for (let i = 0; i < 20; i++) deep = { kind: 'and', items: [deep] };
  const norm = normalizeCondition(deep);
  // 逐层走到上限后，更深的分支被丢掉 —— 不应抛错，也不应无限嵌套。
  let depth = 0;
  let cur: Condition | null = norm;
  while (cur && isConditionGroup(cur)) {
    depth++;
    cur = cur.items[0] ?? null;
  }
  assert.ok(depth <= 9, `嵌套深度应被截断，实得 ${depth}`);
});

test('isConditionGroup：按 kind 判别组与叶子', () => {
  assert.equal(isConditionGroup({ kind: 'and', items: [] }), true);
  assert.equal(isConditionGroup({ field: 'a', op: 'eq', value: '1' }), false);
});

test('conditionSummary：中文连接词摘要（面板关闭后还能对上自己设了什么）', () => {
  assert.equal(conditionSummary(null), '');
  assert.equal(conditionSummary({ field: 'level', op: 'eq', value: 'error' }), 'level 等于 error');
  assert.equal(
    conditionSummary({ field: 'a', op: 'exists', value: '', negate: true }),
    '非 存在 a'
  );
  assert.equal(
    conditionSummary({
      kind: 'and',
      items: [
        { field: 'level', op: 'eq', value: 'error' },
        { field: 'msg', op: 'contains', value: 'timeout' },
      ],
    }),
    '(level 等于 error 且 msg 含 timeout)'
  );
  assert.equal(
    conditionSummary({ kind: 'or', items: [{ field: 'a', op: 'eq', value: '1' }] }),
    'a 等于 1',
    '单项的组退化为该项本身'
  );
});
