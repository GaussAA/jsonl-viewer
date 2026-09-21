import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { setupWebviewDom } from './domHarness.ts';
import { createColumnLayout, type ColumnLayoutDeps } from '../columnLayout.ts';

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
  function makeFixtures(clientWidth = 0): {
    deps: ColumnLayoutDeps;
    rootEl: HTMLDivElement;
    collapseBtn: HTMLButtonElement;
    expandBtn: HTMLButtonElement;
    hamburger: HTMLButtonElement;
    backdrop: HTMLDivElement;
    calls: { refresh: number; nav: number; saved: boolean[]; savedW: number[] };
  } {
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
      listCollapsedFromStore: () => false,
      listWidthFromStore: () => null,
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
});
