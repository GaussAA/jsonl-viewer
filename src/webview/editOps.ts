/**
 * editOps.ts — 写操作域：行编辑 / 删除 / 批量替换 与写后的状态复位（从 webviewEntry.main 抽出）。
 *
 * 抽出的理由：这一块是**「改动磁盘」这件事的前端全过程**——
 * 打开编辑浮层（取磁盘原文）、单/多行删除、全文批量替换、以及写后的一系列复位
 * （清缓存、重拉详情、重算徽章、用宿主权威值校正行数）。它们之间的耦合是内聚的
 * （都围绕一次写操作），与装配层只通过列表/详情/横幅/工具栏四个出口相连。
 *
 * 三条不变式（**勿破坏**）：
 *   1. **编辑框的初始文本必须是磁盘原文**（`READ_RECORD` 的 `rawText`），
 *      不能用解析后的值重新序列化 —— 那会重排用户的键序与空白，还会放大变长编辑的搬移成本；
 *   2. **行增删后必须整体清缓存**：其后每一行的行号都变了，以行号为键的缓存全部失效；
 *   3. **写后必须用宿主权威概览校正行数**：本地只是乐观推算，并发写/冲突/批量跳过
 *      都会让它与磁盘不符。
 */

import { viewBaseline } from './appState.ts';
import type { AppState } from './appState.ts';
import type { RpcBus } from './rpc.ts';
import { HostEndpoint } from '../protocol/rpc.ts';
import type { EditResultPayload, OverviewPayload, ReplaceResultPayload } from '../protocol/rpc.ts';
import type { FocusTarget } from './focusTarget.ts';
import { describeEditFailure } from './editLogic.ts';
import { replaceConfirmText } from './editLogic.ts';
import { describeReplaceOutcome } from '../core/replaceLogic.ts';
import { RPC_HEAVY_TIMEOUT_MS } from '../constants.ts';

export interface EditOpsDeps {
  state: AppState;
  bus: RpcBus;
  list: {
    setTotalRows(n: number): void;
    select(line: number): void;
    refresh(): void;
    clearAllSelection(): void;
  };
  /** 编辑浮层：拿到原文后再打开。 */
  editPanel: { open(line: number, text: string): void };
  /** 选中行的唯一写入口（行增删的位移/收敛与复位都经它）。 */
  focus: FocusTarget;
  banner: {
    show(text: string, actionLabel?: string, onAction?: () => void): void;
    hide(): void;
  };
  toolbar: { toggleReplace(open: boolean): void; setReplaceBusy(busy: boolean): void };
  /** 拉取并展示某行详情。 */
  showDetailForLine: (line: number) => unknown;
  updateToolbar: () => void;
  /** 写操作可能改好坏行 / 让坏行位移 → 防抖刷新徽章。 */
  scheduleBadLinesRefresh: () => void;
  /** 清空多选选区（来自 selection 模块，延迟注入以避免装配顺序问题）。 */
  clearSelection: () => void;
  /** 记录在途的批量替换请求（进度推送与取消按钮据此工作）。 */
  setActiveReplace: (rid: string | null) => void;
  /** 内容变动后重算过滤结果（有过滤条件时）。 */
  rerunFilter: () => void;
  /** 内容变动后重跑搜索刷新命中计数。 */
  rerunSearch: (query: string) => void;
}

export interface EditOps {
  /** 打开某行的编辑浮层（先取磁盘原文）。 */
  openEditForLine: (line: number) => Promise<void>;
  /** 编辑浮层提交时用的乐观锁断言值（本次取到的原文字节数）。 */
  getExpectedBytes: () => number | undefined;
  /** 行增删后的乐观状态调整（其后必须跟一次 refreshOverview）。 */
  applyRowCountChange: (line: number, mode: 'insert' | 'delete') => void;
  /** 用宿主权威概览校正行数与选中边界。 */
  refreshOverview: () => Promise<void>;
  /** 删除某一行（先二次确认）。 */
  deleteRecordAt: (line: number) => void;
  /** 全文查找替换（先二次确认，执行中可取消）。 */
  replaceAll: (query: string, replacement: string) => void;
  /** 批量删除成功后的整体复位。 */
  applyBulkDelete: (deleted: number) => void;
}

export function createEditOps(deps: EditOpsDeps): EditOps {
  const {
    state,
    bus,
    list,
    editPanel,
    banner,
    toolbar,
    focus,
    showDetailForLine,
    updateToolbar,
    scheduleBadLinesRefresh,
    clearSelection,
    setActiveReplace,
    rerunFilter,
    rerunSearch,
  } = deps;

  /** 编辑前记下的旧行字节长度：作为乐观锁断言（磁盘上该行若已变化则拒绝写入）。 */
  let editExpectedBytes: number | undefined;

  /**
   * 打开编辑浮层：先按需拉取该行的磁盘原文（列表缓存里只有解析后的 value，不能当原文用），
   * 拿到后再打开，避免把「重新序列化」的结果冒充用户原文。
   */
  async function openEditForLine(line: number): Promise<void> {
    try {
      const res = await bus.request<{
        ok: boolean;
        error?: string;
        rawText?: string;
        rawBytes?: number;
      }>(HostEndpoint.READ_RECORD, { line }, { timeoutMs: RPC_HEAVY_TIMEOUT_MS }).promise;
      if (res?.rawText === undefined) {
        banner.show(res?.error ?? '无法读取该行内容', undefined);
        return;
      }
      editExpectedBytes = res.rawBytes;
      editPanel.open(line, res.rawText);
    } catch (e) {
      banner.show(e instanceof Error ? e.message : String(e), undefined);
    }
  }

  /**
   * 行增删成功后的本地状态调整。
   *
   * 与替换不同，增删会**改变其后所有行的行号**：以行号为键的列表缓存整体失效，
   * 选中锚点也必须跟随位移（否则详情树会显示「原来是别的行」的内容）。
   *
   * 这里的总行数是**乐观推算**（为省一次往返、避免翻页时先闪一下旧总数），
   * 调用方随后必须 `void refreshOverview()` 用宿主的权威值校正 ——
   * 前端自己算出来的行数一旦与磁盘不一致（并发写、冲突、批量操作），
   * 用户就会在「总数 100、翻到第 100 页却是空的」这种状态里困惑。
   */
  function applyRowCountChange(line: number, mode: 'insert' | 'delete'): void {
    state.cache.clear();
    if (state.overview) {
      const totalRecords = state.overview.totalRecords + (mode === 'insert' ? 1 : -1);
      state.overview = { ...state.overview, totalRecords };
      list.setTotalRows(Math.max(0, totalRecords));
    }
    if (mode === 'insert') {
      // 插入后把选中锚点落到新行上（与「光标停在新行」的编辑器习惯一致）。
      focus.afterInsert(line);
      list.select(line);
      return;
    }
    // 删除：位移 + 按新的总数收敛，二者必须一次做完（分两次会连拉两遍详情，中间那遍还是旧行号）
    focus.afterDelete(line, state.overview?.totalRecords ?? 0);
    if (state.selectedLine !== undefined) list.select(state.selectedLine);
  }

  /**
   * 用宿主返回的权威概览校正本地状态（行数 / 字节数 / 选中锚点边界）。
   *
   * 宿主是行数的**唯一真相**：任何本地推算都可能因并发写、冲突拒绝或批量操作而与
   * 磁盘不符。写操作后必调一次，把「本地乐观值」拉回真实值。
   */
  async function refreshOverview(): Promise<void> {
    try {
      const ov = await bus.request<OverviewPayload>(
        HostEndpoint.GET_OVERVIEW,
        {},
        { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
      ).promise;
      if (!ov) return;
      state.overview = ov;
      list.setTotalRows(ov.totalRecords);
      // 校正可能让选中行越界（例如最后一行被删掉 / 批量删除跳过了一些行）。
      // 收敛必须经写入口：它同时作废旧原文并重拉详情 —— 此前这里只改行号，
      // 于是详情面板停留在旧行内容，用户在该状态下做字段编辑会**基于旧行原文
      // 把改动写到新行上**（不可逆的错改）。
      if (focus.clampTo(ov.totalRecords)) {
        if (state.selectedLine !== undefined) list.select(state.selectedLine);
      }
      updateToolbar();
    } catch {
      // 校正失败不再全然静默（O11 余留）：本地乐观值仍在、下一次操作会再校正一次，
      // 但用户应当知道眼下的总行数可能过期 —— 越界的选中行不会有人替他纠正。
      banner.show('行数校正失败，当前显示的总行数可能已过期。');
    }
  }

  /**
   * 删除某一行（右键入口）。
   *
   * webview 里 window.confirm 不可用（沙箱拦截阻塞式对话框），故复用顶部横幅做二次
   * 确认 —— 删除是不可逆的磁盘写入，必须先问一句。
   */
  function deleteRecordAt(line: number): void {
    banner.show(`确定删除第 ${line + 1} 行？该操作会立即写入磁盘。`, '确认删除', () => {
      void (async () => {
        try {
          const res = await bus.request<EditResultPayload>(
            HostEndpoint.DELETE_RECORD,
            { line, ...viewBaseline(state) },
            { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
          ).promise;
          if (!res?.ok) {
            banner.show(describeEditFailure(res ?? {}), undefined);
            return;
          }
          banner.hide();
          applyRowCountChange(line, 'delete');
          list.refresh();
          updateToolbar();
          if (state.selectedLine !== undefined) void showDetailForLine(state.selectedLine);
          void refreshOverview();
        } catch (e) {
          banner.show(e instanceof Error ? e.message : String(e), undefined);
        }
      })();
    });
  }

  /**
   * 全文查找替换（工具栏「全部替换」）。
   *
   * 二次确认走顶部横幅 —— webview 里 `window.confirm` 不可用（沙箱拦截阻塞式对话框），
   * 且批量改写会**立即落盘**，必须先问一句。
   *
   * 大文件会在确认文案里说明代价（整个文件需要重写），执行中显示**可取消**的进度：
   * 重写 1GB 文件要数秒，没有进度也没有取消入口的等待是最难熬的 —— 用户只能
   * 猜测程序是不是死了，然后去点第二次。
   *
   * 结果文案必须包含「跳过的行数」：用户点了「全部替换」后最危险的误解就是
   * 以为全改完了，而实际有一批行因 JSON 非法被跳过。
   */
  function replaceAll(rawQuery: string, replacement: string): void {
    const query = rawQuery.trim();
    if (!query) {
      banner.show('请先在搜索框填入要查找的内容。', undefined);
      toolbar.toggleReplace(true);
      return;
    }
    const totalBytes = state.overview?.totalBytes ?? 0;
    banner.show(replaceConfirmText(query, replacement, totalBytes), '确认替换', () => {
      void (async () => {
        toolbar.setReplaceBusy(true);
        try {
          const { requestId, promise } = bus.request<ReplaceResultPayload>(
            HostEndpoint.REPLACE_TEXT,
            { query, replacement, ...viewBaseline(state) },
            { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
          );
          // 记下本次请求：进度推送据此渲染横幅，取消按钮据此发 CANCEL。
          setActiveReplace(requestId);
          banner.show('正在替换…', '取消', () => {
            // 只发 CANCEL，**不 settle 本地 Promise** —— 我们要等宿主回执 cancelled 的结果
            // 才能如实告诉用户「文件未被修改」，而不是本地草草收尾。
            bus.post(HostEndpoint.CANCEL, { requestId });
          });

          const res = await promise;
          setActiveReplace(null);

          if (res?.cancelled) {
            banner.show('已取消：文件未被修改。', undefined);
            return;
          }
          if (!res?.ok) {
            banner.show(res?.error ?? '替换失败', undefined);
            return;
          }
          // 改动可能散落全文件，无法逐行失效 —— 整体清空缓存并按需重拉。
          state.cache.clear();
          list.refresh();
          updateToolbar();
          // 内容变了，过滤结果同样不再可信；有过滤条件就重算。
          if (state.filterCond) rerunFilter();
          // 重跑搜索刷新命中计数（原本命中的行可能已经不匹配）。
          rerunSearch(query);
          if (state.selectedLine !== undefined) void showDetailForLine(state.selectedLine);
          // 批量替换可能把成片的坏行改好 → 徽章要随之下降。
          scheduleBadLinesRefresh();
          const suffix = res.undoable ? '' : '；（改动量较大，本次未纳入撤销栈）';
          banner.show(describeReplaceOutcome(res) + suffix, undefined);
        } catch (e) {
          banner.show(e instanceof Error ? e.message : String(e), undefined);
        } finally {
          setActiveReplace(null);
          toolbar.setReplaceBusy(false);
        }
      })();
    });
  }

  /**
   * 批量删除后：总行数减少 N，选区与详情复位。
   *
   * 不做「行号位移推算」而直接整体复位：删掉的行散布在各处，剩余行的新行号取决于
   * 它前面被删了几行 —— 用户看到的是一批内容消失，此时把选中状态留在某个「碰巧算对」
   * 的行上，比清空更令人困惑。
   */
  function applyBulkDelete(deleted: number): void {
    state.cache.clear();
    if (state.overview) {
      const totalRecords = Math.max(0, state.overview.totalRecords - deleted);
      state.overview = { ...state.overview, totalRecords };
      list.setTotalRows(totalRecords);
    }
    clearSelection();
    // 清选中：写入口一并作废旧原文并清空详情面板（三者必须同步，否则会留下"指向已消失行"的原文）
    focus.clear();
    list.clearAllSelection();
    list.refresh();
    updateToolbar();
    // 删掉的可能正是一批坏行（「全选坏行 → 删除」正是本功能的主用途）→ 徽章必须降下来。
    scheduleBadLinesRefresh();
    // 批量删除的实际行数由宿主决定（部分行可能因过大被跳过）→ 必须取权威值，不能只减 N。
    void refreshOverview();
  }

  return {
    openEditForLine,
    getExpectedBytes: () => editExpectedBytes,
    applyRowCountChange,
    refreshOverview,
    deleteRecordAt,
    replaceAll,
    applyBulkDelete,
  };
}
