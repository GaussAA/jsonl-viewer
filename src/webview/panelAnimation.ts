/**
 * panelAnimation.ts — 浮层开合的共用状态机。
 *
 * badLinesPanel / historyPanel / profilePanel / fieldPanel 原先各自抄了一份
 * 「opened 标志 + 下一帧加 open 类 + 焦点陷阱 + 延迟隐藏」，改一处漏三处。
 * 这里收口；各面板只保留自己的业务（刷新、扫描等）。
 */

import { setupFocusTrap } from './focusTrap.ts';

export interface PanelAnimationConfig {
  panel: HTMLElement;
  backdrop: HTMLElement;
  /** 收起过渡时长（ms），须与 CSS 一致（设计体系 §3.6）。默认 120。 */
  closeDelayMs?: number;
  /** 已进入打开状态后调用（刷新、自动扫描等面板自己的事）。 */
  onOpen?: () => void;
  /**
   * 用户用「全局 Esc / 点击遮罩空白处」请求关闭时调用。传入即启用这两个入口。
   *
   * 要面板自己回调（而非这里直接 close）是因为有的面板关闭前还有善后（如字段浮层
   * 要先复位 busy）；绕过它直接收起会让面板停在脏状态。
   */
  onDismiss?: () => void;
}

export interface PanelAnimationController {
  open(): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

export function createPanelAnimation(config: PanelAnimationConfig): PanelAnimationController {
  const { panel, backdrop, onOpen, onDismiss } = config;
  const closeDelayMs = config.closeDelayMs ?? 120;

  let opened = false;
  let trapDispose: (() => void) | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  function clearCloseTimer(): void {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = undefined;
  }

  function open(): void {
    if (opened) return;
    opened = true;
    clearCloseTimer();
    backdrop.hidden = false;
    // 下一帧再加类，保证过渡生效
    requestAnimationFrame(() => {
      backdrop.classList.add('open');
      panel.classList.add('open');
      trapDispose?.();
      trapDispose = setupFocusTrap({ container: panel, onClose: close }).dispose;
    });
    onOpen?.();
  }

  function close(): void {
    if (!opened) return;
    opened = false;
    trapDispose?.();
    trapDispose = undefined;
    backdrop.classList.remove('open');
    panel.classList.remove('open');
    clearCloseTimer();
    closeTimer = setTimeout(() => {
      // 过渡期间用户可能又打开了它 —— 关闭定时器不得把新开的浮层藏掉。
      if (!opened) backdrop.hidden = true;
      closeTimer = undefined;
    }, closeDelayMs);
  }

  // 全局 Esc：焦点陷阱只在焦点位于浮层内时才收得到按键，焦点落到别处时靠它兜底。
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && opened) {
      e.preventDefault();
      onDismiss?.();
    }
  };
  if (onDismiss) {
    document.addEventListener('keydown', onKeyDown);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) onDismiss();
    });
  }

  function dispose(): void {
    if (onDismiss) document.removeEventListener('keydown', onKeyDown);
    trapDispose?.();
    trapDispose = undefined;
    clearCloseTimer();
  }

  return { open, close, isOpen: () => opened, dispose };
}
