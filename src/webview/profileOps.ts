/**
 * profileOps.ts — 数据画像域：面板 + 全文件扫描 + 与筛选的联动（F4）。
 *
 * 抽成独立模块的理由与 `badLinesOps` 相同：这是一条**自洽的链**
 * （工具栏入口 → 面板 → 宿主全文件扫描 → 用某字段反查记录），
 * 与装配层只通过两三个出口相连。
 *
 * 三条不变式（勿破坏）：
 *   1. **扫描是长任务**：横幅给进度与取消，且**取消只发 CANCEL、不本地 settle**
 *      —— 要等宿主回执才知道这次扫描到底算不算数（半份统计与全量统计在界面上
 *      长得一样，只有宿主能告诉我们哪一种是）。
 *   2. **自己开的横幅自己收**：扫描结束（成功或失败）必须 `hide()`，
 *      否则「正在扫描…」会一直挂在屏幕上，看起来像卡住了。
 *   3. **「筛选此字段」用 exists 语义**：用户点的是「看看有这条字段的记录」，
 *      让他先去猜一个值再筛是本末倒置；要按值筛，可在筛选面板里继续加条件。
 */

import type { RpcBus } from './rpc.ts';
import { createProfilePanel } from './profilePanel.ts';
import { HostEndpoint } from '../protocol/rpc.ts';
import type { ProfilePayload } from '../protocol/rpc.ts';
import type { Condition } from '../core/query.ts';
import { RPC_HEAVY_TIMEOUT_MS } from '../constants.ts';

export interface ProfileOpsDeps {
  bus: RpcBus;
  banner: {
    show(text: string, actionLabel?: string, onAction?: () => void): void;
    hide(): void;
  };
  /** 把条件写进筛选（回填面板 + 触发求值）—— 复用既有链路，不另开一条。 */
  applyFilter: (cond: Condition | null) => void;
  /** 记录在途的扫描请求（进度推送据此渲染）。 */
  setActiveProfile: (requestId: string | null) => void;
}

export interface ProfileOps {
  /** 面板根节点（调用方挂载）。 */
  root: HTMLElement;
  /** 打开画像面板（工具栏入口）。 */
  open: () => void;
  /** 面板是否打开。 */
  isOpen: () => boolean;
  /** 进度推送（宿主 EDIT_PROGRESS，kind='profile'）。 */
  setProgress: (processedBytes: number, totalBytes: number) => void;
  dispose: () => void;
}

export function createProfileOps(deps: ProfileOpsDeps): ProfileOps {
  let scanning = false;

  const panel = createProfilePanel({
    scan: async (): Promise<ProfilePayload> => {
      scanning = true;
      try {
        const { requestId, promise } = deps.bus.request<ProfilePayload>(
          HostEndpoint.SCAN_PROFILE,
          {},
          { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
        );
        deps.setActiveProfile(requestId);
        deps.banner.show('正在扫描整个文件统计字段分布…', '取消', () => {
          deps.bus.post(HostEndpoint.CANCEL, { requestId });
        });
        const res = await promise;
        deps.banner.hide();
        return res ?? { ok: false, error: '宿主未返回结果' };
      } catch (e) {
        deps.banner.hide();
        throw e;
      } finally {
        deps.setActiveProfile(null);
        scanning = false;
      }
    },
    isScanning: () => scanning,
    onFilterField: (key: string) => {
      deps.applyFilter({ field: key, op: 'exists', value: '' });
      panel.close();
    },
    notify: (message: string) => deps.banner.show(message, undefined),
  });

  return {
    root: panel.root,
    open: () => panel.open(),
    isOpen: () => panel.isOpen(),
    setProgress: (processedBytes, totalBytes) => panel.setProgress(processedBytes, totalBytes),
    dispose: () => panel.dispose(),
  };
}
