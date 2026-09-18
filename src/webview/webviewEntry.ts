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

import {
  computeFetchWindow,
  FieldLike,
  LRUCache,
  ThrottleQueue,
} from './logic.ts';
import type { RecordEntry } from './virtualScroll.ts';
import { VirtualRecordList } from './virtualScroll.ts';
import { createToolbar, ToolbarInfo } from './toolbar.ts';
import { createDetailTree } from './detailTree.ts';
import { createVSCodeApi, RpcBus } from './rpc.ts';
import {
  mergePersistedState,
  nextMatchIndex,
  prevMatchIndex,
  summarizeWithLayout,
  toPersistedState,
} from './queryLogic.ts';
import type { FieldCondition, FieldLayout } from './queryLogic.ts';
import { HostEndpoint } from '../protocol/rpc.ts';
import type { InitPayload, OverviewPayload, RecordsPayload, SearchResultsPayload } from '../protocol/rpc.ts';
import { CSS_TEXT } from './styles.ts';

/** 渲染用的记录形状（与 LRUCache 值一致）。 */
export type CachedRecord = RecordEntry & { value?: unknown };

function injectStyle(): void {
  const style = document.createElement('style');
  style.textContent = CSS_TEXT;
  document.head.appendChild(style);
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
/** 搜索防抖强匹配 / 过滤结果跳过的显示上限（防御性，避免超大数组卡 UI）。 */
const SEARCH_LIMIT = 5000;

/** 左栏默认宽度与可调宽度持久化键（拖拽分栏用）。 */
const DEFAULT_LIST_WIDTH = 320;
const LIST_WIDTH_KEY = 'jsonlViewer.listWidth';

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

/** 偏好持久化键命名空间。 */
function stateKey(uri: string): string {
  return `jsonlViewer.state.${uri}`;
}

function main(): void {
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

  function supersede(runState: { rid: string; superseded: boolean } | null): void {
    if (runState && !runState.superseded) {
      runState.superseded = true;
      bus.supersede(runState.rid);
    }
  }

  function jumpToMatch(line: number): void {
    list.select(line);
    list.scrollToLine(line);
    state.selectedLine = line;
    void showDetailForLine(line);
  }

  function runSearch(query: string): void {
    state.searchQuery = query;
    // 取消在途搜索（supersede），丢弃迟到结果。
    supersede(state.searchInFlight);
    state.searchInFlight = null;

    const q = query.trim();
    if (!q) {
      state.searchMatches = [];
      state.searchTruncated = false;
      toolbar.setSearchResult(0, 0);
      schedulePersist();
      return;
    }

    const { requestId, promise } = bus.request<SearchResultsPayload>(HostEndpoint.SEARCH, {
      query: q,
      field: undefined,
      scope: 'all',
    });
    state.searchInFlight = { rid: requestId, superseded: false };

    void promise
      .then((res) => {
        if (state.searchInFlight?.rid !== requestId) return;
        state.searchInFlight = null;
        state.searchMatches = (res?.matches ?? []).slice(0, SEARCH_LIMIT);
        state.searchTruncated = !!res?.truncated || (res?.total ?? 0) > state.searchMatches.length;
        if (state.searchMatches.length > 0) {
          toolbar.setSearchResult(state.searchMatches.length, 0);
          jumpToMatch(state.searchMatches[0]);
        } else {
          toolbar.setSearchResult(0, 0);
        }
      })
      .catch(() => {
        if (state.searchInFlight?.rid === requestId) state.searchInFlight = null;
        toolbar.setSearchResult(0, 0);
      });
  }

  function stepSearch(dir: 1 | -1): void {
    const matches = state.searchMatches;
    if (matches.length === 0) return;
    const current = state.selectedLine;
    const idx =
      dir === 1
        ? nextMatchIndex(matches, current ?? -1)
        : prevMatchIndex(matches, current ?? -1);
    if (idx < 0) return;
    toolbar.setSearchResult(matches.length, idx);
    jumpToMatch(matches[idx]);
  }

  function runFilter(cond: FieldCondition | null): void {
    supersede(state.filterInFlight);
    state.filterInFlight = null;

    if (!cond || !cond.field || !cond.op) {
      clearFilterForCond();
      return;
    }
    state.filterCond = cond;
    const { requestId, promise } = bus.request<{ matches: number[] | null }>(HostEndpoint.FILTER, {
      field: cond.field,
      op: cond.op,
      value: cond.value,
    });
    state.filterInFlight = { rid: requestId, superseded: false };

    void promise
      .then((res) => {
        if (state.filterInFlight?.rid !== requestId) return;
        state.filterInFlight = null;
        const matches = res?.matches;
        state.filterMap = matches && matches.length > 0 ? matches : [];
        // 保留滚动位置尽力：不清 scrollTop，直接重建翻译。
        list.setTranslation(state.filterMap);
        list.refresh();
        schedulePersist();
      })
      .catch(() => {
        if (state.filterInFlight?.rid === requestId) state.filterInFlight = null;
      });
  }

  function clearFilterForCond(): void {
    state.filterCond = null;
    state.filterMap = null;
    list.setTranslation(null);
    schedulePersist();
  }

  function applyLayout(layout: FieldLayout): void {
    state.fieldLayout = layout;
    list.refresh();
    toolbar.setLayout(layout);
    schedulePersist();
  }

  /* ---------------- 偏好持久化（防抖写回到 host workspaceState） ---------------- */
  function schedulePersist(): void {
    if (!state.persistKey) return;
    if (state.persistTimer) clearTimeout(state.persistTimer);
    state.persistTimer = setTimeout(() => {
      state.persistTimer = undefined;
      const value = toPersistedState({
        fieldLayout: state.fieldLayout,
        filter: state.filterCond,
        searchQuery: state.searchQuery.trim() || undefined,
      });
      bus.request(HostEndpoint.PERSIST_STATE, { key: state.persistKey, value }).promise.catch(() => {});
    }, 400);
  }

  /* ---------------- 概要栏 ---------------- */
  const toolbar = createToolbar(rootEl, {
    onSearch: (query) => runSearch(query),
    onSearchPrev: () => stepSearch(-1),
    onSearchNext: () => stepSearch(1),
    onApplyFilter: (cond) => runFilter(cond),
    onApplyLayout: (layout) => applyLayout(layout),
  });
  toolbar.update({ fileName: '', status: 'connecting', statusText: '连接中…' });

  /* ---------------- 详情面板（JSON 树，Task 5） ---------------- */
  const detail = createDetailTree(rootEl);

  /* ---------------- 主体布局：严格左右两栏 ---------------- */
  /* 左栏 = 列头(文件/搜索/筛选/统计) + 记录列表；右栏 = 详情面板(自带工具头) */
  const leftCol = document.createElement('div');
  leftCol.className = 'jlv-col-list';

  /* ---------------- 左右两栏分隔条（可拖拽调节宽度） ---------------- */
  const resizer = document.createElement('div');
  resizer.className = 'jlv-resizer';
  resizer.title = '拖动调整左右栏宽度（双击恢复默认）';

  function clampListWidth(w: number): number {
    return Math.max(180, Math.min(w, Math.max(DEFAULT_LIST_WIDTH, window.innerWidth * 0.6)));
  }
  function applyListWidth(w: number): void {
    leftCol.style.width = `${clampListWidth(w)}px`;
  }
  // 恢复上次拖拽宽度
  const savedW = listWidthFromStore();
  if (savedW !== null) applyListWidth(savedW);

  let dragStartX = 0;
  let dragStartW = 0;
  resizer.addEventListener('pointerdown', (e) => {
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
    saveListWidth(clampListWidth(dragStartW + (e.clientX - dragStartX)));
  };
  resizer.addEventListener('pointerup', endDrag);
  resizer.addEventListener('pointercancel', endDrag);
  resizer.addEventListener('dblclick', () => {
    applyListWidth(DEFAULT_LIST_WIDTH);
    saveListWidth(DEFAULT_LIST_WIDTH);
  });

  /* ---------------- 文件变更 / 错误横幅：右上角浮层提示（不占整行） ---------------- */
  const banner = createBanner();

  // 宿主返回的通用错误（如 init/索引构建失败）当前无 requestId 关联，
  // 这里统一透出到横幅，便于定位问题。
  bus.onError((e) => {
    console.error('[jsonl-viewer][webview] host error:', e.message);
    banner.show(`宿主错误：${e.message}`, undefined);
  });

  // 若发送 READY 后迟迟收不到 init（宿主异常/握手失败），给出明确提示而非静默停在“连接中…”。
  setTimeout(() => {
    if (!state.overview) {
      console.warn('[jsonl-viewer][webview] no init received in 8s');
      banner.show('未收到宿主数据响应（8s 超时）。请查看“输出→JSONL Viewer”或开发者控制台。', '重试', () => {
        bus.post(HostEndpoint.READY);
      });
    }
  }, 8000);

  /* ---------------- 虚拟滚动列表 ---------------- */
  const list = new VirtualRecordList({
    getRecord: (line) => state.cache.get(line),
    getFields: () => state.fields,
    summarize: (value) => summarizeWithLayout(value, state.fields, state.fieldLayout),
    onSelect: (line) => {
      state.selectedLine = line;
      list.select(line);
      void showDetailForLine(line);
    },
    onRangeChange: (displayFirst, displayLast) => {
      // 展示位 -> 真实行：过滤态下把可视区展示位映射为真实行号去拉取。
      const map = state.filterMap;
      if (map && map.length > 0) {
        const end = Math.min(displayLast, map.length);
        if (displayFirst < end) {
          const s = map[displayFirst];
          const e = map[end - 1];
          scheduleFetch.push({ first: s, lastExclusive: e + 1 });
        }
        return;
      }
      scheduleFetch.push({ first: displayFirst, lastExclusive: displayLast });
    },
    onJumpToSource: (line) => {
      // 右键「定位到源码行」：请宿主打开源文件并定位到该行（坏行定位同通道）。
      void bus.request(HostEndpoint.JUMP_TO_SOURCE, { line }).promise.catch(() => {});
    },
    onClearFilter: () => clearFilterForCond(),
  });
  // 组装两栏：左栏放入列头(toolbar) + 目录列表(分页)；右栏为详情面板；横幅浮层最后挂载。
  leftCol.appendChild(toolbar.root);
  leftCol.appendChild(list.scrollEl);
  leftCol.appendChild(list.pagerEl);
  rootEl.appendChild(leftCol);
  rootEl.appendChild(resizer);
  rootEl.appendChild(detail.root);
  rootEl.appendChild(banner.root);

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
      detail.showError(cached.error ?? '该行不是合法 JSON。');
      return;
    }

    cancelDetailRequest();
    detail.showLoading();

    const { requestId, promise } = bus.request<{ value?: unknown; error?: string; ok: boolean }>(
      HostEndpoint.READ_RECORD,
      { line }
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
  const scheduleFetch = new ThrottleQueue<{ first: number; lastExclusive: number }>(40, async (win) => {
    await fetchWindow(win);
  });

  async function fetchWindow(win: { first: number; lastExclusive: number }): Promise<void> {
    const ov = state.overview;
    if (!ov) return;
    const total = ov.totalLines;
    const s = clamp(win.first, 0, total);
    const e = clamp(win.lastExclusive, s, total);
    const missing = computeFetchWindow(s, e, (line) => state.cache.has(line) || state.pending.has(line));
    if (!missing) return;

    // 覆盖式取消：若上一请求仍在途，本地标记并请宿主尽力中断。
    if (state.inFlight && !state.inFlight.superseded) {
      state.inFlight.superseded = true;
      bus.supersede(state.inFlight.rid);
    }
    state.inFlight = { rid: '', superseded: false };
    for (let i = 0; i < missing.count; i++) state.pending.add(missing.start + i);

    const { requestId, promise } = bus.request<RecordsPayload>(HostEndpoint.READ_RECORDS, {
      startLine: missing.start,
      count: missing.count,
    });
    state.inFlight.rid = requestId;

    try {
      const payload = await promise;
      if (state.inFlight?.rid !== requestId || state.inFlight.superseded) return;
      if (payload.items.length === 0) return;
      for (const it of payload.items) {
        state.cache.set(it.line, { value: it.value, ok: it.ok, error: it.error });
        if (it.line + 1 > state.maxLoaded) state.maxLoaded = it.line + 1;
      }
      // 可视区已有真实数据，重绘展示。
      list.refresh();
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
    const merged = mergePersistedState(savedState, {
      fieldLayout: state.fieldLayout,
      filter: state.filterCond,
      searchQuery: state.searchQuery,
    }, known);
    if (merged.fieldLayout) {
      state.fieldLayout = merged.fieldLayout;
      toolbar.setLayout(state.fieldLayout);
      list.refresh();
    }
    if (merged.filter) runFilter(merged.filter);
    if (merged.searchQuery) {
      // 恢复搜索词（不自动触发搜索，避免打开即扫全文件；用户可按回车/触发）。
      const input = toolbar.searchInput();
      if (input && !input.value) input.value = merged.searchQuery;
    }
  }

  bus.onInit((payload: InitPayload) => {
    state.overview = payload;
    state.persistKey = stateKey(payload.uri);
    list.setTotalRows(payload.totalLines);
    updateToolbar();

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
      .request<OverviewPayload>(HostEndpoint.GET_OVERVIEW, {})
      .promise.then((ov) => {
        if (!ov) return;
        state.overview = ov;
        list.setTotalRows(ov.totalLines);
        updateToolbar();
      })
      .catch(() => {
        /* init 已含概览，这里失败可忽略；且不触发错误横幅。 */
      });

    // Task 3 接入后用于摘要卡片；若宿主尚未实现（返回 error）则回退到顶层 key 摘要。
    void bus
      .request<{ fields: FieldLike[] }>(HostEndpoint.GET_SAMPLE_FIELDS, {})
      .promise.then((res) => {
        if (res && Array.isArray(res.fields)) {
          state.fields = res.fields;
          toolbar.setFields(res.fields);
          toolbar.setLayout(state.fieldLayout);
          list.refresh();
          tryApplyPersisted();
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
    supersede(state.inFlight);
    state.inFlight = null;
    supersede(state.searchInFlight);
    state.searchInFlight = null;
    supersede(state.filterInFlight);
    state.filterInFlight = null;
    cancelDetailRequest();
    detail.showLoading();

    try {
      const ov = await bus.request<OverviewPayload>(HostEndpoint.RELOAD, {}).promise;
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
      toolbar.setSearchResult(0, 0);
      list.setTranslation(null);
      list.setTotalRows(ov.totalLines);
      updateToolbar();
      detail.clear();
      // 重新拉字段推断（供摘要卡片 / 过滤下拉）。
      void bus
        .request<{ fields: FieldLike[] }>(HostEndpoint.GET_SAMPLE_FIELDS, {})
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
    banner.show(payload.message ?? '文件已变更，索引可能过期。', '重新加载', () => void reloadFile());
  });

  // 初始：向宿主报告就绪，等待 init 回执。
  bus.post(HostEndpoint.READY);

  // 软刷新 / 尺寸变化：重新渲染当前可视窗口。
  window.addEventListener('resize', () => list.refresh());

  updateToolbar();
}

main();