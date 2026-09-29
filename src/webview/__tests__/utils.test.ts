/**
 * utils.test.ts — 文本渲染工具（escapeHtml / renderHighlight）。
 *
 * 高亮的实现方式直接决定 XSS 面：这里断言**用户数据永远只成为文本节点**，
 * 而不是「转义后再拼 HTML」（后者的任何一处疏漏都是一次注入）。
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { setupWebviewDom } from './domHarness.ts';
import { escapeHtml, renderHighlight } from '../utils.ts';

describe('escapeHtml / renderHighlight', () => {
  before(() => {
    setupWebviewDom();
  });

  it('renderHighlight：用户数据只成为文本节点，绝不进 HTML 解析器', () => {
    const doc = globalThis.document;
    const el = doc.createElement('span');
    const evil = '<img src=x onerror="globalThis.__pwned=1">';
    renderHighlight(el, evil, [[0, 4]]); // 前 4 个字符命中

    assert.strictEqual(el.querySelector('img'), null, '不得解析出 img 元素');
    assert.strictEqual(
      (globalThis as unknown as Record<string, unknown>).__pwned,
      undefined,
      '注入的脚本不得执行'
    );
    assert.strictEqual(el.textContent, evil, '文本保持原样（含那些尖括号）');
    const mark = el.querySelector('mark.jlv-hit');
    assert.ok(mark, '命中片段被包成 mark');
    assert.strictEqual(mark!.textContent, evil.slice(0, 4));
  });

  it('renderHighlight：无命中时退化为纯文本；乱序/越界区间被安全忽略', () => {
    const doc = globalThis.document;
    const el = doc.createElement('span');
    renderHighlight(el, 'abc', []);
    assert.strictEqual(el.textContent, 'abc');

    const el2 = doc.createElement('span');
    renderHighlight(el2, 'abcdef', [
      [4, 6],
      [0, 2],
      [99, 120],
    ]);
    assert.strictEqual(el2.textContent, 'abcdef', '文本不丢不乱');
  });

  it('renderHighlight：多段命中逐段包 mark，中间文本原样保留', () => {
    const doc = globalThis.document;
    const el = doc.createElement('span');
    renderHighlight(el, 'aXbXc', [
      [1, 2],
      [3, 4],
    ]);
    const marks = Array.from(el.querySelectorAll('mark.jlv-hit'));
    assert.strictEqual(marks.length, 2);
    assert.strictEqual(el.textContent, 'aXbXc');
  });

  it('escapeHtml：四个核心字符转义（既有行为不得回归）', () => {
    assert.strictEqual(escapeHtml('a&b<c>d"e'), 'a&amp;b&lt;c&gt;d&quot;e');
  });
});
