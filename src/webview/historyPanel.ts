/**
 * historyPanel.ts — 会话编辑历史浮层。
 *
 * 与 `editPanel` 同样的浮层语义（设计体系 §3.6 的弹出/收起节奏）。
 *
 * 列表按时间升序，`cursor` 之前为「已应用」、之后为「已撤销」—— 与宿主的**同一个
 * 光标**一一对应，前端不另存一份状态（两处状态必然会在某条路径上不同步）。
 *
 * 点击某条 = 「让历史停在这一步」（光标移到该条之后）。跨多条时**必须二次确认**：
 * 一次点击可能撤销十几步，用户需要先知道代价。
 */

import { formatBytes } from './editLogic.ts';
import type { HistoryEntryView, HistoryPayload, HistoryResultPayload } from '../protocol/rpc.ts';

export interface HistoryPanelDeps {
  fetchHistory(): Promise<HistoryPayload>;
  undoStep(): Promise<HistoryResultPayload>;
  redoStep(): Promise<HistoryResultPayload>;
  revertTo(id: string): Promise<HistoryResultPayload>;
  /** 二次确认（装配层用顶部横幅实现 —— webview 里 window.confirm 不可用）。 */
  confirm(message: string, onConfirm: () => void): void;
  /** 宿主已改动文件：装配层据此刷新列表 / 详情 / 工具栏。 */
  onChanged(): void;
  /** 提示成功或失败文案。 */
  notify(message: string): void;
}

export interface HistoryPanelController {
  /** 供装配层挂载的根节点（浮层 backdrop）。 */
  readonly root: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

/** 字节增量的可读表示（零变化不给正负号，避免「+0 B」这种噪音）。 */
function formatDelta(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '±0';
  return `${n > 0 ? '+' : '−'}${formatBytes(Math.abs(n))}`;
}

/** 条目类型 → 短标签（列表里用徽章呈现）。 */
const KIND_LABEL: Record<HistoryEntryView['kind'], string> = {
  edit: '改',
  insert: '插',
  delete: '删',
  deleteMany: '批删',
  replaceAll: '替换',
};

export function createHistoryPanel(deps: HistoryPanelDeps): HistoryPanelController {
  let opened = false;
  let busy = false;

  const backdrop = document.createElement('div');
  backdrop.className = 'jlv-hist-backdrop';
  backdrop.hidden = true;

  const panel = document.createElement('div');
  panel.className = 'jlv-hist';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', '编辑历史');

  /* ---------------- 头部 ---------------- */
  const head = document.createElement('div');
  head.className = 'jlv-edit-head';

  const title = document.createElement('div');
  title.className = 'jlv-edit-title';
  title.textContent = '编辑历史';

  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.className = 'jlv-btn';
  undoBtn.textContent = '撤销一步';
  undoBtn.addEventListener('click', () => void step('undo'));

  const redoBtn = document.createElement('button');
  redoBtn.type = 'button';
  redoBtn.className = 'jlv-btn';
  redoBtn.textContent = '重做一步';
  redoBtn.addEventListener('click', () => void step('redo'));

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'jlv-btn';
  closeBtn.textContent = '关闭';
  closeBtn.addEventListener('click', () => close());

  const headActions = document.createElement('div');
  headActions.className = 'jlv-edit-head-actions';
  headActions.append(undoBtn, redoBtn, closeBtn);
  head.append(title, headActions);

  /* ---------------- 列表 ---------------- */
  const list = document.createElement('div');
  list.className = 'jlv-hist-list';

  const note = document.createElement('div');
  note.className = 'jlv-hist-note';
  note.hidden = true;

  panel.append(head, list, note);
  backdrop.append(panel);

  /* ---------------- 渲染 ---------------- */

  function renderEmpty(message: string): void {
    list.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'jlv-hist-empty';
    empty.textContent = message;
    list.append(empty);
    undoBtn.disabled = true;
    redoBtn.disabled = true;
  }

  function render(data: HistoryPayload): void {
    list.textContent = '';
    undoBtn.disabled = busy || data.cursor === 0;
    redoBtn.disabled = busy || data.cursor >= data.entries.length;
    note.hidden = !data.dropped;
    if (data.dropped) {
      // 如实告知：否则用户会以为看到的是完整历史，进而误判「那步操作没做过」。
      note.textContent = '更早的记录已因超出上限被丢弃，仅显示最近的操作。';
    }

    if (data.entries.length === 0) {
      renderEmpty('本次会话还没有编辑操作。');
      return;
    }

    // 倒序展示（最新在上）—— 用户关心的是「刚才做了什么」。
    for (let i = data.entries.length - 1; i >= 0; i--) {
      const e = data.entries[i];
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'jlv-hist-row';
      // cursor 之后的条目为「已撤销」，用暗色区分
      row.classList.toggle('undone', i >= data.cursor);
      row.dataset.index = String(i);

      const badge = document.createElement('span');
      badge.className = `jlv-hist-badge kind-${e.kind}`;
      badge.textContent = KIND_LABEL[e.kind] ?? '编辑';

      const label = document.createElement('span');
      label.className = 'jlv-hist-label';
      label.textContent = e.label;

      const meta = document.createElement('span');
      meta.className = 'jlv-hist-meta';
      meta.textContent = `${formatDelta(e.bytesDelta)} · ${new Date(e.at).toLocaleTimeString()}`;

      row.append(badge, label, meta);
      row.addEventListener('click', () => requestStopAt(i, data));
      list.append(row);
    }
  }

  /**
   * 「让历史停在这一步」：把光标移到该条之后。
   *
   * 之所以不做成「点击即回退」：同一位置既可能需要撤销（该条已应用）也可能需要重做
   * （该条已撤销）。统一为「停在这一步」后，用户看到的与得到的一致。
   */
  function requestStopAt(index: number, data: HistoryPayload): void {
    const target = index + 1; // 光标位置（该条为最新已应用）
    if (target === data.cursor) return; // 已在此处，无需操作

    const shrinking = target < data.cursor;
    const steps = Math.abs(data.cursor - target);
    const verb = shrinking ? '撤销' : '重做';
    deps.confirm(`将${verb} ${steps} 次操作（历史停在第 ${index + 1} 条），确定？`, () => {
      void (async () => {
        busy = true;
        try {
          const res = await deps.revertTo(data.entries[index].id);
          if (!res.ok) {
            deps.notify(res.error ?? `${verb}失败`);
          } else {
            deps.notify(`已${verb} ${res.steps} 次操作`);
          }
          deps.onChanged();
          await refresh();
        } finally {
          busy = false;
        }
      })();
    });
  }

  async function step(dir: 'undo' | 'redo'): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const res = dir === 'undo' ? await deps.undoStep() : await deps.redoStep();
      if (!res.ok) {
        deps.notify(res.error ?? (dir === 'undo' ? '撤销失败' : '重做失败'));
      } else {
        deps.notify(`已${dir === 'undo' ? '撤销' : '重做'}：${res.label ?? ''}`);
      }
      deps.onChanged();
      await refresh();
    } finally {
      busy = false;
    }
  }

  /** 重新拉取并渲染（宿主是唯一状态源，前端不自行推算光标）。 */
  async function refresh(): Promise<void> {
    try {
      render(await deps.fetchHistory());
    } catch (e) {
      renderEmpty(`读取历史失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /* ---------------- 开关 ---------------- */

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && opened) {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKeyDown);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });

  function open(): void {
    if (opened) return;
    opened = true;
    backdrop.hidden = false;
    // 下一帧再加类，保证过渡生效（与 editPanel 一致）
    requestAnimationFrame(() => {
      backdrop.classList.add('open');
      panel.classList.add('open');
    });
    void refresh();
  }

  function close(): void {
    if (!opened) return;
    opened = false;
    backdrop.classList.remove('open');
    panel.classList.remove('open');
    setTimeout(
      () => {
        if (!opened) backdrop.hidden = true;
      },
      // 与 CSS 的收起时长一致（设计体系 §3.6：收起走快速淡出）
      120
    );
  }

  return {
    root: backdrop,
    open,
    close,
    isOpen: () => opened,
    dispose: () => document.removeEventListener('keydown', onKeyDown),
  };
}
