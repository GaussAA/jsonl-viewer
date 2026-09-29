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

import { computeFetchWindow, segmentSortedLines, ThrottleQueue } from './logic.ts';
import type { FieldLike } from './logic.ts';
import { VirtualRecordList } from './virtualScroll.ts';
import { createToolbar } from './toolbar.ts';
import type { ToolbarInfo } from './toolbar.ts';
import { createDetailTree, type DetailTreeNavHandlers } from './detailTree.ts';
import { createEditPanel } from './editPanel.ts';
import { createHistoryPanel } from './historyPanel.ts';
import { scanProgressText } from './badLinesPanel.ts';
import {
  editProgressText,
  estimateEditCost,
  replaceProgressText,
  EDIT_COST_WARN_BYTES,
} from './editLogic.ts';
import { createColumnLayout, type ColumnLayout } from './columnLayout.ts';
import { createQueryActions, type QueryActions } from './queryActions.ts';
import { createPersistence } from './persistence.ts';
import { createNavigation } from './navigation.ts';
import { createSelection } from './selection.ts';
import { createEditOps } from './editOps.ts';
import { createFieldEdit } from './fieldEdit.ts';
import { createBadLinesOps } from './badLinesOps.ts';
import { createPersistRestore } from './persistRestore.ts';
import { createFocusTarget } from './focusTarget.ts';
import { createVSCodeApi, RpcBus } from './rpc.ts';
import { createAppState } from './appState.ts';
import type { VSCodeApi } from './rpc.ts';
import { summarizeWithLayout } from './queryLogic.ts';
import { HostEndpoint } from '../protocol/rpc.ts';
import type { EditResultPayload, HistoryPayload, HistoryResultPayload } from '../protocol/rpc.ts';
import type { InitPayload, OverviewPayload, RecordsPayload } from '../protocol/rpc.ts';
import { CSS_TEXT } from './styles.ts';
import { INIT_TIMEOUT_MS, RPC_HEAVY_TIMEOUT_MS } from '../constants.ts';

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
  // 文件变更 / 超时 / 进度这类状态对读屏必须**可播报**（此前是纯视觉元素，读屏完全无感）。
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');

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

/**
 * 会话级 UI 偏好（左栏宽度 / 折叠态）—— 存 **VS Code 托管的 webview state**
 * （`acquireVsCodeApi().getState/setState`），而非 `localStorage`。
 *
 * 为何换成它：
 *   1. `localStorage` 是浏览器侧存储，在 webview 里可能被策略禁用或随沙箱重置而丢失，
 *      表现为「上次调好的栏宽又回默认了」；
 *   2. webview state 由 VS Code 在面板重建（隐藏后恢复 / 重开窗口）时**原样交回**，
 *      正是为这类「视图自身状态」设计的通道；
 *   3. 它与「文件级偏好走宿主 workspaceState」形成清晰分层：**视图自身状态同步读**、
 *      **跨会话的文件偏好异步落宿主** —— 栏宽必须在首帧同步可用，否则会先闪一下默认宽度。
 *
 * 注意：不要用 workspaceState 存栏宽 —— 那要经过一次异步 RPC，首帧拿不到，
 * 用户会看到宽度跳变。
 */
interface UiState {
  listWidth?: number;
  listCollapsed?: boolean;
}

/** 当前 webview 的 VS Code API 句柄（main 中赋值，供本模块级读写函数使用）。 */
let vscodeApi: VSCodeApi | null = null;

function readUiState(): UiState {
  try {
    const s = vscodeApi?.getState?.();
    return s && typeof s === 'object' ? (s as UiState) : {};
  } catch {
    return {}; // state 不可用不应影响功能
  }
}

function writeUiState(patch: UiState): void {
  try {
    vscodeApi?.setState?.({ ...readUiState(), ...patch });
  } catch {
    /* 写入失败（配额 / 沙箱）忽略：栏宽不是关键数据 */
  }
}

/** 读取持久化的左栏宽度（首帧同步可用）。 */
function listWidthFromStore(): number | null {
  const n = readUiState().listWidth;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}
function saveListWidth(w: number): void {
  writeUiState({ listWidth: w });
}

function listCollapsedFromStore(): boolean {
  return readUiState().listCollapsed === true;
}
function saveListCollapsed(collapsed: boolean): void {
  writeUiState({ listCollapsed: collapsed });
}

/** 偏好持久化键命名空间。 */
function stateKey(uri: string): string {
  return `jsonlViewer.state.${uri}`;
}

export function main(): void {
  injectStyle();

  const api = createVSCodeApi();
  // 供模块级的 UI 偏好读写函数使用（webview state 由 VS Code 托管，见 readUiState）。
  vscodeApi = api;
  const rootEl = document.getElementById('app');
  if (!rootEl) return;

  // 后端不可用（例如在非 webview 环境打开 app）：给出友好提示，不抛错。
  if (!api) {
    rootEl.textContent = 'JSONL Viewer：无法连接到插件宿主（缺少 acquireVsCodeApi）。';
    return;
  }
  const bus = new RpcBus(api);

  const state = createAppState();

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
    // 详情展示由 selectLine → selection.selectSingle → focus 统一负责，不在这里重复拉
    selectLine: (line) => selection.selectSingle(line),
    updateNavEnabled: () => nav.updateNavEnabled(),
    schedulePersist,
  });

  /* ---------------- 概要栏 ---------------- */
  const toolbar = createToolbar(rootEl, {
    onSearch: (query) => actions.runSearch(query),
    onSearchPrev: () => actions.stepSearch(-1),
    onSearchNext: () => actions.stepSearch(1),
    onReplaceAll: (query, replacement) => editOps.replaceAll(query, replacement),
    onOpenHistory: () => historyPanel.open(),
    onOpenBadLines: () => badLinesOps.open(),
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

  /** 正在执行的批量字段级替换（null = 无）。 */
  let activeFieldReplace: { requestId: string } | null = null;

  /**
   * 长任务进度 → 横幅（只换文字，不得触碰「取消」按钮）。
   *
   * 按 `kind` 分派而非各订阅一次：进度通道本就是「长任务的字节级进度」，
   * 与任务语义无关；加一种长任务不该再造一条推送链路。
   */
  bus.onEditProgress((info) => {
    if (
      (info.kind === 'replace' && activeReplace) ||
      (info.kind === 'replaceField' && activeFieldReplace)
    ) {
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
    console.error('[jsonl-viewer][webview] host error:', e.code ?? 'INTERNAL', e.message);
    // 按错误码分情况，而非一律「宿主错误」：取消是零风险的静默收场，
    // 冲突要引导重新加载，超时要给出可重试的暗示 —— 混成一句会让人无从行动。
    if (e.code === 'CANCELLED') return;
    if (e.code === 'CONFLICT') {
      banner.show(`文件已被外部修改：${e.message}`, '重新加载', () => void reloadFile());
      return;
    }
    if (e.code === 'TIMEOUT') {
      banner.show(`请求超时：${e.message}（可重试）`, undefined);
      return;
    }
    banner.show(`宿主错误：${e.message}`, undefined);
  });

  // 协议版本不匹配：扩展更新后 VS Code 可能仍复用旧版 webview 脚本。
  // 不提示的话，用户只会看到「点了没反应 / 字段全空」这类无法归因的现象。
  bus.onProtocolMismatch(({ host, web }) => {
    banner.show(
      `扩展已更新（宿主协议 v${host}，当前界面 v${web}）——请关闭并重新打开该文件以加载新版界面。`,
      undefined
    );
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
    onSelect: (line, mods) => selection.handleSelect(line, mods),
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
    onEditRecord: (line) => void editOps.openEditForLine(line),
    // 右键「在第 N 行前插入」：无需拉原文，直接以空文本打开插入模式的浮层。
    onInsertRecord: (line) => editPanel.open(line, '', 'insert'),
    // 右键「删除第 N 行」：先横幅二次确认，再落盘。
    onDeleteRecord: (line) => editOps.deleteRecordAt(line),
    // 右键菜单的批量项（选区 > 1 行时出现）
    onDeleteSelected: () => selection.confirmDelete(),
    onCopySelected: () => void selection.copy(),
    onClearFilter: () => actions.clearFilterForCond(),
    // 截断态「复制该行 JSON」：按需拉完整值（列表缓存不持有超大对象）。
    onRequestRecord: (line) =>
      bus.request<{ value?: unknown; error?: string; ok: boolean }>(
        HostEndpoint.READ_RECORD,
        { line },
        { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
      ).promise,
  });
  /* ---------------- prev / next 导航（已抽至 navigation.ts） ----------------
   * 纯状态推导：展示位 ↔ 真实行号映射 + 选中位置 + 边界可用性。
   * 必须在 createColumnLayout 之前装配：布局初始化会同步回调 updateNavEnabled。 */
  /* ---------------- 选中行的唯一写入口（focusTarget.ts） ----------------
   * 此前 state.selectedLine 散落 11 处写入、跨 5 个模块，配套动作（作废旧原文 /
   * 取消在途详情 / 重拉详情）极易漏 —— refreshOverview 的越界收敛就漏了。
   * 收敛成单一入口后，这类"漏一步"在结构上不可能再发生。
   * 位置要求：早于 nav/selection/editOps/badLinesOps（它们都要注入它）。 */
  const focus = createFocusTarget({
    state,
    showDetail: (line) => void showDetailForLine(line),
    clearDetail: () => detail.clear(),
    cancelDetailRequest: () => cancelDetailRequest(),
  });

  const nav = createNavigation({
    state,
    list,
    detail,
    navHandlers,
    focus,
    openEditForLine: (line) => void editOps.openEditForLine(line),
  });

  /* ---------------- 行编辑浮层（编辑能力） ----------------
   * 初始文本一律取**磁盘原文**（readRecord 的 rawText），而非用 value 重新序列化的结果：
   * 后者会把用户原有的键序与空白重排掉，字节长度随之变化、放大变长编辑的搬移成本。 */

  const editPanel = createEditPanel({
    getOverview: () =>
      state.overview
        ? { totalBytes: state.overview.totalBytes, totalRecords: state.overview.totalRecords }
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
              { line: info.line, text: info.text, expectedBytes: editOps.getExpectedBytes() },
              { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
            );

      const ov = state.overview;
      const cost = ov === null ? 0 : estimateEditCost(ov.totalBytes, ov.totalRecords, info.line);
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
        editOps.applyRowCountChange(line, mode);
      }
      list.refresh();
      if (state.selectedLine !== undefined) void showDetailForLine(state.selectedLine);
      updateToolbar();
      // 编辑可能把坏行改好（也可能因行增删而位移）→ 徽章要跟上。
      badLinesOps.scheduleRefresh();
      // 本地行数是乐观推算 —— 用宿主权威值校正（并发写 / 冲突下推算会失真）。
      void editOps.refreshOverview();
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
      badLinesOps.scheduleRefresh();
      // 撤销/重做会增删行 → 总行数必须回到宿主的权威值。
      void editOps.refreshOverview();
    },
    notify: (message) => banner.show(message, undefined),
  });
  rootEl.appendChild(historyPanel.root);

  /* ---------------- 坏行诊断（已抽至 badLinesOps.ts） ----------------
   * 徽章 → 面板 → 跳转/全选 是一条自洽的诊断链，整体切出。
   * selection 以访问器注入 —— 选区在本模块之后才装配（交互时才访问，运行时已就绪）。 */
  const badLinesOps = createBadLinesOps({
    bus,
    list,
    toolbar,
    banner,
    selection: {
      replace: (lines) => selection.replace(lines),
      selectSingle: (line) => selection.selectSingle(line),
    },
    focus,
    updateNavEnabled: () => nav.updateNavEnabled(),
    setActiveScan: (rid) => {
      activeScan = rid === null ? null : { requestId: rid };
    },
  });
  rootEl.appendChild(badLinesOps.root);

  /* ---------------- 写操作域（已抽至 editOps.ts） ----------------
   * 编辑 / 删除 / 批量替换 / 写后复位，统一由 editOps 提供。
   * 位置要求：晚于 editPanel（依赖它打开浮层）、早于 selection（后者需要 applyBulkDelete）。
   * clearSelection 以访问器注入 —— selection 在本模块之后才装配。 */
  const editOps = createEditOps({
    state,
    bus,
    list,
    editPanel,
    banner,
    toolbar,
    focus,
    showDetailForLine: (line) => void showDetailForLine(line),
    updateToolbar,
    scheduleBadLinesRefresh: () => badLinesOps.scheduleRefresh(),
    clearSelection: () => selection.clear(),
    setActiveReplace: (rid) => {
      activeReplace = rid === null ? null : { requestId: rid };
    },
    rerunFilter: () => {
      if (state.filterCond) actions.runFilter(state.filterCond);
    },
    rerunSearch: (query) => actions.runSearch(query),
  });

  /* ---------------- 多选选区（已抽至 selection.ts） ----------------
   * 选区状态**只存在这一处**：列表只渲染、详情来源是另一个概念。
   * layout 以访问器注入——它在更后面才装配完成（直接传值会撞 TDZ）。 */
  const selection = createSelection({
    state,
    bus,
    list,
    banner,
    focus,
    updateNavEnabled: () => nav.updateNavEnabled(),
    layout: {
      isNarrow: () => layout.isNarrow(),
      setDrawer: (open) => layout.setDrawer(open),
    },
    applyBulkDelete: editOps.applyBulkDelete,
  });

  // 组装两栏：左栏放入列头(toolbar) + 目录列表(分页)；右栏为详情面板；横幅浮层最后挂载。
  leftCol.appendChild(toolbar.root);
  leftCol.appendChild(list.scrollEl);
  leftCol.appendChild(selection.root); // 选区操作条紧贴列表下方（选中 > 1 行时出现）
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
    updateNavEnabled: () => nav.updateNavEnabled(),
    saveListCollapsed,
    listCollapsedFromStore,
    listWidthFromStore,
    saveListWidth,
  });

  /* ---------------- 字段级编辑（已抽至 fieldEdit.ts） ----------------
   * 与整行编辑对称：都是在磁盘原文上定位后走同一条落盘链路，
   * 差别只在「新文本怎么算出来」（字段编辑由 jsonSpan 精确替换那一段字节）。 */
  const fieldEdit = createFieldEdit({
    state,
    bus,
    list,
    banner,
    navHandlers,
    showDetailForLine: (line) => void showDetailForLine(line),
    updateToolbar,
    scheduleBadLinesRefresh: () => badLinesOps.scheduleRefresh(),
    setActiveFieldReplace: (rid) => {
      activeFieldReplace = rid === null ? null : { requestId: rid };
    },
  });
  rootEl.appendChild(fieldEdit.root);

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
    const total = ov.totalRecords;
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
      badLinesOps.scheduleRefresh();
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
      info.totalRecords = ov.totalRecords;
      info.loadedLines = state.cache.size;
      // 翻页式目录：展示当前页的真实行闭区间（1 起）；空页兜底到全量。
      const bounds = list.getCurrentPageRealBounds();
      info.range = bounds ?? ([0, Math.max(0, ov.totalRecords - 1)] as [number, number]);
      info.buildMs = ov.buildMs;
    }
    toolbar.update(info);
  }

  /* ---------------- init / 生命周期 ---------------- */
  /* ---------------- 偏好恢复（已抽至 persistRestore.ts） ----------------
   * 两源合并（持久化状态 + 字段推断结果）的时序规则集中在那里，
   * 包括「失败也标记已加载」这条容易漏掉的分支。 */
  const persistRestore = createPersistRestore({
    state,
    toolbar,
    list,
    runFilter: (cond) => actions.runFilter(cond),
  });

  bus.onInit((payload: InitPayload) => {
    // 索引已就绪：收起「正在构建索引…」柔性提示（若曾显示）。
    if (buildHintShown) {
      buildHintShown = false;
      banner.hide();
    }
    state.overview = payload;
    state.persistKey = stateKey(payload.uri);
    list.setTotalRows(payload.totalRecords);
    updateToolbar();
    nav.updateNavEnabled();
    // reload 会清空宿主侧的坏行集合，从零重新积累 —— 徽章须同步（否则会残留旧数字）。
    void badLinesOps.refresh();

    // 打开文件默认选中第一条并展示其 JSON；右侧细节树已内置「仅展开顶层、嵌套折叠」的默认态。
    if (state.selectedLine === undefined && payload.totalRecords > 0) {
      focus.set(0); // 详情由写入口一并拉取
      list.select(0); // 首帧不加 scrollToLine（避免入场动画/重建导致打开时闪一次）
      nav.updateNavEnabled();
    }

    // 读取已持久化偏好（无数据时同样标记「已加载」，见 persistRestore）。
    void bus
      .request<unknown>(HostEndpoint.LOAD_STATE, { key: state.persistKey })
      .promise.then((v) => persistRestore.onLoaded(v))
      .catch(() => persistRestore.onLoaded(undefined));

    // 拉一遍最新概览（构建索引后统计更精确），同时由列表的 onRangeChange 触发初始 readRecords。
    void bus
      .request<OverviewPayload>(HostEndpoint.GET_OVERVIEW, {}, { timeoutMs: RPC_HEAVY_TIMEOUT_MS })
      .promise.then((ov) => {
        if (!ov) return;
        state.overview = ov;
        list.setTotalRows(ov.totalRecords);
        updateToolbar();
        nav.updateNavEnabled();
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
          persistRestore.tryApply();
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
  function resetLocalState(totalRecords: number): void {
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
    list.setTotalRows(totalRecords);
    updateToolbar();
    nav.updateNavEnabled();
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
      resetLocalState(ov.totalRecords);
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
    resetLocalState(state.overview?.totalRecords ?? 0);
    focus.clear(); // 清选中 + 作废旧原文 + 清详情面板（三者必须同步）
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
    if (editPanel.isOpen() || historyPanel.isOpen() || badLinesOps.isOpen() || fieldEdit.isOpen())
      return;
    if (selection.lines.size > 0) {
      selection.clear();
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
    badLinesOps.dispose();
    fieldEdit.dispose();
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
