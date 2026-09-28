/**
 * badLinesOps.ts — 坏行诊断域：徽章刷新、扫描面板、跳转与全选（从 webviewEntry.main 抽出）。
 *
 * 抽出的理由：这是一整条**自洽的诊断链**——徽章（概要栏）→ 面板（列表 + 扫描）→
 * 跳转/全选（与选区和详情联动）。它与装配层其余部分只通过「打开面板」「跳转某行」
 * 两个出口相连，内聚度高。
 *
 * 三条不变式（**勿破坏**）：
 *   1. **徽章失败静默**：`GET_BAD_LINES` 取不到就不显示徽章 —— 为一条辅助信息弹错误
 *      横幅只会打扰用户；但**扫描**的取消/失败必须如实报（它改了宿主的集合）。
 *   2. **取消只发 CANCEL、不 settle 本地 Promise**：要等宿主回执才能说清「坏行集合
 *      未被改动」，本地草草收尾会让用户不确定到底动没动。
 *   3. **全选超上限一律拒绝、绝不截断**：静默截断会让用户以为「坏行都选上了」，
 *      随后一次删除删掉的可就不只是坏行 —— 后果不可逆。
 */

import type { RpcBus } from './rpc.ts';
import type { FocusTarget } from './focusTarget.ts';
import { createBadLinesPanel, scanProgressText } from './badLinesPanel.ts';
import { HostEndpoint } from '../protocol/rpc.ts';
import type { BadLinesPayload } from '../protocol/rpc.ts';
import {
  BAD_LINES_REFRESH_DEBOUNCE_MS,
  MAX_SELECTION_LINES,
  RPC_HEAVY_TIMEOUT_MS,
} from '../constants.ts';

export interface BadLinesOpsDeps {
  bus: RpcBus;
  list: { select(line: number): void; scrollToLine(line: number): void };
  /** 概要栏徽章（坏行计数）。 */
  toolbar: { update(info: { badLines: { count: number; partial: boolean } }): void };
  banner: { show(text: string, actionLabel?: string, onAction?: () => void): void };
  /** 选区：坏行「全选」写入选区、跳转时单选一行。 */
  selection: {
    replace(lines: readonly number[]): number;
    selectSingle(line: number): void;
  };
  /** 选中行的唯一写入口（坏行落点也走它，详情展示由它一并负责）。 */
  focus: FocusTarget;
  updateNavEnabled: () => void;
  /** 记录在途的扫描请求（进度推送据此渲染横幅）。 */
  setActiveScan: (requestId: string | null) => void;
}

export interface BadLinesOps {
  /** 面板根节点（调用方挂载）。 */
  root: HTMLElement;
  /** 打开坏行面板（工具栏入口）。 */
  open: () => void;
  /** 立刻拉取坏行计数并更新徽章（失败静默）。 */
  refresh: () => Promise<void>;
  /** 防抖刷新（滚动浏览会连续触发读批）。 */
  scheduleRefresh: () => void;
  /** 面板是否打开（Esc 分层处理要用）。 */
  isOpen: () => boolean;
  /** 释放：清理防抖定时器与面板监听。 */
  dispose: () => void;
}

export function createBadLinesOps(deps: BadLinesOpsDeps): BadLinesOps {
  const { bus, list, toolbar, banner, selection, focus, updateNavEnabled, setActiveScan } = deps;

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let scanning = false;

  /** 宿主无响应时的兜底：标记为 partial —— 不假装是权威全量。 */
  function emptyBadLines(): BadLinesPayload {
    return { lines: [], partial: true, scanned: 0, totalLines: 0, truncated: false };
  }

  /** 拉取坏行计数并更新徽章。失败静默：它只是辅助提示，不该打断主流程。 */
  async function refresh(): Promise<void> {
    try {
      const res = await bus.request<BadLinesPayload>(HostEndpoint.GET_BAD_LINES, {}).promise;
      if (res) toolbar.update({ badLines: { count: res.lines.length, partial: res.partial } });
    } catch {
      // 取不到就不显示徽章 —— 为一条辅助信息弹错误横幅只会打扰用户。
    }
  }

  /** 防抖刷新（滚动浏览会连续触发读批）。 */
  function scheduleRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refresh();
    }, BAD_LINES_REFRESH_DEBOUNCE_MS);
  }

  /** 跳转到某行（坏行定位）：选中 + 滚动 + 详情，走单一入口保证视觉与选区一致。 */
  function jumpToLine(line: number): void {
    selection.selectSingle(line); // 与列表点击同一条路径：选区、选中行、详情三者必然一致
    list.scrollToLine(line);
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
    const n = selection.replace(lines);
    if (n > 0) {
      focus.set(lines[0]); // 视口落到首个坏行（详情随之刷新）
      list.select(lines[0]);
    }
    return n;
  }

  const panel = createBadLinesPanel({
    fetchBadLines: async () => {
      const res = await bus.request<BadLinesPayload>(HostEndpoint.GET_BAD_LINES, {}).promise;
      return res ?? emptyBadLines();
    },
    scanBadLines: async () => {
      scanning = true;
      try {
        const { requestId, promise } = bus.request<BadLinesPayload>(
          HostEndpoint.SCAN_BAD_LINES,
          {},
          { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
        );
        // 扫描大文件要数秒：横幅给进度与取消。取消**只发 CANCEL、不 settle 本地
        // Promise** —— 要等宿主回执才能如实说「坏行集合未被改动」，本地草草收尾
        // 会让用户不确定文件到底动了没有。
        setActiveScan(requestId);
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
        setActiveScan(null);
        scanning = false;
      }
    },
    isScanning: () => scanning,
    jumpTo: (line) => jumpToLine(line),
    selectLines: (lines) => selectBadLines(lines),
    notify: (message) => banner.show(message, undefined),
  });

  return {
    root: panel.root,
    open: () => panel.open(),
    refresh,
    scheduleRefresh,
    isOpen: () => panel.isOpen(),
    dispose: () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = undefined;
      panel.dispose();
    },
  };
}
