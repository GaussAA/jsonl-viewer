/**
 * styles.ts — webview 注入的 CSS 文本。
 *
 * 按交互原型（prototype.html）最终设计 **1:1 复刻**，全部以 VS Code 主题变量
 * （--vscode-*）表达配色（半透明白 + 主题派生色），自动跟随主题。
 * 结构遵循原型：左栏浮卡工具栏 + 卡片目录 + 两行分页；右栏大卡片头部 + JSON 树。
 */

import cssText from './styles.css?raw';

export const CSS_TEXT = cssText;
