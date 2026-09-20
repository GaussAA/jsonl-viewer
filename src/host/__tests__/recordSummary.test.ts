/**
 * recordSummary.test.ts — 阶段三「有界摘要 / 超大行浅扫描」纯函数单测。
 *
 * 覆盖 makeSummary（已解析值）与 summarizeRawLine（未解析超大行）：类型判定、
 * 顶层条目数计数、空容器、嵌套不计入顶层、预览截断。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  jsonCountOf,
  jsonKindOf,
  makeSummary,
  summarizeRawLine,
} from '../recordSummary.ts';

/* ---------------- makeSummary ---------------- */

test('makeSummary：对象取前 N 个顶层 key', () => {
  const s = makeSummary({ id: 1, name: 'a', tag: 'x', extra: 9, more: 0 });
  assert.equal(s.length, 4); // 默认最多 4
  assert.deepEqual(
    s.map((f) => f.key),
    ['id', 'name', 'tag', 'extra']
  );
  assert.equal(s[0].display, '1');
  assert.equal(s[1].display, 'a');
});

test('makeSummary：标量直接折叠展示', () => {
  assert.deepEqual(makeSummary('hello'), [{ key: '', display: 'hello' }]);
  assert.deepEqual(makeSummary(42), [{ key: '', display: '42' }]);
  assert.deepEqual(makeSummary(true), [{ key: '', display: 'true' }]);
  assert.deepEqual(makeSummary(null), [{ key: '', display: 'null' }]);
});

test('makeSummary：数组折叠为 [item] 预览', () => {
  const s = makeSummary([1, 2, 3]);
  assert.equal(s.length, 1);
  assert.equal(s[0].display, '[…] (3 items)');
});

test('makeSummary：空对象 / 超长字符串省略', () => {
  assert.deepEqual(makeSummary({}), [{ key: '', display: '{}' }]);
  const long = 'x'.repeat(500);
  const s = makeSummary({ v: long });
  assert.ok(s[0].display.endsWith('…'), `display=${s[0].display}`);
  assert.ok(s[0].display.length <= 121); // 120 + '…'
});

/* ---------------- jsonKindOf / jsonCountOf ---------------- */

test('jsonKindOf / jsonCountOf：类型与顶层条目数', () => {
  assert.equal(jsonKindOf({ a: 1 }), 'object');
  assert.equal(jsonKindOf([1, 2]), 'array');
  assert.equal(jsonKindOf('s'), 'string');
  assert.equal(jsonKindOf(3), 'number');
  assert.equal(jsonKindOf(false), 'boolean');
  assert.equal(jsonKindOf(null), 'null');
  assert.equal(jsonCountOf({ a: 1, b: 2 }), 2);
  assert.equal(jsonCountOf([1, 2, 3, 4]), 4);
  assert.equal(jsonCountOf('s'), 0);
  assert.equal(jsonCountOf(3), 0);
});

/* ---------------- summarizeRawLine（不 JSON.parse） ---------------- */

test('summarizeRawLine：对象顶层条目数', () => {
  const r = summarizeRawLine(Buffer.from('{"a":1,"b":2,"c":3}'));
  assert.equal(r.kind, 'object');
  assert.equal(r.count, 3);
  assert.ok(r.preview.startsWith('{'));
});

test('summarizeRawLine：数组顶层条目数', () => {
  const r = summarizeRawLine(Buffer.from('[1,2,3,4]'));
  assert.equal(r.kind, 'array');
  assert.equal(r.count, 4);
});

test('summarizeRawLine：空容器计 0', () => {
  assert.equal(summarizeRawLine(Buffer.from('{}')).count, 0);
  assert.equal(summarizeRawLine(Buffer.from('[]')).count, 0);
  assert.equal(summarizeRawLine(Buffer.from('{  }')).count, 0);
});

test('summarizeRawLine：嵌套不计入顶层条目数', () => {
  const r = summarizeRawLine(Buffer.from('{"a":{"x":1,"y":2},"b":[1,2,3]}'));
  assert.equal(r.kind, 'object');
  assert.equal(r.count, 2); // 仅 a、b 两个顶层 key
});

test('summarizeRawLine：标量类型判定', () => {
  assert.equal(summarizeRawLine(Buffer.from('"hello world"')).kind, 'string');
  assert.equal(summarizeRawLine(Buffer.from('42')).kind, 'number');
  assert.equal(summarizeRawLine(Buffer.from('-3.14')).kind, 'number');
  assert.equal(summarizeRawLine(Buffer.from('true')).kind, 'boolean');
  assert.equal(summarizeRawLine(Buffer.from('null')).kind, 'null');
});

test('summarizeRawLine：含字符串内逗号/括号不误计', () => {
  // 字符串值里的逗号与方括号不应被当顶层结构计数
  const r = summarizeRawLine(Buffer.from('{"msg":"a,b]c","n":2}'));
  assert.equal(r.kind, 'object');
  assert.equal(r.count, 2);
});

test('summarizeRawLine：超长行预览截断（不解析整条）', () => {
  const big = '{"data":"' + 'x'.repeat(5000) + '"}';
  const r = summarizeRawLine(Buffer.from(big));
  assert.equal(r.kind, 'object');
  assert.equal(r.count, 1);
  assert.ok(r.preview.endsWith('…'), `preview=${r.preview.slice(0, 40)}…`);
  assert.ok(r.preview.length <= 161); // 160 + '…'
});
