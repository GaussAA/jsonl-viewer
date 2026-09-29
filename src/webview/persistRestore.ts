/**
 * persistRestore.ts — 偏好恢复：把上次打开同一文件的状态（字段布局 / 过滤 / 搜索词）
 * 合并回当前会话（从 webviewEntry.main 抽出）。
 *
 * 抽出的理由：这是一条**有明确时序的两源合并**规则 —— 持久化状态与字段推断结果
 * 谁先到不一定（LOAD_STATE 是本地读、GET_SAMPLE_FIELDS 要走宿主抽样），
 * 必须「两者都就绪才合并」。把这套时序单独放一处，才不会被散落的回调各写一遍。
 *
 * 三条不可动摇的规则：
 *   1. **脏数据不得覆盖当前布局**：合并以「当前字段集」为白名单（`mergePersistedState`
 *      的 `known` 参数），持久化里的未知字段一律丢弃 —— 文件结构可能早已变了。
 *   2. **恢复搜索词但不自动触发搜索**：打开文件就扫全文件（GB 级要数秒）是不可接受的
 *      代价，用户想搜自己按回车。
 *   3. **失败也要标记「已加载」**：否则后续字段推断到达时会永远等一个不会来的信号，
 *      表现为「偏好恢复随机失效」。
 */

import type { AppState } from './appState.ts';
import type { Condition, FieldLayout } from './queryLogic.ts';
import { mergePersistedState } from './queryLogic.ts';

export interface PersistRestoreDeps {
  state: AppState;
  /** 应用字段布局 + 读取搜索框（用于回填搜索词）。 */
  toolbar: {
    setLayout(layout: FieldLayout): void;
    /** 把过滤条件回填进筛选面板（F3）：恢复偏好后面板里也是这一份，不是空的。 */
    setFilterCondition(cond: Condition | null): void;
    searchInput(): HTMLInputElement | null;
  };
  list: { refresh(): void };
  /** 用恢复出的条件重算过滤（null = 恢复成「不过滤」）。 */
  runFilter: (cond: Condition | null) => void;
}

export interface PersistRestore {
  /**
   * 持久化状态到达（`LOAD_STATE` 回执）。`undefined` 表示「无持久化数据」——
   * 同样要标记已加载，否则合并会永远等待。
   */
  onLoaded: (saved: unknown) => void;
  /** 字段推断完成后调用；两源都就绪才真正合并。 */
  tryApply: () => void;
}

export function createPersistRestore(deps: PersistRestoreDeps): PersistRestore {
  const { state, toolbar, list, runFilter } = deps;

  let loaded = false;
  let saved: unknown;

  function tryApply(): void {
    if (!loaded || !state.fields) return;
    // 以当前字段集为白名单：持久化里已不存在的字段一律丢弃，避免脏布局覆盖现状。
    const known = new Set(state.fields.map((f) => f.key));
    const merged = mergePersistedState(
      saved,
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
    // 回填面板 + 触发求值：只做后者的话，用户打开筛选面板会看到一个空白盒子，
    // 以为「没有条件」，而列表却明显是被筛过的 —— 这是最容易让人误判的一类不一致。
    toolbar.setFilterCondition(merged.filter ?? null);
    if (merged.filter) runFilter(merged.filter);
    if (merged.searchQuery) {
      // 恢复搜索词（不自动触发搜索，避免打开即扫全文件；用户可按回车/触发）。
      const input = toolbar.searchInput();
      if (input && !input.value) input.value = merged.searchQuery;
    }
  }

  return {
    onLoaded: (value: unknown) => {
      saved = value;
      loaded = true; // 失败/无数据同样置真：见文件头规则 ③
      tryApply();
    },
    tryApply,
  };
}
