import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { setupWebviewDom } from './domHarness.ts';
import { createToolbar } from '../toolbar.ts';
import type { FieldCondition, FieldLayout } from '../queryLogic.ts';

/**
 * toolbar 组件测试（覆盖率补强：视图层）。
 *
 * 价值：工具栏承担文件名/统计/状态展示、搜索（防抖 + 上下匹配）、过滤与字段布局三个浮层面板，
 * 是 webview 的主交互入口。断言落在可观测行为（元素文本 / 类名 / hidden / 回调入参）。
 */

const REAL_SET_TIMEOUT = globalThis.setTimeout;

/** 等待若干毫秒（原生定时器；domHarness 的 setTimeout 被 unref，不可用于等待）。 */
function wait(ms: number): Promise<void> {
  return new Promise((r) => REAL_SET_TIMEOUT(() => r(), ms));
}

interface Harness {
  tb: ReturnType<typeof createToolbar>;
  calls: {
    search: string[];
    prev: number;
    next: number;
    filter: (FieldCondition | null)[];
    layout: FieldLayout[];
  };
}

function makeToolbar(): Harness {
  const doc = globalThis.document;
  // 关键：每例先清空文档，保证用例间零干扰。
  // 工具栏会把搜索浮层面板挂到 document.body（而非自身 root），若不清空，
  // 前序用例遗留的节点会让内部的文档级查询命中错误元素（表现为「点击无反应」）。
  doc.body.innerHTML = '';
  const calls = {
    search: [] as string[],
    prev: 0,
    next: 0,
    filter: [] as (FieldCondition | null)[],
    layout: [] as FieldLayout[],
  };
  const host = doc.createElement('div');
  doc.body.append(host);
  const tb = createToolbar(host, {
    onSearch: (q) => calls.search.push(q),
    onSearchPrev: () => {
      calls.prev += 1;
    },
    onSearchNext: () => {
      calls.next += 1;
    },
    onApplyFilter: (c) => calls.filter.push(c),
    onApplyLayout: (l) => calls.layout.push(l),
  });
  host.append(tb.root);
  return { tb, calls };
}

const byTitle = (h: Harness, title: string): HTMLButtonElement => {
  const btn = Array.from(h.tb.root.querySelectorAll('button')).find((b) => b.title === title);
  if (!btn) throw new Error(`未找到按钮「${title}」`);
  return btn as HTMLButtonElement;
};

/** 派发输入事件（触发防抖搜索）。 */
function fireInput(el: HTMLElement): void {
  const win = (globalThis as unknown as { window: { Event: new (t: string, o?: unknown) => Event } }).window;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
}

describe('createToolbar（视图层覆盖率补强）', () => {
  before(() => {
    setupWebviewDom();
  });

  it('update：文件名 / 行数 / 范围 / 构建耗时 / 状态文案落到对应元素', () => {
    const h = makeToolbar();
    h.tb.update({ fileName: 'big.jsonl', totalLines: 1000, loadedLines: 42, range: [0, 20], buildMs: 12, status: 'ready' });

    assert.strictEqual(h.tb.els.fileNameEl.textContent, 'big.jsonl', '文件名');
    assert.match(h.tb.els.totalLinesEl.textContent ?? '', /1,000/, '总行数（千分位）');
    assert.strictEqual(h.tb.els.rangeEl.textContent, '1–21', '当前范围按 1 起展示');
    assert.match(h.tb.els.buildMsEl.textContent ?? '', /12ms/, '构建耗时');
    assert.strictEqual(h.tb.els.statusEl.textContent, '就绪', '状态文案');
    assert.match(h.tb.els.statusRootEl.className, /ready/, '就绪态样式类');
  });

  it('update：非就绪状态不带 ready 类；错误态带 error 类并展示自定义文案', () => {
    const h = makeToolbar();

    h.tb.update({ fileName: 'a', totalLines: 0, loadedLines: 0, range: [0, 0], buildMs: undefined, status: 'indexing' });
    assert.ok(!/ready/.test(h.tb.els.statusRootEl.className), '索引中不带 ready');
    assert.ok(!/error/.test(h.tb.els.statusRootEl.className), '索引中不带 error');

    h.tb.update({ fileName: 'a', totalLines: 0, loadedLines: 0, range: [0, 0], buildMs: undefined, status: 'error', statusText: '索引失败' });
    assert.match(h.tb.els.statusRootEl.className, /error/, '错误态样式类');
    assert.strictEqual(h.tb.els.statusEl.textContent, '索引失败', '自定义状态文案');
  });

  it('搜索输入：防抖后才回调（输入过程中不提前触发）', async () => {
    const h = makeToolbar();
    const input = h.tb.searchInput();
    assert.ok(input, '存在搜索输入框');

    input.value = 'needle';
    fireInput(input);
    assert.strictEqual(h.calls.search.length, 0, '输入瞬间不回调（防抖）');

    await wait(400);
    assert.deepStrictEqual(h.calls.search, ['needle'], '防抖到期回调一次');
  });

  it('清除搜索按钮：立即清空输入并回调空串', () => {
    const h = makeToolbar();
    const input = h.tb.searchInput();
    assert.ok(input);
    input.value = 'abc';

    byTitle(h, '清除搜索').click();
    assert.strictEqual(input.value, '', '输入已清空');
    assert.deepStrictEqual(h.calls.search, [''], '立即回调空串');
  });

  it('上一个 / 下一个匹配按钮触发对应回调', () => {
    const h = makeToolbar();
    // 真实流程：先有搜索结果，导航按钮才会启用（未启用时 jsdom 的 click() 是空操作）
    h.tb.setSearchResult(7, 2);
    byTitle(h, '上一个匹配').click();
    byTitle(h, '下一个匹配').click();
    byTitle(h, '下一个匹配').click();
    assert.strictEqual(h.calls.prev, 1);
    assert.strictEqual(h.calls.next, 2);
  });

  it('setSearchResult：匹配计数按「第几个/总数」展示', () => {
    const h = makeToolbar();
    const count = h.tb.root.querySelector('.jlv-search-count');
    assert.ok(count, '存在匹配计数元素');

    h.tb.setSearchResult(7, 2);
    assert.match(count.textContent ?? '', /3\/7/, '第 3 条 / 共 7 条');

    h.tb.setSearchResult(0, 0);
    assert.ok(!/3\/7/.test(count.textContent ?? ''), '无匹配时不再显示旧计数');
  });

  it('setFilterTruncated：控制「过滤结果被截断」提示的显隐', () => {
    const h = makeToolbar();
    const note = h.tb.root.querySelector<HTMLElement>('.jlv-filter-note');
    assert.ok(note, '存在过滤提示元素');

    h.tb.setFilterTruncated(true);
    assert.strictEqual(note.hidden, false, '截断时提示可见');

    h.tb.setFilterTruncated(false);
    assert.strictEqual(note.hidden, true, '未截断时隐藏');
  });

  it('过滤面板：点击按钮打开浮层，点关闭淡出隐藏（单实例复用，不移除 DOM）', async () => {
    const h = makeToolbar();
    // 浮层面板挂在 document.body（非工具栏自身子树）
    const doc = globalThis.document;

    byTitle(h, '字段值过滤').click();
    const panel = doc.querySelector<HTMLElement>('.jlv-float-panel');
    assert.ok(panel, '打开后出现浮层面板');
    assert.notStrictEqual(panel.style.display, 'none', '打开后可见');

    const close = panel.querySelector<HTMLElement>('.jlv-panel-close');
    assert.ok(close, '面板带关闭按钮');
    close.click();
    assert.ok(panel.classList.contains('closing'), '关闭即进入淡出态');

    await wait(220); // 淡出 120ms 后置 display:none（定时器被 unref，须用原生定时器维持循环）
    assert.strictEqual(panel.style.display, 'none', '淡出后隐藏');
    assert.strictEqual(doc.querySelectorAll('.jlv-float-panel').length, 1, '单实例复用：未移除 DOM');
  });

  it('字段布局面板：打开后渲染字段列表；勾选变更即回调布局', () => {
    const h = makeToolbar();
    h.tb.setFields([
      { key: 'id', type: 'number' },
      { key: 'name', type: 'string' },
    ]);
    byTitle(h, '字段显示定制（显隐/排序/固定）').click();

    const list = globalThis.document.querySelector('.jlv-layout-list');
    assert.ok(list, '打开后出现布局列表');
    const rows = Array.from(list.querySelectorAll('.jlv-layout-row'));
    assert.ok(rows.length >= 2, `字段行已渲染（实际 ${rows.length}）`);

    const before = h.calls.layout.length;
    const cb = rows[0].querySelector<HTMLInputElement>('.jlv-layout-hidden');
    assert.ok(cb, '字段行带显隐勾选框');
    cb.checked = !cb.checked;
    cb.dispatchEvent(
      new (globalThis as unknown as { window: { Event: new (t: string, o?: unknown) => Event } }).window.Event('change', {
        bubbles: true,
      })
    );
    assert.ok(h.calls.layout.length > before, '变更后回调 onApplyLayout');
  });

  it('refresh / destroy：均不抛错，且 destroy 后交互安全', () => {
    const h = makeToolbar();
    h.tb.update({ fileName: 'a', totalLines: 5, loadedLines: 5, range: [0, 5], buildMs: 1, status: 'ready' });
    assert.doesNotThrow(() => h.tb.refresh());
    assert.doesNotThrow(() => h.tb.destroy());
    assert.doesNotThrow(() => byTitle(h, '下一个匹配').click(), 'destroy 后点击安全');
  });
});
