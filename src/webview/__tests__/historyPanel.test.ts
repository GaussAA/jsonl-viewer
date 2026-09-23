import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { setupWebviewDom } from './domHarness.ts';
import { createHistoryPanel } from '../historyPanel.ts';
import type { HistoryEntryView, HistoryPayload, HistoryResultPayload } from '../../protocol/rpc.ts';

/**
 * 会话编辑历史浮层测试。
 *
 * 断言落在「可观测行为」：渲染出的行、类名（已撤销标记）、回调入参。
 * 关键不变式：**前端不自行推算光标**，一切以宿主返回的快照为准。
 */

const REAL_SET_TIMEOUT = globalThis.setTimeout;
const wait = (ms: number): Promise<void> => new Promise((r) => REAL_SET_TIMEOUT(() => r(), ms));

const mkEntry = (
  id: string,
  kind: HistoryEntryView['kind'],
  label: string,
  bytesDelta = 12
): HistoryEntryView => ({ id, kind, label, lines: 1, bytesDelta, at: 1758600000000 });

const okResult = (over: Partial<HistoryResultPayload> = {}): HistoryResultPayload => ({
  ok: true,
  steps: 1,
  cursor: 0,
  total: 1,
  label: '编辑第 1 行',
  ...over,
});

interface Harness {
  panel: ReturnType<typeof createHistoryPanel>;
  calls: {
    undo: number;
    redo: number;
    revert: string[];
    confirm: string[];
    changed: number;
    notify: string[];
  };
  snapshot: HistoryPayload;
  revertResult: HistoryResultPayload;
  undoResult: HistoryResultPayload;
  fetchError?: string;
}

function makePanel(): Harness {
  globalThis.document.body.innerHTML = '';
  const calls = {
    undo: 0,
    redo: 0,
    revert: [] as string[],
    confirm: [] as string[],
    changed: 0,
    notify: [] as string[],
  };
  const h: Harness = {
    panel: undefined as never,
    calls,
    snapshot: { entries: [], cursor: 0, dropped: false },
    revertResult: okResult(),
    undoResult: okResult(),
  };

  h.panel = createHistoryPanel({
    fetchHistory: async () => {
      if (h.fetchError) throw new Error(h.fetchError);
      return h.snapshot;
    },
    undoStep: async () => {
      calls.undo += 1;
      return h.undoResult;
    },
    redoStep: async () => {
      calls.redo += 1;
      return h.undoResult;
    },
    revertTo: async (id) => {
      calls.revert.push(id);
      return h.revertResult;
    },
    confirm: (message, onConfirm) => {
      calls.confirm.push(message);
      onConfirm(); // 模拟用户点「确认」
    },
    onChanged: () => {
      calls.changed += 1;
    },
    notify: (message) => calls.notify.push(message),
  });

  globalThis.document.body.append(h.panel.root);
  return h;
}

const rows = (): HTMLElement[] =>
  Array.from(globalThis.document.querySelectorAll<HTMLElement>('.jlv-hist-row'));
const rowText = (el: HTMLElement): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
const byLabel = (text: string): HTMLButtonElement =>
  Array.from(globalThis.document.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent === text
  )!;
const empty = (): HTMLElement | null =>
  globalThis.document.querySelector<HTMLElement>('.jlv-hist-empty');

describe('historyPanel（会话编辑历史浮层）', () => {
  before(() => {
    setupWebviewDom();
  });

  it('打开后拉取快照并倒序渲染（最新在上）', async () => {
    const h = makePanel();
    h.snapshot = {
      entries: [
        mkEntry('h1', 'edit', '编辑第 1 行'),
        mkEntry('h2', 'deleteMany', '删除 3 行', -60),
      ],
      cursor: 2,
      dropped: false,
    };

    h.panel.open();
    await wait(30);

    const els = rows();
    assert.strictEqual(els.length, 2);
    assert.match(rowText(els[0]), /删除 3 行/, '最新的在最上面');
    assert.match(rowText(els[1]), /编辑第 1 行/);
    assert.match(rowText(els[0]), /−60 B/, '字节增量带符号展示');
  });

  it('光标之后的条目标记为「已撤销」', async () => {
    const h = makePanel();
    h.snapshot = {
      entries: [mkEntry('h1', 'edit', '编辑第 1 行'), mkEntry('h2', 'edit', '编辑第 2 行')],
      cursor: 1, // 第 2 条已被撤销
      dropped: false,
    };

    h.panel.open();
    await wait(30);

    const els = rows(); // 倒序：els[0] 是 h2
    assert.ok(els[0].classList.contains('undone'), '已撤销的条目带 undone 类');
    assert.ok(!els[1].classList.contains('undone'));
  });

  it('空历史：给出空态且撤销/重做按钮禁用', async () => {
    const h = makePanel();
    h.panel.open();
    await wait(30);

    assert.ok(empty(), '有空态提示');
    assert.match(empty()!.textContent ?? '', /还没有编辑操作/);
    assert.strictEqual(byLabel('撤销一步').disabled, true);
    assert.strictEqual(byLabel('重做一步').disabled, true);
  });

  it('光标在两端时对应按钮禁用（不能撤销到底 / 重做到头）', async () => {
    const h = makePanel();
    h.snapshot = { entries: [mkEntry('h1', 'edit', '编辑第 1 行')], cursor: 0, dropped: false };
    h.panel.open();
    await wait(30);
    assert.strictEqual(byLabel('撤销一步').disabled, true, '光标在起点：无可撤销');
    assert.strictEqual(byLabel('重做一步').disabled, false);

    h.snapshot = { entries: [mkEntry('h1', 'edit', '编辑第 1 行')], cursor: 1, dropped: false };
    await h.panel.open(); // 已打开时 open 是幂等 no-op，需直接触发刷新
    h.panel.close();
    await wait(200);
    h.panel.open();
    await wait(30);
    assert.strictEqual(byLabel('重做一步').disabled, true, '光标在末尾：无可重做');
  });

  it('「更早的记录已丢弃」必须如实标注', async () => {
    const h = makePanel();
    h.snapshot = { entries: [mkEntry('h1', 'edit', '编辑第 1 行')], cursor: 1, dropped: true };
    h.panel.open();
    await wait(30);

    const note = globalThis.document.querySelector<HTMLElement>('.jlv-hist-note')!;
    assert.strictEqual(note.hidden, false);
    assert.match(note.textContent ?? '', /已.*丢弃/);
  });

  it('点条目：二次确认含步数，确认后调 revertTo 并通知装配层刷新', async () => {
    const h = makePanel();
    h.snapshot = {
      entries: [
        mkEntry('h1', 'edit', '编辑第 1 行'),
        mkEntry('h2', 'edit', '编辑第 2 行'),
        mkEntry('h3', 'edit', '编辑第 3 行'),
      ],
      cursor: 3,
      dropped: false,
    };
    h.revertResult = okResult({ steps: 3, cursor: 0 });

    h.panel.open();
    await wait(30);

    // 倒序展示：rows()[2] 是最旧的 h1（停在第 1 步 → 撤销 2 次）
    rows()[2].click();
    await wait(30);

    assert.strictEqual(h.calls.confirm.length, 1);
    assert.match(h.calls.confirm[0], /将撤销 2 次操作/, '确认文案必须说明代价');
    assert.deepStrictEqual(h.calls.revert, ['h1'], '回退到该条之前');
    assert.strictEqual(h.calls.changed, 1, '通知装配层刷新');
    assert.match(h.calls.notify.at(-1) ?? '', /已撤销 3 次操作/);
  });

  it('点已撤销的条目 → 文案变为「重做」', async () => {
    const h = makePanel();
    h.snapshot = {
      entries: [mkEntry('h1', 'edit', '编辑第 1 行'), mkEntry('h2', 'edit', '编辑第 2 行')],
      cursor: 0,
      dropped: false,
    };
    h.revertResult = okResult({ steps: 1, cursor: 1 });

    h.panel.open();
    await wait(30);

    rows()[0].click(); // 最新的一条（h2）；光标在 0 → 需重做 2 步才停在此处
    await wait(30);
    assert.match(h.calls.confirm[0], /将重做 2 次操作/);
    assert.deepStrictEqual(h.calls.revert, ['h2']);
  });

  it('点当前光标所在的条目 → 无操作（不弹确认）', async () => {
    const h = makePanel();
    h.snapshot = {
      entries: [mkEntry('h1', 'edit', '编辑第 1 行'), mkEntry('h2', 'edit', '编辑第 2 行')],
      cursor: 2,
      dropped: false,
    };
    h.panel.open();
    await wait(30);

    rows()[0].click(); // 最新一条即光标处
    await wait(30);
    assert.strictEqual(h.calls.confirm.length, 0);
    assert.deepStrictEqual(h.calls.revert, []);
  });

  it('「撤销一步 / 重做一步」按钮走宿主光标并如实提示', async () => {
    const h = makePanel();
    h.snapshot = { entries: [mkEntry('h1', 'edit', '编辑第 1 行')], cursor: 1, dropped: false };
    h.undoResult = okResult({ label: '编辑第 1 行' });

    h.panel.open();
    await wait(30);

    byLabel('撤销一步').click();
    await wait(30);
    assert.strictEqual(h.calls.undo, 1);
    assert.strictEqual(h.calls.changed, 1);
    assert.match(h.calls.notify.at(-1) ?? '', /已撤销：编辑第 1 行/);
  });

  it('撤销失败时如实报错，不假装成功', async () => {
    const h = makePanel();
    h.snapshot = { entries: [mkEntry('h1', 'edit', '编辑第 1 行')], cursor: 1, dropped: false };
    h.undoResult = { ok: false, steps: 0, cursor: 1, total: 1, error: '文件已被外部修改' };

    h.panel.open();
    await wait(30);
    byLabel('撤销一步').click();
    await wait(30);

    assert.match(h.calls.notify.at(-1) ?? '', /文件已被外部修改/);
  });

  it('拉取失败时给出可读提示而非静默空白', async () => {
    const h = makePanel();
    h.fetchError = '宿主无响应';

    h.panel.open();
    await wait(30);

    assert.ok(empty());
    assert.match(empty()!.textContent ?? '', /读取历史失败/);
    assert.match(empty()!.textContent ?? '', /宿主无响应/);
  });

  it('Esc 关闭；重复 open/close 幂等', async () => {
    const h = makePanel();
    h.panel.open();
    await wait(30);
    assert.strictEqual(h.panel.isOpen(), true);

    const w = (
      globalThis as unknown as {
        window: { KeyboardEvent: new (t: string, o?: unknown) => KeyboardEvent };
      }
    ).window;
    globalThis.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.strictEqual(h.panel.isOpen(), false);

    h.panel.close(); // 再次 close 不应抛错
    h.panel.open();
    assert.strictEqual(h.panel.isOpen(), true);
  });
});
