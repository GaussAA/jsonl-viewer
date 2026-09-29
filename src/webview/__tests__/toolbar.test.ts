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
    /** 「全部替换」收到的 (查询, 替换文本)。 */
    replace: [string, string][];
    /** 「坏行诊断」打开次数。 */
    badLines: number;
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
    replace: [] as [string, string][],
    badLines: 0,
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
    onReplaceAll: (q, r) => calls.replace.push([q, r]),
    onOpenBadLines: () => {
      calls.badLines += 1;
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
  const win = (
    globalThis as unknown as { window: { Event: new (t: string, o?: unknown) => Event } }
  ).window;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
}

describe('createToolbar（视图层覆盖率补强）', () => {
  before(() => {
    setupWebviewDom();
  });

  it('update：文件名 / 行数 / 范围 / 构建耗时 / 状态文案落到对应元素', () => {
    const h = makeToolbar();
    h.tb.update({
      fileName: 'big.jsonl',
      totalRecords: 1000,
      loadedLines: 42,
      range: [0, 20],
      buildMs: 12,
      status: 'ready',
    });

    assert.strictEqual(h.tb.els.fileNameEl.textContent, 'big.jsonl', '文件名');
    assert.match(h.tb.els.totalRecordsEl.textContent ?? '', /1,000/, '总行数（千分位）');
    assert.strictEqual(h.tb.els.rangeEl.textContent, '1–21', '当前范围按 1 起展示');
    assert.match(h.tb.els.buildMsEl.textContent ?? '', /12ms/, '构建耗时');
    assert.strictEqual(h.tb.els.statusEl.textContent, '就绪', '状态文案');
    assert.match(h.tb.els.statusRootEl.className, /ready/, '就绪态样式类');
  });

  it('update：非就绪状态不带 ready 类；错误态带 error 类并展示自定义文案', () => {
    const h = makeToolbar();

    h.tb.update({
      fileName: 'a',
      totalRecords: 0,
      loadedLines: 0,
      range: [0, 0],
      buildMs: undefined,
      status: 'indexing',
    });
    assert.ok(!/ready/.test(h.tb.els.statusRootEl.className), '索引中不带 ready');
    assert.ok(!/error/.test(h.tb.els.statusRootEl.className), '索引中不带 error');

    h.tb.update({
      fileName: 'a',
      totalRecords: 0,
      loadedLines: 0,
      range: [0, 0],
      buildMs: undefined,
      status: 'error',
      statusText: '索引失败',
    });
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

  it('可访问性：浮层打开时焦点落在表单控件（而非「关闭」），关闭后归还原按钮（O10）', () => {
    const h = makeToolbar();
    const doc = globalThis.document;
    const filterBtn = h.tb.root.querySelector<HTMLButtonElement>('button[title="字段值过滤"]');
    assert.ok(filterBtn, '存在筛选按钮');

    filterBtn.click();
    const panel = doc.querySelector<HTMLElement>('.jlv-float-panel');
    assert.ok(panel, '浮层已挂载');
    assert.strictEqual(panel.style.display, 'block', '浮层已显示');

    const active = doc.activeElement as HTMLElement | null;
    // 缺陷形态：h3（含关闭按钮）在 DOM 上先于表单控件，宽泛的 querySelector('button, input, select')
    // 命中的正是「关闭」—— 用户一按 Enter 就把刚打开的面板关了。
    assert.ok(
      !active?.classList.contains('jlv-panel-close'),
      '焦点不得落在关闭按钮上（否则 Enter 会立刻关掉面板）'
    );
    assert.ok(panel.contains(active), '焦点应落在浮层内');
    assert.ok(
      active?.tagName === 'SELECT' || active?.tagName === 'INPUT' || active?.tagName === 'BUTTON',
      `应是可操作的控件，实得=${active?.tagName}`
    );

    // Esc 关闭 → 焦点归还触发按钮（键盘用户不丢位置）
    panel.dispatchEvent(
      new (
        globalThis as unknown as {
          window: { KeyboardEvent: new (t: string, o?: unknown) => Event };
        }
      ).window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    assert.strictEqual(doc.activeElement, filterBtn, '关闭后焦点归还原按钮');
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

  /* ------------------------- 查找替换 ------------------------- */

  /** 替换按钮的 title 带操作说明（会写入磁盘），故按类名而非 title 定位。 */
  const goBtn = (h: Harness): HTMLButtonElement =>
    h.tb.root.querySelector<HTMLButtonElement>('.jlv-replace-go')!;
  const replaceRow = (h: Harness): HTMLElement =>
    h.tb.root.querySelector<HTMLElement>('.jlv-replace')!;

  it('替换行默认收起，切换按钮可展开 / 收起', () => {
    const h = makeToolbar();
    const row = replaceRow(h);
    const toggle = byTitle(h, '查找替换');
    assert.strictEqual(row.hidden, true, '默认收起');
    assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');

    toggle.click();
    assert.strictEqual(row.hidden, false, '点击后展开');
    assert.strictEqual(toggle.getAttribute('aria-expanded'), 'true', '无障碍状态同步');

    toggle.click();
    assert.strictEqual(row.hidden, true, '再次点击收起');
  });

  it('toggleReplace(open)：显式指定展开状态（幂等，不来回切换）', () => {
    const h = makeToolbar();
    const row = replaceRow(h);

    assert.strictEqual(h.tb.toggleReplace(true), true);
    assert.strictEqual(row.hidden, false);
    assert.strictEqual(h.tb.toggleReplace(true), true, '已经是展开态，再指定展开仍是展开');
    assert.strictEqual(row.hidden, false);
    assert.strictEqual(h.tb.toggleReplace(false), false);
    assert.strictEqual(row.hidden, true);
  });

  it('「全部替换」把搜索框与替换框的内容一并回调', () => {
    const h = makeToolbar();
    const search = h.tb.searchInput()!;
    search.value = 'bob';
    h.tb.replaceInput().value = 'alice';

    goBtn(h).click();
    assert.deepStrictEqual(h.calls.replace, [['bob', 'alice']]);
  });

  it('setReplaceBusy：执行中禁用控件并改文案，避免重复触发第二次写入', () => {
    const h = makeToolbar();
    const btn = goBtn(h);

    h.tb.setReplaceBusy(true);
    assert.strictEqual(btn.disabled, true);
    assert.match(btn.textContent ?? '', /替换中/);
    assert.strictEqual(h.tb.replaceInput().disabled, true);

    h.tb.setReplaceBusy(false);
    assert.strictEqual(btn.disabled, false);
    assert.strictEqual(btn.textContent, '全部替换');
    assert.strictEqual(h.tb.replaceInput().disabled, false);
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
    assert.strictEqual(
      doc.querySelectorAll('.jlv-float-panel').length,
      1,
      '单实例复用：未移除 DOM'
    );
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

    const beforeCount = h.calls.layout.length;
    const cb = rows[0].querySelector<HTMLInputElement>('.jlv-layout-hidden');
    assert.ok(cb, '字段行带显隐勾选框');
    cb.checked = !cb.checked;
    cb.dispatchEvent(
      new (
        globalThis as unknown as { window: { Event: new (t: string, o?: unknown) => Event } }
      ).window.Event('change', {
        bubbles: true,
      })
    );
    assert.ok(h.calls.layout.length > beforeCount, '变更后回调 onApplyLayout');
  });

  it('refresh / destroy：均不抛错，且 destroy 后交互安全', () => {
    const h = makeToolbar();
    h.tb.update({
      fileName: 'a',
      totalRecords: 5,
      loadedLines: 5,
      range: [0, 5],
      buildMs: 1,
      status: 'ready',
    });
    assert.doesNotThrow(() => h.tb.refresh());
    assert.doesNotThrow(() => h.tb.destroy());
    assert.doesNotThrow(() => byTitle(h, '下一个匹配').click(), 'destroy 后点击安全');
  });

  /* ------------------------- 坏行徽章 ------------------------- */

  const chipEl = (h: Harness): HTMLButtonElement =>
    h.tb.root.querySelector<HTMLButtonElement>('.jlv-bad-chip')!;

  it('坏行徽章：默认与 0 坏行时都隐藏（常驻只会是噪音）', () => {
    const h = makeToolbar();
    const chip = chipEl(h);
    assert.ok(chip, '徽章节点存在');
    assert.strictEqual(chip.hidden, true, '默认隐藏');

    h.tb.update({ badLines: { count: 0, partial: true } });
    assert.strictEqual(chip.hidden, true, '0 坏行仍隐藏');
  });

  it('坏行徽章：partial 用「N+」下界写法，全量才是确数', () => {
    const h = makeToolbar();
    const chip = chipEl(h);

    h.tb.update({ badLines: { count: 3, partial: true } });
    assert.strictEqual(chip.hidden, false);
    assert.match(chip.textContent ?? '', /3\+ 坏行/, '未扫描时是下界，写成确数会误导');
    assert.strictEqual(chip.classList.contains('partial'), true, '虚线边框提示「未查全」');
    assert.match(chip.title, /仅在已浏览范围内/);

    h.tb.update({ badLines: { count: 3, partial: false } });
    assert.match(chip.textContent ?? '', /3 坏行/);
    assert.strictEqual(chip.classList.contains('partial'), false, '全量后不再是下界');
    assert.match(chip.title, /共 3 个坏行/);
  });

  it('坏行徽章：点击回调 onOpenBadLines', () => {
    const h = makeToolbar();
    h.tb.update({ badLines: { count: 1, partial: false } });
    chipEl(h).click();
    assert.strictEqual(h.calls.badLines, 1);
  });

  it('坏行徽章：常规 update 不带 badLines 时不得被清掉', () => {
    const h = makeToolbar();
    h.tb.update({ badLines: { count: 2, partial: false } });
    // updateToolbar() 会被频繁调用且不携带 badLines —— 若它顺手重置徽章，
    // 用户每次滚动都会看到徽章闪一下。
    h.tb.update({ totalRecords: 100, loadedLines: 20, range: [0, 19], status: 'ready' });
    assert.strictEqual(chipEl(h).hidden, false, '常规刷新不得改动徽章');
    assert.match(chipEl(h).textContent ?? '', /2 坏行/);
  });
});
