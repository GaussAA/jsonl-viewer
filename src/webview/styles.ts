/**
 * styles.ts — webview 注入的 CSS 文本。
 *
 * 全部以 VS Code 主题变量（--vscode-*）表达配色，不写死色值，自动跟随主题。
 * 顶部定义一套派生自 --vscode-* 的「设计 token」（间距 / 圆角 / 字号 / 过渡 / 阴影 /
 * 语义色），供所有组件复用，形成统一的排版节奏与视觉层级。
 *
 * 作为字符串常量由 webviewEntry 注入 <style>（CSP 已放行 style-src 'unsafe-inline'），
 * 避免额外引入 css 打包插件、保持 iife 单文件。
 */
export const CSS_TEXT = `
:root {
  /* 字体 */
  --jlv-font: var(--vscode-font-family, system-ui, -apple-system, "Segoe UI", sans-serif);
  --jlv-mono: var(--vscode-editor-font-family, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace);

  /* 基础配色（全部派生自主题变量） */
  --jlv-fg: var(--vscode-foreground, #cccccc);
  --jlv-bg: var(--vscode-editor-background, #1e1e1e);
  --jlv-panel-bg: var(--vscode-sideBar-background, #252526);
  --jlv-border: var(--vscode-panel-border, rgba(128,128,128,0.35));
  --jlv-guide: var(--vscode-editorWidget-border, rgba(128,128,128,0.28));
  --jlv-error-bg: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.15));
  --jlv-error-fg: var(--vscode-errorForeground, #f48771);
  --jlv-card-hover: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12));
  --jlv-selection: var(--vscode-list-activeSelectionBackground, #04395e);
  --jlv-selection-fg: var(--vscode-list-activeSelectionForeground, #ffffff);
  --jlv-dim: var(--vscode-descriptionForeground, #8a8a8a);

  /* JSON 语义色 */
  --jlv-string: var(--vscode-charts-green, #7fdb8a);
  --jlv-number: var(--vscode-charts-blue, #88c0ff);
  --jlv-key: var(--vscode-charts-yellow, #e5c07b);
  --jlv-bool: var(--vscode-charts-purple, #c586c0);
  --jlv-null: var(--vscode-charts-orange, #e0a36a);
  --jlv-container: var(--vscode-descriptionForeground, #9a9a9a);

  /* 状态语义色 */
  --jlv-good: var(--vscode-charts-green, #7fdb8a);
  --jlv-warn: var(--vscode-charts-yellow, #e5c07b);
  --jlv-bad: var(--vscode-errorForeground, #f48771);
  --jlv-info: var(--vscode-charts-blue, #88c0ff);

  /* 间距刻度 */
  --jlv-space-1: 4px;
  --jlv-space-2: 8px;
  --jlv-space-3: 12px;
  --jlv-space-4: 16px;
  --jlv-space-5: 20px;
  --jlv-space-6: 24px;

  /* 圆角 */
  --jlv-radius-1: 4px;
  --jlv-radius-2: 6px;
  --jlv-radius-3: 8px;
  --jlv-radius-full: 999px;

  /* 字号层级 */
  --jlv-font-size-xs: 11px;
  --jlv-font-size-sm: 12px;
  --jlv-font-size-md: 13px;
  --jlv-font-size-lg: 14px;
  --jlv-font-size-xl: 16px;

  /* 过渡 / 阴影 */
  --jlv-ease: cubic-bezier(.2, 0, 0, 1);
  --jlv-transition: 140ms var(--jlv-ease);
  --jlv-shadow-1: 0 1px 3px rgba(0, 0, 0, .22);
  --jlv-shadow-2: 0 6px 18px rgba(0, 0, 0, .34);
}

* { box-sizing: border-box; }
html, body, #app { height: 100%; margin: 0; }
#app {
  display: flex;
  flex-direction: column;
  font-family: var(--jlv-font);
  color: var(--jlv-fg);
  background: var(--jlv-bg);
  font-size: var(--jlv-font-size-md);
}

/* 统一滚动条 */
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background, rgba(121,121,121,.4));
  border: 2px solid transparent;
  border-radius: var(--jlv-radius-full);
  background-clip: content-box;
}
*::-webkit-scrollbar-thumb:hover { background-color: var(--vscode-scrollbarSlider-hoverBackground, rgba(121,121,121,.6)); }
*::-webkit-scrollbar-thumb:active { background-color: var(--vscode-scrollbarSlider-activeBackground, rgba(121,121,121,.7)); }
*::-webkit-scrollbar-corner { background: transparent; }

/* 焦点可见环 */
:focus-visible {
  outline: 2px solid var(--vscode-focusBorder, #007fd4);
  outline-offset: -1px;
}

/* 无障碍：使用者偏好在减少动效时关闭动画/过渡 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}

/* ============================================================
 * 顶部概要栏（两层：primary 行 + 统计行）
 * ============================================================ */
.jlv-topbar {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--jlv-border);
  background: var(--jlv-panel-bg);
  position: relative; z-index: 2;
}
.jlv-topbar__primary {
  display: flex;
  align-items: center;
  gap: var(--jlv-space-3);
  padding: var(--jlv-space-2) var(--jlv-space-4);
  flex-wrap: wrap;
}
.jlv-topbar__stats {
  display: flex;
  align-items: center;
  gap: var(--jlv-space-2);
  padding: 0 var(--jlv-space-4) var(--jlv-space-2);
  flex-wrap: wrap;
}
.jlv-topbar__spacer { flex: 1 1 24px; min-width: var(--jlv-space-3); }

/* 文件名块 */
.jlv-file {
  display: inline-flex;
  align-items: center;
  gap: var(--jlv-space-2);
  min-width: 0;
  max-width: 340px;
}
.jlv-file__icon {
  display: inline-flex;
  align-items: center;
  color: var(--jlv-dim);
  flex: none;
}
.jlv-title {
  font-weight: 600;
  font-size: var(--jlv-font-size-md);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 状态 */
.jlv-status {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: var(--jlv-font-size-sm); color: var(--jlv-dim); white-space: nowrap;
  padding: 2px 8px;
  border-radius: var(--jlv-radius-full);
  background: var(--vscode-statusBar-noFolderBackground-dimmed, rgba(128,128,128,.12));
}
.jlv-status .dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--vscode-charts-orange, #e0a36a);
}
.jlv-status.ready .dot { background: var(--jlv-good); }
.jlv-status.error .dot { background: var(--jlv-bad); }

/* 统计芯片 */
.jlv-stat-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  font-size: var(--jlv-font-size-sm);
  color: var(--jlv-dim);
  white-space: nowrap;
  background: color-mix(in srgb, var(--vscode-descriptionForeground, #8a8a8a) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--jlv-border) 70%, transparent);
  border-radius: var(--jlv-radius-full);
  line-height: 1;
}
.jlv-stat-chip__ic { display: inline-flex; align-items: center; color: var(--jlv-dim); flex: none; }

/* 搜索框 */
.jlv-search-box {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 200px;
  max-width: 420px;
  flex: 1 1 220px;
  padding: 0 8px;
  height: 26px;
  background: var(--vscode-input-background, #3c3c3c);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: var(--jlv-radius-2);
  color-scheme: inherit;
  transition: border-color var(--jlv-transition), box-shadow var(--jlv-transition);
}
.jlv-search-box:focus-within {
  border-color: var(--vscode-focusBorder, #007fd4);
  box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007fd4);
}
.jlv-search-box__icon { display: inline-flex; align-items: center; color: var(--jlv-dim); flex: none; }
.jlv-search-box .jlv-search {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--vscode-input-foreground, var(--jlv-fg));
  outline: none;
  font-family: inherit;
  font-size: var(--jlv-font-size-sm);
  padding: 0;
}
.jlv-search-box .jlv-search::placeholder { color: var(--jlv-dim); }
.jlv-search-box__clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px; height: 18px;
  flex: none;
  border: none;
  background: transparent;
  color: var(--jlv-dim);
  border-radius: 50%;
  cursor: pointer;
  transition: background var(--jlv-transition);
}
.jlv-search-box__clear:hover { background: var(--jlv-card-hover); color: var(--jlv-fg); }
.jlv-search-box__count {
  flex: none;
  padding: 1px 7px;
  border-radius: var(--jlv-radius-full);
  font-size: var(--jlv-font-size-xs);
  font-family: var(--jlv-mono);
  color: var(--vscode-foreground, var(--jlv-fg));
  background: var(--vscode-list-activeSelectionBackground, #04395e);
}

/* 通用小按钮 */
.jlv-tbtn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  color: var(--jlv-fg);
  border: 1px solid var(--jlv-border);
  border-radius: var(--jlv-radius-2);
  font-size: var(--jlv-font-size-sm);
  padding: 3px 10px;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
  transition: background var(--jlv-transition), color var(--jlv-transition), border-color var(--jlv-transition), transform var(--jlv-transition);
}
.jlv-tbtn:hover { background: var(--jlv-card-hover); }
.jlv-tbtn:active { transform: translateY(1px); }
.jlv-tbtn.active { background: var(--jlv-selection); color: var(--jlv-selection-fg); border-color: transparent; }
.jlv-tbtn__ic { display: inline-flex; align-items: center; }

.jlv-field { min-width: 160px; color-scheme: inherit; }
.jlv-topbar .jlv-search { min-width: 0; }
.jlv-topbar .jlv-ctrl-group { display: inline-flex; align-items: center; gap: var(--jlv-space-1); }
.jlv-topbar .jlv-nav { padding: 2px 6px; }
.jlv-topbar .jlv-nav:disabled { opacity: .35; cursor: default; }

/* ============================================================
 * 主体：左侧记录列表（窄栏）+ 右侧 JSON 树（主体）
 * ============================================================ */
.jlv-body { flex: 1 1 0; display: flex; min-height: 0; }

/* 虚拟滚动容器 */
.jlv-scroll {
  flex: 0 0 300px;
  overflow-y: auto;
  position: relative;
  min-width: 0;
  contain: strict;
  border-right: 1px solid var(--jlv-border);
  background: var(--jlv-panel-bg);
}
.jlv-inner { position: relative; width: 100%; }

/* 记录卡片 */
.jlv-card {
  position: absolute;
  left: 0; right: 0;
  display: flex;
  align-items: stretch;
  gap: var(--jlv-space-2);
  padding: var(--jlv-space-2) var(--jlv-space-3);
  border-bottom: 1px solid var(--jlv-border);
  border-left: 2px solid transparent;
  cursor: pointer;
  overflow: hidden;
  contain: layout;
  transition: background var(--jlv-transition), border-color var(--jlv-transition);
}
.jlv-card:hover { background: var(--jlv-card-hover); }
.jlv-card.selected {
  background: var(--jlv-selection);
  color: var(--jlv-selection-fg);
  border-left-color: var(--vscode-focusBorder, #007fd4);
}
.jlv-card.error { background: var(--jlv-error-bg); }

/* 行号导轨 */
.jlv-card__lno {
  flex: none;
  width: 40px;
  padding-top: 1px;
  font-family: var(--jlv-mono);
  font-size: var(--jlv-font-size-xs);
  color: var(--jlv-dim);
  text-align: right;
  user-select: none;
  border-right: 1px solid var(--jlv-border);
  margin-right: var(--jlv-space-1);
  transition: color var(--jlv-transition);
}
.jlv-card.selected .jlv-card__lno { color: color-mix(in srgb, var(--jlv-selection-fg) 62%, transparent); border-color: color-mix(in srgb, var(--jlv-selection-fg) 20%, transparent); }

/* 卡片主体列 */
.jlv-card__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  justify-content: center;
}

/* 字段行 */
.jlv-kv { display: flex; gap: var(--jlv-space-2); align-items: baseline; min-width: 0; }
.jlv-kv__key {
  flex: none;
  min-width: 44px;
  font-family: var(--jlv-mono);
  font-size: var(--jlv-font-size-xs);
  color: var(--jlv-key);
  opacity: .85;
  transition: color var(--jlv-transition), opacity var(--jlv-transition);
}
.jlv-card.selected .jlv-kv__key { color: var(--jlv-selection-fg); opacity: .62; }
.jlv-kv__val {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  word-break: break-all;
  font-family: var(--jlv-mono);
  font-size: var(--jlv-font-size-sm);
}
.jlv-kv__val.str { color: var(--jlv-string); }
.jlv-kv__val.num { color: var(--jlv-number); }
.jlv-card.selected .jlv-kv__val.str,
.jlv-card.selected .jlv-kv__val.num { color: var(--jlv-selection-fg); }

/* 语义状态徽标 */
.jlv-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  width: fit-content;
  max-width: 100%;
  padding: 1px 8px;
  border-radius: var(--jlv-radius-full);
  font-family: var(--jlv-font);
  font-size: var(--jlv-font-size-xs);
  line-height: 1.45;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}
.jlv-badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.jlv-badge--good { color: var(--jlv-good); background: rgba(127,219,138,.15); background: color-mix(in srgb, var(--jlv-good) 15%, transparent); }
.jlv-badge--warn { color: var(--jlv-warn); background: rgba(229,192,123,.15); background: color-mix(in srgb, var(--jlv-warn) 15%, transparent); }
.jlv-badge--bad { color: var(--jlv-bad); background: rgba(244,135,113,.15); background: color-mix(in srgb, var(--jlv-bad) 16%, transparent); }
.jlv-badge--info { color: var(--jlv-info); background: rgba(136,192,255,.15); background: color-mix(in srgb, var(--jlv-info) 15%, transparent); }
.jlv-card.selected .jlv-badge { background: color-mix(in srgb, var(--jlv-selection-fg) 14%, transparent); }

/* 错误卡 */
.jlv-card-bad {
  color: var(--jlv-error-fg);
  font-size: var(--jlv-font-size-sm);
  word-break: break-all;
  line-height: 1.4;
}

/* 加载占位骨架 */
.jlv-tombstone {
  color: var(--jlv-dim);
  font-style: italic;
  font-size: var(--jlv-font-size-sm);
  display: flex;
  align-items: center;
  gap: var(--jlv-space-2);
}
.jlv-skeleton-bar { width: 60%; height: 9px; border-radius: var(--jlv-radius-full); background: var(--jlv-card-hover); display: inline-block; }

/* 列表顶部加载指示条 */
.jlv-loading-bar {
  position: fixed; top: 0; left: 0; height: 2px; width: 100%;
  background: linear-gradient(90deg, transparent, var(--vscode-progressBar-background, #0e639c), transparent);
  animation: jlv-slide 1.1s infinite; z-index: 10; pointer-events: none;
}
@keyframes jlv-slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }

/* 文件变更 / 错误横幅 */
.jlv-banner {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--jlv-space-3);
  padding: var(--jlv-space-2) var(--jlv-space-4);
  background: var(--jlv-error-bg);
  border-bottom: 1px solid var(--jlv-border);
  color: var(--jlv-fg);
  font-size: var(--jlv-font-size-sm);
}
.jlv-banner::before {
  content: '';
  width: 9px; height: 9px; border-radius: 50%;
  background: var(--jlv-warn);
  flex: none;
}
.jlv-banner[hidden] { display: none; }
.jlv-banner-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jlv-banner-action { white-space: nowrap; }

/* ============================================================
 * 右侧详情面板（JSON 树）
 * ============================================================ */
.jlv-detail {
  flex: 1 1 auto;
  min-width: 0;
  background: var(--jlv-bg);
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.jlv-detail .jlv-detail-hint { color: var(--jlv-dim); font-size: var(--jlv-font-size-sm); }

/* 树工具条 */
.jlv-tree-tools {
  flex: 0 0 auto;
  padding: var(--jlv-space-2) var(--jlv-space-3);
  border-bottom: 1px solid var(--jlv-border);
  display: flex;
  align-items: center;
  gap: var(--jlv-space-2);
  background: var(--jlv-panel-bg);
}
.jlv-tree-tools__spacer { flex: 1 1 auto; }
.jlv-tree-tools-group {
  display: inline-flex;
  align-items: center;
  gap: var(--jlv-space-1);
  flex-wrap: wrap;
  padding: 2px;
  background: var(--vscode-toolbar-hoverBackground-dimmed, rgba(128,128,128,.10));
  border: 1px solid var(--jlv-border);
  border-radius: var(--jlv-radius-2);
}
.jlv-tree-tools-group .jlv-tbtn { border: none; background: transparent; padding: 2px 8px; border-radius: var(--jlv-radius-1); }
.jlv-tree-tools-group .jlv-tbtn:hover { background: var(--jlv-card-hover); }
.jlv-tree-tools-group .jlv-tbtn:active { transform: none; }
.jlv-depth { padding: 2px 6px; color-scheme: inherit; background: transparent; color: inherit; border: none; border-radius: var(--jlv-radius-1); font-family: inherit; font-size: var(--jlv-font-size-sm); cursor: pointer; }
.jlv-depth:hover { background: var(--jlv-card-hover); }
.jlv-depth:focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); }

/* 路径面包屑 */
.jlv-tree-crumb {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--jlv-space-1);
  padding: 5px var(--jlv-space-3);
  border-bottom: 1px solid var(--jlv-border);
  color: var(--jlv-dim);
  font-size: var(--jlv-font-size-sm);
  font-family: var(--jlv-mono);
  user-select: none;
  background: color-mix(in srgb, var(--jlv-panel-bg) 60%, transparent);
}
.jlv-crumb-seg {
  background: transparent;
  border: none;
  border-radius: var(--jlv-radius-1);
  color: var(--jlv-key);
  cursor: pointer;
  font-family: inherit;
  font-size: var(--jlv-font-size-sm);
  padding: 1px 4px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: background var(--jlv-transition);
}
.jlv-crumb-seg:hover { background: var(--jlv-card-hover); }
.jlv-crumb-seg.current { background: var(--jlv-selection); color: var(--jlv-selection-fg); }
.jlv-crumb-sep { color: var(--jlv-dim); opacity: .6; }

/* 树体 */
.jlv-detail-body.jlv-tree-body {
  flex: 1 1 auto;
  overflow: auto;
  padding: var(--jlv-space-2) var(--jlv-space-2) 40px var(--jlv-space-3);
  font-family: var(--jlv-mono);
  font-size: var(--jlv-font-size-sm);
  line-height: 1.55;
}

/* 空态 / 加载 / 错误 */
.jlv-tree-hint, .jlv-tree-loading, .jlv-tree-error {
  color: var(--jlv-dim);
  padding: var(--jlv-space-5) var(--jlv-space-3);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--jlv-space-2);
  min-height: 120px;
}
.jlv-tree-hint { font-style: italic; opacity: .85; }
.jlv-tree-loading { font-style: italic; }
.jlv-tree-error { color: var(--jlv-error-fg); font-style: normal; word-break: break-all; text-align: center; }

/* 树行 */
.jlv-tree-row {
  position: relative;
  display: flex;
  align-items: baseline;
  gap: 2px;
  padding-left: var(--indent, 0px);
  border-radius: var(--jlv-radius-1);
  white-space: nowrap;
  min-height: 20px;
  cursor: pointer;
  transition: background var(--jlv-transition);
}
.jlv-tree-row > .jlv-tree-children { display: block; }
.jlv-tree-row:hover { background: var(--jlv-card-hover); }
.jlv-tree-row.selected {
  background: color-mix(in srgb, var(--jlv-selection) 45%, transparent);
  box-shadow: inset 2px 0 0 var(--vscode-focusBorder, #007fd4);
}
.jlv-tree-row .toggler {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  flex: none;
  color: var(--jlv-dim);
  cursor: pointer;
  border-radius: var(--jlv-radius-1);
  transition: color var(--jlv-transition), background var(--jlv-transition);
}
.jlv-tree-row .toggler:hover { color: var(--jlv-fg); background: var(--jlv-card-hover); }
.jlv-tree-row.collapsed .toggler { transform: rotate(-90deg); }
.jlv-tree-row .toggler svg { display: block; }
.jlv-tree-row .jlv-key { color: var(--jlv-key); flex: none; }
.jlv-tree-row .jlv-colon { color: var(--jlv-dim); margin-right: 4px; opacity: .7; }
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

/* 子节点缩进引导线 */
.jlv-tree-children {
  margin-left: 4px;
  padding-left: 4px;
  border-left: 1px solid var(--jlv-guide);
}

/* 大数组「加载更多」 */
.jlv-load-more {
  padding: 2px 0 2px 16px;
  color: var(--jlv-bool);
  cursor: pointer;
  font-size: var(--jlv-font-size-sm);
  user-select: none;
  border-radius: var(--jlv-radius-1);
}
.jlv-load-more:hover { text-decoration: underline; background: var(--jlv-card-hover); }

/* 加载指示环 */
.jlv-progress-ring {
  width: 14px;
  height: 14px;
  flex: none;
  border-radius: 50%;
  border: 2px solid var(--vscode-progressBar-background, #0e639c);
  border-top-color: transparent;
  animation: jlv-ring .8s linear infinite;
}
@keyframes jlv-ring { to { transform: rotate(360deg); } }

/* 屏幕较小时把详情占位收窄到底部下方 */
@media (max-width: 700px) {
  .jlv-body { flex-direction: column; }
  .jlv-detail { flex: 0 0 auto; border-top: 1px solid var(--jlv-border); max-height: 160px; }
  .jlv-scroll { flex: 1 1 0; border-right: none; }
}

/* ============================================================
 * 浮动面板（过滤 / 字段定制）
 * ============================================================ */
.jlv-panel {
  position: fixed;
  left: var(--jlv-space-2);
  z-index: 20;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--jlv-space-2);
  padding: var(--jlv-space-3);
  margin-top: var(--jlv-space-1);
  background: var(--jlv-panel-bg);
  border: 1px solid var(--jlv-border);
  border-radius: var(--jlv-radius-2);
  box-shadow: var(--jlv-shadow-2);
  font-size: var(--jlv-font-size-sm);
  color: var(--jlv-fg);
}
.jlv-ctrl-label { display: inline-flex; align-items: center; gap: 6px; color: var(--jlv-dim); white-space: nowrap; }
.jlv-panel input[type='text'],
.jlv-panel input.jlv-field { min-width: 120px; color-scheme: inherit; }

/* 字段定制行 */
.jlv-layout-list { display: flex; flex-direction: column; gap: var(--jlv-space-1); }
.jlv-layout-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  border-radius: var(--jlv-radius-1);
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
  font-family: var(--jlv-mono);
  font-size: var(--jlv-font-size-sm);
}
`;