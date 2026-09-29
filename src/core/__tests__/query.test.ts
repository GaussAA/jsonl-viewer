/**
 * query.test.ts — 字段过滤求值 + **命中区间**（高亮的单一来源）。
 *
 * findRanges 放在 core 的理由：宿主搜索（searchEngine 的 Buffer 折叠）与前端高亮必须
 * 用同一套匹配语义，否则会出现「搜索说命中、高亮标不出来」这类自相矛盾的界面。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRanges, matchesFilter, recordFieldValue, ARRAY_RECORD_KEY } from '../query.ts';

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
