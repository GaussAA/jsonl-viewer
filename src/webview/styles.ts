/**
 * styles.ts — webview 注入的 CSS 文本。
 *
 * 全部以 VS Code 主题变量（--vscode-*）表达配色，不写死色值，自动跟随主题。
 * 作为字符串常量由 webviewEntry 注入 <style>（CSP 已放行 style-src 'unsafe-inline'），
 * 避免额外引入 css 打包插件、保持 iife 单文件。
 */
export const CSS_TEXT = `
:root {
  --jlv-font: var(--vscode-font-family, system-ui, sans-serif);
  --jlv-fg: var(--vscode-foreground, #cccccc);
  --jlv-bg: var(--vscode-editor-background, #1e1e1e);
  --jlv-panel-bg: var(--vscode-sideBar-background, #252526);
  --jlv-border: var(--vscode-panel-border, rgb(128,128,128,0.35));
  --jlv-error-bg: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.15));
  --jlv-error-fg: var(--vscode-errorForeground, #f48771);
  --jlv-card-hover: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12));
  --jlv-selection: var(--vscode-list-activeSelectionBackground, #04395e);
  --jlv-selection-fg: var(--vscode-list-activeSelectionForeground, #fff);
  --jlv-dim: var(--vscode-descriptionForeground, #8a8a8a);
  --jlv-string: var(--vscode-charts-green, #7fdb8a);
  --jlv-number: var(--vscode-charts-blue, #88c0ff);
  --jlv-key: var(--vscode-charts-yellow, #e5c07b);
  --jlv-bool: var(--vscode-charts-purple, #c586c0);
  --jlv-null: var(--vscode-charts-orange, #e0a36a);
  --jlv-container: var(--vscode-descriptionForeground, #9a9a9a);
}

* { box-sizing: border-box; }
html, body, #app { height: 100%; margin: 0; }
#app {
  display: flex;
  flex-direction: column;
  font-family: var(--jlv-font);
  color: var(--jlv-fg);
  background: var(--jlv-bg);
  font-size: 13px;
}

/* 顶部概要栏 */
.jlv-topbar {
  flex: 0 0 auto;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--jlv-border);
  background: var(--jlv-panel-bg);
  position: relative; z-index: 2;
}
.jlv-topbar .jlv-title { font-weight: 600; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jlv-topbar .jlv-stat { color: var(--jlv-dim); white-space: nowrap; }
.jlv-topbar .jlv-status {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--jlv-dim); white-space: nowrap;
}
.jlv-status .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-charts-orange, #e0a36a); }
.jlv-status.ready .dot { background: var(--vscode-charts-green, #7fdb8a); }
.jlv-status.error .dot { background: var(--jlv-error-fg); }
.jlv-topbar .spacer { flex: 1 1 40px; }
.jlv-topbar .jlv-field {
  min-width: 160px; color-scheme: inherit;
}

/* 主体：左侧记录列表（目录态，窄栏） + 右侧 JSON 树主显示区（真正主体，占据剩余宽度） */
.jlv-body { flex: 1 1 0; display: flex; min-height: 0; }

/* 虚拟滚动容器（记录列表 = 左侧窄栏，作用相当于“目录”/摘要） */
.jlv-scroll {
  flex: 0 0 300px;
  overflow-y: auto;
  position: relative;
  min-width: 0;
  contain: strict;
  border-right: 1px solid var(--jlv-border);
}
.jlv-inner { position: relative; width: 100%; }

/* 卡片（绝对定位，由虚拟滚动放置） */
.jlv-card {
  position: absolute;
  left: 0; right: 0;
  padding: 6px 12px;
  border-bottom: 1px solid var(--jlv-border);
  cursor: pointer;
  overflow: hidden;
  contain: layout;
}
.jlv-card:hover { background: var(--jlv-card-hover); }
.jlv-card.selected {
  background: var(--jlv-selection);
  color: var(--jlv-selection-fg);
}
.jlv-card .jlv-line-no {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px; color: var(--jlv-dim);
  user-select: none;
}
.jlv-card .jlv-kv { display: flex; gap: 8px; align-items: baseline; margin-top: 2px; }
.jlv-card .jlv-kv .key { color: var(--jlv-key); flex: none; }
.jlv-card .jlv-kv .val { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; word-break: break-all; }
.jlv-card .jlv-kv .val.str { color: var(--jlv-string); }
.jlv-card .jlv-kv .val.num { color: var(--jlv-number); }
.jlv-card .jlv-card-bad { color: var(--jlv-error-fg); font-size: 12px; margin-top: 3px; word-break: break-all; }
.jlv-card.error { background: var(--jlv-error-bg); }

/* 加载中 / 空态占位 */
.jlv-tombstone { color: var(--jlv-dim); font-style: italic; }

/* 列表加载指示 */
.jlv-loading-bar { position: fixed; top: 0; left: 0; height: 2px; width: 100%;
  background: linear-gradient(90deg, transparent, var(--vscode-progressBar-background, #0e639c), transparent);
  animation: jlv-slide 1.1s infinite; z-index: 10; pointer-events: none; }
@keyframes jlv-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }

/* 文件变更 / 错误横幅（Task 7）：位于工具条与列表之间 */
.jlv-banner {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: var(--jlv-error-bg);
  border-bottom: 1px solid var(--jlv-border);
  color: var(--jlv-fg);
  font-size: 12px;
}
.jlv-banner[hidden] { display: none; }
.jlv-banner-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jlv-banner-action { white-space: nowrap; }

/* 详情面板（JSON 树，Task 5）——真正的主体，占据剩余全部宽度 */
.jlv-detail {
  flex: 1 1 auto;
  min-width: 0;
  border-left: none;
  background: var(--jlv-panel-bg);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.jlv-detail .jlv-detail-hint { color: var(--jlv-dim); font-size: 12px; }

/* 工具条 */
.jlv-tree-tools {
  flex: 0 0 auto;
  padding: 6px 8px;
  border-bottom: 1px solid var(--jlv-border);
  display: flex;
  align-items: center;
  gap: 8px;
}
.jlv-tree-tools-group { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.jlv-tbtn {
  background: transparent;
  color: var(--jlv-fg);
  border: 1px solid var(--jlv-border);
  border-radius: 3px;
  font-size: 12px;
  padding: 2px 8px;
  cursor: pointer;
  font-family: inherit;
}
.jlv-tbtn:hover { background: var(--jlv-card-hover); }
.jlv-tbtn:active { transform: translateY(1px); }
.jlv-depth { padding: 2px 4px; color-scheme: inherit; }

/* 路径面包屑 */
.jlv-tree-crumb {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--jlv-border);
  color: var(--jlv-dim);
  font-size: 12px;
  font-family: var(--vscode-editor-font-family, monospace);
  user-select: none;
}
.jlv-crumb-seg {
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--jlv-key);
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
  padding: 0 3px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.jlv-crumb-seg:hover { background: var(--jlv-card-hover); }
.jlv-crumb-seg.current { background: var(--jlv-selection); color: var(--jlv-selection-fg); }
.jlv-crumb-sep { color: var(--jlv-dim); }

/* 树体（可滚动） */
.jlv-detail-body.jlv-tree-body {
  flex: 1 1 auto;
  overflow: auto;
  padding: 6px 4px 40px 8px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 12px;
  line-height: 1.5;
}
.jlv-tree-hint, .jlv-tree-loading, .jlv-tree-error {
  color: var(--jlv-dim);
  padding: 8px;
}
.jlv-tree-loading { display: flex; align-items: center; gap: 8px; }
.jlv-tree-error { color: var(--jlv-error-fg); word-break: break-all; }

/* 行 */
.jlv-tree-row {
  display: flex;
  align-items: baseline;
  gap: 2px;
  padding-left: var(--indent, 0px);
  border-radius: 3px;
  white-space: nowrap;
  min-height: 18px;
}
.jlv-tree-row > .jlv-tree-children { display: block; }
.jlv-tree-row:hover { background: var(--jlv-card-hover); }
.jlv-tree-row.selected { background: var(--jlv-selection); }
.jlv-tree-row .toggler {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  flex: none;
  color: var(--jlv-dim);
  cursor: pointer;
  transform-origin: center;
}
.jlv-tree-row.collapsed .toggler { transform: rotate(-90deg); }
.jlv-tree-row .toggler svg { display: block; }
.jlv-tree-row .jlv-key { color: var(--jlv-key); flex: none; }
.jlv-tree-row .jlv-colon { color: var(--jlv-dim); margin-right: 4px; }
.jlv-tree-row .jlv-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.jlv-tree-row .jlv-value.str { color: var(--jlv-string); }
.jlv-tree-row .jlv-value.num { color: var(--jlv-number); }
.jlv-tree-row .jlv-value.bool { color: var(--jlv-bool); }
.jlv-tree-row .jlv-value.null { color: var(--jlv-null); font-style: italic; }
.jlv-tree-row .jlv-value.obj { color: var(--jlv-container); }
.jlv-tree-row .jlv-summary { font-style: italic; }

/* 大数组「加载更多」 */
.jlv-load-more {
  padding: 2px 0 2px 16px;
  color: var(--jlv-bool);
  cursor: pointer;
  font-size: 12px;
  user-select: none;
}
.jlv-load-more:hover { text-decoration: underline; }

/* 加载指示环 */
.jlv-progress-ring {
  width: 14px;
  height: 14px;
  flex: none;
  border-radius: 50%;
  border: 2px solid var(--vscode-progressBar-background, #0e639c);
  border-top-color: transparent;
  animation: jlv-ring 0.8s linear infinite;
}
@keyframes jlv-ring { to { transform: rotate(360deg); } }

/* 屏幕较小时把详情占位收窄到底部下方 */
@media (max-width: 700px) {
  .jlv-body { flex-direction: column; }
  .jlv-detail { flex: 0 0 auto; border-left: none; border-top: 1px solid var(--jlv-border); max-height: 160px; }
}

/* ---- Toolbar 搜索 / 过滤 / 字段定制（Task 6） ---- */
.jlv-topbar .jlv-search { min-width: 200px; }
.jlv-topbar .jlv-ctrl-group { display: inline-flex; align-items: center; gap: 4px; }
.jlv-topbar .jlv-nav { padding: 1px 7px; }
.jlv-topbar .jlv-nav:disabled { opacity: 0.35; cursor: default; }
.jlv-topbar .jlv-match {
  font-size: 12px;
  color: var(--jlv-dim);
  min-width: 34px;
  text-align: center;
  white-space: nowrap;
}
.jlv-topbar .jlv-tbtn.active { background: var(--jlv-selection); color: var(--jlv-selection-fg); }

/* 浮动面板（过滤 / 字段定制） */
.jlv-panel {
  position: fixed;
  left: 8px;
  z-index: 20;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 10px;
  margin-top: 4px;
  background: var(--jlv-panel-bg);
  border: 1px solid var(--jlv-border);
  border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  font-size: 12px;
  color: var(--jlv-fg);
}
.jlv-ctrl-label { display: inline-flex; align-items: center; gap: 4px; color: var(--jlv-dim); }
.jlv-ctrl-label > span { white-space: nowrap; }
.jlv-panel input[type='text'],
.jlv-panel input.jlv-field { min-width: 120px; color-scheme: inherit; }

/* 字段定制行 */
.jlv-layout-list { display: flex; flex-direction: column; gap: 2px; }
.jlv-layout-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 3px;
  cursor: pointer;
}
.jlv-layout-row:hover { background: var(--jlv-card-hover); }
.jlv-layout-row .jlv-layout-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--jlv-key);
}
`;