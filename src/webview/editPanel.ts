/**
 * editPanel.ts — 行编辑浮层面板（DOM 层）。
 *
 * **为何用浮层而非「详情区切换到编辑态」**：
 *   1. 不干扰详情树的懒构建状态（切视图会丢失展开态与已构建的子节点缓存）；
 *   2. 直接复用设计体系 §3.6 的浮层动效规范（弹出缩放+上浮 180ms / 关闭快速淡出 100ms）；
 *   3. 列表右键与详情工具两个入口共用同一面板，行为天然一致。
 *
 * 编辑粒度是**整行**（JSONL 的天然单位）：面板只负责「给一段文本、拿一份结果」，
 * 校验、成本提示、错误文案全部委托给纯逻辑层 `editLogic.ts`（可单测）。
 *
 * 两种模式共用同一面板（`mode`）：**替换**既有行、**插入**新行 —— 两者除了标题与
 * 提交端点不同，交互完全一致，没必要造两套浮层。
 */

import {
  describeEditFailure,
  editCostWarning,
  estimateEditCost,
  formatJsonText,
  validateEditText,
} from './editLogic.ts';

/** 宿主对一次编辑提交的回应（与 `EditResultPayload` 同形，只保留前端关心的字段）。 */
export interface EditPanelSubmitResult {
  ok: boolean;
  error?: string;
  conflict?: boolean;
  invalid?: boolean;
  bytesDelta?: number;
  movedBytes?: number;
  costMs?: number;
}

/** 编辑模式：替换既有行 / 在指定行之前插入新行（决定标题文案与提交走哪个端点）。 */
export type EditMode = 'replace' | 'insert';

export interface EditPanelDeps {
  /** 把编辑提交给宿主（mode 决定宿主走替换还是插入）。 */
  submit(info: { line: number; text: string; mode: EditMode }): Promise<EditPanelSubmitResult>;
  /** 提交成功后的回调（刷新列表卡片 / 详情树）。 */
  onCommitted?(info: { line: number; mode: EditMode }): void;
  /** 取概览用于成本预估；索引未就绪时返回 undefined。 */
  getOverview?(): { totalBytes: number; totalRecords: number } | undefined;
}

export interface EditPanelController {
  /** 面板根元素（遮罩层），由宿主挂到布局容器。 */
  readonly root: HTMLElement;
  /**
   * 打开面板。
   * @param line 目标行号；`mode === 'insert'` 时表示「新行将插到它之前」。
   * @param initialText 编辑框初始文本（替换：磁盘原文；插入：空串）。
   * @param mode 替换既有行 / 插入新行。
   */
  open(line: number, initialText: string, mode?: EditMode): void;
  /** 关闭面板（不提交）。 */
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

export function createEditPanel(deps: EditPanelDeps): EditPanelController {
  let currentLine = -1;
  let currentMode: EditMode = 'replace';
  let submitting = false;
  /** 逻辑上的打开态（与 CSS 过渡无关：关闭动画的 100ms 内也应如实返回 false）。 */
  let opened = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  /* ---------------- DOM ---------------- */

  const backdrop = document.createElement('div');
  backdrop.className = 'jlv-edit-backdrop';
  backdrop.hidden = true;

  const panel = document.createElement('div');
  panel.className = 'jlv-edit-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'jlv-edit-title');

  const title = document.createElement('span');
  title.id = 'jlv-edit-title';
  title.className = 'jlv-edit-title';

  const btnClose = document.createElement('button');
  btnClose.type = 'button';
  btnClose.className = 'jlv-edit-close';
  btnClose.title = '关闭（Esc）';
  btnClose.setAttribute('aria-label', '关闭');
  btnClose.textContent = '×';

  const head = document.createElement('div');
  head.className = 'jlv-edit-head';
  head.append(title, btnClose);

  const hint = document.createElement('div');
  hint.className = 'jlv-edit-hint';
  hint.hidden = true;

  const input = document.createElement('textarea');
  input.className = 'jlv-edit-input';
  input.spellcheck = false;
  input.setAttribute('aria-label', '记录 JSON 文本');
  input.rows = 8;

  const error = document.createElement('div');
  error.className = 'jlv-edit-error';
  error.hidden = true;

  const btnFormat = document.createElement('button');
  btnFormat.type = 'button';
  btnFormat.className = 'jlv-edit-btn';
  btnFormat.textContent = '格式化';

  const spacer = document.createElement('span');
  spacer.className = 'jlv-edit-spacer';

  const btnCancel = document.createElement('button');
  btnCancel.type = 'button';
  btnCancel.className = 'jlv-edit-btn';
  btnCancel.textContent = '取消';

  const btnSave = document.createElement('button');
  btnSave.type = 'button';
  btnSave.className = 'jlv-edit-btn jlv-edit-primary';
  btnSave.textContent = '保存';

  const foot = document.createElement('div');
  foot.className = 'jlv-edit-foot';
  foot.append(btnFormat, spacer, btnCancel, btnSave);

  panel.append(head, hint, input, error, foot);
  backdrop.appendChild(panel);

  /* ---------------- 内部动作 ---------------- */

  function showError(message: string): void {
    error.textContent = message;
    error.hidden = false;
  }

  function clearError(): void {
    error.textContent = '';
    error.hidden = true;
  }

  /** 依据当前行位与概览重算成本提示（估值超阈值才显示）。 */
  function refreshHint(): void {
    const overview = deps.getOverview?.();
    const warn = overview
      ? editCostWarning(estimateEditCost(overview.totalBytes, overview.totalRecords, currentLine))
      : undefined;
    hint.textContent = warn ?? '';
    hint.hidden = warn === undefined;
    hint.classList.toggle('warn', warn !== undefined);
  }

  function close(): void {
    if (!opened) return;
    opened = false;
    submitting = false;
    clearError();
    panel.classList.remove('open');
    backdrop.classList.remove('open');
    // 关闭走快速淡出（设计体系 §3.6：100ms），结束后再真正隐藏，避免打断过渡。
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      backdrop.hidden = true;
      closeTimer = undefined;
    }, 100);
  }

  async function save(): Promise<void> {
    if (submitting || currentLine < 0) return;
    clearError();

    // ① 本地即时校验：省一次往返，也让用户立刻看到问题所在。
    const checked = validateEditText(input.value);
    if (!checked.ok) {
      showError(checked.error);
      input.focus();
      return;
    }

    submitting = true;
    btnSave.disabled = true;
    btnCancel.disabled = true;
    btnSave.textContent = '保存中…';
    try {
      const res = await deps.submit({ line: currentLine, text: checked.text, mode: currentMode });
      if (res.ok) {
        deps.onCommitted?.({ line: currentLine, mode: currentMode });
        close();
        return;
      }
      // ② 宿主侧失败（冲突 / 权限 / 磁盘满…）：保持打开，让用户能改或重试。
      showError(describeEditFailure(res));
      input.focus();
    } catch (e) {
      showError(e instanceof Error ? e.message : String(e));
    } finally {
      submitting = false;
      btnSave.disabled = false;
      btnCancel.disabled = false;
      btnSave.textContent = '保存';
    }
  }

  function onFormat(): void {
    const formatted = formatJsonText(input.value);
    if (formatted === undefined) {
      showError('当前内容不是合法 JSON，无法格式化');
      return;
    }
    clearError();
    input.value = formatted;
    refreshHint();
    input.focus();
  }

  /* ---------------- 事件 ---------------- */

  btnClose.addEventListener('click', () => close());
  btnCancel.addEventListener('click', () => close());
  btnSave.addEventListener('click', () => void save());
  btnFormat.addEventListener('click', onFormat);

  // 点遮罩关闭，但点面板内部不关。
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });

  input.addEventListener('input', () => {
    if (!error.hidden) clearError();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    // Ctrl/Cmd + Enter 保存
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    }
  });

  const controller: EditPanelController = {
    root: backdrop,
    open(line: number, initialText: string, mode: EditMode = 'replace'): void {
      currentLine = line;
      currentMode = mode;
      opened = true;
      title.textContent = mode === 'insert' ? `在第 ${line + 1} 行前插入` : `编辑第 ${line + 1} 行`;
      input.value = initialText;
      clearError();
      refreshHint();

      if (closeTimer) {
        clearTimeout(closeTimer);
        closeTimer = undefined;
      }
      backdrop.hidden = false;
      // 先建立收起起始态 → reflow → 再加 open 触发过渡（设计体系 §4.3 防竞态写法）。
      panel.classList.remove('open');
      backdrop.classList.remove('open');
      void panel.offsetWidth;
      panel.classList.add('open');
      backdrop.classList.add('open');
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
    close,
    isOpen: () => opened,
    dispose(): void {
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = undefined;
      backdrop.remove();
    },
  };

  return controller;
}
