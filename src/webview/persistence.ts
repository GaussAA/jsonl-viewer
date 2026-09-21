/**
 * persistence.ts — 偏好持久化调度（从 webviewEntry.main 抽出，T5 #32）。
 *
 * 职责：把「当前 UI 偏好」（字段布局 / 过滤条件 / 搜索词）防抖写回宿主的 workspaceState。
 * 通过依赖注入与 main 解耦（bus + state 子集），行为与原 main 内联实现逐字一致。
 *
 * 设计：写回需防抖（默认 400ms）——用户连续调整布局/过滤时只落盘最后一次，
 * 避免高频 PERSIST_STATE 请求。persistKey 由宿主 init 回执给出，未就绪时整体跳过。
 */

import { HostEndpoint } from '../protocol/rpc.ts';
import type { RpcBus } from './rpc.ts';
import { toPersistedState } from './queryLogic.ts';
import type { FieldCondition, FieldLayout } from './queryLogic.ts';

/** 持久化调度读写的 AppState 字段子集。 */
export interface PersistState {
  /** 偏好持久化键（jsonlViewer.state.<uri>）；init 后赋值，未就绪为 null。 */
  persistKey: string | null;
  /** 在途防抖定时器（本模块读写）。 */
  persistTimer: ReturnType<typeof setTimeout> | undefined;
  fieldLayout: FieldLayout;
  filterCond: FieldCondition | null;
  searchQuery: string;
}

export interface PersistDeps {
  bus: RpcBus;
  state: PersistState;
  /** 防抖间隔（毫秒，默认 400）。 */
  debounceMs?: number;
}

export interface Persistence {
  /** 防抖调度一次偏好写回（persistKey 未就绪时跳过）。 */
  schedulePersist: () => void;
}

export function createPersistence(deps: PersistDeps): Persistence {
  const { bus, state } = deps;
  const debounceMs = deps.debounceMs ?? 400;

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
    }, debounceMs);
  }

  return { schedulePersist };
}
