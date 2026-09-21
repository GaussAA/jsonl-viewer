/**
 * queryActions.ts — 搜索 / 过滤 / 字段布局动作集（从 webviewEntry.main 抽出，T5 #31）。
 *
 * 职责：把「搜索」「上/下一个匹配」「过滤」「清除过滤」「字段布局」这些用户动作封装为一组
 * 纯动作函数，通过依赖注入与 main 解耦（bus / state / list / toolbar / 详情跳转 / 导航态 / 持久化）。
 * 行为与原 main 内联实现逐字一致，仅把闭包变量改为 deps 引用。
 *
 * 注意：`list` 与 `toolbar` 在 main 中晚于本模块创建，且 toolbar 的回调又依赖本模块动作
 * （先有动作、后有 toolbar），故以访问器 getList/getToolbar 晚绑定——调用发生在用户交互时，
 * 彼时二者均已就绪。
 */

import { HostEndpoint } from '../protocol/rpc.ts';
import type { SearchResultsPayload } from '../protocol/rpc.ts';
import { RPC_HEAVY_TIMEOUT_MS } from '../constants.ts';
import { nextMatchIndex, prevMatchIndex } from './queryLogic.ts';
import type { FieldCondition, FieldLayout } from './queryLogic.ts';
import type { VirtualRecordList } from './virtualScroll.ts';
import type { createToolbar } from './toolbar.ts';
import type { RpcBus } from './rpc.ts';

/** 搜索匹配保留上限（防御性，避免超大数组卡 UI）。 */
export const SEARCH_LIMIT = 5000;

/** queryActions 读写的 AppState 字段子集。 */
export interface QueryState {
  searchQuery: string;
  searchMatches: number[];
  searchTruncated: boolean;
  searchInFlight: { rid: string; superseded: boolean } | null;
  filterMap: number[] | null;
  filterCond: FieldCondition | null;
  filterInFlight: { rid: string; superseded: boolean } | null;
  selectedLine: number | undefined;
  fieldLayout: FieldLayout;
}

export interface QueryActionsDeps {
  bus: RpcBus;
  state: QueryState;
  /** 晚绑定：list 在 main 中于本模块之后创建。 */
  getList: () => VirtualRecordList;
  /** 晚绑定：toolbar 在 main 中于本模块之后创建。 */
  getToolbar: () => ReturnType<typeof createToolbar>;
  /** 跳转到指定行并展示详情（main 提供）。 */
  showDetailForLine: (line: number) => void;
  /** 刷新 prev/next 等导航按钮可用态（main 提供）。 */
  updateNavEnabled: () => void;
  /** 防抖持久化偏好（#32 将抽出，此处注入）。 */
  schedulePersist: () => void;
}

export interface QueryActions {
  /** 取消在途请求（标记 superseded 并通知总线丢弃迟到结果）。 */
  supersede(runState: { rid: string; superseded: boolean } | null): void;
  jumpToMatch(line: number): void;
  runSearch(query: string): void;
  stepSearch(dir: 1 | -1): void;
  runFilter(cond: FieldCondition | null): void;
  clearFilterForCond(): void;
  applyLayout(layout: FieldLayout): void;
}

export function createQueryActions(deps: QueryActionsDeps): QueryActions {
  const { bus, state } = deps;

  function supersede(runState: { rid: string; superseded: boolean } | null): void {
    if (runState && !runState.superseded) {
      runState.superseded = true;
      bus.supersede(runState.rid);
    }
  }

  function jumpToMatch(line: number): void {
    const list = deps.getList();
    list.select(line);
    list.scrollToLine(line);
    state.selectedLine = line;
    void deps.showDetailForLine(line);
    deps.updateNavEnabled();
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
      deps.getToolbar().setSearchResult(0, 0);
      deps.schedulePersist();
      return;
    }

    const { requestId, promise } = bus.request<SearchResultsPayload>(
      HostEndpoint.SEARCH,
      {
        query: q,
        field: undefined,
        scope: 'all',
      },
      { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
    );
    state.searchInFlight = { rid: requestId, superseded: false };

    void promise
      .then((res) => {
        if (state.searchInFlight?.rid !== requestId) return;
        state.searchInFlight = null;
        state.searchMatches = (res?.matches ?? []).slice(0, SEARCH_LIMIT);
        state.searchTruncated = !!res?.truncated || (res?.total ?? 0) > state.searchMatches.length;
        const toolbar = deps.getToolbar();
        if (state.searchMatches.length > 0) {
          toolbar.setSearchResult(state.searchMatches.length, 0);
          jumpToMatch(state.searchMatches[0]);
        } else {
          toolbar.setSearchResult(0, 0);
        }
      })
      .catch(() => {
        if (state.searchInFlight?.rid === requestId) state.searchInFlight = null;
        deps.getToolbar().setSearchResult(0, 0);
      });
  }

  function stepSearch(dir: 1 | -1): void {
    const matches = state.searchMatches;
    if (matches.length === 0) return;
    const current = state.selectedLine;
    const idx =
      dir === 1 ? nextMatchIndex(matches, current ?? -1) : prevMatchIndex(matches, current ?? -1);
    if (idx < 0) return;
    deps.getToolbar().setSearchResult(matches.length, idx);
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
    const { requestId, promise } = bus.request<{ matches: number[] | null; truncated?: boolean }>(
      HostEndpoint.FILTER,
      {
        field: cond.field,
        op: cond.op,
        value: cond.value,
      },
      { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
    );
    state.filterInFlight = { rid: requestId, superseded: false };

    void promise
      .then((res) => {
        if (state.filterInFlight?.rid !== requestId) return;
        state.filterInFlight = null;
        const matches = res?.matches;
        state.filterMap = matches && matches.length > 0 ? matches : [];
        const toolbar = deps.getToolbar();
        const list = deps.getList();
        // M7：宿主结果被截断时不再静默显示不全的匹配集。
        toolbar.setFilterTruncated(!!res?.truncated);
        // 保留滚动位置尽力：不清 scrollTop，直接重建翻译。
        list.setTranslation(state.filterMap);
        list.refresh();
        deps.schedulePersist();
        deps.updateNavEnabled();
      })
      .catch(() => {
        if (state.filterInFlight?.rid === requestId) state.filterInFlight = null;
        deps.getToolbar().setFilterTruncated(false);
      });
  }

  function clearFilterForCond(): void {
    state.filterCond = null;
    state.filterMap = null;
    const toolbar = deps.getToolbar();
    const list = deps.getList();
    toolbar.setFilterTruncated(false);
    list.setTranslation(null);
    deps.schedulePersist();
    deps.updateNavEnabled();
  }

  function applyLayout(layout: FieldLayout): void {
    state.fieldLayout = layout;
    deps.getList().refresh();
    deps.getToolbar().setLayout(layout);
    deps.schedulePersist();
  }

  return {
    supersede,
    jumpToMatch,
    runSearch,
    stepSearch,
    runFilter,
    clearFilterForCond,
    applyLayout,
  };
}
