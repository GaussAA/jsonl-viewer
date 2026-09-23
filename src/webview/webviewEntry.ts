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
import { createEditPanel } from './editPanel.ts';
import { createHistoryPanel } from './historyPanel.ts';
import { createBadLinesPanel, scanProgressText } from './badLinesPanel.ts';
import { createFieldPanel } from './fieldPanel.ts';
import { toPathParts } from './detailLogic.ts';
import type { PathSeg } from './detailLogic.ts';
import { replaceValueAtPath } from '../core/jsonSpan.ts';
import {
  describeEditFailure,
  editProgressText,
  estimateEditCost,
  replaceConfirmText,
  replaceProgressText,
  EDIT_COST_WARN_BYTES,
} from './editLogic.ts';
import { createColumnLayout, type ColumnLayout } from './columnLayout.ts';
import { createQueryActions, type QueryActions } from './queryActions.ts';
import { createPersistence } from './persistence.ts';
import { createVSCodeApi, RpcBus } from './rpc.ts';
import { mergePersistedState, summarizeWithLayout } from './queryLogic.ts';
import type { FieldCondition, FieldLayout } from './queryLogic.ts';
import { HostEndpoint } from '../protocol/rpc.ts';
import type {
  BadLinesPayload,
  CopyLinesResultPayload,
  DeleteManyResultPayload,
  EditResultPayload,
  HistoryPayload,
  HistoryResultPayload,
  ReplaceResultPayload,
} from '../protocol/rpc.ts';
import type { InitPayload, OverviewPayload, RecordsPayload } from '../protocol/rpc.ts';
import { CSS_TEXT } from './styles.ts';
import { describeReplaceOutcome } from '../core/replaceLogic.ts';
import {
  BAD_LINES_REFRESH_DEBOUNCE_MS,
  INIT_TIMEOUT_MS,
  MAX_SELECTION_LINES,
  RPC_HEAVY_TIMEOUT_MS,
} from '../constants.ts';

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

/** 顶部可操作提示横幅（文件已变更 / 重新加载 / 重试 / 写操作进度）。 */
function createBanner(): {
  root: HTMLElement;
  show(text: string, actionLabel?: string, onAction?: () => void): void;
  /** 只换文字，**不触碰按钮** —— 进度更新若走 show() 会让「取消」按钮每次回调都重置闪烁。 */
  setText(message: string): void;
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
    setText(message: string) {
      text.textContent = message;
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
  /**
   * 当前详情所展示行的**磁盘原文**与字节数。
   *
   * 字段级编辑必须在原文里定位并只替换目标值那一段（不能用解析后的值重新序列化 ——
   * 那会重排用户的键序与空白）。`bytes` 同时用作编辑请求的乐观锁断言。
   */
  detailRaw: { text: string; bytes: number } | null;

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
    detailRaw: null,
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
    selectLine: (line) => selectSingle(line),
    updateNavEnabled,
    schedulePersist,
  });

  /* ---------------- 概要栏 ---------------- */
  const toolbar = createToolbar(rootEl, {
    onSearch: (query) => actions.runSearch(query),
    onSearchPrev: () => actions.stepSearch(-1),
    onSearchNext: () => actions.stepSearch(1),
    onReplaceAll: (query, replacement) => replaceAll(query, replacement),
    onOpenHistory: () => historyPanel.open(),
    onOpenBadLines: () => badLinesPanel.open(),
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

  /**
   * 正在执行的批量替换（null = 无）。
   *
   * 进度推送与「取消」按钮都依赖它：没有它就无法判断某条进度是否属于当前操作
   * （迟到的推送不该覆盖新横幅），也无从知道该取消哪个 requestId。
   */
  let activeReplace: { requestId: string } | null = null;

  /** 正在执行的坏行全文件扫描（null = 无）。 */
  let activeScan: { requestId: string } | null = null;
  /** 正在执行的单行编辑（仅当成本足够大、真的会等待时才置位）。 */
  let activeEdit: { requestId: string } | null = null;

  /**
   * 长任务进度 → 横幅（只换文字，不得触碰「取消」按钮）。
   *
   * 按 `kind` 分派而非各订阅一次：进度通道本就是「长任务的字节级进度」，
   * 与任务语义无关；加一种长任务不该再造一条推送链路。
   */
  bus.onEditProgress((info) => {
    if (info.kind === 'replace' && activeReplace) {
      banner.setText(replaceProgressText(info.processedBytes, info.totalBytes));
      return;
    }
    if (info.kind === 'scanBadLines' && activeScan) {
      banner.setText(scanProgressText(info.processedBytes, info.totalBytes));
      return;
    }
    if (info.kind === 'edit' && activeEdit) {
      banner.setText(editProgressText(info.processedBytes, info.totalBytes));
    }
  });

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
    onSelect: (line, mods) => handleSelect(line, mods),
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
    // 右键「编辑第 N 行」：打开编辑浮层（初始文本取磁盘原文）。
    onEditRecord: (line) => void openEditForLine(line),
    // 右键「在第 N 行前插入」：无需拉原文，直接以空文本打开插入模式的浮层。
    onInsertRecord: (line) => editPanel.open(line, '', 'insert'),
    // 右键「删除第 N 行」：先横幅二次确认，再落盘。
    onDeleteRecord: (line) => deleteRecordAt(line),
    // 右键菜单的批量项（选区 > 1 行时出现）
    onDeleteSelected: () => confirmDeleteSelection(),
    onCopySelected: () => void copySelection(),
    onClearFilter: () => actions.clearFilterForCond(),
    // 截断态「复制该行 JSON」：按需拉完整值（列表缓存不持有超大对象）。
    onRequestRecord: (line) =>
      bus.request<{ value?: unknown; error?: string; ok: boolean }>(
        HostEndpoint.READ_RECORD,
        { line },
        { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
      ).promise,
  });
  /* ---------------- 行编辑浮层（编辑能力） ----------------
   * 初始文本一律取**磁盘原文**（readRecord 的 rawText），而非用 value 重新序列化的结果：
   * 后者会把用户原有的键序与空白重排掉，字节长度随之变化、放大变长编辑的搬移成本。 */
  /** 编辑前记下的旧行字节长度：作为乐观锁断言（磁盘上该行若已变化则拒绝写入）。 */
  let editExpectedBytes: number | undefined;

  const editPanel = createEditPanel({
    getOverview: () =>
      state.overview
        ? { totalBytes: state.overview.totalBytes, totalLines: state.overview.totalLines }
        : undefined,
    /**
     * 提交编辑。
     *
     * 绝大多数编辑是毫秒级完成，故**只在预估搬移成本超过阈值时**才弹进度横幅 ——
     * 否则每次保存都闪一下横幅，比不显示更烦。而真到「改大文件首行」这种要搬移
     * 几百 MB 的场景，用户必须能看到进度并且能中止，而不是猜程序是不是死了。
     */
    submit: async (info) => {
      const req =
        info.mode === 'insert'
          ? bus.request<EditResultPayload>(
              HostEndpoint.INSERT_RECORD,
              { at: info.line, text: info.text },
              { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
            )
          : bus.request<EditResultPayload>(
              HostEndpoint.EDIT_RECORD,
              { line: info.line, text: info.text, expectedBytes: editExpectedBytes },
              { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
            );

      const ov = state.overview;
      const cost = ov === null ? 0 : estimateEditCost(ov.totalBytes, ov.totalLines, info.line);
      const showProgress = cost >= EDIT_COST_WARN_BYTES;
      if (showProgress) {
        activeEdit = { requestId: req.requestId };
        banner.show(editProgressText(0, 0), '取消', () => {
          // 只发 CANCEL、不 settle 本地 Promise —— 要等宿主回执才能如实说
          // 「文件未被修改」，本地草草收尾会让用户不确定文件到底动了没有。
          bus.post(HostEndpoint.CANCEL, { requestId: req.requestId });
        });
      }

      try {
        return await req.promise;
      } finally {
        activeEdit = null;
        if (showProgress) banner.hide();
      }
    },
    onCommitted: ({ line, mode }) => {
      if (mode === 'replace') {
        // 只有该行内容变了 —— 丢弃这一行的缓存即可。
        state.cache.delete(line);
      } else {
        // 行增删会改变其后每一行的行号 → 整个以行号为键的缓存都失效，必须清空。
        applyRowCountChange(line, mode);
      }
      list.refresh();
      if (state.selectedLine !== undefined) void showDetailForLine(state.selectedLine);
      updateToolbar();
      // 编辑可能把坏行改好（也可能因行增删而位移）→ 徽章要跟上。
      scheduleBadLinesRefresh();
    },
  });
  rootEl.appendChild(editPanel.root);

  /* ---------------- 会话编辑历史（M3） ---------------- */

  /** 宿主无响应时的兜底结果（宁可如实报错，也不要伪造成「成功但没变化」）。 */
  const historyFailure = (error: string): HistoryResultPayload => ({
    ok: false,
    steps: 0,
    cursor: 0,
    total: 0,
    error,
  });

  /**
   * 历史浮层。**宿主是唯一状态源**：前端只渲染宿主返回的光标，不自行推算 ——
   * 前端一旦自己也维护一份「撤销到第几步」，就必然与 Ctrl+Z（同样走宿主光标）打架。
   */
  const historyPanel = createHistoryPanel({
    fetchHistory: async () => {
      const res = await bus.request<HistoryPayload>(HostEndpoint.GET_HISTORY, {}).promise;
      return res ?? { entries: [], cursor: 0, dropped: false };
    },
    undoStep: async () =>
      (await bus.request<HistoryResultPayload>(HostEndpoint.UNDO_EDIT, {}).promise) ??
      historyFailure('宿主无响应'),
    redoStep: async () =>
      (await bus.request<HistoryResultPayload>(HostEndpoint.REDO_EDIT, {}).promise) ??
      historyFailure('宿主无响应'),
    revertTo: async (id) =>
      (await bus.request<HistoryResultPayload>(HostEndpoint.REVERT_TO, { id }).promise) ??
      historyFailure('宿主无响应'),
    confirm: (message, onConfirm) => banner.show(message, '确认', onConfirm),
    // 历史回退可能改动任意位置的内容：整体清缓存并重拉（逐行失效没有意义）。
    onChanged: () => {
      state.cache.clear();
      state.maxLoaded = 0;
      list.refresh();
      updateToolbar();
      if (state.selectedLine !== undefined) void showDetailForLine(state.selectedLine);
      // 撤销/重做可能把行改回来、也可能删掉一批 → 徽章须重算。
      scheduleBadLinesRefresh();
    },
    notify: (message) => banner.show(message, undefined),
  });
  rootEl.appendChild(historyPanel.root);

  /* ---------------- 坏行诊断浮层（惰性发现 + 显式全量扫描） ---------------- */

  /** 扫描是否在进行中（浮层据此禁用按钮 —— 也是「不允许并发第二次扫描」的闸门）。 */
  let scanningBadLines = false;
  /** 读批后的刷新防抖句柄：滚动会连续读批，逐次拉取只是无意义的 IPC 压力。 */
  let badLinesRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  /** 宿主无响应时的兜底：标记为 partial —— 不假装是权威全量。 */
  function emptyBadLines(): BadLinesPayload {
    return { lines: [], partial: true, scanned: 0, totalLines: 0, truncated: false };
  }

  /** 拉取坏行计数并更新徽章。失败静默：它只是辅助提示，不该打断主流程。 */
  async function refreshBadLines(): Promise<void> {
    try {
      const res = await bus.request<BadLinesPayload>(HostEndpoint.GET_BAD_LINES, {}).promise;
      if (res) toolbar.update({ badLines: { count: res.lines.length, partial: res.partial } });
    } catch {
      // 取不到就不显示徽章 —— 为一条辅助信息弹错误横幅只会打扰用户。
    }
  }

  /** 防抖刷新（滚动浏览会连续触发读批）。 */
  function scheduleBadLinesRefresh(): void {
    if (badLinesRefreshTimer) clearTimeout(badLinesRefreshTimer);
    badLinesRefreshTimer = setTimeout(() => {
      badLinesRefreshTimer = undefined;
      void refreshBadLines();
    }, BAD_LINES_REFRESH_DEBOUNCE_MS);
  }

  /** 跳转到某行（坏行定位）：选中 + 滚动 + 详情，走单一入口保证视觉与选区一致。 */
  function jumpToLine(line: number): void {
    selectSingle(line);
    list.scrollToLine(line);
    void showDetailForLine(line);
    updateNavEnabled();
  }

  /**
   * 把坏行写入选区，返回实际选中数。
   *
   * 超上限**拒绝而非截断**：静默截断会让用户以为「坏行都选上了」，随后一次删除
   * 删掉的可就不只是坏行 —— 这类后果不可逆。
   */
  function selectBadLines(lines: readonly number[]): number {
    if (lines.length === 0) return 0;
    if (lines.length > MAX_SELECTION_LINES) {
      banner.show(
        `坏行过多（${lines.length} 行，超过单次选择上限 ${MAX_SELECTION_LINES}）——` +
          '请分批处理，或改用外部清洗工具。',
        undefined
      );
      return 0;
    }
    selectedLines.clear();
    for (const l of lines) selectedLines.add(l);
    selAnchor = lines[0];
    state.selectedLine = lines[0];
    list.select(lines[0]);
    syncSelection();
    return selectedLines.size;
  }

  const badLinesPanel = createBadLinesPanel({
    fetchBadLines: async () => {
      const res = await bus.request<BadLinesPayload>(HostEndpoint.GET_BAD_LINES, {}).promise;
      return res ?? emptyBadLines();
    },
    scanBadLines: async () => {
      scanningBadLines = true;
      try {
        const { requestId, promise } = bus.request<BadLinesPayload>(
          HostEndpoint.SCAN_BAD_LINES,
          {},
          { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
        );
        // 扫描大文件要数秒：横幅给进度与取消。取消**只发 CANCEL、不 settle 本地
        // Promise** —— 要等宿主回执才能如实说「坏行集合未被改动」，本地草草收尾
        // 会让用户不确定文件到底动了没有。
        activeScan = { requestId };
        banner.show(scanProgressText(0, 0), '取消', () => {
          bus.post(HostEndpoint.CANCEL, { requestId });
        });
        const res = await promise;
        // 直接用扫描结果更新徽章，省一次往返。
        if (res && !res.cancelled) {
          toolbar.update({ badLines: { count: res.lines.length, partial: res.partial } });
        }
        return res ?? emptyBadLines();
      } finally {
        activeScan = null;
        scanningBadLines = false;
      }
    },
    isScanning: () => scanningBadLines,
    jumpTo: (line) => jumpToLine(line),
    selectLines: (lines) => selectBadLines(lines),
    notify: (message) => banner.show(message, undefined),
  });
  rootEl.appendChild(badLinesPanel.root);

  /**
   * 打开编辑浮层：先按需拉取该行的磁盘原文（列表缓存里只有解析后的 value，不能当原文用），
   * 拿到后再打开，避免把「重新序列化」的结果冒充用户原文。
   */
  async function openEditForLine(line: number): Promise<void> {
    try {
      const res = await bus.request<{
        ok: boolean;
        error?: string;
        rawText?: string;
        rawBytes?: number;
      }>(HostEndpoint.READ_RECORD, { line }, { timeoutMs: RPC_HEAVY_TIMEOUT_MS }).promise;
      if (res?.rawText === undefined) {
        banner.show(res?.error ?? '无法读取该行内容', undefined);
        return;
      }
      editExpectedBytes = res.rawBytes;
      editPanel.open(line, res.rawText);
    } catch (e) {
      banner.show(e instanceof Error ? e.message : String(e), undefined);
    }
  }

  /**
   * 行增删成功后的本地状态调整。
   *
   * 与替换不同，增删会**改变其后所有行的行号**：以行号为键的列表缓存整体失效，
   * 选中锚点也必须跟随位移（否则详情树会显示「原来是别的行」的内容）。
   * 总行数在此本地维护，不必为一次增删再往返一次 getOverview。
   */
  function applyRowCountChange(line: number, mode: 'insert' | 'delete'): void {
    state.cache.clear();
    if (state.overview) {
      const totalLines = state.overview.totalLines + (mode === 'insert' ? 1 : -1);
      state.overview = { ...state.overview, totalLines };
      list.setTotalRows(Math.max(0, totalLines));
    }
    if (mode === 'insert') {
      // 插入后把选中锚点落到新行上（与「光标停在新行」的编辑器习惯一致）。
      state.selectedLine = line;
      list.select(line);
      return;
    }
    if (state.selectedLine === undefined) return;
    state.selectedLine = state.selectedLine > line ? state.selectedLine - 1 : state.selectedLine;
    const maxLine = Math.max(0, (state.overview?.totalLines ?? 1) - 1);
    if (state.selectedLine > maxLine) state.selectedLine = maxLine;
    list.select(state.selectedLine);
  }

  /**
   * 删除某一行（右键入口）。
   *
   * webview 里 window.confirm 不可用（沙箱拦截阻塞式对话框），故复用顶部横幅做二次
   * 确认 —— 删除是不可逆的磁盘写入，必须先问一句。
   */
  function deleteRecordAt(line: number): void {
    banner.show(`确定删除第 ${line + 1} 行？该操作会立即写入磁盘。`, '确认删除', () => {
      void (async () => {
        try {
          const res = await bus.request<EditResultPayload>(
            HostEndpoint.DELETE_RECORD,
            { line },
            { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
          ).promise;
          if (!res?.ok) {
            banner.show(describeEditFailure(res ?? {}), undefined);
            return;
          }
          banner.hide();
          applyRowCountChange(line, 'delete');
          list.refresh();
          updateToolbar();
          if (state.selectedLine !== undefined) void showDetailForLine(state.selectedLine);
        } catch (e) {
          banner.show(e instanceof Error ? e.message : String(e), undefined);
        }
      })();
    });
  }

  /**
   * 全文查找替换（工具栏「全部替换」）。
   *
   * 二次确认走顶部横幅 —— webview 里 `window.confirm` 不可用（沙箱拦截阻塞式对话框），
   * 且批量改写会**立即落盘**，必须先问一句。
   *
   * 大文件会在确认文案里说明代价（整个文件需要重写），执行中显示**可取消**的进度：
   * 重写 1GB 文件要数秒，没有进度也没有取消入口的等待是最难熬的 —— 用户只能
   * 猜测程序是不是死了，然后去点第二次。
   *
   * 结果文案必须包含「跳过的行数」：用户点了「全部替换」后最危险的误解就是
   * 以为全改完了，而实际有一批行因 JSON 非法被跳过。
   */
  function replaceAll(rawQuery: string, replacement: string): void {
    const query = rawQuery.trim();
    if (!query) {
      banner.show('请先在搜索框填入要查找的内容。', undefined);
      toolbar.toggleReplace(true);
      return;
    }
    const totalBytes = state.overview?.totalBytes ?? 0;
    banner.show(replaceConfirmText(query, replacement, totalBytes), '确认替换', () => {
      void (async () => {
        toolbar.setReplaceBusy(true);
        try {
          const { requestId, promise } = bus.request<ReplaceResultPayload>(
            HostEndpoint.REPLACE_TEXT,
            { query, replacement },
            { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
          );
          // 记下本次请求：进度推送据此渲染横幅，取消按钮据此发 CANCEL。
          activeReplace = { requestId };
          banner.show('正在替换…', '取消', () => {
            // 只发 CANCEL，**不 settle 本地 Promise** —— 我们要等宿主回执 cancelled 的结果
            // 才能如实告诉用户「文件未被修改」，而不是本地草草收尾。
            bus.post(HostEndpoint.CANCEL, { requestId });
          });

          const res = await promise;
          activeReplace = null;

          if (res?.cancelled) {
            banner.show('已取消：文件未被修改。', undefined);
            return;
          }
          if (!res?.ok) {
            banner.show(res?.error ?? '替换失败', undefined);
            return;
          }
          // 改动可能散落全文件，无法逐行失效 —— 整体清空缓存并按需重拉。
          state.cache.clear();
          state.maxLoaded = 0;
          list.refresh();
          updateToolbar();
          // 内容变了，过滤结果同样不再可信；有过滤条件就重算。
          if (state.filterCond) actions.runFilter(state.filterCond);
          // 重跑搜索刷新命中计数（原本命中的行可能已经不匹配）。
          actions.runSearch(query);
          if (state.selectedLine !== undefined) void showDetailForLine(state.selectedLine);
          // 批量替换可能把成片的坏行改好 → 徽章要随之下降。
          scheduleBadLinesRefresh();
          const suffix = res.undoable ? '' : '；（改动量较大，本次未纳入撤销栈）';
          banner.show(describeReplaceOutcome(res) + suffix, undefined);
        } catch (e) {
          banner.show(e instanceof Error ? e.message : String(e), undefined);
        } finally {
          activeReplace = null;
          toolbar.setReplaceBusy(false);
        }
      })();
    });
  }

  /**
   * 批量删除后：总行数减少 N，选区与详情复位。
   *
   * 不做「行号位移推算」而直接整体复位：删掉的行散布在各处，剩余行的新行号取决于
   * 它前面被删了几行 —— 用户看到的是一批内容消失，此时把选中状态留在某个「碰巧算对」
   * 的行上，比清空更令人困惑。
   */
  function applyBulkDelete(deleted: number): void {
    state.cache.clear();
    if (state.overview) {
      const totalLines = Math.max(0, state.overview.totalLines - deleted);
      state.overview = { ...state.overview, totalLines };
      list.setTotalRows(totalLines);
    }
    clearSelection();
    state.selectedLine = undefined;
    state.detailRaw = null; // 详情已清空，原文一并作废（避免对已消失的行发起字段编辑）
    list.clearAllSelection();
    detail.clear();
    list.refresh();
    updateToolbar();
    // 删掉的可能正是一批坏行（「全选坏行 → 删除」正是本功能的主用途）→ 徽章必须降下来。
    scheduleBadLinesRefresh();
  }

  /* ---------------- 多选：选区状态 + 浮动操作条 ---------------- */

  /**
   * 选中的行集合。与 `state.selectedLine` 是两个概念：后者是详情面板的来源，
   * 前者是批量操作的对象。单选时两者一致。
   *
   * 状态**只放在这里**（列表只负责渲染 `setSelectedLines`）：同一份状态放两处，
   * 迟早会在某条路径上不同步，而这类 bug 表现为「删掉了没选中的行」这种严重后果。
   */
  const selectedLines = new Set<number>();
  /** Shift 范围选择的锚点。 */
  let selAnchor: number | undefined;

  /** 选区操作条（列表下方；选区 > 1 行时出现）。 */
  const selBar = document.createElement('div');
  selBar.className = 'jlv-selbar';
  selBar.hidden = true;

  const selText = document.createElement('span');
  selText.className = 'jlv-selbar-text';

  const selCopyBtn = document.createElement('button');
  selCopyBtn.type = 'button';
  selCopyBtn.className = 'jlv-btn';
  selCopyBtn.textContent = '复制';
  selCopyBtn.title = '复制选中行的原文到剪贴板';
  selCopyBtn.addEventListener('click', () => void copySelection());

  const selDeleteBtn = document.createElement('button');
  selDeleteBtn.type = 'button';
  selDeleteBtn.className = 'jlv-btn jlv-btn-danger';
  selDeleteBtn.textContent = '删除';
  selDeleteBtn.title = '删除选中的行（立即写入磁盘）';
  selDeleteBtn.addEventListener('click', () => confirmDeleteSelection());

  const selClearBtn = document.createElement('button');
  selClearBtn.type = 'button';
  selClearBtn.className = 'jlv-btn';
  selClearBtn.textContent = '取消选择';
  // 只清多选集合：详情面板仍停留在「最后点击的那一行」（它与多选是两个概念）。
  selClearBtn.addEventListener('click', () => clearSelection());

  selBar.append(selText, selCopyBtn, selDeleteBtn, selClearBtn);

  /** 把选区状态同步到列表与操作条（所有改选区的路径都必须过它）。 */
  function syncSelection(): void {
    list.setSelectedLines(selectedLines);
    const n = selectedLines.size;
    selBar.hidden = n <= 1;
    if (n > 1) selText.textContent = `已选中 ${n} 行`;
  }

  /** 清空选区（不改 `state.selectedLine`，详情仍可停留在原行）。 */
  function clearSelection(): void {
    selectedLines.clear();
    selAnchor = undefined;
    syncSelection();
  }

  /**
   * 单选某行：**同时**设置详情来源与选区（两者一致）。
   *
   * 键盘导航、跳转搜索匹配、初始化等所有「非鼠标点击」的选中路径都应走它 ——
   * 否则会出现「视觉上选中了、选区里却没有」的不一致，而批量操作按选区执行。
   */
  function selectSingle(line: number): void {
    selectedLines.clear();
    selectedLines.add(line);
    selAnchor = line;
    state.selectedLine = line;
    list.select(line);
    syncSelection();
  }

  /**
   * 显示顺序上 a 与 b 之间的所有真实行号（含两端）；范围过大时返回 null。
   *
   * 无过滤时就是连续整数区间；**过滤态下只包含当前显示中的行** —— 用户看到的是一份
   * 筛选后的列表，Shift 范围选择理应只覆盖看得见的那些行。
   *
   * 先算长度再决定是否分配：`Array.from({length: 1e6})` 会当场吃掉几十 MB。
   */
  function displayRangeBetween(a: number, b: number): number[] | null {
    const map = state.filterMap;
    if (!map) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (hi - lo + 1 > MAX_SELECTION_LINES) return null;
      return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    }
    const ia = map.indexOf(a);
    const ib = map.indexOf(b);
    if (ia < 0 || ib < 0) return [a, b]; // 端点不在当前视图：退化为两端
    const lo = Math.min(ia, ib);
    const hi = Math.max(ia, ib);
    if (hi - lo + 1 > MAX_SELECTION_LINES) return null;
    return map.slice(lo, hi + 1);
  }

  /** 列表点击 → 更新选区。三种模式：普通单选 / Ctrl 切换 / Shift 范围。 */
  function handleSelect(line: number, mods: { ctrl: boolean; shift: boolean }): void {
    if (mods.shift && selAnchor !== undefined) {
      const range = displayRangeBetween(selAnchor, line);
      if (!range) {
        banner.show(`一次最多选择 ${MAX_SELECTION_LINES} 行，请缩小范围后再试。`, undefined);
      } else {
        for (const l of range) selectedLines.add(l);
        // Shift 不重置锚点，便于连续多次扩展
      }
    } else if (mods.ctrl) {
      if (selectedLines.has(line)) selectedLines.delete(line);
      else selectedLines.add(line);
      selAnchor = line;
    } else {
      selectedLines.clear();
      selectedLines.add(line);
      selAnchor = line;
    }
    state.selectedLine = line;
    list.select(line);
    syncSelection();
    void showDetailForLine(line);
    updateNavEnabled();
    // 窄容器抽屉：选中记录后收起目录抽屉，回到详情主视图
    if (layout.isNarrow()) layout.setDrawer(false);
  }

  /**
   * 复制选中的行。原文由宿主读取后写入剪贴板（`vscode.env.clipboard` 比 webview 侧的
   * `navigator.clipboard` 可靠，不受 webview 权限限制）。
   */
  async function copySelection(): Promise<void> {
    const lines = [...selectedLines].toSorted((a, b) => a - b);
    if (lines.length === 0) return;
    try {
      const res = await bus.request<CopyLinesResultPayload>(
        HostEndpoint.COPY_LINES,
        { lines },
        { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
      ).promise;
      if (!res?.ok) {
        banner.show(res?.error ?? '复制失败', undefined);
        return;
      }
      const parts = [`已复制 ${res.count} 行到剪贴板`];
      if (res.skipped > 0) parts.push(`${res.skipped} 行因过大跳过`);
      if (res.truncated) parts.push('因超过上限已截断，请分批复制');
      banner.show(parts.join('；'), undefined);
    } catch (e) {
      banner.show(e instanceof Error ? e.message : String(e), undefined);
    }
  }

  /**
   * 批量删除选中的行。不可逆的磁盘写入，先横幅二次确认（webview 里 `window.confirm`
   * 不可用）。确认文案带上「几段连续」—— 用户能借此确认自己框对了吗。
   */
  function confirmDeleteSelection(): void {
    const lines = [...selectedLines].toSorted((a, b) => a - b);
    if (lines.length === 0) return;
    let segments = 1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] !== lines[i - 1] + 1) segments++;
    }
    // 多行时补一个前导空格，让「确定删除 3 行」而不是「确定删除3 行」（中文排版）。
    const what =
      lines.length === 1 ? `第 ${lines[0] + 1} 行` : ` ${lines.length} 行（${segments} 段连续）`;
    banner.show(`确定删除${what}？该操作会立即写入磁盘。`, '确认删除', () => {
      void (async () => {
        try {
          const res = await bus.request<DeleteManyResultPayload>(
            HostEndpoint.DELETE_RECORDS,
            { lines },
            { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
          ).promise;
          if (res?.cancelled) {
            banner.show('已取消：文件未被修改。', undefined);
            return;
          }
          if (!res?.ok) {
            banner.show(res?.error ?? '删除失败', undefined);
            return;
          }
          applyBulkDelete(res.deleted);
          const skippedNote = res.skipped > 0 ? `；${res.skipped} 行因过大跳过` : '';
          banner.show(`已删除 ${res.deleted} 行${skippedNote}`, undefined);
        } catch (e) {
          banner.show(e instanceof Error ? e.message : String(e), undefined);
        }
      })();
    });
  }

  // 组装两栏：左栏放入列头(toolbar) + 目录列表(分页)；右栏为详情面板；横幅浮层最后挂载。
  leftCol.appendChild(toolbar.root);
  leftCol.appendChild(list.scrollEl);
  leftCol.appendChild(selBar); // 选区操作条紧贴列表下方（选中 > 1 行时出现）
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

  // 详情工具「编辑」：编辑当前显示的那一行。
  navHandlers.onEdit = () => {
    if (state.selectedLine === undefined) return;
    void openEditForLine(state.selectedLine);
  };

  /* ---------------- 字段级编辑（详情树上点某个字段的值） ---------------- */

  const fieldPanel = createFieldPanel({
    submit: (segs, next) => commitFieldEdit(segs, next),
    notify: (message) => banner.show(message, undefined),
  });
  rootEl.appendChild(fieldPanel.root);

  navHandlers.onEditField = (segs, value) => {
    // 入口侧已按「原文是否可用」判定过，此处再防一层：拿不到原文就无法安全定位，
    // 与其让用户改完才发现失败，不如当场说清。
    if (!state.detailRaw) {
      banner.show('该行的原文不可用，请重新载入该记录后再编辑。', undefined);
      return;
    }
    fieldPanel.open(segs, value);
  };

  /**
   * 提交字段编辑：**定位 → 外科式替换 → 走已有的整行编辑链路**。
   *
   * 之所以复用 `EDIT_RECORD` 而不为字段编辑新开一条写入路径：冲突检测、乐观锁、
   * 索引增量、撤销栈、自写基线同步这五件事已经在那里做对了，复制一份必然漂移。
   * 字段级编辑与整行编辑的差别只在「新文本怎么算出来」——那由 jsonSpan 负责。
   */
  async function commitFieldEdit(
    segs: readonly PathSeg[],
    next: unknown
  ): Promise<{ ok: boolean; error?: string }> {
    const line = state.selectedLine;
    const raw = state.detailRaw;
    if (line === undefined) return { ok: false, error: '没有选中的记录。' };
    if (!raw) return { ok: false, error: '该行的原文不可用，请重新载入该记录后再编辑。' };

    // ① 只在原文里替换目标值那一段字节 —— 键序、空白、其余字段的转义风格逐字节不变。
    const replaced = replaceValueAtPath(raw.text, toPathParts(segs), next);
    if (!replaced.ok) return { ok: false, error: replaced.error };

    // ② 走整行编辑：`expectedBytes` 用宿主回传的原文字节数做乐观锁（外部改动即拒绝）。
    let res: EditResultPayload | null = null;
    try {
      res = await bus.request<EditResultPayload>(
        HostEndpoint.EDIT_RECORD,
        { line, text: replaced.text, expectedBytes: raw.bytes },
        { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
      ).promise;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!res?.ok) return { ok: false, error: describeEditFailure(res ?? {}) };

    // ③ 落盘成功：该行缓存失效 → 重绘卡片 → **后台**重拉详情。
    //    重拉必须 fire-and-forget：它要等宿主回执，若 await 它，保存就会显得卡住，
    //    而且重拉失败还会被误当成保存失败（两者是两回事）。
    //    重拉仍然必要 —— 详情树的原文会随之更新，否则下一次字段编辑会基于过期原文定位。
    state.cache.delete(line);
    list.refresh();
    updateToolbar();
    void showDetailForLine(line);
    scheduleBadLinesRefresh();
    return { ok: true };
  }

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
    // 切换行时**立刻**作废上一行的原文：新详情到位前若还留着旧原文，任何字段级编辑
    // 都会基于它定位，从而把改动写到别的行上 —— 那是最难发现的一类错改。
    // 放在函数最开头，各条提前返回的分支（坏行 / 异常）也就一并覆盖了。
    state.detailRaw = null;

    const cached = state.cache.get(line);
    if (cached && cached.ok === false) {
      cancelDetailRequest();
      detail.showError(cached.error ?? '该行不是合法 JSON。', line);
      return;
    }

    cancelDetailRequest();
    detail.showLoading();

    const { requestId, promise } = bus.request<{
      value?: unknown;
      error?: string;
      ok: boolean;
      rawText?: string;
      rawBytes?: number;
    }>(HostEndpoint.READ_RECORD, { line }, { timeoutMs: RPC_HEAVY_TIMEOUT_MS });
    state.detailInFlight = { rid: requestId };

    try {
      const res = await promise;
      if (state.detailInFlight?.rid !== requestId) return; // 已被更新的选择取代
      if (res && res.ok !== false && res.value !== undefined) {
        // 原文可用才记下（字段级编辑要在其中定位），并据此决定是否渲染字段编辑入口。
        state.detailRaw =
          res.rawText !== undefined && res.rawBytes !== undefined
            ? { text: res.rawText, bytes: res.rawBytes }
            : null;
        detail.showRecord(res.value, line, state.detailRaw !== null);
      } else {
        detail.showError(res?.error ?? '无法解析该记录。');
      }
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
      // 这一轮可能刚发现新的坏行（宿主集合是惰性积累的）→ 防抖刷新徽章，
      // 让用户滚动浏览时就能看见「原来这里有几行是坏的」。
      scheduleBadLinesRefresh();
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
    // reload 会清空宿主侧的坏行集合，从零重新积累 —— 徽章须同步（否则会残留旧数字）。
    void refreshBadLines();

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
  /** 取消全部在途请求（读批 / 搜索 / 过滤 / 详情），避免新旧数据交错污染 UI。 */
  function cancelAllInFlight(): void {
    actions.supersede(state.inFlight);
    state.inFlight = null;
    actions.supersede(state.searchInFlight);
    state.searchInFlight = null;
    actions.supersede(state.filterInFlight);
    state.filterInFlight = null;
    cancelDetailRequest();
  }

  /**
   * 索引已变更后的**本地状态复位**。
   *
   * 抽成独立函数供两条路径共用（手动「重新加载」与宿主推送的文档复位）——复位清单一旦
   * 在两处各写一遍，迟早会漂移，届时表现为「某条路径漏清了过滤/搜索」这类难查的脏状态。
   */
  function resetLocalState(totalLines: number): void {
    state.cache.clear();
    state.pending.clear();
    state.maxLoaded = 0;
    state.fields = null;
    // 索引已重建：行号与原文全部失效，详情原文一并作废。
    state.detailRaw = null;
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
    list.setTotalRows(totalLines);
    updateToolbar();
    updateNavEnabled();
  }

  /** 重新拉字段推断（摘要卡片 / 过滤下拉的数据源）。 */
  function fetchFields(): void {
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
  }

  async function reloadFile(): Promise<void> {
    banner.hide();
    cancelAllInFlight();
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
      resetLocalState(ov.totalLines);
      detail.clear();
      fetchFields();
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

  /**
   * 文档复位推送（放弃改动 / revert 触发）。
   *
   * 宿主已完成「从磁盘重载 + 重建索引」，故此处**只复位本地派生状态、不再发 RELOAD**
   * —— 再发一次会让宿主对大文件白扫一遍（GB 级要数秒）。
   */
  bus.onDocumentReset((payload) => {
    cancelAllInFlight();
    state.selectedLine = undefined;
    resetLocalState(state.overview?.totalLines ?? 0);
    detail.clear();
    fetchFields();
    banner.show(payload.message ?? '已从磁盘重新加载。');
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
  /**
   * Esc：清空多选。
   *
   * 编辑浮层打开时让位给它（浮层自己的 Esc 负责关闭面板）—— 否则按一次 Esc 会同时
   * 关面板又清选区，两件不相干的事一起发生。
   */
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    // 浮层打开时让位给它们（各自的 Esc 负责关闭自身）
    if (
      editPanel.isOpen() ||
      historyPanel.isOpen() ||
      badLinesPanel.isOpen() ||
      fieldPanel.isOpen()
    )
      return;
    if (selectedLines.size > 0) {
      clearSelection();
      e.preventDefault();
    }
  };
  document.addEventListener('keydown', onKeyDown);

  let cleanupCalled = false;
  const cleanup = (): void => {
    if (cleanupCalled) return;
    cleanupCalled = true;
    layout.dispose(); // 释放 ResizeObserver + 收起/展开动画定时器（columnLayout 内部状态）
    bus.dispose();
    scheduleFetch.dispose();
    list.dispose();
    detail.dispose();
    editPanel.dispose();
    historyPanel.dispose();
    badLinesPanel.dispose();
    fieldPanel.dispose();
    if (badLinesRefreshTimer) clearTimeout(badLinesRefreshTimer);
    toolbar.destroy();
    document.removeEventListener('keydown', onKeyDown);
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
