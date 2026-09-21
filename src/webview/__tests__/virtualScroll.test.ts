import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { setupWebviewDom } from './domHarness.ts';
import {
  VirtualRecordList,
  PAGE_SIZE,
  type ListCallbacks,
  type RecordEntry,
} from '../virtualScroll.ts';

/**
 * VirtualRecordList 组件测试（覆盖率补强：视图层）。
 *
 * 价值：虚拟滚动 / 分页 / 过滤映射是本插件「百万行不卡」的根本。
 * 本测试用 jsdom + 桩回调驱动其公开 API 与交互（翻页、跳页、键盘、空态、过滤映射、释放），
 * 全部断言落在「可观测行为」上（DOM 结构 / 回调入参 / 页信息），不依赖实现细节。
 *
 * 注意：domHarness 会把 setTimeout 包成 unref 版（防握手定时器阻塞进程退出），
 * 故需要等待换页动画时，必须用补丁生效前捕获的原生定时器（REAL_SET_TIMEOUT）。
 */

const REAL_SET_TIMEOUT = globalThis.setTimeout;

/** 等待若干毫秒（原生定时器，保证事件循环存活）。 */
function wait(ms: number): Promise<void> {
  return new Promise((r) => REAL_SET_TIMEOUT(() => r(), ms));
}

/** 开关 reduce-motion（虚拟滚动据此决定换页动画是走动画还是同步重建）。 */
function setReducedMotion(on: boolean): void {
  const w = (globalThis as unknown as { window: { matchMedia: (q: string) => unknown } }).window;
  w.matchMedia = (q: string) => ({
    matches: on,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  });
  (globalThis as unknown as Record<string, unknown>).matchMedia = w.matchMedia;
}

interface Harness {
  list: VirtualRecordList;
  calls: { select: number[]; range: Array<[number, number]>; cleared: number; requested: number[] };
  /** 已加载的记录（其余行返回 undefined → 渲染「加载中」占位）。 */
  loaded: Set<number>;
}

function makeList(pageSize?: number): Harness {
  const calls = {
    select: [] as number[],
    range: [] as Array<[number, number]>,
    cleared: 0,
    requested: [] as number[],
  };
  const loaded = new Set<number>();
  const cb: ListCallbacks = {
    getRecord: (line): RecordEntry | undefined =>
      loaded.has(line)
        ? {
            ok: true,
            value: { id: line },
            summary: [{ key: 'id', display: String(line) }],
            kind: 'object',
            count: 1,
          }
        : undefined,
    getFields: () => null,
    onSelect: (line) => calls.select.push(line),
    onRangeChange: (first, lastExclusive) => calls.range.push([first, lastExclusive]),
    onClearFilter: () => {
      calls.cleared += 1;
    },
    onRequestRecord: (line) => {
      calls.requested.push(line);
      return Promise.resolve({ ok: true, value: { id: line } });
    },
  };
  // 用例级隔离：清空文档，避免前序用例残留的列表干扰选择器与内部查询。
  globalThis.document.body.innerHTML = '';
  const list =
    pageSize === undefined ? new VirtualRecordList(cb) : new VirtualRecordList(cb, pageSize);
  globalThis.document.body.append(list.scrollEl, list.pagerEl);
  return { list, calls, loaded };
}

/**
 * 取「当前页卡片」列表。
 *
 * ⚠️ 勿用 `querySelector('.jlv-inner > *')`：同一文档内存在多个列表（前序测试遗留）时，
 * jsdom 的选择器引擎会返回 null（`querySelectorAll` 用同一选择器却正常）——属引擎怪癖。
 * 直接用 DOM 属性（`.children`）访问，稳定且更快。
 */
function cards(list: VirtualRecordList): HTMLElement[] {
  const inner = list.scrollEl.querySelector('.jlv-inner');
  return inner ? (Array.from(inner.children) as HTMLElement[]) : [];
}

/** 按标题点击分页按钮（« ‹ › » 与页码）。 */
function clickByTitle(list: VirtualRecordList, title: string): void {
  const btn = Array.from(list.pagerEl.querySelectorAll('button')).find((b) => b.title === title);
  if (!btn) throw new Error(`未找到标题为「${title}」的分页按钮`);
  btn.click();
}

/** 分页按钮的禁用态。 */
function disabledOf(list: VirtualRecordList, title: string): boolean {
  const btn = Array.from(list.pagerEl.querySelectorAll('button')).find((b) => b.title === title);
  if (!btn) throw new Error(`未找到标题为「${title}」的分页按钮`);
  return (btn as HTMLButtonElement).disabled;
}

describe('VirtualRecordList（视图层覆盖率补强）', () => {
  before(() => {
    setupWebviewDom();
    setReducedMotion(true); // 默认走同步重建，断言确定
  });

  it('未收到概览前不渲染（避免先画 0 行再刷成卡片造成闪烁）', () => {
    const { list } = makeList();
    assert.strictEqual(cards(list).length, 0, '尚未渲染任何卡片');
  });

  it('setTotalRows：页数按 pageSize 上取整且至少 1 页；getPageInfo 反映概览', () => {
    const { list } = makeList();
    list.setTotalRows(1);
    assert.deepStrictEqual(list.getPageInfo(), {
      page: 0,
      pages: 1,
      pageSize: PAGE_SIZE,
      totalRows: 1,
    });

    list.setTotalRows(100);
    assert.deepStrictEqual(list.getPageInfo(), {
      page: 0,
      pages: 5,
      pageSize: PAGE_SIZE,
      totalRows: 100,
    });

    list.setTotalRows(101);
    assert.strictEqual(list.getPageInfo().pages, 6, '101 行 → 6 页');
  });

  it('自定义 pageSize：非法值归一（0/负 → 1，小数向下取整）', () => {
    assert.strictEqual(makeList(0).list.pageSize, 1, '0 → 1');
    assert.strictEqual(makeList(-5).list.pageSize, 1, '负数 → 1');
    assert.strictEqual(makeList(7.9).list.pageSize, 7, '小数向下取整');
  });

  it('渲染当前页卡片并回调展示位区间', () => {
    const { list, calls } = makeList();
    list.setTotalRows(25);
    const rendered = cards(list);
    assert.strictEqual(rendered.length, PAGE_SIZE, '首页满页 20 条');
    assert.strictEqual(rendered[0].id, 'jlv-opt-0', '首卡片绑定真实行 0');
    assert.deepStrictEqual(calls.range.at(-1), [0, PAGE_SIZE], '回调 [0,20)');
  });

  it('同值二次 setTotalRows 不重建（防重复刷目录导致闪烁）', () => {
    const { list } = makeList();
    list.setTotalRows(50);
    const first = cards(list)[0];
    list.setTotalRows(50);
    const again = cards(list)[0];
    assert.strictEqual(first, again, '同一 DOM 节点（未重建）');
  });

  it('总行数变小 → 当前页被夹取到最后一页', () => {
    const { list } = makeList();
    list.setTotalRows(100);
    clickByTitle(list, '末页');
    assert.strictEqual(list.getPageInfo().page, 4);

    list.setTotalRows(25); // 只剩 2 页
    const info = list.getPageInfo();
    assert.strictEqual(info.pages, 2);
    assert.strictEqual(info.page, 1, '被夹到末页');
  });

  it('翻页按钮：下一页/上一页切换，首末页时对应按钮禁用', () => {
    const { list } = makeList();
    list.setTotalRows(100); // 5 页

    assert.strictEqual(disabledOf(list, '首页'), true, '首页禁用');
    assert.strictEqual(disabledOf(list, '上一页'), true, '上一页禁用');
    assert.strictEqual(disabledOf(list, '下一页'), false, '下一页可用');
    assert.strictEqual(disabledOf(list, '末页'), false, '末页可用');

    clickByTitle(list, '下一页');
    assert.strictEqual(list.getPageInfo().page, 1);
    assert.strictEqual(disabledOf(list, '上一页'), false, '翻页后上一页可用');
    assert.strictEqual(cards(list)[0]?.id, 'jlv-opt-20', '第二页首行为 20');

    clickByTitle(list, '上一页');
    assert.strictEqual(list.getPageInfo().page, 0);

    clickByTitle(list, '末页');
    assert.strictEqual(list.getPageInfo().page, 4);
    assert.strictEqual(disabledOf(list, '下一页'), true, '末页的下一页禁用');
  });

  it('页码窗口：页数≤3 全显示无省略号；页数多时含省略号且必含当前页', () => {
    const small = makeList();
    small.list.setTotalRows(40); // 2 页
    assert.strictEqual(
      small.list.pagerEl.querySelectorAll('.jlv-pager-ellipsis').length,
      0,
      '少页无省略号'
    );

    const many = makeList();
    many.list.setTotalRows(400); // 20 页
    // 窗口 [1,2,3] 位于首端 → 仅尾部省略号
    assert.strictEqual(
      many.list.pagerEl.querySelectorAll('.jlv-pager-ellipsis').length,
      1,
      '首端仅尾部省略号'
    );
    assert.strictEqual(
      many.list.pagerEl.querySelector('.jlv-pager-btn.active')?.textContent,
      '1',
      '当前页高亮'
    );

    // 跳到中段（第 6 页）→ 窗口两侧皆有省略号
    const jump = many.list.pagerEl.querySelector<HTMLInputElement>('.jlv-pager-input');
    assert.ok(jump);
    jump.value = '6';
    jump.dispatchEvent(
      new (globalThis as unknown as { window: { Event: new (t: string) => Event } }).window.Event(
        'change'
      )
    );
    assert.strictEqual(
      many.list.pagerEl.querySelector('.jlv-pager-btn.active')?.textContent,
      '6',
      '高亮随页移动'
    );
    assert.strictEqual(
      many.list.pagerEl.querySelectorAll('.jlv-pager-ellipsis').length,
      2,
      '中段两侧省略号'
    );

    // 末页 → 仅首部省略号
    clickByTitle(many.list, '末页');
    assert.strictEqual(
      many.list.pagerEl.querySelectorAll('.jlv-pager-ellipsis').length,
      1,
      '末端仅首部省略号'
    );
    assert.strictEqual(
      many.list.pagerEl.querySelector('.jlv-pager-btn.active')?.textContent,
      '20',
      '末页高亮'
    );
  });

  it('跳页输入：合法值跳转并回写，非法值回退原页码', () => {
    const { list } = makeList();
    list.setTotalRows(100); // 5 页
    // 注意：每次跳转都会重建分页条，故每次交互前须重新取输入框
    const change = (): void => {
      const el = list.pagerEl.querySelector<HTMLInputElement>('.jlv-pager-input');
      el?.dispatchEvent(
        new (globalThis as unknown as { window: { Event: new (t: string) => Event } }).window.Event(
          'change'
        )
      );
    };
    const valueOf = (): string =>
      list.pagerEl.querySelector<HTMLInputElement>('.jlv-pager-input')?.value ?? '';

    assert.ok(list.pagerEl.querySelector('.jlv-pager-input'), '存在跳页输入框');

    list.pagerEl.querySelector<HTMLInputElement>('.jlv-pager-input')!.value = '3';
    change();
    assert.strictEqual(list.getPageInfo().page, 2, '跳到第 3 页');
    assert.strictEqual(valueOf(), '3', '回写当前页');

    list.pagerEl.querySelector<HTMLInputElement>('.jlv-pager-input')!.value = '99'; // 越界
    change();
    assert.strictEqual(list.getPageInfo().page, 2, '越界不跳转');
    assert.strictEqual(valueOf(), '3', '回退原页码');

    list.pagerEl.querySelector<HTMLInputElement>('.jlv-pager-input')!.value = '0'; // 非法
    change();
    assert.strictEqual(list.getPageInfo().page, 2, '非法值不跳转');
  });

  it('过滤态 setTranslation：行数取映射长度，展示位↔真实行双向映射正确', () => {
    const { list } = makeList();
    list.setTotalRows(100); // 底层 100 行
    list.setTranslation([5, 17, 42]); // 仅 3 行命中

    const info = list.getPageInfo();
    assert.strictEqual(info.totalRows, 3, '展示行数 = 映射长度');
    assert.deepStrictEqual(list.getCurrentPageRealBounds(), [5, 42], '当前页真实行区间');

    // 跳转到真实行 17 所在页（展示位 1）
    list.scrollToLine(17);
    assert.strictEqual(list.getPageInfo().page, 0, '3 行仅一页');

    // 清除过滤 → 恢复底层总行数
    list.setTranslation(null);
    assert.strictEqual(list.getPageInfo().totalRows, 100, '恢复全量');
  });

  it('空态：0 行渲染空态；过滤无命中额外提供「清除过滤」入口', () => {
    const empty = makeList();
    empty.list.setTotalRows(0);
    assert.ok(empty.list.scrollEl.querySelector('.jlv-empty'), '渲染空态容器');

    const filtered = makeList();
    filtered.list.setTotalRows(100);
    filtered.list.setTranslation([]); // 过滤无命中
    const action = filtered.list.scrollEl.querySelector<HTMLElement>('.jlv-empty__action');
    assert.ok(action, '过滤空态提供操作入口');
    action.click();
    assert.strictEqual(filtered.calls.cleared, 1, '点击触发 onClearFilter');
  });

  it('选中：select 落 aria-selected 并可读回', () => {
    const { list } = makeList();
    list.setTotalRows(25);
    assert.strictEqual(list.getSelected(), undefined, '初始无选中');

    list.select(3);
    assert.strictEqual(list.getSelected(), 3);
    assert.strictEqual(
      list.scrollEl.querySelector('#jlv-opt-3')?.getAttribute('aria-selected'),
      'true'
    );
    assert.strictEqual(
      list.scrollEl.querySelector('#jlv-opt-4')?.getAttribute('aria-selected'),
      'false'
    );
  });

  it('键盘 ArrowDown/ArrowUp：移动选中并联动详情', () => {
    const { list, calls } = makeList();
    list.setTotalRows(25);
    const win = (
      globalThis as unknown as { window: { KeyboardEvent: new (t: string, o?: unknown) => Event } }
    ).window;

    list.scrollEl.dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );
    assert.strictEqual(list.getSelected(), 0, '无选中时从本页首行开始');
    assert.deepStrictEqual(calls.select.at(-1), 0, '联动 onSelect');

    list.scrollEl.dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );
    assert.strictEqual(list.getSelected(), 1, '下移一格');

    list.scrollEl.dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })
    );
    assert.strictEqual(list.getSelected(), 0, '上移一格');
  });

  it('键盘 Home/End/PageDown：翻页并选中目标行', () => {
    const { list, calls } = makeList();
    list.setTotalRows(100); // 5 页
    const win = (
      globalThis as unknown as { window: { KeyboardEvent: new (t: string, o?: unknown) => Event } }
    ).window;

    list.scrollEl.dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'PageDown', bubbles: true })
    );
    assert.strictEqual(list.getPageInfo().page, 1, 'PageDown 翻到第 2 页');
    assert.strictEqual(list.getSelected(), 20, '选中新页首行');

    list.scrollEl.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    assert.strictEqual(list.getPageInfo().page, 4, 'End 到末页');
    assert.strictEqual(list.getSelected(), 99, '选中末行');

    list.scrollEl.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    assert.strictEqual(list.getPageInfo().page, 0, 'Home 回首页');
    assert.strictEqual(list.getSelected(), 0);
    assert.ok(calls.select.length >= 3, '键盘导航均联动详情');
  });

  it('键盘 Enter：激活当前选中行（无选中则本页首行）', () => {
    const { list, calls } = makeList();
    list.setTotalRows(25);
    const win = (
      globalThis as unknown as { window: { KeyboardEvent: new (t: string, o?: unknown) => Event } }
    ).window;

    list.scrollEl.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.strictEqual(list.getSelected(), 0, '无选中 → 本页首行');
    assert.strictEqual(calls.select.at(-1), 0);

    list.select(7);
    list.scrollEl.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.strictEqual(calls.select.at(-1), 7, '选中 → 激活该行');
  });

  it('dispose：清空卡片并移除分页条，之后调用不抛错', () => {
    const { list } = makeList();
    list.setTotalRows(25);
    assert.ok(cards(list).length > 0);

    list.dispose();
    assert.strictEqual(cards(list).length, 0, '卡片已清空');
    assert.strictEqual(list.pagerEl.isConnected, false, '分页条已从文档移除');

    assert.doesNotThrow(() => list.refresh(), 'dispose 后 refresh 安全');
    assert.doesNotThrow(() => list.setTotalRows(10), 'dispose 后 setTotalRows 安全');
  });

  it('换页动画路径（reduced-motion 关闭）：旧卡片先滑出，动画结束后重建新页', async () => {
    setReducedMotion(false);
    try {
      const { list } = makeList();
      list.setTotalRows(100);
      const firstCard = cards(list)[0];
      assert.ok(firstCard);

      clickByTitle(list, '下一页');
      assert.strictEqual(list.getPageInfo().page, 1, '页码已切换');
      assert.ok(cards(list)[0]?.classList.contains('jlv-card-leaving'), '旧卡片进入滑出态');

      await wait(400); // 动画时长 160ms + 卡片数错峰
      const after = cards(list)[0];
      assert.strictEqual(after?.id, 'jlv-opt-20', '动画结束后重建为第二页');
      assert.ok(!after?.classList.contains('jlv-card-leaving'), '新卡片不带滑出态');
    } finally {
      setReducedMotion(true);
    }
  });
});
