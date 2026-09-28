/**
 * navigation.ts — 详情面板的「上一条 / 下一条」导航与导航态（从 webviewEntry.main 抽出）。
 *
 * 抽出的理由：这一块是**纯状态推导**——把「展示位 ↔ 真实行号」的映射、选中位置、
 * 边界可用性三件事算清楚，再驱动两个按钮的可用态与跳转。它不碰 DOM、不发 RPC，
 * 与装配层其余部分只通过三个回调相连（聚焦列表 / 拉详情 / 打开编辑），
 * 是最适合先切出去的一块。
 *
 * 关键口径（**勿改**）：
 *   - 过滤态下导航只在**当前筛选结果内**移动 —— 用户看到的是筛选后的列表，
 *     按「下一条」却跳到一条不在结果里的记录，是明显的错乱；
 *   - 无选中时两侧都可用（会从首条或末条开始），否则面板会呈现「两个按钮都灰着」
 *     的死路。
 */

import type { AppState } from './appState.ts';
import type { DetailTreeNavHandlers } from './detailTree.ts';
import type { FocusTarget } from './focusTarget.ts';

export interface NavigationDeps {
  /** 只依赖这三个字段——模块不该拿到整份状态的写权限。 */
  state: Pick<AppState, 'filterMap' | 'overview' | 'selectedLine'>;
  /** 列表：把目标行滚动到可视区。 */
  list: { focus(line: number): void };
  /** 详情面板：设置上一个/下一个按钮的可用态。 */
  detail: { setNavEnabled(prev: boolean, next: boolean): void };
  /** 详情树导航回调（由本模块填充）。 */
  navHandlers: DetailTreeNavHandlers;
  /**
   * 选中行的**唯一写入口**（含作废旧原文、取消在途详情、重拉详情）。
   * 本模块不再直接写 `state.selectedLine` —— 那是 11 处散落写入的来源。
   */
  focus: FocusTarget;
  /** 打开某行的编辑浮层。 */
  openEditForLine: (line: number) => unknown;
}

export interface Navigation {
  /** 选中态或过滤态变化后调用：重算上/下一条的可用态。 */
  updateNavEnabled: () => void;
}

export function createNavigation(deps: NavigationDeps): Navigation {
  const { state, list, detail, navHandlers, focus, openEditForLine } = deps;

  /** 当前可见记录总数（过滤态取筛选结果长度）。 */
  function getTotalVisible(): number {
    return state.filterMap ? state.filterMap.length : (state.overview?.totalRecords ?? 0);
  }

  /** 展示位索引 → 真实行号（过滤态/全量态统一）。 */
  function displayToReal(d: number): number {
    return state.filterMap ? state.filterMap[d] : d;
  }

  /** 当前选中行在展示序列中的索引；-1 表示无选中或不在范围内。 */
  function selectedDisplayIndex(): number {
    const line = state.selectedLine;
    if (line === undefined) return -1;
    if (state.filterMap) {
      return state.filterMap.indexOf(line);
    }
    if (state.overview && line >= 0 && line < state.overview.totalRecords) return line;
    return -1;
  }

  function updateNavEnabled(): void {
    const total = getTotalVisible();
    if (total <= 0) {
      detail.setNavEnabled(false, false);
      return;
    }
    const idx = selectedDisplayIndex();
    if (idx < 0) {
      // 无选中：两边都放行（会从第一条或最后一条开始）
      detail.setNavEnabled(true, true);
      return;
    }
    detail.setNavEnabled(idx > 0, idx < total - 1);
  }

  /** 按方向走一步（dir = -1 上一条 / +1 下一条）。 */
  function step(dir: -1 | 1): void {
    const total = getTotalVisible();
    if (total <= 0) return;
    const idx = selectedDisplayIndex();
    const target = idx < 0 ? (dir < 0 ? total - 1 : 0) : idx + dir;
    if (target < 0 || target >= total) return;
    const real = displayToReal(target);
    list.focus(real);
    focus.set(real); // 单一写入口：作废旧原文 + 取消在途详情 + 重拉详情，一步不漏
    updateNavEnabled();
  }

  navHandlers.onPrevRecord = () => step(-1);
  navHandlers.onNextRecord = () => step(1);

  // 详情工具「编辑」：编辑当前显示的那一行。
  navHandlers.onEdit = () => {
    if (state.selectedLine === undefined) return;
    void openEditForLine(state.selectedLine);
  };

  return { updateNavEnabled };
}
