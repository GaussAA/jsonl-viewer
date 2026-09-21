/**
 * webviewEntry.ts — webview 前端入口（组装层）。
 *
 * 职责：创建 RPC 总线、维护应用状态（概览/记录缓存/字段）、驱动「按需拉取调度器」、
 * 把虚拟滚动列表 + 概要栏 + 详情占位接到一起。整体内存只与可视区成正比：
 *   - 记录缓存：容量受限的 LRU（cache.maxEntries），滚动出最远区域的记录被逐出；
 *   - 拉取调度：ThrottleQueue「节流 + 合并 + supersede」——再快的滚动也只发 1~2 个
 *     readRecords，且只取缺失段；迟到的旧窗口响应被丢弃。
 *
 * Task 5/6 的接口：详情占位 + onSelect 钩子给 Task 5；searchInput/onFilter 与 setFields
 * 给 Task 6；这里都用注入钩子/字段预留，不改动协议即可对接。
 */

import { computeFetchWindow, LRUCache, segmentSortedLines, ThrottleQueue } from './logic.ts';
import type { FieldLike } from './logic.ts';
import type { RecordEntry } from './virtualScroll.ts';
import { VirtualRecordList } from './virtualScroll.ts';
import { createToolbar } from './toolbar.ts';
import type { ToolbarInfo } from './toolbar.ts';
import { createDetailTree, type DetailTreeNavHandlers } from './detailTree.ts';
import { createColumnLayout, type ColumnLayout } from './columnLayout.ts';
import { createQueryActions, type QueryActions } from './queryActions.ts';
import { createPersistence } from './persistence.ts';
import { createVSCodeApi, RpcBus } from './rpc.ts';
import { mergePersistedState, summarizeWithLayout } from './queryLogic.ts';
import type { FieldCondition, FieldLayout } from './queryLogic.ts';
import { HostEndpoint } from '../protocol/rpc.ts';
import type { InitPayload, OverviewPayload, RecordsPayload } from '../protocol/rpc.ts';
import { CSS_TEXT } from './styles.ts';
import { INIT_TIMEOUT_MS, RPC_HEAVY_TIMEOUT_MS } from '../constants.ts';

/** 渲染用的记录形状（与 LRUCache 值一致）。 */
export type CachedRecord = RecordEntry & { value?: unknown };

function injectStyle(): void {
  const style = document.createElement('style');
  style.textContent = CSS_TEXT;
  document.head.appendChild(style);

  /* --- 滚动条：完全隐藏（不显示、不占位），保留滚动能力 ---
   * VS Code webview 会注入 `* { scrollbar-width: thin !important }`，
   * 这里用同级别 !important 且更高的选择器覆盖为 none，并隐藏 webkit 伪元素。
   * 隐藏后鼠标滚轮 / 触摸 / 键盘翻页仍可正常滚动，只是不再显示可见滚动条。
   */
  const PROTECTED = 'data-jlv-scrollbar';
  const s = document.createElement('style');
  s.setAttribute(PROTECTED, '');
  s.textContent = `
    /* 隐藏所有滚动条但不禁止滚动 */
    html, body, #app,
    .jlv-list-wrap, .jlv-tree-body,
    .jlv-layout-list, .jlv-float-panel {
      scrollbar-width: none !important;
      scrollbar-color: transparent transparent !important;
    }
    html::-webkit-scrollbar, body::-webkit-scrollbar, #app::-webkit-scrollbar,
    .jlv-list-wrap::-webkit-scrollbar, .jlv-tree-body::-webkit-scrollbar,
    .jlv-layout-list::-webkit-scrollbar, .jlv-float-panel::-webkit-scrollbar {
      width: 0 !important;
      height: 0 !important;
      display: none !important;
      background: transparent !important;
    }
    ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
  `;
  document.head.appendChild(s);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 顶部可操作提示横幅（文件已变更 / 重新加载 / 重试）。 */
function createBanner(): {
  root: HTMLElement;
  show(text: string, actionLabel?: string, onAction?: () => void): void;
  hide(): void;
  get active(): boolean;
} {
  const root = document.createElement('div');
  root.className = 'jlv-banner';
  root.hidden = true;

  const text = document.createElement('span');
  text.className = 'jlv-banner-text';
  const action = document.createElement('button');
  action.className = 'jlv-tbtn jlv-banner-action';
  let onAction: (() => void) | undefined;
  action.addEventListener('click', () => onAction?.());
  root.append(text, action);

  const ctrl = {
    root,
    show(message: string, actionLabel = '重新加载', handler?: () => void) {
      text.textContent = message;
      onAction = handler;
      if (actionLabel) {
        action.textContent = actionLabel;
        action.hidden = false;
      } else {
        action.hidden = true;
      }
      root.hidden = false;
      ctrl.active = true;
    },
    hide() {
      root.hidden = true;
      ctrl.active = false;
    },
    active: false,
  };
  return ctrl;
}

interface AppState {
  overview: OverviewPayload | null;
  /** 行号 -> 记录（LRU，容量受限，逐出即释放底层值对象）。 */
  cache: LRUCache<number, CachedRecord>;
  /** 正被在途请求覆盖的行号，避免对同一缺失窗口重复发射。 */
  pending: Set<number>;
  /** 当前在途 readRecords 的 supersede 标记。 */
  inFlight: { rid: string; superseded: boolean } | null;
  fields: readonly FieldLike[] | null;
  /** 字段显示定制布局（驱动摘要卡片）。 */
  fieldLayout: FieldLayout;
  /** 已解析到的最大行号（概要栏「已解析」）。 */
  maxLoaded: number;
  selectedLine: number | undefined;
  /** 当前在途 readRecord（详情）请求的 supersede 标记，切换选中行时取消。 */
  detailInFlight: { rid: string } | null;

  /* Task 6：搜索 / 过滤 / 持久化 */
  searchQuery: string;
  /** 最近一次搜索结果匹配的真实行号（升序）。 */
  searchMatches: number[];
  /** 是否因 host 截断尚有未列出的匹配（不影响 ±1 导航，仅提示）。 */
  searchTruncated: boolean;
  searchInFlight: { rid: string; superseded: boolean } | null;
  /** 过滤态：展示位 -> 真实行号；null = 全量。 */
  filterMap: number[] | null;
  filterCond: FieldCondition | null;
  filterInFlight: { rid: string; superseded: boolean } | null;
  /** 偏好持久化键（jsonlViewer.state.<uri>）；init 后赋值。 */
  persistKey: string | null;
  persistTimer: ReturnType<typeof setTimeout> | undefined;
}

/** 记录缓存容量上限（可视区 + overscan 的常数倍；逐出即释放内存）。 */
const CACHE_MAX_ENTRIES = 600;

/** 左栏可调宽度持久化键（拖拽分栏用）。 */
const LIST_WIDTH_KEY = 'jsonlViewer.listWidth';
/** 左栏折叠状态持久化键。 */
const LIST_COLLAPSED_KEY = 'jsonlViewer.listCollapsed';

/** 便捷：返回左栏宽度持久化键。 */
function listWidthFromStore(): number | null {
  const raw = localStorage.getItem(LIST_WIDTH_KEY);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function saveListWidth(w: number): void {
  try {
    localStorage.setItem(LIST_WIDTH_KEY, String(w));
  } catch {
    /* localStorage 不可用时忽略（不影响功能）。 */
  }
}

function listCollapsedFromStore(): boolean {
  try {
    return localStorage.getItem(LIST_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}
function saveListCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(LIST_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** 偏好持久化键命名空间。 */
function stateKey(uri: string): string {
  return `jsonlViewer.state.${uri}`;
}

export function main(): void {
  injectStyle();

  const api = createVSCodeApi();
  const rootEl = document.getElementById('app');
  if (!rootEl) return;

  // 后端不可用（例如在非 webview 环境打开 app）：给出友好提示，不抛错。
  if (!api) {
    rootEl.textContent = 'JSONL Viewer：无法连接到插件宿主（缺少 acquireVsCodeApi）。';
    return;
  }
  const bus = new RpcBus(api);

  const state: AppState = {
    overview: null,
    cache: new LRUCache<number, CachedRecord>(CACHE_MAX_ENTRIES),
    pending: new Set(),
    inFlight: null,
    fields: null,
    fieldLayout: { pinned: [], order: [], hidden: [], maxKeys: 4 },
    maxLoaded: 0,
    selectedLine: undefined,
    detailInFlight: null,
    searchQuery: '',
    searchMatches: [],
    searchTruncated: false,
    searchInFlight: null,
    filterMap: null,
    filterCond: null,
    filterInFlight: null,
    persistKey: null,
    persistTimer: undefined,
  };

  /* ---------------- 搜索 / 过滤 / 字段定制动作 ---------------- */
  // 已抽至 queryActions.ts（T5 #31）：supersede / jumpToMatch / runSearch / stepSearch /
  // runFilter / clearFilterForCond / applyLayout。动作工厂在下方 schedulePersist 定义之后创建
  // （schedulePersist 作为依赖注入），list/toolbar 则以其后创建的实例经访问器晚绑定。

  /* ---------------- 偏好持久化（防抖写回到 host workspaceState，persistence，T5 #32） ---------------- */
  const { schedulePersist } = createPersistence({ bus, state });

  /* ---------------- 搜索 / 过滤 / 字段布局动作（queryActions，T5 #31） ---------------- */
  // list / toolbar 晚于此处创建，故经访问器晚绑定（动作仅在用户交互时执行，彼时二者就绪）。
  const actions: QueryActions = createQueryActions({
    bus,
    state,
    getList: () => list,
    getToolbar: () => toolbar,
    showDetailForLine: (line) => void showDetailForLine(line),
    updateNavEnabled,
    schedulePersist,
  });

  /* ---------------- 概要栏 ---------------- */
  const toolbar = createToolbar(rootEl, {
    onSearch: (query) => actions.runSearch(query),
    onSearchPrev: () => actions.stepSearch(-1),
    onSearchNext: () => actions.stepSearch(1),
    onApplyFilter: (cond) => actions.runFilter(cond),
    onApplyLayout: (layout) => actions.applyLayout(layout),
  });
  toolbar.update({ fileName: '', status: 'connecting', statusText: '连接中…' });

  /* ---------------- 详情面板（JSON 树，Task 5） ---------------- */
  const navHandlers: DetailTreeNavHandlers = {};
  const detail = createDetailTree(rootEl, navHandlers);

  /* ---------------- 主体布局：严格左右两栏 ---------------- */
  /* 左栏 = 列头(文件/搜索/筛选/统计) + 记录列表；右栏 = 详情面板(自带工具头) */
  const leftCol = document.createElement('div');
  leftCol.className = 'jlv-col-list';

  /* ---------------- 左右两栏分隔条（可拖拽调节宽度 + 折叠按钮） ---------------- */
  const resizer = document.createElement('div');
  resizer.className = 'jlv-resizer';
  resizer.title = '拖动调整左右栏宽度（双击恢复默认）';

  // 折叠按钮（居中在 resizer 上）
  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'jlv-resizer__toggle';
  collapseBtn.title = '收起左栏';
  collapseBtn.setAttribute('aria-label', '收起左栏');
  collapseBtn.innerHTML = ICON_COLLAPSE_LEFT;
  resizer.appendChild(collapseBtn);

  // 展开按钮（折叠后显示在右栏边缘）
  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.className = 'jlv-col-list__expand';
  expandBtn.title = '展开左栏';
  expandBtn.setAttribute('aria-label', '展开左栏');
  expandBtn.innerHTML = ICON_EXPAND_RIGHT;
  expandBtn.hidden = true;
  rootEl.appendChild(expandBtn);

  // 左右两栏布局协调逻辑（收起/展开动画、拖拽调宽、窄容器响应式抽屉）已抽至 columnLayout.ts（T5 #30）。
  // 此处仅持有 DOM 节点（leftCol/resizer/collapseBtn/expandBtn/hamburger/backdrop）；
  // layout 在底部 hamburger/backdrop 创建后经 createColumnLayout 接线全部逻辑与事件。
  let layout: ColumnLayout;

  /* ---------------- 文件变更 / 错误横幅：右上角浮层提示（不占整行） ---------------- */
  const banner = createBanner();

  // 宿主返回的通用错误（如 init/索引构建失败）当前无 requestId 关联，
  // 这里统一透出到横幅，便于定位问题。
  bus.onError((e) => {
    console.error('[jsonl-viewer][webview] host error:', e.message);
    banner.show(`宿主错误：${e.message}`, undefined);
  });

  // 握手超时：**柔性提示**而非报错。
  // 原先提示「未收到宿主数据响应（8s 超时）」在大文件上会误导——索引构建本身就需要时间
  // （实测约 1ms/MB，10GB 约 11s，慢盘更久），此时一切正常却被判成故障。
  // 现在改为「正在构建索引…」，并在 init 真正到达时自动收起。
  let buildHintShown = false;
  setTimeout(() => {
    if (!state.overview) {
      buildHintShown = true;
      console.warn('[jsonl-viewer][webview] init 尚未到达，可能仍在构建索引');
      banner.show('正在构建索引…（超大文件首次打开可能需要数十秒，请稍候）');
    }
  }, INIT_TIMEOUT_MS);

  /* ---------------- 虚拟滚动列表 ---------------- */
  const list = new VirtualRecordList({
    getRecord: (line) => state.cache.get(line),
    getFields: () => state.fields,
    summarize: (value) => summarizeWithLayout(value, state.fields, state.fieldLayout),
    onSelect: (line) => {
      state.selectedLine = line;
      list.select(line);
      void showDetailForLine(line);
      updateNavEnabled();
      // 窄容器抽屉：选中记录后收起目录抽屉，回到详情主视图（layout 于底部接线后可用）
      if (layout.isNarrow()) layout.setDrawer(false);
    },
    onRangeChange: (displayFirst, displayLast) => {
      // 分页/翻页已改变当前可视页 → 立即刷新范围文本（不依赖后面是否有实际拉取）。
      updateToolbar();
      // 展示位 -> 真实行：过滤态下把可视区展示位映射为真实行号去拉取。
      const map = state.filterMap;
      if (map && map.length > 0) {
        const end = Math.min(displayLast, map.length);
        if (displayFirst < end) {
          // 稀疏匹配时只拉取实际命中的行（按相邻性分段），避免请求横跨数百万行的连续大区间。
          scheduleFetch.push(segmentSortedLines(map, displayFirst, end));
        }
        return;
      }
      scheduleFetch.push([{ first: displayFirst, lastExclusive: displayLast }]);
    },
    onJumpToSource: (line) => {
      // 右键「定位到源码行」：请宿主打开源文件并定位到该行（坏行定位同通道）。
      void bus.request(HostEndpoint.JUMP_TO_SOURCE, { line }).promise.catch(() => {});
    },
    onClearFilter: () => actions.clearFilterForCond(),
    // 截断态「复制该行 JSON」：按需拉完整值（列表缓存不持有超大对象）。
    onRequestRecord: (line) =>
      bus.request<{ value?: unknown; error?: string; ok: boolean }>(
        HostEndpoint.READ_RECORD,
        { line },
        { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
      ).promise,
  });
  // 组装两栏：左栏放入列头(toolbar) + 目录列表(分页)；右栏为详情面板；横幅浮层最后挂载。
  leftCol.appendChild(toolbar.root);
  leftCol.appendChild(list.scrollEl);
  leftCol.appendChild(list.pagerEl);
  rootEl.appendChild(leftCol);
  rootEl.appendChild(resizer);
  rootEl.appendChild(detail.root);
  rootEl.appendChild(banner.root);

  /* ---------------- 窄容器响应式：竖向堆叠 ---------------- */
  /* 窄容器(<700px)：off-canvas 抽屉 —— 详情常驻主视图，目录左栏收进左侧抽屉。
   * 水平拖拽分栏条与桌面折叠/展开按钮在窄态由 CSS 隐藏；这里只创建并驱动抽屉(汉堡菜单+遮罩)。 */

  /* 详情头部左上角「汉堡菜单」：点开/收起目录抽屉（仅窄容器显示，CSS 控制显隐） */
  const hamburger = document.createElement('button');
  hamburger.type = 'button';
  hamburger.className = 'jlv-hamburger';
  hamburger.title = '记录目录';
  hamburger.setAttribute('aria-label', '打开记录目录');
  hamburger.innerHTML = ICON_MENU;
  detail.root.querySelector<HTMLElement>('.jlv-detail-header')?.prepend(hamburger);

  /* 抽屉遮罩：打开时盖住详情，点击关闭 */
  const backdrop = document.createElement('div');
  backdrop.className = 'jlv-drawer-backdrop';
  backdrop.hidden = true;
  rootEl.appendChild(backdrop);

  // 抽屉开关 / 响应式重排 / ResizeObserver 观测（setDrawer / syncResponsive / onContainerResize）
  // 全部由 columnLayout 接管（T5 #30）。DOM 节点已在上方创建并挂载，此处仅接线行为。
  layout = createColumnLayout({
    rootEl,
    detailRoot: detail.root,
    leftCol,
    resizer,
    collapseBtn,
    expandBtn,
    hamburger,
    backdrop,
    refreshList: () => list.refresh(),
    updateNavEnabled,
    saveListCollapsed,
    listCollapsedFromStore,
    listWidthFromStore,
    saveListWidth,
  });

  /* ---------------- prev / next 导航 ---------------- */

  /** 获取当前可见记录总数（考虑过滤态）。 */
  function getTotalVisible(): number {
    return state.filterMap ? state.filterMap.length : (state.overview?.totalLines ?? 0);
  }

  /** 将展示位索引转为真实行号（过滤态/全量态统一）。 */
  function displayToReal(d: number): number {
    return state.filterMap ? state.filterMap[d] : d;
  }

  /** 获取当前选中行在展示序列中的索引；返回 -1 表示无选中或不在范围。 */
  function selectedDisplayIndex(): number {
    const line = state.selectedLine;
    if (line === undefined) return -1;
    if (state.filterMap) {
      return state.filterMap.indexOf(line);
    }
    if (state.overview && line >= 0 && line < state.overview.totalLines) return line;
    return -1;
  }

  /** 更新详情面板导航按钮（上一条/下一条）的启用状态。 */
  function updateNavEnabled(): void {
    const total = getTotalVisible();
    if (total <= 0) {
      detail.setNavEnabled(false, false);
      return;
    }
    const idx = selectedDisplayIndex();
    if (idx < 0) {
      // 无选中时：允许两边导航（会从第一条或最后一条开始）
      detail.setNavEnabled(true, true);
      return;
    }
    detail.setNavEnabled(idx > 0, idx < total - 1);
  }

  navHandlers.onPrevRecord = () => {
    const total = getTotalVisible();
    if (total <= 0) return;
    const idx = selectedDisplayIndex();
    const target = idx < 0 ? total - 1 : idx - 1;
    if (target < 0) return;
    const real = displayToReal(target);
    list.focus(real);
    state.selectedLine = real;
    void showDetailForLine(real);
    updateNavEnabled();
  };
  navHandlers.onNextRecord = () => {
    const total = getTotalVisible();
    if (total <= 0) return;
    const idx = selectedDisplayIndex();
    const target = idx < 0 ? 0 : idx + 1;
    if (target >= total) return;
    const real = displayToReal(target);
    list.focus(real);
    state.selectedLine = real;
    void showDetailForLine(real);
    updateNavEnabled();
  };

  /* ---------------- 详情面板：按需请求完整 JSON ---------------- */

  function cancelDetailRequest(): void {
    if (state.detailInFlight) bus.supersede(state.detailInFlight.rid);
    state.detailInFlight = null;
  }

  /**
   * 选中某行时拉取其完整 JSON 渲染到详情树（Task 5）。
   * - 切换选中行时取消上一在途详情请求（supersede），迟到响应被丢弃；
   * - 坏行（ok=false）直接展示错误信息（此时已是缓存中的汇总值，无需再请求）。
   */
  async function showDetailForLine(line: number): Promise<void> {
    const cached = state.cache.get(line);
    if (cached && cached.ok === false) {
      cancelDetailRequest();
      detail.showError(cached.error ?? '该行不是合法 JSON。', line);
      return;
    }

    cancelDetailRequest();
    detail.showLoading();

    const { requestId, promise } = bus.request<{ value?: unknown; error?: string; ok: boolean }>(
      HostEndpoint.READ_RECORD,
      { line },
      { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
    );
    state.detailInFlight = { rid: requestId };

    try {
      const res = await promise;
      if (state.detailInFlight?.rid !== requestId) return; // 已被更新的选择取代
      if (res && res.ok !== false && res.value !== undefined) detail.showRecord(res.value, line);
      else detail.showError(res?.error ?? '无法解析该记录。');
    } catch (err) {
      if (state.detailInFlight?.rid === requestId) {
        detail.showError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (state.detailInFlight?.rid === requestId) state.detailInFlight = null;
    }
  }

  /* ---------------- 按需拉取调度器 ---------------- */
  const scheduleFetch = new ThrottleQueue<{ first: number; lastExclusive: number }[]>(
    40,
    async (windows) => {
      // 逐段串行拉取；任一段被 supersede/超时即放弃剩余段（已有更新的窗口请求接手）。
      for (const win of windows) {
        const ok = await fetchWindow(win);
        if (!ok) return;
      }
    }
  );

  /** 拉取单个连续窗口。返回 false 表示被取消/超时/无需拉取（调用方应停止后续段）。 */
  async function fetchWindow(win: { first: number; lastExclusive: number }): Promise<boolean> {
    const ov = state.overview;
    if (!ov) return false;
    const total = ov.totalLines;
    const s = clamp(win.first, 0, total);
    const e = clamp(win.lastExclusive, s, total);
    const missing = computeFetchWindow(
      s,
      e,
      (line) => state.cache.has(line) || state.pending.has(line)
    );
    if (!missing) return false;

    // 覆盖式取消：若上一请求仍在途，本地标记并请宿主尽力中断。
    if (state.inFlight && !state.inFlight.superseded) {
      state.inFlight.superseded = true;
      bus.supersede(state.inFlight.rid);
    }
    state.inFlight = { rid: '', superseded: false };
    for (let i = 0; i < missing.count; i++) state.pending.add(missing.start + i);

    const { requestId, promise } = bus.request<RecordsPayload>(
      HostEndpoint.READ_RECORDS,
      {
        startLine: missing.start,
        count: missing.count,
      },
      { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
    );
    state.inFlight.rid = requestId;

    try {
      const payload = await promise;
      if (state.inFlight?.rid !== requestId || state.inFlight.superseded) return false;
      if (payload.items.length === 0) return false;
      for (const it of payload.items) {
        state.cache.set(it.line, {
          value: it.value,
          ok: it.ok,
          error: it.error,
          summary: it.summary,
          truncated: it.truncated,
          kind: it.kind,
          count: it.count,
        });
        if (it.line + 1 > state.maxLoaded) state.maxLoaded = it.line + 1;
      }
      // 可视区已有真实数据，重绘展示。
      list.refresh();
      return true;
    } catch {
      // 被 supersede 取消或超时：忽略（已有更新的窗口请求接手），避免 unhandled rejection。
      return false;
    } finally {
      for (let i = 0; i < missing.count; i++) state.pending.delete(missing.start + i);
      if (state.inFlight?.rid === requestId) state.inFlight = null;
      updateToolbar();
    }
  }

  /* ---------------- 概要栏刷新 ---------------- */
  function updateToolbar(): void {
    const ov = state.overview;
    // 未加载概览（连接/索引构建中）时，不展示可能误导的行统计（如「当前可见 1–0 行」）。
    const info: Partial<ToolbarInfo> & { fileName?: string } = {
      fileName: ov?.uri ?? 'JSONL Viewer',
      status: ov ? 'ready' : 'connecting',
      statusText: ov ? '就绪' : '连接中…',
    };
    if (ov) {
      info.totalLines = ov.totalLines;
      info.loadedLines = state.cache.size;
      // 翻页式目录：展示当前页的真实行闭区间（1 起）；空页兜底到全量。
      const bounds = list.getCurrentPageRealBounds();
      info.range = bounds ?? ([0, Math.max(0, ov.totalLines - 1)] as [number, number]);
      info.buildMs = ov.buildMs;
    }
    toolbar.update(info);
  }

  /* ---------------- init / 生命周期 ---------------- */
  /* ---------------- 偏好持久化：恢复上次打开同一文件的状态 ---------------- */
  let savedLoaded = false;
  let savedState: unknown;
  function tryApplyPersisted(): void {
    if (!savedLoaded || !state.fields) return;
    const known = new Set(state.fields.map((f) => f.key));
    const merged = mergePersistedState(
      savedState,
      {
        fieldLayout: state.fieldLayout,
        filter: state.filterCond,
        searchQuery: state.searchQuery,
      },
      known
    );
    if (merged.fieldLayout) {
      state.fieldLayout = merged.fieldLayout;
      toolbar.setLayout(state.fieldLayout);
      list.refresh();
    }
    if (merged.filter) actions.runFilter(merged.filter);
    if (merged.searchQuery) {
      // 恢复搜索词（不自动触发搜索，避免打开即扫全文件；用户可按回车/触发）。
      const input = toolbar.searchInput();
      if (input && !input.value) input.value = merged.searchQuery;
    }
  }

  bus.onInit((payload: InitPayload) => {
    // 索引已就绪：收起「正在构建索引…」柔性提示（若曾显示）。
    if (buildHintShown) {
      buildHintShown = false;
      banner.hide();
    }
    state.overview = payload;
    state.persistKey = stateKey(payload.uri);
    list.setTotalRows(payload.totalLines);
    updateToolbar();
    updateNavEnabled();

    // 打开文件默认选中第一条并展示其 JSON；右侧细节树已内置「仅展开顶层、嵌套折叠」的默认态。
    if (state.selectedLine === undefined && payload.totalLines > 0) {
      state.selectedLine = 0;
      list.select(0); // 首帧不加 scrollToLine（避免入场动画/重建导致打开时闪一次）
      void showDetailForLine(0);
      updateNavEnabled();
    }

    // 读取已持久化偏好（无则 savedLoaded 仍置 true，便于后续在此刻合并）。
    void bus
      .request<unknown>(HostEndpoint.LOAD_STATE, { key: state.persistKey })
      .promise.then((v) => {
        savedState = v;
        savedLoaded = true;
        tryApplyPersisted();
      })
      .catch(() => {
        savedLoaded = true;
      });

    // 拉一遍最新概览（构建索引后统计更精确），同时由列表的 onRangeChange 触发初始 readRecords。
    void bus
      .request<OverviewPayload>(HostEndpoint.GET_OVERVIEW, {}, { timeoutMs: RPC_HEAVY_TIMEOUT_MS })
      .promise.then((ov) => {
        if (!ov) return;
        state.overview = ov;
        list.setTotalRows(ov.totalLines);
        updateToolbar();
        updateNavEnabled();
      })
      .catch(() => {
        /* init 已含概览，这里失败可忽略；且不触发错误横幅。 */
      });

    // Task 3 接入后用于摘要卡片；若宿主尚未实现（返回 error）则回退到顶层 key 摘要。
    void bus
      .request<{ fields: FieldLike[]; total?: number; scanned?: number }>(
        HostEndpoint.GET_SAMPLE_FIELDS,
        {},
        { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
      )
      .promise.then((res) => {
        if (res && Array.isArray(res.fields)) {
          state.fields = res.fields;
          toolbar.setFields(res.fields);
          toolbar.setLayout(state.fieldLayout);
          list.refresh();
          tryApplyPersisted();
          // 抽样行**全部**无法解析：多半根本不是「UTF-8 编码的 JSONL」。
          // 与其让用户面对满屏坏行不知所措，不如给出可执行的解释。
          // 门槛 20 行，避免小文件 / 空文件误报。
          if (res.fields.length === 0 && (res.scanned ?? 0) >= 20 && (res.total ?? 0) === 0) {
            banner.show(
              `抽样 ${res.scanned} 行均无法解析为 JSON：文件可能不是 UTF-8 编码，或不是「每行一条 JSON」的 JSONL 格式。`
            );
          }
        }
      })
      .catch(() => {
        /* 未实现，正常回退。 */
      });
  });

  /* ---------------- Task 7：文件变更检测 + 重新加载 ---------------- */
  async function reloadFile(): Promise<void> {
    banner.hide();
    // 取消所有在途请求，避免新旧数据交错或残留响应污染 UI。
    actions.supersede(state.inFlight);
    state.inFlight = null;
    actions.supersede(state.searchInFlight);
    state.searchInFlight = null;
    actions.supersede(state.filterInFlight);
    state.filterInFlight = null;
    cancelDetailRequest();
    detail.showLoading();

    try {
      const ov = await bus.request<OverviewPayload>(
        HostEndpoint.RELOAD,
        {},
        {
          timeoutMs: RPC_HEAVY_TIMEOUT_MS,
        }
      ).promise;
      if (!ov) return;
      state.overview = ov;
      // 索引重建后，旧的缓存 / 搜索 / 过滤结果全部失效，整体复位。
      state.cache.clear();
      state.pending.clear();
      state.maxLoaded = 0;
      state.fields = null;
      state.searchMatches = [];
      state.searchTruncated = false;
      state.filterMap = null;
      state.filterCond = null;
      // M14：搜索词与持久化定时器一并复位，避免重载后旧过滤被写回持久化。
      state.searchQuery = '';
      if (state.persistTimer) {
        clearTimeout(state.persistTimer);
        state.persistTimer = undefined;
      }
      toolbar.setSearchResult(0, 0);
      toolbar.setFilterTruncated(false);
      list.setTranslation(null);
      list.setTotalRows(ov.totalLines);
      updateToolbar();
      detail.clear();
      updateNavEnabled();
      // 重新拉字段推断（供摘要卡片 / 过滤下拉）。
      void bus
        .request<{ fields: FieldLike[] }>(
          HostEndpoint.GET_SAMPLE_FIELDS,
          {},
          { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
        )
        .promise.then((res) => {
          if (res && Array.isArray(res.fields)) {
            state.fields = res.fields;
            toolbar.setFields(res.fields);
            toolbar.setLayout(state.fieldLayout);
            list.refresh();
          }
        })
        .catch(() => {});
    } catch (e) {
      banner.show(e instanceof Error ? e.message : String(e), '重试', () => void reloadFile());
    }
  }

  bus.onStale((payload) => {
    banner.show(
      payload.message ?? '文件已变更，索引可能过期。',
      '重新加载',
      () => void reloadFile()
    );
  });

  // 初始：向宿主报告就绪，等待 init 回执。
  bus.post(HostEndpoint.READY);

  // 尺寸变化：由 ResizeObserver 仅在跨窄/宽断点（容器 <700px）时触发 syncResponsive 重排，
  // 不在此对每次 resize 重建目录/分页，避免拖拽调窗时左栏卡片反复重建（闪烁/刷新）。

  updateToolbar();

  /* ---------- 生命周期清理 ----------
   * VS Code webview 关闭时不会自动调用任何 dispose 回调——
   * 我们在 beforeunload 里显式释放 document 级监听器。
   * 关键：detailTree 的 document.click、toolbar.panelShell 的 document.pointerdown、
   * ThrottleQueue 的 setTimeout、RpcBus 的 pending timers 都必须清理。
   * 防御性双重保险：同一 window 上多注册一次 beforeunload 无害。
   */
  let cleanupCalled = false;
  const cleanup = (): void => {
    if (cleanupCalled) return;
    cleanupCalled = true;
    layout.dispose(); // 释放 ResizeObserver + 收起/展开动画定时器（columnLayout 内部状态）
    bus.dispose();
    scheduleFetch.dispose();
    list.dispose();
    detail.dispose();
    toolbar.destroy();
  };
  window.addEventListener('beforeunload', cleanup);
}

/** 折叠左栏按钮图标（<<）。 */
const ICON_COLLAPSE_LEFT =
  '<svg width="10" height="10" viewBox="0 0 16 16"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** 展开左栏按钮图标（>>）。 */
const ICON_EXPAND_RIGHT =
  '<svg width="10" height="10" viewBox="0 0 16 16"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
/** 汉堡菜单图标（三横线，窄容器目录抽屉开关）。 */
const ICON_MENU =
  '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M2 4h12M2 8h12M2 12h12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

// 测试环境（无 document / 无 acquireVsCodeApi）下不自动挂载，便于 node --test 经 jsdom 装配后
// 动态 import 本模块做冒烟测试；浏览器/webview 由 VS Code 注入 document 与 acquireVsCodeApi，正常挂载。
if (
  typeof document !== 'undefined' &&
  typeof (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi === 'function'
) {
  main();
}
