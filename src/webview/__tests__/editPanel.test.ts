/**
 * editPanel.test.ts — 行编辑浮层的 DOM 行为测试（jsdom）。
 *
 * 覆盖：打开填充、本地校验拦截（不触发提交）、提交成功关闭、冲突时保持打开、
 * Esc 关闭、格式化、成本提示的显示与抑制。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupWebviewDom } from './domHarness.ts';

// editPanel 直接使用 document/window，须先装配 DOM 环境再动态导入。
const host = setupWebviewDom();
const win = host.dom.window;
const { createEditPanel } = await import('../editPanel.ts');

interface SubmitResult {
  ok: boolean;
  error?: string;
  conflict?: boolean;
  invalid?: boolean;
  bytesDelta?: number;
  movedBytes?: number;
  costMs?: number;
}

function makePanel(
  opts: { result?: SubmitResult; overview?: { totalBytes: number; totalLines: number } } = {}
) {
  const calls: Array<{ line: number; text: string }> = [];
  const committed: Array<{ line: number; bytesDelta: number; movedBytes: number }> = [];
  const panel = createEditPanel({
    getOverview: () => opts.overview,
    submit: async (line, text) => {
      calls.push({ line, text });
      return opts.result ?? { ok: true, bytesDelta: 0, movedBytes: 0, costMs: 1 };
    },
    onCommitted: (info) => committed.push(info),
  });
  document.body.appendChild(panel.root);
  return { panel, calls, committed };
}

function q<T extends Element>(root: HTMLElement, sel: string): T {
  const el = root.querySelector(sel);
  assert.ok(el, `夹具错误：找不到 ${sel}`);
  return el as T;
}

/** 让 async 的保存流程走完（内部有 await）。 */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test('editPanel：open 填充标题与初始文本，isOpen 立即为真', () => {
  const { panel } = makePanel();
  try {
    assert.equal(panel.isOpen(), false);
    panel.open(2, '{"a":1}');
    assert.equal(panel.isOpen(), true);
    assert.equal(q<HTMLElement>(panel.root, '.jlv-edit-title').textContent, '编辑第 3 行');
    assert.equal(q<HTMLTextAreaElement>(panel.root, '.jlv-edit-input').value, '{"a":1}');
  } finally {
    panel.dispose();
  }
});

test('editPanel：本地校验拦截空内容与非法 JSON，且不触发提交', () => {
  const { panel, calls } = makePanel();
  try {
    panel.open(0, '{"a":1}');
    const input = q<HTMLTextAreaElement>(panel.root, '.jlv-edit-input');
    const save = q<HTMLButtonElement>(panel.root, '.jlv-edit-primary');

    input.value = '   ';
    save.click();
    assert.equal(calls.length, 0, '空内容不得提交');

    input.value = '{"a":1,,}';
    save.click();
    assert.equal(calls.length, 0, '非法 JSON 不得提交');
    assert.equal(q<HTMLElement>(panel.root, '.jlv-edit-error').hidden, false, '应就地提示错误');
  } finally {
    panel.dispose();
  }
});

test('editPanel：提交成功 → 上报 onCommitted 并关闭', async () => {
  const { panel, calls, committed } = makePanel({
    result: { ok: true, bytesDelta: 7, movedBytes: 3, costMs: 2 },
  });
  try {
    panel.open(4, '{"a":1}');
    q<HTMLTextAreaElement>(panel.root, '.jlv-edit-input').value = '{"a":2}';
    q<HTMLButtonElement>(panel.root, '.jlv-edit-primary').click();
    await tick();

    assert.deepEqual(calls, [{ line: 4, text: '{"a":2}' }]);
    assert.deepEqual(committed, [{ line: 4, bytesDelta: 7, movedBytes: 3 }]);
    assert.equal(panel.isOpen(), false);
  } finally {
    panel.dispose();
  }
});

test('editPanel：冲突失败 → 保持打开并给出「重新加载」指引', async () => {
  const { panel, committed } = makePanel({
    result: { ok: false, conflict: true, error: '文件已被外部修改' },
  });
  try {
    panel.open(0, '{"a":1}');
    q<HTMLButtonElement>(panel.root, '.jlv-edit-primary').click();
    await tick();

    assert.equal(panel.isOpen(), true, '失败时必须保持打开，让用户能改或重试');
    assert.equal(committed.length, 0, '失败不得上报 onCommitted');
    const err = q<HTMLElement>(panel.root, '.jlv-edit-error');
    assert.equal(err.hidden, false);
    assert.match(err.textContent ?? '', /重新加载/);
  } finally {
    panel.dispose();
  }
});

test('editPanel：Esc 关闭且不提交', () => {
  const { panel, calls } = makePanel();
  try {
    panel.open(0, '{"a":1}');
    q<HTMLTextAreaElement>(panel.root, '.jlv-edit-input').dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    assert.equal(panel.isOpen(), false);
    assert.equal(calls.length, 0);
  } finally {
    panel.dispose();
  }
});

test('editPanel：格式化按钮重排文本；非法内容给出提示且不改动原文', () => {
  const { panel } = makePanel();
  try {
    panel.open(0, '{"a":1}');
    const input = q<HTMLTextAreaElement>(panel.root, '.jlv-edit-input');
    const fmt = q<HTMLButtonElement>(panel.root, '.jlv-edit-btn'); // 首个按钮即「格式化」

    fmt.click();
    assert.equal(input.value, '{\n  "a": 1\n}');

    input.value = 'not json';
    fmt.click();
    assert.equal(input.value, 'not json', '非法内容不得被清空或改写');
    assert.match(q<HTMLElement>(panel.root, '.jlv-edit-error').textContent ?? '', /不是合法 JSON/);
  } finally {
    panel.dispose();
  }
});

test('editPanel：成本超阈值提示「需搬移」，未超阈值不打扰', () => {
  const big = makePanel({ overview: { totalBytes: 100 * 1024 * 1024, totalLines: 10 } });
  try {
    big.panel.open(0, '{}'); // 首行 → 估算约 90MB > 32MB 阈值
    const hint = q<HTMLElement>(big.panel.root, '.jlv-edit-hint');
    assert.equal(hint.hidden, false);
    assert.match(hint.textContent ?? '', /搬移/);
  } finally {
    big.panel.dispose();
  }

  const small = makePanel({ overview: { totalBytes: 1024, totalLines: 10 } });
  try {
    small.panel.open(9, '{}'); // 末行 → 零搬移
    assert.equal(q<HTMLElement>(small.panel.root, '.jlv-edit-hint').hidden, true);
  } finally {
    small.panel.dispose();
  }
});
