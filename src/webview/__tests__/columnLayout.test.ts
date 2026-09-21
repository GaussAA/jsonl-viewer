import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { setupWebviewDom } from './domHarness.ts';
import { createColumnLayout, type ColumnLayoutDeps } from '../columnLayout.ts';

/**
 * 原生 setTimeout 的早期捕获。
 *
 * domHarness.setupWebviewDom() 会把**所有** setTimeout 包成 unref 版（避免握手超时定时器
 * 阻塞进程退出）；若测试自己也用被 unref 的定时器等待动画落定，事件循环会提前空转而
 * 抛出「Promise resolution is still pending」。故在补丁生效前捕获原生版本，专供等待。
 */
const REAL_SET_TIMEOUT = globalThis.setTimeout;

/**
 * columnLayout 模块级回归测试（T5 #30）。
 *
 * 价值：#30 把 main() 内联的收起/展开动画、拖拽调宽、窄容器响应式抽屉抽成独立工厂。
 * 本测试直接用伪 DOM + 桩依赖驱动工厂，验证「抽屉开关 / 折叠接线 / 宽窄分支 / 释放」行为，
 * 作为该模块的精确回归护栏（不依赖 webviewEntry 全量装配）。
 */
describe('createColumnLayout（T5 #30 抽取回归）', () => {
  let doc: Document;

  before(() => {
    setupWebviewDom();
    doc = globalThis.document;
  });

  /** 构造工厂所需节点 + 可观测桩依赖。 */
  function makeFixtures(
    clientWidth = 0,
    extra: { savedWidth?: number | null; collapsedFromStore?: boolean; reduceMotion?: boolean } = {}
  ): {
    deps: ColumnLayoutDeps;
    rootEl: HTMLDivElement;
    collapseBtn: HTMLButtonElement;
    expandBtn: HTMLButtonElement;
    hamburger: HTMLButtonElement;
    backdrop: HTMLDivElement;
    calls: { refresh: number; nav: number; saved: boolean[]; savedW: number[] };
  } {
    // 每个夹具都显式设定 matchMedia 结果，避免测试间相互影响（reduce-motion 分支）。
    const win = globalThis.window as unknown as { matchMedia: (q: string) => unknown };
    win.matchMedia = (q: string) => ({
      matches: extra.reduceMotion === true,
      media: q,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    });
    (globalThis as unknown as Record<string, unknown>).matchMedia = win.matchMedia;

    const rootEl = doc.createElement('div');
    // jsdom 无布局引擎，clientWidth 恒 0；用实例属性覆盖以驱动窄/宽分支。
    Object.defineProperty(rootEl, 'clientWidth', { value: clientWidth, configurable: true });

    const detailRoot = doc.createElement('div');
    const header = doc.createElement('div');
    header.className = 'jlv-detail-header';
    detailRoot.appendChild(header);

    const leftCol = doc.createElement('div');
    const resizer = doc.createElement('div');
    const collapseBtn = doc.createElement('button');
    const expandBtn = doc.createElement('button');
    expandBtn.hidden = true;
    const hamburger = doc.createElement('button');
    const backdrop = doc.createElement('div');
    backdrop.hidden = true;

    const calls = { refresh: 0, nav: 0, saved: [] as boolean[], savedW: [] as number[] };
    const deps: ColumnLayoutDeps = {
      rootEl,
      detailRoot,
      leftCol,
      resizer,
      collapseBtn,
      expandBtn,
      hamburger,
      backdrop,
      refreshList: () => {
        calls.refresh += 1;
      },
      updateNavEnabled: () => {
        calls.nav += 1;
      },
      saveListCollapsed: (c) => {
        calls.saved.push(c);
      },
      listCollapsedFromStore: () => extra.collapsedFromStore === true,
      listWidthFromStore: () => extra.savedWidth ?? null,
      saveListWidth: (w) => {
        calls.savedW.push(w);
      },
    };
    return { deps, rootEl, collapseBtn, expandBtn, hamburger, backdrop, calls };
  }

  it('setDrawer 开/关：切换 list-open 类、遮罩显隐、汉堡 aria-label', () => {
    const { deps, rootEl, hamburger, backdrop } = makeFixtures();

    const layout = createColumnLayout(deps);
    const initialAria = hamburger.getAttribute('aria-label');

    layout.setDrawer(true);
    assert.ok(rootEl.classList.contains('list-open'), '打开后 rootEl 含 list-open');
    assert.strictEqual(backdrop.hidden, false, '打开后遮罩可见');
    assert.notStrictEqual(hamburger.getAttribute('aria-label'), initialAria, 'aria-label 已切换');

    layout.setDrawer(false);
    assert.ok(!rootEl.classList.contains('list-open'), '关闭后 rootEl 不含 list-open');
    assert.strictEqual(backdrop.hidden, true, '关闭后遮罩隐藏');
    assert.strictEqual(hamburger.getAttribute('aria-label'), initialAria, 'aria-label 复原');
  });

  it('点击汉堡菜单切换抽屉，点击遮罩关闭抽屉', () => {
    const { deps, rootEl, hamburger, backdrop } = makeFixtures();
    createColumnLayout(deps);

    hamburger.click();
    assert.ok(rootEl.classList.contains('list-open'), '点击汉堡后抽屉打开');
    hamburger.click();
    assert.ok(!rootEl.classList.contains('list-open'), '再次点击汉堡后抽屉关闭');

    hamburger.click();
    assert.ok(rootEl.classList.contains('list-open'), '抽屉再次打开');
    backdrop.click();
    assert.ok(!rootEl.classList.contains('list-open'), '点击遮罩后抽屉关闭');
  });

  it('点击折叠按钮触发收起（按钮显隐即时切换，非 reduce-motion 路径）', () => {
    const { deps, collapseBtn, expandBtn } = makeFixtures();
    createColumnLayout(deps);

    collapseBtn.click();
    assert.strictEqual(collapseBtn.hidden, true, '收起后折叠按钮隐藏');
    assert.strictEqual(expandBtn.hidden, false, '收起后展开按钮显示');
  });

  it('窄容器（clientWidth<700）：syncResponsive 收拢抽屉且不刷新列表', () => {
    const { deps, rootEl, collapseBtn, expandBtn, calls } = makeFixtures(500);
    const layout = createColumnLayout(deps);

    assert.strictEqual(layout.isNarrow(), true, '窄容器态');
    assert.ok(!rootEl.classList.contains('list-open'), '窄态默认收拢抽屉');
    assert.strictEqual(collapseBtn.hidden, true, '窄态隐藏折叠按钮');
    assert.strictEqual(expandBtn.hidden, true, '窄态隐藏展开按钮');
    assert.strictEqual(calls.refresh, 0, '窄态不刷新列表');
  });

  it('宽容器（clientWidth>=700）：syncResponsive 刷新列表并广播导航态', () => {
    const { deps, collapseBtn, expandBtn, calls } = makeFixtures(900);
    const layout = createColumnLayout(deps);

    assert.strictEqual(layout.isNarrow(), false, '宽容器态');
    assert.strictEqual(calls.refresh, 1, '宽态刷新列表一次');
    assert.ok(calls.nav >= 1, 'updateNavEnabled 已被调用');
    // 宽态持久化折叠为 false → applyCollapsedUI(false) → 两按钮均隐藏
    assert.strictEqual(collapseBtn.hidden, false, '宽态折叠按钮可见');
    assert.strictEqual(expandBtn.hidden, true, '宽态展开按钮隐藏');
  });

  it('dispose 幂等且不抛错（释放 ResizeObserver 与动画定时器）', () => {
    const { deps } = makeFixtures();
    const layout = createColumnLayout(deps);
    assert.doesNotThrow(() => layout.dispose());
    assert.doesNotThrow(() => layout.dispose());
  });

  /* ---------------- 收起/展开动画、拖拽与断点重排（覆盖率补强） ---------------- */

  it('收起动画（非 reduce-motion）：写滑移样式，动画结束后落定 collapsed 态', async () => {
    const { deps, collapseBtn, expandBtn } = makeFixtures(900);
    const leftCol = deps.leftCol as HTMLDivElement;
    createColumnLayout(deps);

    collapseBtn.click();
    assert.strictEqual(collapseBtn.hidden, true, '折叠按钮即时隐藏');
    assert.strictEqual(expandBtn.hidden, false, '展开按钮即时显示');
    assert.match(leftCol.style.transition, /transform/, '已写入过渡');
    assert.strictEqual(leftCol.style.transform, 'translateX(-320px)', '滑移出位（默认宽 320）');
    assert.strictEqual(leftCol.style.marginRight, '-320px', '负边距让右栏补位');

    await wait(400);
    assert.ok(leftCol.classList.contains('collapsed'), '动画结束落定折叠态');
    assert.strictEqual(leftCol.style.transform, '', '内联滑移样式已清除');
  });

  it('展开动画（非 reduce-motion）：从折叠态滑回并清除内联样式', async () => {
    const { deps, expandBtn } = makeFixtures(900);
    const leftCol = deps.leftCol as HTMLDivElement;
    const layout = createColumnLayout(deps);

    (deps.collapseBtn as HTMLButtonElement).click();
    await wait(400);
    assert.ok(leftCol.classList.contains('collapsed'), '先落定折叠态');

    expandBtn.click();
    assert.match(leftCol.style.transition, /margin-right/, '展开写入过渡');
    assert.strictEqual(leftCol.style.transform, 'translateX(0)', '滑入到位');

    await wait(400);
    assert.ok(!leftCol.classList.contains('collapsed'), '动画结束回到展开态');
    layout.dispose();
  });

  it('reduce-motion：点折叠即时落定（不写滑移样式、不排动画定时器）', () => {
    const { deps, collapseBtn } = makeFixtures(900, { reduceMotion: true });
    const leftCol = deps.leftCol as HTMLDivElement;
    createColumnLayout(deps);

    collapseBtn.click();
    assert.ok(leftCol.classList.contains('collapsed'), '即时落定');
    assert.strictEqual(leftCol.style.transform, '', '无滑移样式');
  });

  it('拖拽分隔条：按位移调整宽度并在 pointerup 落盘', () => {
    const { deps, calls } = makeFixtures(900);
    const resizer = deps.resizer as HTMLDivElement;
    const leftCol = deps.leftCol as HTMLDivElement;
    // jsdom 无布局与指针捕获：补桩（宽 320 + 位移 160 = 480）
    (
      leftCol as unknown as { getBoundingClientRect: () => { width: number } }
    ).getBoundingClientRect = () => ({
      width: 320,
    });
    (resizer as unknown as { setPointerCapture: (id?: number) => void }).setPointerCapture =
      () => {};

    createColumnLayout(deps);
    dispatchPointer(resizer, 'pointerdown', 100);
    assert.ok(resizer.classList.contains('active'), '拖拽开始');

    dispatchPointer(resizer, 'pointermove', 260);
    assert.strictEqual(leftCol.style.width, '480px', '320 + 位移160');

    dispatchPointer(resizer, 'pointerup', 260);
    assert.ok(!resizer.classList.contains('active'), '拖拽结束');
    assert.deepStrictEqual(calls.savedW, [480], '宽度已落盘');
  });

  it('拖拽宽度夹取下限（大幅左移取 180）', () => {
    const { deps } = makeFixtures(900);
    const resizer = deps.resizer as HTMLDivElement;
    const leftCol = deps.leftCol as HTMLDivElement;
    (
      leftCol as unknown as { getBoundingClientRect: () => { width: number } }
    ).getBoundingClientRect = () => ({
      width: 320,
    });
    (resizer as unknown as { setPointerCapture: (id?: number) => void }).setPointerCapture =
      () => {};
    createColumnLayout(deps);

    dispatchPointer(resizer, 'pointerdown', 500);
    dispatchPointer(resizer, 'pointermove', 0);
    assert.strictEqual(leftCol.style.width, '180px', '下限夹取');
  });

  it('折叠态禁止拖拽（pointerdown 直接返回）', () => {
    const { deps } = makeFixtures(900, { reduceMotion: true });
    const resizer = deps.resizer as HTMLDivElement;
    (resizer as unknown as { setPointerCapture: (id?: number) => void }).setPointerCapture =
      () => {};
    createColumnLayout(deps);

    (deps.collapseBtn as HTMLButtonElement).click(); // 折叠
    dispatchPointer(resizer, 'pointerdown', 100);
    assert.ok(!resizer.classList.contains('active'), '折叠态不启动拖拽');
  });

  it('双击分隔条恢复默认宽度并落盘', () => {
    const { deps, calls } = makeFixtures(900);
    const resizer = deps.resizer as HTMLDivElement;
    const leftCol = deps.leftCol as HTMLDivElement;
    (
      leftCol as unknown as { getBoundingClientRect: () => { width: number } }
    ).getBoundingClientRect = () => ({
      width: 320,
    });
    (resizer as unknown as { setPointerCapture: (id?: number) => void }).setPointerCapture =
      () => {};
    createColumnLayout(deps);

    dispatchPointer(resizer, 'pointerdown', 100);
    dispatchPointer(resizer, 'pointermove', 300); // 先改宽
    dispatchMouse(resizer, 'dblclick');
    assert.strictEqual(leftCol.style.width, '320px', '恢复默认宽');
    assert.deepStrictEqual(calls.savedW, [320], '默认宽落盘');
  });

  it('初始化：持久化宽度存在时即应用，缺省则不写内联宽', () => {
    const withSaved = makeFixtures(900, { savedWidth: 400 });
    createColumnLayout(withSaved.deps);
    assert.strictEqual(
      (withSaved.deps.leftCol as HTMLDivElement).style.width,
      '400px',
      '应用持久化宽度'
    );

    const noSaved = makeFixtures(900);
    createColumnLayout(noSaved.deps);
    assert.strictEqual(
      (noSaved.deps.leftCol as HTMLDivElement).style.width,
      '',
      '无持久化值不写内联宽'
    );
  });

  it('宽容器 + 持久化折叠态：初始化即落定折叠', () => {
    const { deps } = makeFixtures(900, { collapsedFromStore: true, reduceMotion: true });
    const leftCol = deps.leftCol as HTMLDivElement;
    createColumnLayout(deps);
    assert.ok(leftCol.classList.contains('collapsed'), '宽态恢复持久化折叠');
  });

  it('ResizeObserver 跨断点（窄→宽）触发 syncResponsive 重排并刷新列表', () => {
    const captured: Array<() => void> = [];
    class CapturingRO {
      constructor(cb: () => void) {
        captured.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const g = globalThis as unknown as Record<string, unknown>;
    const win = g.window as Record<string, unknown>;
    const prevWin = win.ResizeObserver;
    const prevG = g.ResizeObserver;
    win.ResizeObserver = CapturingRO;
    g.ResizeObserver = CapturingRO;

    try {
      const { deps, rootEl, calls } = makeFixtures(500); // 起始窄
      const layout = createColumnLayout(deps);
      assert.strictEqual(layout.isNarrow(), true, '起始窄容器');
      assert.strictEqual(captured.length, 1, '已观测容器');

      Object.defineProperty(rootEl, 'clientWidth', { value: 1200, configurable: true });
      captured[0](); // 触发 onContainerResize

      assert.strictEqual(layout.isNarrow(), false, '跨断点转宽');
      assert.ok(calls.refresh >= 1, '宽态重排刷新列表');
      layout.dispose();
    } finally {
      win.ResizeObserver = prevWin;
      g.ResizeObserver = prevG;
    }
  });
});

/** 派发指针事件（jsdom 无 PointerEvent 构造器时用 MouseEvent 承载 clientX）。 */
function dispatchPointer(target: Element, type: string, clientX: number): void {
  const win = (
    globalThis as unknown as { window: { MouseEvent: new (t: string, o?: unknown) => Event } }
  ).window;
  target.dispatchEvent(new win.MouseEvent(type, { clientX, bubbles: true }));
}

/** 派发普通鼠标事件。 */
function dispatchMouse(target: Element, type: string): void {
  const win = (
    globalThis as unknown as { window: { MouseEvent: new (t: string, o?: unknown) => Event } }
  ).window;
  target.dispatchEvent(new win.MouseEvent(type, { bubbles: true }));
}

/** 等待若干毫秒（供动画落定断言）——须用未被 unref 的原生定时器。 */
function wait(ms: number): Promise<void> {
  return new Promise((r) => REAL_SET_TIMEOUT(() => r(), ms));
}
