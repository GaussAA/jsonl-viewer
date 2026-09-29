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
import { hasAnyRealCondition, nextMatchIndex, prevMatchIndex } from './queryLogic.ts';
import type { Condition, FieldLayout } from './queryLogic.ts';
import type { VirtualRecordList } from './virtualScroll.ts';
import type { createToolbar } from './toolbar.ts';
import type { RpcBus } from './rpc.ts';

/** 搜索匹配保留上限（防御性，避免超大数组卡 UI）。 */
export const SEARCH_LIMIT = 5000;

/** queryActions 读写的 AppState 字段子集。 */
export interface QueryState {
  searchQuery: string;
  searchMatches: number[];
  searchInFlight: { rid: string; superseded: boolean } | null;
  filterMap: number[] | null;
  filterCond: Condition | null;
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
  /**
   * 选中某行（main 提供）。
   *
   * 必须由装配层统一入口：选中要同时更新「详情来源 + 多选选区 + 列表视觉」，
   * 各调用方自己拼容易漏掉其中一项，而漏掉选区会让后续批量操作作用于错误的行。
   */
  selectLine: (line: number) => void;
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
  runFilter(cond: Condition | null): void;
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
    // 选中语义统一收口：selectLine → selection.selectSingle → focusTarget.set，
    // 后者会**一并**作废旧原文并拉取详情。此处再拉一次就会发出两条重复的
    // READ_RECORD（既浪费往返，也让详情请求相互 supersede、产生无谓的闪烁）。
    deps.selectLine(line);
    deps.getList().scrollToLine(line);
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
      deps.getToolbar().setSearchResult(0, 0);
      // 清空搜索 → 同时清掉卡片上的命中高亮（否则会留下一个「已经不存在」的标记）。
      deps.getList().setSearchNeedle(null);
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
        const toolbar = deps.getToolbar();
        deps.getToolbar().setQueryError(null); // 有结果了 → 撤掉失败态
        // 命中高亮：把搜索词交给列表，由它把**已渲染卡片**里的命中片段标出来。
        // 只标已渲染的（不为高亮预取数据）——「为什么这行算命中」通常一眼就能看清那几行。
        deps.getList().setSearchNeedle(q);
        if (state.searchMatches.length > 0) {
          toolbar.setSearchResult(state.searchMatches.length, 0);
          jumpToMatch(state.searchMatches[0]);
        } else {
          toolbar.setSearchResult(0, 0);
        }
      })
      .catch(() => {
        if (state.searchInFlight?.rid === requestId) state.searchInFlight = null;
        // 失败 ≠ 没有命中：显示 0 会让用户以为文件里真的没有这个词，从而做出错误判断。
        deps.getToolbar().setQueryError('搜索失败（可重试）');
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

  function runFilter(cond: Condition | null): void {
    supersede(state.filterInFlight);
    state.filterInFlight = null;

    // 「有没有真正填过的条件」按**结构**判定：组合条件的外层是组、没有 field/op 字段，
    // 沿用旧的 `cond.field && cond.op` 判断会把整组条件当成空条件、静默清掉过滤。
    if (!hasAnyRealCondition(cond)) {
      clearFilterForCond();
      return;
    }
    state.filterCond = cond;
    const { requestId, promise } = bus.request<{ matches: number[] | null; truncated?: boolean }>(
      HostEndpoint.FILTER,
      { condition: cond },
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
        toolbar.setQueryError(null);
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
        // 过滤失败时**保留旧 filterMap**（不把用户丢进空视图），但要如实说明这次没生效。
        deps.getToolbar().setQueryError('过滤失败（可重试），仍显示上一次结果');
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
