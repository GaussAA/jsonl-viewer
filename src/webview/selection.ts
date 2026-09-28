/**
 * selection.ts — 多选选区：状态 + 浮动操作条 + 批量复制/删除（从 webviewEntry.main 抽出）。
 *
 * 抽出的理由：这是一块**自成一体的小状态机**——选区集合、Shift 锚点、三种点击模式
 * （单选 / Ctrl 切换 / Shift 范围）、以及两条只对选区生效的批量操作。它与装配层的
 * 耦合面很窄（列表渲染 + 详情来源 + 导航态 + 删除后的行数复位），适合整体切出。
 *
 * 状态归属的**铁律**（抽出后仍然成立）：
 *   选区**只存在这一处**。列表只负责渲染（`setSelectedLines`），详情来源是另一个概念
 *   （`state.selectedLine`）。同一份状态放两处，迟早会在某条路径上不同步，
 *   而这类 bug 的表现是「删掉了没选中的行」—— 后果不可逆。
 */

import type { AppState } from './appState.ts';
import type { RpcBus } from './rpc.ts';
import { HostEndpoint } from '../protocol/rpc.ts';
import type { CopyLinesResultPayload, DeleteManyResultPayload } from '../protocol/rpc.ts';
import type { FocusTarget } from './focusTarget.ts';
import { MAX_SELECTION_LINES, RPC_HEAVY_TIMEOUT_MS } from '../constants.ts';

export interface SelectionDeps {
  /** 只依赖过滤映射与选中行：模块不该拿到整份状态的写权限以外的东西。 */
  state: Pick<AppState, 'filterMap' | 'selectedLine'>;
  bus: RpcBus;
  /** 列表：渲染选区 / 选中单行 / 清空选中。 */
  list: {
    setSelectedLines(lines: ReadonlySet<number>): void;
    select(line: number): void;
    clearAllSelection(): void;
  };
  /** 顶部横幅：提示与二次确认（webview 里 window.confirm 不可用）。 */
  banner: {
    show(text: string, actionLabel?: string, onAction?: () => void): void;
  };
  /** 选中行的唯一写入口（详情展示由它一并负责，本模块不再直接写 state.selectedLine）。 */
  focus: FocusTarget;
  /** 选中态变化后刷新导航可用态。 */
  updateNavEnabled: () => void;
  /** 窄容器抽屉控制（选中记录后收起目录，回到详情主视图）。 */
  layout: { isNarrow(): boolean; setDrawer(open: boolean): void };
  /** 批量删除成功后的本地复位（清缓存 / 清选区 / 刷新徽章 / 校正总行数）。 */
  applyBulkDelete: (deleted: number) => void;
}

export interface Selection {
  /** 选区操作条（调用方挂到左栏）。 */
  root: HTMLElement;
  /** 当前选中的行（只读视图；批量操作按它执行）。 */
  readonly lines: ReadonlySet<number>;
  /** 整体替换选区（坏行面板「全选坏行」用）；返回实际选中数。 */
  replace: (lines: readonly number[]) => number;
  /** 清空选区（不改 `state.selectedLine`，详情仍可停留在原行）。 */
  clear: () => void;
  /** 单选某行：同时设置详情来源与选区。 */
  selectSingle: (line: number) => void;
  /** 列表点击 → 更新选区（普通 / Ctrl / Shift 三态）。 */
  handleSelect: (line: number, mods: { ctrl: boolean; shift: boolean }) => void;
  /** 复制选中行原文到剪贴板（宿主侧写入，比 webview clipboard 可靠）。 */
  copy: () => Promise<void>;
  /** 批量删除：先二次确认（不可逆的磁盘写入），再落盘。 */
  confirmDelete: () => void;
}

export function createSelection(deps: SelectionDeps): Selection {
  const { state, bus, list, banner, focus, updateNavEnabled, layout, applyBulkDelete } = deps;

  const selectedLines = new Set<number>();
  /** Shift 范围选择的锚点。 */
  let selAnchor: number | undefined;

  /* ---------------- 选区操作条 ---------------- */
  const selBar = document.createElement('div');
  selBar.className = 'jlv-selbar';
  selBar.hidden = true;

  const selText = document.createElement('span');
  selText.className = 'jlv-selbar-text';

  const selCopyBtn = document.createElement('button');
  selCopyBtn.type = 'button';
  selCopyBtn.className = 'jlv-btn';
  selCopyBtn.textContent = '复制';
  selCopyBtn.title = '复制选中行的原文到剪贴板';
  selCopyBtn.addEventListener('click', () => void copy());

  const selDeleteBtn = document.createElement('button');
  selDeleteBtn.type = 'button';
  selDeleteBtn.className = 'jlv-btn jlv-btn-danger';
  selDeleteBtn.textContent = '删除';
  selDeleteBtn.title = '删除选中的行（立即写入磁盘）';
  selDeleteBtn.addEventListener('click', () => confirmDelete());

  const selClearBtn = document.createElement('button');
  selClearBtn.type = 'button';
  selClearBtn.className = 'jlv-btn';
  selClearBtn.textContent = '取消选择';
  // 只清多选集合：详情面板仍停留在「最后点击的那一行」（它与多选是两个概念）。
  selClearBtn.addEventListener('click', () => clear());

  selBar.append(selText, selCopyBtn, selDeleteBtn, selClearBtn);

  /** 把选区状态同步到列表与操作条（所有改选区的路径都必须过它）。 */
  function syncSelection(): void {
    list.setSelectedLines(selectedLines);
    const n = selectedLines.size;
    selBar.hidden = n <= 1;
    if (n > 1) selText.textContent = `已选中 ${n} 行`;
  }

  function clear(): void {
    selectedLines.clear();
    selAnchor = undefined;
    syncSelection();
  }

  /**
   * 显示顺序上 a 与 b 之间的所有真实行号（含两端）；范围过大时返回 null。
   *
   * 无过滤时就是连续整数区间；**过滤态下只包含当前显示中的行** —— 用户看到的是一份
   * 筛选后的列表，Shift 范围选择理应只覆盖看得见的那些行。
   *
   * 先算长度再决定是否分配：`Array.from({length: 1e6})` 会当场吃掉几十 MB。
   */
  function displayRangeBetween(a: number, b: number): number[] | null {
    const map = state.filterMap;
    if (!map) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (hi - lo + 1 > MAX_SELECTION_LINES) return null;
      return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    }
    const ia = map.indexOf(a);
    const ib = map.indexOf(b);
    if (ia < 0 || ib < 0) return [a, b]; // 端点不在当前视图：退化为两端
    const lo = Math.min(ia, ib);
    const hi = Math.max(ia, ib);
    if (hi - lo + 1 > MAX_SELECTION_LINES) return null;
    return map.slice(lo, hi + 1);
  }

  /**
   * 单选某行：**同时**设置详情来源与选区（两者一致）。
   *
   * 键盘导航、跳转搜索匹配、初始化等所有「非鼠标点击」的选中路径都应走它 ——
   * 否则会出现「视觉上选中了、选区里却没有」的不一致，而批量操作按选区执行。
   */
  function selectSingle(line: number): void {
    selectedLines.clear();
    selectedLines.add(line);
    selAnchor = line;
    focus.set(line); // 写入口同时作废旧原文、取消在途详情、重拉详情
    list.select(line);
    syncSelection();
  }

  /** 列表点击 → 更新选区。三种模式：普通单选 / Ctrl 切换 / Shift 范围。 */
  function handleSelect(line: number, mods: { ctrl: boolean; shift: boolean }): void {
    if (mods.shift && selAnchor !== undefined) {
      const range = displayRangeBetween(selAnchor, line);
      if (!range) {
        banner.show(`一次最多选择 ${MAX_SELECTION_LINES} 行，请缩小范围后再试。`, undefined);
      } else {
        for (const l of range) selectedLines.add(l);
        // Shift 不重置锚点，便于连续多次扩展
      }
    } else if (mods.ctrl) {
      if (selectedLines.has(line)) selectedLines.delete(line);
      else selectedLines.add(line);
      selAnchor = line;
    } else {
      selectedLines.clear();
      selectedLines.add(line);
      selAnchor = line;
    }
    focus.set(line); // 详情由写入口一并负责（不再各处各写一次，那正是漏作废旧原文的源头）
    list.select(line);
    syncSelection();
    updateNavEnabled();
    // 窄容器抽屉：选中记录后收起目录抽屉，回到详情主视图
    if (layout.isNarrow()) layout.setDrawer(false);
  }

  /**
   * 复制选中的行。原文由宿主读取后写入剪贴板（`vscode.env.clipboard` 比 webview 侧的
   * `navigator.clipboard` 可靠，不受 webview 权限限制）。
   */
  async function copy(): Promise<void> {
    const lines = [...selectedLines].toSorted((a, b) => a - b);
    if (lines.length === 0) return;
    try {
      const res = await bus.request<CopyLinesResultPayload>(
        HostEndpoint.COPY_LINES,
        { lines },
        { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
      ).promise;
      if (!res?.ok) {
        banner.show(res?.error ?? '复制失败', undefined);
        return;
      }
      const parts = [`已复制 ${res.count} 行到剪贴板`];
      if (res.skipped > 0) parts.push(`${res.skipped} 行因过大跳过`);
      if (res.truncated) parts.push('因超过上限已截断，请分批复制');
      banner.show(parts.join('；'), undefined);
    } catch (e) {
      banner.show(e instanceof Error ? e.message : String(e), undefined);
    }
  }

  /**
   * 批量删除选中的行。不可逆的磁盘写入，先横幅二次确认（webview 里 `window.confirm`
   * 不可用）。确认文案带上「几段连续」—— 用户能借此确认自己框对了吗。
   */
  function confirmDelete(): void {
    const lines = [...selectedLines].toSorted((a, b) => a - b);
    if (lines.length === 0) return;
    let segments = 1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] !== lines[i - 1] + 1) segments++;
    }
    // 多行时补一个前导空格，让「确定删除 3 行」而不是「确定删除3 行」（中文排版）。
    const what =
      lines.length === 1 ? `第 ${lines[0] + 1} 行` : ` ${lines.length} 行（${segments} 段连续）`;
    banner.show(`确定删除${what}？该操作会立即写入磁盘。`, '确认删除', () => {
      void (async () => {
        try {
          const res = await bus.request<DeleteManyResultPayload>(
            HostEndpoint.DELETE_RECORDS,
            { lines },
            { timeoutMs: RPC_HEAVY_TIMEOUT_MS }
          ).promise;
          if (res?.cancelled) {
            banner.show('已取消：文件未被修改。', undefined);
            return;
          }
          if (!res?.ok) {
            banner.show(res?.error ?? '删除失败', undefined);
            return;
          }
          applyBulkDelete(res.deleted);
          const skippedNote = res.skipped > 0 ? `；${res.skipped} 行因过大跳过` : '';
          banner.show(`已删除 ${res.deleted} 行${skippedNote}`, undefined);
        } catch (e) {
          banner.show(e instanceof Error ? e.message : String(e), undefined);
        }
      })();
    });
  }

  return {
    root: selBar,
    lines: selectedLines,
    replace(targets: readonly number[]): number {
      selectedLines.clear();
      for (const l of targets) selectedLines.add(l);
      selAnchor = targets[0];
      syncSelection();
      return selectedLines.size;
    },
    clear,
    selectSingle,
    handleSelect,
    copy,
    confirmDelete,
  };
}
