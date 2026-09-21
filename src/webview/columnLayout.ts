/**
 * columnLayout.ts — 左右两栏布局协调模块（从 webviewEntry.main 抽出，T5 #30）。
 *
 * 职责（纯 DOM 协调，不含业务逻辑）：
 *   - 收起/展开「拉抽屉」动画（含 prefers-reduced-motion 降级）；
 *   - 分隔条拖拽调宽（双击恢复默认）；
 *   - 窄容器(<700px)响应式：off-canvas 目录抽屉（汉堡 + 遮罩），跨断点重排。
 *
 * 行为抽取（非 DOM 抽取）：DOM 节点的创建与挂载顺序仍由 main 负责（保证 z-order 与首帧不变），
 * 本模块仅接收已创建的节点并接管全部逻辑/状态/事件接线，行为与原 main 内联实现逐字一致。
 * 通过依赖注入与 main 解耦：rootEl / detailRoot / 各节点 / 刷新与导航回调 / 四个持久化辅助由外部提供。
 */

/** 左栏默认宽度（拖拽分栏基准）。 */
export const DEFAULT_LIST_WIDTH = 320;
/** 收起/展开动画时长与缓动（与设计体系 --jlv-dur-slow / --jlv-ease 对齐）。 */
const COL_ANIM_MS = 300;
const COL_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';

export interface ColumnLayoutDeps {
  /** #app 根节点。 */
  rootEl: HTMLElement;
  /** 详情面板根（syncResponsive 不依赖，但保留以便未来扩展）。 */
  detailRoot: HTMLElement;
  /** 左栏容器（main 已创建并挂载）。 */
  leftCol: HTMLDivElement;
  /** 分隔条（main 已创建并挂载）。 */
  resizer: HTMLDivElement;
  /** 折叠按钮（已挂到 resizer）。 */
  collapseBtn: HTMLButtonElement;
  /** 展开按钮（main 已挂到 rootEl）。 */
  expandBtn: HTMLButtonElement;
  /** 窄容器汉堡菜单（main 已 prepend 到 detailRoot 的 .jlv-detail-header）。 */
  hamburger: HTMLButtonElement;
  /** 抽屉遮罩（main 已创建并挂载）。 */
  backdrop: HTMLDivElement;
  /** 重排后刷新列表（syncResponsive 宽容器分支调用）。 */
  refreshList: () => void;
  /** 折叠态变化后刷新导航按钮可用态。 */
  updateNavEnabled: () => void;
  /** 持久化左栏折叠态。 */
  saveListCollapsed: (collapsed: boolean) => void;
  /** 读取持久化折叠态。 */
  listCollapsedFromStore: () => boolean;
  /** 读取持久化左栏宽度。 */
  listWidthFromStore: () => number | null;
  /** 持久化左栏宽度。 */
  saveListWidth: (w: number) => void;
}

export interface ColumnLayout {
  /** 开/关窄容器目录抽屉（list-open 类驱动 CSS 滑入滑出）。 */
  setDrawer: (open: boolean) => void;
  /** 依据窄/宽容器收敛布局（跨断点重排时调用）。 */
  syncResponsive: () => void;
  /** 当前是否窄容器态。 */
  isNarrow: () => boolean;
  /** 释放 ResizeObserver（main 的 beforeunload 清理调用）。 */
  dispose: () => void;
}

export function createColumnLayout(deps: ColumnLayoutDeps): ColumnLayout {
  const { rootEl, leftCol, resizer, collapseBtn, expandBtn, hamburger, backdrop } = deps;

  let listCollapsed = false;
  let listAnimTimer: ReturnType<typeof setTimeout> | undefined;
  /** 窄容器态：布局以 #app 容器宽度为基准（与 CSS @container max-width:699px 对齐），而非视口。
   *  首次取初始容器宽度；后续由 onContainerResize() 跨断点时更新并触发重排。 */
  let narrow = rootEl.clientWidth < 700;
  /** 最近一次展开态下的左栏宽度（用于展开动画的初始边距）。 */
  let expandedWidthPx: number;

  /** 直接设置折叠/展开的最终 UI 状态（按钮显隐 + 持久化）。 */
  function applyCollapsedUI(collapsed: boolean): void {
    listCollapsed = collapsed;
    leftCol.classList.toggle('collapsed', collapsed);
    // resizer 保持恒定 5px，不随收起变化 → 避免动画结束那一刻右栏因 resizer 宽度跳变产生 5px 抖动
    collapseBtn.hidden = collapsed;
    expandBtn.hidden = !collapsed;
    expandBtn.title = '展开左栏';
    // 收起/展开不影响当前页数据，无需重建目录 DOM
    deps.saveListCollapsed(collapsed);
    deps.updateNavEnabled();
  }

  /** 清除 JS 注入的过渡/滑移样式；宽度由 .collapsed 或内联 width 决定（保留展开宽度）。
   *  必须同时清 flexBasis：动画期间写入了内联 flex-basis，而左栏是 flex:0 0 auto，
   *  flex-basis 优先于 width 决定尺寸；不清除会导致 resizer 拖拽改 width 失效。 */
  function resetColInline(): void {
    leftCol.style.transition = '';
    leftCol.style.transform = '';
    leftCol.style.marginRight = '';
    leftCol.style.opacity = '';
    leftCol.style.flexBasis = '';
  }

  const reduceMotion = (): boolean =>
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /**
   * 收起/展开「拉抽屉」动画：
   *   - 收起：左栏整体 translateX 0 → -W（向外移出）+ margin-right 0 → -W（右栏向右让出的空间收拢、
   *           实际是右栏顺势左移补位）。不加淡入淡出。
   *   - 展开：左栏 translateX -W → 0（向内移入）+ margin-right -W → 0（右栏右移归位）。
   * 因 margin-right 与右栏占据的 slot 宽度保持在动画结束前同步（负边距让右栏提前满幅），
   * 所以动画结束归零 flex 槽位时右栏宽度已就位 → 无结尾抖动。
   */
  function setListCollapsed(collapsed: boolean): void {
    if (reduceMotion()) {
      clearTimeout(listAnimTimer);
      resetColInline();
      applyCollapsedUI(collapsed);
      return;
    }
    const W = expandedWidthPx;
    clearTimeout(listAnimTimer);
    const trans = `transform ${COL_ANIM_MS}ms ${COL_EASE}, margin-right ${COL_ANIM_MS}ms ${COL_EASE}`;
    // 按钮显隐即时切换，便于反向操作
    collapseBtn.hidden = collapsed;
    expandBtn.hidden = !collapsed;
    expandBtn.title = '展开左栏';

    if (collapsed) {
      // 收起：抽屉向外移出
      leftCol.classList.remove('collapsed');
      leftCol.style.width = `${W}px`;
      leftCol.style.flexBasis = `${W}px`;
      leftCol.style.minWidth = '0';
      leftCol.style.overflow = 'hidden';
      leftCol.style.transform = 'translateX(0)';
      leftCol.style.marginRight = '0px';
      leftCol.style.transition = 'none';
      void leftCol.offsetWidth; // 强制提交起始帧
      leftCol.style.transition = trans;
      leftCol.style.transform = `translateX(-${W}px)`;
      leftCol.style.marginRight = `-${W}px`;
    } else {
      // 展开：抽屉向内移入
      applyCollapsedUI(false); // 还原占位（宽度回到展开值）
      leftCol.style.width = `${W}px`;
      leftCol.style.flexBasis = `${W}px`;
      leftCol.style.minWidth = '0';
      leftCol.style.overflow = 'hidden';
      leftCol.style.transition = 'none';
      leftCol.style.transform = `translateX(-${W}px)`;
      leftCol.style.marginRight = `-${W}px`; // 使右栏保持当前满幅，避免先跳位
      void leftCol.offsetWidth; // 强制提交起始帧
      leftCol.style.transition = trans;
      leftCol.style.transform = 'translateX(0)';
      leftCol.style.marginRight = '0px';
    }

    // 动画结束后：清掉滑移/过渡，落到静态折叠态（宽度归零由 .collapsed 完成）
    listAnimTimer = setTimeout(() => {
      resetColInline();
      applyCollapsedUI(collapsed);
    }, COL_ANIM_MS + 40);
  }

  collapseBtn.addEventListener('click', () => setListCollapsed(true));
  expandBtn.addEventListener('click', () => setListCollapsed(false));

  function clampListWidth(w: number): number {
    return Math.max(180, Math.min(w, Math.max(DEFAULT_LIST_WIDTH, window.innerWidth * 0.6)));
  }
  function applyListWidth(w: number): void {
    const cw = clampListWidth(w);
    leftCol.style.width = `${cw}px`;
    expandedWidthPx = cw;
  }
  // 恢复上次拖拽宽度
  const savedW = deps.listWidthFromStore();
  expandedWidthPx = savedW ?? DEFAULT_LIST_WIDTH;
  if (savedW !== null) applyListWidth(savedW);
  // 恢复折叠状态（仅宽屏；窄屏由 syncResponsive 的抽屉模式接管，不在此恢复）
  // 用 applyCollapsedUI（无动画），避免挂载即播收起动画导致首帧闪烁抖动。
  if (!narrow && deps.listCollapsedFromStore()) applyCollapsedUI(true);

  let dragStartX = 0;
  let dragStartW = 0;
  resizer.addEventListener('pointerdown', (e) => {
    if (listCollapsed) return; // 折叠态不允许拖拽
    if ((e.target as HTMLElement).closest('.jlv-resizer__toggle')) return; // 折叠按钮不触发拖拽
    resizer.classList.add('active');
    dragStartX = e.clientX;
    dragStartW = leftCol.getBoundingClientRect().width;
    resizer.setPointerCapture(e.pointerId);
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!resizer.classList.contains('active')) return;
    applyListWidth(clampListWidth(dragStartW + (e.clientX - dragStartX)));
  });
  const endDrag = (e: PointerEvent): void => {
    if (!resizer.classList.contains('active')) return;
    resizer.classList.remove('active');
    const cw = clampListWidth(dragStartW + (e.clientX - dragStartX));
    deps.saveListWidth(cw);
    expandedWidthPx = cw;
  };
  resizer.addEventListener('pointerup', endDrag);
  resizer.addEventListener('pointercancel', endDrag);
  resizer.addEventListener('dblclick', () => {
    if (listCollapsed) return;
    applyListWidth(DEFAULT_LIST_WIDTH);
    deps.saveListWidth(DEFAULT_LIST_WIDTH);
  });

  /** 开/关窄容器目录抽屉（list-open 类驱动 CSS 滑入滑出）。 */
  function setDrawer(open: boolean): void {
    rootEl.classList.toggle('list-open', open);
    backdrop.hidden = !open;
    hamburger.setAttribute('aria-label', open ? '收起记录目录' : '打开记录目录');
    hamburger.title = open ? '收起记录目录' : '记录目录';
  }
  hamburger.addEventListener('click', () => setDrawer(!rootEl.classList.contains('list-open')));
  backdrop.addEventListener('click', () => setDrawer(false));

  /** 依据窄/宽容器收敛布局。 */
  function syncResponsive(): void {
    // 跨断点/重建布局时收拢抽屉，避免残留打开态。
    setDrawer(false);
    if (narrow) {
      // 窄容器：清掉桌面折叠态/内联样式；目录抽屉默认收起，详情铺满为主视图。
      resetColInline();
      leftCol.classList.remove('collapsed');
      listCollapsed = false;
      collapseBtn.hidden = true;
      expandBtn.hidden = true;
    } else {
      // 宽容器：恢复桌面两栏（持久化折叠则保持）
      if (deps.listCollapsedFromStore()) applyCollapsedUI(true);
      else applyCollapsedUI(false);
      deps.refreshList();
    }
  }

  /** 容器(面板)宽度跨窄/宽断点 → 更新 narrow 并重排；同侧变化（拖动调整面板）不重排。 */
  let roNarrow: ResizeObserver | null = null;
  function onContainerResize(): void {
    const n = rootEl.clientWidth < 700;
    if (n === narrow) return;
    narrow = n;
    syncResponsive();
  }
  if (typeof window.ResizeObserver === 'function') {
    roNarrow = new ResizeObserver(onContainerResize);
    roNarrow.observe(rootEl);
  } else {
    // 回退：不支持容器查询时跟随视口尺寸
    window.addEventListener('resize', onContainerResize);
  }
  syncResponsive();

  return {
    setDrawer,
    syncResponsive,
    isNarrow: () => narrow,
    dispose: () => {
      clearTimeout(listAnimTimer);
      if (roNarrow) roNarrow.disconnect();
    },
  };
}
