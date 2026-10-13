/**
 * focusTrap.ts — 模态对话框焦点陷阱工具
 *
 * 复用 toolbar.ts 的焦点陷阱逻辑，为 Edit/History/BadLines/Profile/Field 面板提供统一实现。
 */

export interface FocusTrapOptions {
  /** 对话框容器 */
  container: HTMLElement;
  /** 关闭回调 */
  onClose: () => void;
  /** 可选：打开时不自动聚焦（某些面板有自己的聚焦逻辑） */
  noAutoFocus?: boolean;
}

/**
 * 为模态对话框设置焦点陷阱。
 *
 * - Esc 关闭
 * - Tab 循环（不穿到背后）
 * - 返回 dispose 函数，用于清理事件监听
 */
export function setupFocusTrap(opts: FocusTrapOptions): { dispose: () => void } {
  const { container, onClose, noAutoFocus } = opts;

  /** 容器内所有可聚焦元素（排除 disabled） */
  const focusables = (): HTMLElement[] => [
    ...container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])'
    ),
  ];

  // 打开时聚焦第一个控件
  if (!noAutoFocus) {
    const items = focusables();
    items[0]?.focus();
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    // Esc 关闭
    if (e.key === 'Escape') {
      onClose();
      return;
    }

    // Tab 循环
    if (e.key !== 'Tab') return;
    const items = focusables();
    if (items.length === 0) return;

    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;

    if (e.shiftKey && (active === first || !container.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  container.addEventListener('keydown', onKeyDown);

  return {
    dispose: () => container.removeEventListener('keydown', onKeyDown),
  };
}
