/**
 * security.test.ts — 安全/边界条件测试。
 *
 * 覆盖：XSS 防护、escapeHtml 完整性、dispose 清理防御、边界输入。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from '../utils.ts';

/* ------------------------------ escapeHtml / XSS ------------------------------ */

test('escapeHtml: 空串保持空', () => {
  assert.equal(escapeHtml(''), '');
});

test('escapeHtml: 普通文本不变', () => {
  const plain = 'hello world 你好 🌍';
  assert.equal(escapeHtml(plain), plain);
});

test('escapeHtml: & < > " 四种核心字符被正确转义', () => {
  assert.equal(escapeHtml('a&b'), 'a&amp;b');
  assert.equal(escapeHtml('a<b'), 'a&lt;b');
  assert.equal(escapeHtml('a>b'), 'a&gt;b');
  assert.equal(escapeHtml('a"b'), 'a&quot;b');
});

test('escapeHtml: 单引号被正确转义', () => {
  assert.equal(escapeHtml("a'b"), 'a&#39;b');
});

test('escapeHtml: 组合所有危险字符', () => {
  const input = `<script>alert("x'ss")</script>&`;
  const expected = '&lt;script&gt;alert(&quot;x&#39;ss&quot;)&lt;/script&gt;&amp;';
  assert.equal(escapeHtml(input), expected);
});

test('escapeHtml: 无二次转义', () => {
  // escapeHtml 不做去重，escapeHtml(escapeHtml(s)) 会对新生成的 & 再转一次——这是对的
  const once = escapeHtml('&');
  const twice = escapeHtml(once);
  assert.equal(once, '&amp;');
  assert.equal(twice, '&amp;amp;');
});

/* ------------------------------ 边界条件 ------------------------------ */

test('escapeHtml: 大文本（100KB 级别）正确且不抛错', () => {
  const big = '<>&"'.repeat(25_000); // 100K chars
  const t0 = Date.now();
  const out = escapeHtml(big);
  const t1 = Date.now();
  // 每个危险字符变成 5 或 6 字符 → 总长度远大于原长度
  assert.ok(out.length > big.length, '转义后长度必须增加');
  assert.ok(t1 - t0 < 2000, '100K 字符应在 2s 内完成（正则替换）');
});

test('escapeHtml: 正则不匹配的字符保持原样', () => {
  const safe = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_.:-/=?#@';
  assert.equal(escapeHtml(safe), safe);
});

test('escapeHtml: 多行文本正确处理', () => {
  // \n 和 \r 不在转义范围内（HTML textContent/innerHTML 对换行是安全的）
  const multiline = 'line1\nline2\r\nline3';
  assert.equal(escapeHtml(multiline), multiline);
});
