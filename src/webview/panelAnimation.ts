/**
 * 面板打开/关闭动画管理工具
 * 用于消除 badLinesPanel、historyPanel、profilePanel 等面板中的重复代码
 */

import { setupFocusTrap } from './focusTrap.js';

export interface PanelAnimationConfig {
  /** 面板容器元素 */
  panel: HTMLElement;
  /** 背景遮罩元素 */
  backdrop: HTMLElement;
  /** 关闭回调（可选） */
  onClose?: () => void;
  /** 打开后的刷新回调（可选） */
  onRefresh?: () => void | Promise<void>;
}

export interface PanelAnimationController {
  /** 打开面板 */
  open: () => void;
  /** 关闭面板 */
  close: () => void;
  /** 是否已打开 */
  isOpened: () => boolean;
  /** 销毁控制器 */
  dispose: () => void;
}

/**
 * 创建面板动画控制器
 *
 * 统一处理：
 * - 打开/关闭状态管理
 * - CSS 过渡动画（open 类）
 * - 焦点陷阱设置
 * - 延迟隐藏（关闭动画完成后）
 */
export function createPanelAnimation(config: PanelAnimationConfig): PanelAnimationController {
  const { panel, backdrop, onClose, onRefresh } = config;

  let opened = false;
  let trapDispose: (() => void) | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  function open(): void {
    if (opened) return;
    opened = true;

    // 清除关闭定时器（如果正在关闭过程中被重新打开）
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }

    backdrop.hidden = false;

    // 下一帧再加类，保证 CSS 过渡生效
    requestAnimationFrame(() => {
      backdrop.classList.add('open');
      panel.classList.add('open');

      // 设置焦点陷阱
      trapDispose?.();
      trapDispose = setupFocusTrap({
        container: panel,
        onClose: close,
      }).dispose;
    });

    // 触发刷新回调
    if (onRefresh) {
      void onRefresh();
    }
  }

  function close(): void {
    if (!opened) return;
    opened = false;

    // 释放焦点陷阱
    trapDispose?.();
    trapDispose = undefined;

    // 移除 open 类，触发关闭动画
    backdrop.classList.remove('open');
    panel.classList.remove('open');

    // 清除旧定时器
    if (closeTimer) clearTimeout(closeTimer);

    // 动画结束后隐藏元素（节省 GPU 资源）
    closeTimer = setTimeout(() => {
      backdrop.hidden = true;
      closeTimer = undefined;
    }, 300); // 与 CSS transition 时长一致

    // 触发关闭回调
    onClose?.();
  }

  function isOpened(): boolean {
    return opened;
  }

  function dispose(): void {
    trapDispose?.();
    trapDispose = undefined;
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
  }

  return { open, close, isOpened, dispose };
}
