/**
 * panelCoordinator.ts — 浮层面板协调器（从 toolbar.ts 提取）。
 *
 * 职责：
 *   1. 管理「同时只能打开一个浮层」的互斥逻辑；
 *   2. 提供统一的 `toggle(id)` 接口；
 *   3. 惰性构建：面板只在首次打开时构建。
 *
 * 设计原则：
 *   - Coordinator 只负责协调，不直接操作焦点（由 FloatPanel.open/close 处理）；
 *   - 保持与现有 FloatPanel 接口兼容。
 */

/** 浮层面板的最小接口（与 toolbar.ts 中的 FloatPanel 兼容）。 */
export interface ManagedPanel {
  open: () => void;
  close: () => void;
  style: { display: string };
}

/** 面板注册信息。 */
interface PanelEntry {
  /** 面板实例（首次打开时由 builder 创建）。 */
  panel: ManagedPanel | null;
  /** 面板构建工厂（惰性调用）。 */
  builder: () => ManagedPanel;
  /** 清理函数（可选，dispose 时调用）。 */
  dispose?: () => void;
}

/**
 * 浮层面板协调器。
 *
 * 管理多个互斥的浮层面板（filter、layout、history、edit、profile），
 * 确保同时最多只有一个面板打开。
 */
export class PanelCoordinator {
  private readonly panels = new Map<string, PanelEntry>();
  private currentOpen: string | null = null;

  /**
   * 注册一个面板（惰性构建）。
   *
   * @param id 面板唯一标识（如 'filter', 'layout'）
   * @param builder 面板构建工厂（只在首次打开时调用）
   * @param dispose 清理函数（可选，destroy 时调用）
   */
  register(id: string, builder: () => ManagedPanel, dispose?: () => void): void {
    if (this.panels.has(id)) {
      throw new Error(`Panel "${id}" already registered`);
    }
    this.panels.set(id, { panel: null, builder, dispose });
  }

  /**
   * 切换面板显示状态（核心方法）。
   *
   * 行为：
   *   - 如果目标面板已打开 → 关闭它
   *   - 如果目标面板未打开 → 关闭当前打开的面板（如有），然后打开目标面板
   *   - 如果目标面板尚未构建 → 先调用 builder 构建，再打开
   *
   * @param id 面板唯一标识
   */
  toggle(id: string): void {
    const entry = this.panels.get(id);
    if (!entry) {
      throw new Error(`Panel "${id}" not registered`);
    }

    // 惰性构建：首次打开时才创建面板
    if (!entry.panel) {
      entry.panel = entry.builder();
    }

    const panel = entry.panel;
    const isCurrentlyOpen = panel.style.display !== 'none';

    if (isCurrentlyOpen) {
      // 当前面板已打开 → 关闭它
      panel.close();
      this.currentOpen = null;
    } else {
      // 当前面板未打开 → 先关闭其他面板，再打开它
      this.closeAll();
      panel.open();
      this.currentOpen = id;
    }
  }

  /**
   * 关闭所有面板。
   *
   * 用于：
   *   - toggle 时关闭其他面板（互斥）
   *   - 用户按 Esc 键关闭浮层
   *   - 外部需要强制关闭所有浮层
   */
  closeAll(): void {
    for (const entry of this.panels.values()) {
      if (entry.panel && entry.panel.style.display !== 'none') {
        entry.panel.close();
      }
    }
    this.currentOpen = null;
  }

  /**
   * 获取当前打开的面板 ID（如果有）。
   *
   * 用于测试或调试。
   */
  getCurrentOpen(): string | null {
    return this.currentOpen;
  }

  /**
   * 清理所有面板资源（webview 关闭时调用）。
   *
   * 调用每个面板的 dispose 函数（如果提供了）。
   */
  destroy(): void {
    for (const entry of this.panels.values()) {
      entry.dispose?.();
    }
    this.panels.clear();
    this.currentOpen = null;
  }
}
