/**
 * focusTarget.ts — 「当前选中行」的**唯一写入口**（含它的派生状态）。
 *
 * 为何要有它（数据驱动，见 `docs/ARCHITECTURE_REVIEW.md` T5 的触发条件②）：
 * `state.selectedLine` 此前散落 **11 处写入、跨 5 个模块**（selection / navigation /
 * badLinesOps / editOps / webviewEntry），语义又各不相同（点击选中、导航移动、坏行落点、
 * 行增删位移、越界收敛、复位）。真正的危险不在"写得乱"，而在**配套动作会漏**：
 *
 *   `selectedLine` 与 `detailRaw`（详情面板那行的**磁盘原文**）是一对必须同步的状态 ——
 *   字段级编辑用「selectedLine 定位行、detailRaw 提供原文」。二者一旦错位，
 *   编辑器就会**基于 A 行的原文、把改动写到 B 行上**（不可逆的错改）。
 *   原实现里多数路径记得作废原文，但 `refreshOverview` 的越界收敛路径漏了。
 *
 * 于是本模块把「改选中行」收敛成一个动作，并把配套行为**内置**：
 *   ① 作废 `detailRaw`（原文与目标行必须永远一致）；
 *   ② 取消在途详情请求（迟到的响应属于旧目标，落到新目标上就是脏数据）；
 *   ③ 重拉详情（否则详情面板停留在旧行内容，用户看到的与"选中"不符）。
 *
 * 分工说明：本模块只管**状态一致性**，不管渲染。列表选中态（`list.select`）与滚动
 * 由调用方按 UI 需要决定 —— 有些路径要 focus、有些不要，混进来会让语义变浑。
 *
 * 注：这是「收敛写入口」而非引入 store 框架。T5 的触发条件是"写入点 ≥3 且定位困难"，
 * 症结在**散落与遗漏**，收敛即可治本；全量 store（不可变更新 + subscribe）会把所有
 * 读点一并翻改，收益（可撤销/重放）当前并无需求，属 B1 判定的过度设计。
 */

import type { AppState } from './appState.ts';

export interface FocusTargetDeps {
  /** 只依赖这三个字段——模块不该拿到整份状态的写权限。 */
  state: Pick<AppState, 'selectedLine' | 'detailRaw' | 'detailInFlight'>;
  /** 拉取并展示某行详情。 */
  showDetail: (line: number) => void;
  /** 清空详情面板（收敛到「无选中」时）。 */
  clearDetail: () => void;
  /** 取消在途的详情请求（缺省时退化为直接清标记）。 */
  cancelDetailRequest?: () => void;
}

export interface FocusTarget {
  /** 当前选中行（只读；未选中为 undefined）。 */
  get: () => number | undefined;
  /** 选中某行（点击 / 导航 / 坏行落点 / 首次加载）。 */
  set: (line: number) => void;
  /** 在 `line` 处插入一行后：落点移到新行。 */
  afterInsert: (line: number) => void;
  /**
   * 删除第 `line` 行后：同一内容换行号（选中行在其后则前移一位），
   * 并按 `totalRecords`（删除后的总数）做越界收敛。
   *
   * 位移与收敛**必须一起做**：先位移再收敛若分两次走写入口，会连拉两遍详情，
   * 中间那一遍还是错的（旧行号）。
   */
  afterDelete: (line: number, totalRecords: number) => void;
  /**
   * 按新的总行数做越界收敛（权威校正后调用）。
   * 返回**是否发生了收敛** —— 调用方据此决定是否提示/继续。
   */
  clampTo: (totalRecords: number) => boolean;
  /** 清空选中（批量删除复位 / reload 复位）。 */
  clear: () => void;
}

export function createFocusTarget(deps: FocusTargetDeps): FocusTarget {
  const { state, showDetail, clearDetail, cancelDetailRequest } = deps;

  /**
   * 目标变更的公共前置：作废原文 + 掐掉在途详情（见文件头 ①②）。
   *
   * `detailInFlight` 由本模块**无条件清掉**，不依赖注入的 `cancelDetailRequest` 是否
   * 规矩 —— 那个回调只负责"尽力通知宿主中断"，而本地标记的清理由本模块独自担保。
   * 唯一写入口的价值正在于此：配套动作不靠调用方自觉。
   */
  function invalidateDerived(): void {
    state.detailRaw = null;
    cancelDetailRequest?.();
    state.detailInFlight = null;
  }

  /** 变更到某个具体行：作废派生状态并重拉详情（见文件头 ③）。 */
  function moveTo(line: number): void {
    invalidateDerived();
    state.selectedLine = line;
    showDetail(line);
  }

  return {
    get: () => state.selectedLine,

    set: (line: number) => moveTo(line),

    afterInsert: (line: number) => moveTo(line),

    afterDelete: (line: number, totalRecords: number) => {
      const cur = state.selectedLine;
      if (cur === undefined) return; // 无选中：删除不需要动落点

      // ① 位移（选中行在删除点之后则前移一位）
      let next = cur > line ? cur - 1 : cur;
      // ② 收敛（删除后总数变小，末行可能已越界）
      if (totalRecords <= 0) {
        invalidateDerived();
        state.selectedLine = undefined;
        clearDetail();
        return;
      }
      if (next >= totalRecords) next = totalRecords - 1;

      if (next === cur) {
        // 行号不变，但**该行的内容已因文件重排而变**（尤其删除点在其之前时），
        // 原文仍须作废并重拉 —— 这是"看起来没事"却最容易留下脏原文的情形。
        invalidateDerived();
        showDetail(cur);
        return;
      }
      moveTo(next);
    },

    clampTo: (totalRecords: number) => {
      const cur = state.selectedLine;
      if (cur === undefined) return false;
      if (cur < totalRecords) return false;
      if (totalRecords <= 0) {
        invalidateDerived();
        state.selectedLine = undefined;
        clearDetail();
        return true;
      }
      moveTo(totalRecords - 1);
      return true;
    },

    clear: () => {
      invalidateDerived();
      state.selectedLine = undefined;
      clearDetail();
    },
  };
}
