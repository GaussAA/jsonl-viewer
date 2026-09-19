/**
 * styles.ts — webview 注入的 CSS 文本。
 *
 * 按交互原型（prototype.html）最终设计 **1:1 复刻**，全部以 VS Code 主题变量
 * （--vscode-*）表达配色（半透明白 + 主题派生色），自动跟随主题。
 * 结构遵循原型：左栏浮卡工具栏 + 卡片目录 + 两行分页；右栏大卡片头部 + JSON 树。
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
  --jlv-focus: var(--vscode-focusBorder, #007fd4);

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
  --jlv-key-dim: var(--vscode-charts-yellow, #c8a86a);

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
  --jlv-radius-4: 12px;
  --jlv-radius-full: 999px;

  /* 字号层级 */
  --jlv-font-size-xs: 11px;
  --jlv-font-size-sm: 12px;
  --jlv-font-size-md: 13px;

  /* 动效（设计体系 §1.1） */
  --jlv-ease: cubic-bezier(0.16, 1, 0.3, 1);
  --jlv-transition: 140ms var(--jlv-ease);
  --jlv-dur-fast: 120ms;
  --jlv-dur-base: 180ms;
  --jlv-dur-slow: 280ms;

  /* 阴影 */
  --jlv-shadow-1: 0 1px 3px rgba(0, 0, 0, .22);
  --jlv-shadow-2: 0 12px 40px rgba(0, 0, 0, .5), 0 2px 8px rgba(0, 0, 0, .3);
}

/* ---------------- 动效 keyframes（原型一致） ---------------- */
@keyframes jlv-card-in { from { opacity: 0; transform: translateX(42px); } to { opacity: 1; transform: translateX(0); } }
@keyframes jlv-bar-grow { from { transform: scaleY(.4); opacity: .5; } to { transform: scaleY(1); opacity: 1; } }
@keyframes jlv-pop-in { from { opacity: 0; transform: translateY(4px) scale(.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes jlv-pop-out { from { opacity: 1; transform: translateY(0) scale(1); } to { opacity: 0; transform: translateY(3px) scale(.97); } }
@keyframes jlv-row-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }
@keyframes jlv-copy-pulse { 0% { transform: scale(.8); } 60% { transform: scale(1.15); } 100% { transform: scale(1); } }
@keyframes jlv-badge-pop { from { transform: scale(.92); opacity: .5; } to { transform: scale(1); opacity: 1; } }
@keyframes jlv-ring { to { transform: rotate(360deg); } }

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #app { height: 100%; overflow: hidden; }
html, body { width: 100%; }
#app { width: 100%; }
[hidden] { display: none !important; }
body {
  display: flex;
  font-family: var(--jlv-font);
  font-size: var(--jlv-font-size-md);
  color: var(--jlv-fg);
  background: var(--jlv-bg);
}
#app { display: flex; flex-direction: row; align-items: stretch; min-width: 0; }

/* 系统减弱动效：全部关闭 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}

/* 窄屏（<700px）：左右栏纵向堆叠 */
@media (max-width: 699px) {
  body { flex-direction: column; overflow: auto; }
  #app { flex-direction: column; }
  .jlv-col-list { width: 100% !important; flex: none; }
  .jlv-col-detail { min-height: 400px; }
}

/* 焦点可见环 */
:focus-visible { outline: 2px solid var(--jlv-focus); outline-offset: -1px; }

/* ============================================================
 * 左栏（原型 .col-list）
 * ============================================================ */
.jlv-col-list {
  flex: 0 0 auto;
  width: 340px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 12px 10px 14px;
  background: transparent;
  overflow: hidden;
}

/* 可拖拽分栏条（无硬分隔线：默认透明，hover 才显示拖拽指示） */
.jlv-resizer {
  flex: 0 0 5px;
  width: 5px;
  min-width: 5px;
  cursor: col-resize;
  position: relative;
  touch-action: none;
  user-select: none;
  background: transparent;
}
.jlv-resizer::after {
  content: '';
  position: absolute;
  top: 0; bottom: 0;
  left: 2px;
  width: 1px;
  background: transparent;
  transition: left var(--jlv-transition), width var(--jlv-transition), background var(--jlv-transition);
}
.jlv-resizer:hover::after,
.jlv-resizer.active::after { left: 1px; width: 3px; background: var(--jlv-focus); }

/* ---------------- 工具栏浮卡（原型 .toolbar） ---------------- */
.jlv-toolbar {
  background: linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.01));
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: var(--jlv-radius-4);
  padding: 14px;
  flex-shrink: 0;
}
.jlv-toolbar-header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.jlv-toolbar-icon {
  width: 26px; height: 26px; border-radius: 7px;
  background: linear-gradient(135deg, var(--jlv-key), var(--jlv-key-dim));
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; color: #1a1a1e; flex-shrink: 0;
}
.jlv-toolbar-title { flex: 1; min-width: 0; }
.jlv-filename {
  font-size: 13px; font-weight: 600; color: var(--jlv-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.jlv-sub {
  font-size: 10px; color: var(--jlv-dim);
  display: flex; align-items: center; gap: 5px; margin-top: 2px;
}
.jlv-dot-ok { width: 5px; height: 5px; border-radius: 50%; background: var(--jlv-good); }

/* 搜索框（原型 .search） */
.jlv-search {
  background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px; padding: 8px 12px;
  display: flex; align-items: center; gap: 8px;
  transition: border-color .15s, box-shadow .15s;
}
.jlv-search:focus-within { border-color: color-mix(in srgb, var(--jlv-focus) 60%, transparent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--jlv-focus) 18%, transparent); }
.jlv-search .jlv-search-ic { display: inline-flex; align-items: center; color: var(--jlv-dim); flex: none; }
.jlv-search input {
  flex: 1; min-width: 0; border: none; background: transparent; outline: none;
  color: var(--jlv-fg); font-size: 11px; font-family: inherit;
}
.jlv-search input::placeholder { color: var(--jlv-dim); }
.jlv-search-kbd {
  font-size: 9px; background: color-mix(in srgb, var(--jlv-info) 20%, transparent);
  color: var(--jlv-info); padding: 2px 6px; border-radius: 4px; font-family: var(--jlv-mono);
}
.jlv-search-clear {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; flex: none;
  border: none; background: transparent; color: var(--jlv-dim);
  border-radius: 50%; cursor: pointer;
  transition: background var(--jlv-transition), color var(--jlv-transition);
}
.jlv-search-clear:hover { background: var(--jlv-card-hover); color: var(--jlv-fg); }
.jlv-search-count {
  flex: none; padding: 1px 7px; border-radius: var(--jlv-radius-full);
  font-size: 9px; font-family: var(--jlv-mono);
  color: var(--jlv-info); background: color-mix(in srgb, var(--jlv-info) 15%, transparent);
}
.jlv-nav-btn {
  flex: none; width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; border-radius: 6px; background: rgba(255,255,255,0.04);
  color: var(--jlv-dim); font-family: inherit; font-size: 11px; cursor: pointer;
  transition: background var(--jlv-transition), color var(--jlv-transition);
}
.jlv-nav-btn:hover:not(:disabled) { background: rgba(255,255,255,0.08); color: var(--jlv-fg); }
.jlv-nav-btn:disabled { opacity: .3; cursor: default; }

/* 按钮行（原型 .toolbar-actions / .btn）——宽度自适应文本 */
.jlv-toolbar-actions { display: flex; align-items: center; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
.jlv-filter-note {
  display: block; margin-top: 8px; font-size: 11px;
  color: color-mix(in srgb, var(--jlv-warn) 90%, var(--jlv-fg));
  background: color-mix(in srgb, var(--jlv-warn) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--jlv-warn) 25%, transparent);
  border-radius: 6px; padding: 4px 8px;
}
.jlv-btn {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; color: var(--jlv-dim); padding: 5px 12px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.07);
  border-radius: 6px; cursor: pointer; font-family: inherit;
  width: auto; flex: none;
  transition: background .12s, border-color .12s, color .12s, transform .12s var(--jlv-ease);
}
.jlv-btn:hover { background: rgba(255,255,255,0.07); color: var(--jlv-fg); }
.jlv-btn:active { transform: translateY(1px); }
.jlv-btn.active {
  background: color-mix(in srgb, var(--jlv-focus) 20%, transparent);
  border-color: color-mix(in srgb, var(--jlv-focus) 40%, transparent);
  color: var(--jlv-info);
}
.jlv-btn .jlv-btn-ic { display: inline-flex; align-items: center; }
.jlv-page-info {
  font-size: 10px; color: var(--jlv-dim);
  padding: 5px 10px; background: rgba(128,128,128,0.08);
  border-radius: 6px; font-family: var(--jlv-mono); margin-left: auto;
}

/* ---------------- 目录列表（原型 .list-wrap） ---------------- */
.jlv-list-wrap {
  flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
  display: flex; flex-direction: column; gap: 6px;
  padding: 2px 6px 2px 0;
}

/* 记录卡片（原型 .record-card） */
.jlv-record-card {
  background: rgba(255,255,255,0.018);
  border: 1px solid rgba(255,255,255,0.05);
  border-left: 3px solid transparent;
  border-radius: 10px;
  padding: 10px 12px;
  cursor: pointer;
  position: relative;
  transition: background .15s, border-color .15s, border-left-color .15s, transform .1s;
}
.jlv-record-card.jlv-card-enter { animation: jlv-card-in var(--jlv-dur-slow) var(--jlv-ease) backwards; }
.jlv-record-card.jlv-card-leaving {
  transform: translateX(-36px);
  opacity: 0;
  transition: transform .16s var(--jlv-ease), opacity .16s var(--jlv-ease);
}
.jlv-record-card:hover { background: rgba(255,255,255,0.032); border-color: rgba(255,255,255,0.09); transform: translateX(1px); }
/* 选中：主题标准高亮（亮蓝底 + 白字 + 左高亮条），非"高暗" */
.jlv-record-card.selected {
  background: var(--jlv-selection);
  color: var(--jlv-selection-fg);
  border: 1px solid color-mix(in srgb, var(--jlv-selection-fg) 22%, transparent);
  border-left: 3px solid var(--jlv-focus);
}
.jlv-record-card.selected .jlv-card-preview { color: var(--jlv-selection-fg); opacity: .88; }
.jlv-record-card.selected .jlv-card-preview .key,
.jlv-record-card.selected .jlv-card-preview .str,
.jlv-record-card.selected .jlv-card-preview .num,
.jlv-record-card.selected .jlv-card-preview .bool { color: var(--jlv-selection-fg); opacity: .9; }
.jlv-record-card.selected .jlv-type-badge { color: var(--jlv-selection-fg); background: color-mix(in srgb, var(--jlv-selection-fg) 18%, transparent); }
/* 选中：左高亮条生长 */
.jlv-record-card.selected::before {
  content: '';
  position: absolute; left: -1px; top: 20%; bottom: 20%; width: 3px;
  background: var(--jlv-focus);
  border-radius: 0 3px 3px 0;
  transform-origin: center;
  animation: jlv-bar-grow var(--jlv-dur-base) var(--jlv-ease);
}
.jlv-record-card.error { background: color-mix(in srgb, var(--jlv-bad) 6%, transparent); border-color: color-mix(in srgb, var(--jlv-bad) 18%, transparent); }

.jlv-card-head { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
.jlv-line-badge { font-family: var(--jlv-mono); font-size: 10px; font-weight: 600; color: var(--jlv-dim); }
.jlv-record-card.selected .jlv-line-badge {
  color: var(--jlv-selection-fg);
  background: color-mix(in srgb, var(--jlv-selection-fg) 18%, transparent);
  padding: 1px 7px; border-radius: 4px;
}
.jlv-type-badge { font-size: 9px; padding: 1px 6px; border-radius: 4px; font-family: var(--jlv-mono); }
.jlv-type-badge.object { background: color-mix(in srgb, var(--jlv-good) 15%, transparent); color: var(--jlv-good); }
.jlv-type-badge.array { background: color-mix(in srgb, var(--jlv-warn) 15%, transparent); color: var(--jlv-warn); }
.jlv-type-badge.string { background: color-mix(in srgb, var(--jlv-info) 15%, transparent); color: var(--jlv-info); }
.jlv-type-badge.error { background: color-mix(in srgb, var(--jlv-bad) 15%, transparent); color: var(--jlv-bad); }
.jlv-type-badge.number { background: color-mix(in srgb, var(--jlv-number) 15%, transparent); color: var(--jlv-number); }

.jlv-card-preview {
  font-size: 10px; font-family: var(--jlv-mono); color: var(--jlv-dim);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.5;
}
.jlv-record-card.selected .jlv-card-preview { color: var(--jlv-selection-fg); }
.jlv-card-preview .str { color: var(--jlv-string); }
.jlv-card-preview .num { color: var(--jlv-number); }
.jlv-card-preview .bool { color: var(--jlv-bool); }
.jlv-card-preview .key { color: var(--jlv-key-dim); }
.jlv-card-preview.error-text { color: var(--jlv-bad); white-space: normal; }

/* 悬停复制行号按钮 */
.jlv-card-line__copy {
  margin-left: auto;
  flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px;
  border: none; background: transparent; color: var(--jlv-dim);
  border-radius: var(--jlv-radius-1); cursor: pointer;
  opacity: 0;
  transition: opacity var(--jlv-transition), background var(--jlv-transition), color var(--jlv-transition);
}
.jlv-record-card:hover .jlv-card-line__copy,
.jlv-record-card.selected .jlv-card-line__copy { opacity: .75; }
.jlv-card-line__copy:hover { opacity: 1; color: var(--jlv-fg); background: var(--jlv-card-hover); }
.jlv-card-line__copy.copied { opacity: 1; color: var(--jlv-good); }

/* 空态 */
.jlv-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: var(--jlv-space-1); padding: var(--jlv-space-6) var(--jlv-space-3);
  color: var(--jlv-dim); text-align: center;
}
.jlv-empty__icon { color: var(--jlv-dim); opacity: .85; margin-bottom: var(--jlv-space-2); }
.jlv-empty__text { font-size: var(--jlv-font-size-sm); color: var(--jlv-fg); font-weight: 600; }
.jlv-empty__sub { font-size: var(--jlv-font-size-xs); color: var(--jlv-dim); font-style: italic; margin-bottom: var(--jlv-space-1); }
.jlv-empty__action { margin-top: var(--jlv-space-2); }

/* ---------------- 分页条（原型 .pager 两行） ---------------- */
.jlv-pager {
  display: flex; flex-direction: column; gap: 6px;
  padding: 8px; margin-left: 6px;
  font-size: 10px; color: var(--jlv-dim); flex-shrink: 0;
  background: rgba(255,255,255,0.018);
  border: 1px solid rgba(255,255,255,0.05);
  border-radius: 10px;
}
.jlv-pager-nav { display: flex; align-items: center; gap: 1px; flex-wrap: wrap; }
.jlv-pager-btn {
  width: 26px; height: 22px; padding: 0;
  background: rgba(255,255,255,0.04); border: none; border-radius: 5px; cursor: pointer;
  color: var(--jlv-dim); font-family: inherit; font-size: 11px; font-weight: 500;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background .1s, color .1s, border-color .1s;
  flex-shrink: 0;
}
.jlv-pager-btn:hover:not(:disabled):not(.active) { background: rgba(255,255,255,0.09); color: var(--jlv-fg); }
.jlv-pager-btn:active:not(:disabled):not(.active) { background: rgba(255,255,255,0.13); }
.jlv-pager-btn:disabled { opacity: .25; cursor: default; }
.jlv-pager-btn.active {
  background: color-mix(in srgb, var(--jlv-focus) 25%, transparent);
  color: var(--jlv-info); font-weight: 600;
}
.jlv-pager-btn.jlv-pager-navbtn { width: 20px; color: var(--jlv-dim); font-size: 12px; }
.jlv-pager-ellipsis { width: 20px; text-align: center; color: var(--jlv-dim); opacity: .5; font-size: 11px; flex-shrink: 0; user-select: none; }
.jlv-pager-side { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.jlv-pager-summary { font-family: var(--jlv-mono); white-space: nowrap; color: var(--jlv-dim); }
.jlv-pager-input-wrap { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: var(--jlv-dim); white-space: nowrap; }
.jlv-pager-input {
  width: 34px; height: 22px; padding: 0; text-align: center;
  background: rgba(0,0,0,0.3);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 4px; color: var(--jlv-fg);
  font-family: var(--jlv-mono); font-size: 11px;
  -moz-appearance: textfield;
}
.jlv-pager-input::-webkit-outer-spin-button,
.jlv-pager-input::-webkit-inner-spin-button { -webkit-appearance: none; appearance: none; margin: 0; }
.jlv-pager-input:focus {
  outline: none; border-color: color-mix(in srgb, var(--jlv-focus) 50%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--jlv-focus) 15%, transparent);
}

/* ============================================================
 * 右栏（原型 .col-detail / .detail-card）
 * ============================================================ */
.jlv-col-detail {
  flex: 1 1 0;
  min-width: 0;
  width: 0;                     /* 与 flex:1 配套：强制从 0 开始分配宽度，不随内容膨胀 */
  max-width: 100%;
  background: var(--jlv-bg);
  padding: 14px 14px 10px 10px;
  display: flex; flex-direction: column; overflow: hidden;
}
.jlv-detail-card {
  flex: 1; min-height: 0; min-width: 0;
  max-width: 100%;
  background: rgba(255,255,255,0.022); border: 1px solid rgba(255,255,255,0.05);
  border-radius: var(--jlv-radius-4); overflow: hidden;
  display: flex; flex-direction: column;
}

/* 卡片头部（原型 .detail-header） */
.jlv-detail-header {
  background: rgba(0,0,0,0.28);
  padding: 12px 16px;
  display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0; gap: 8px;
}
.jlv-dh-left { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; overflow: hidden; }
.jlv-dh-line {
  display: inline-block;
  font-family: var(--jlv-mono); font-size: 11px; font-weight: 700;
  color: var(--jlv-info); background: color-mix(in srgb, var(--jlv-info) 15%, transparent);
  padding: 3px 9px; border-radius: 5px; flex-shrink: 0;
}
.jlv-dh-line.pop { animation: jlv-badge-pop var(--jlv-dur-base) var(--jlv-ease); }
.jlv-dh-src { font-family: var(--jlv-mono); font-size: 10px; color: var(--jlv-dim); flex-shrink: 0; }
.jlv-dh-divider { color: var(--jlv-dim); opacity: .4; flex-shrink: 0; }
.jlv-dh-crumb {
  font-family: var(--jlv-mono); font-size: 11px; color: var(--jlv-dim);
  display: flex; align-items: center; gap: 3px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.jlv-crumb-seg {
  color: var(--jlv-key-dim); cursor: pointer; padding: 1px 5px; border-radius: 3px;
  border: none; background: transparent; font-family: inherit; font-size: 11px;
  transition: background .12s;
}
.jlv-crumb-seg:hover { background: rgba(255,255,255,0.06); }
.jlv-crumb-seg.current { color: var(--jlv-info); background: color-mix(in srgb, var(--jlv-info) 15%, transparent); }
.jlv-crumb-sep { opacity: .35; color: var(--jlv-dim); }
.jlv-dh-tools { display: flex; gap: 4px; flex-shrink: 0; }
.jlv-dh-tool {
  width: 28px; height: 28px;
  background: rgba(255,255,255,0.05); border: 1px solid transparent; border-radius: 6px;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  color: var(--jlv-dim); font-size: 11px; font-family: inherit; padding: 0;
  transition: background .12s, color .12s, border-color .12s, transform .12s var(--jlv-ease);
}
.jlv-dh-tool:hover { background: rgba(255,255,255,0.1); color: var(--jlv-fg); border-color: rgba(255,255,255,0.08); }
.jlv-dh-tool:active { transform: scale(.95); }
.jlv-dh-tool.copy-pulse { animation: jlv-copy-pulse var(--jlv-dur-base) var(--jlv-ease); }

/* 展开层级下拉（自绘） */
.jlv-depth { position: relative; display: inline-flex; flex: none; }
.jlv-depth__trigger {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 0 7px; height: 28px;
  font-family: inherit; font-size: 11px; color: var(--jlv-dim);
  background: rgba(255,255,255,0.05); border: 1px solid transparent; border-radius: 6px;
  cursor: pointer;
  transition: border-color var(--jlv-transition), background var(--jlv-transition), color var(--jlv-transition);
}
.jlv-depth__trigger:hover { background: rgba(255,255,255,0.1); color: var(--jlv-fg); border-color: rgba(255,255,255,0.08); }
.jlv-depth__trigger svg { color: var(--jlv-dim); transition: transform var(--jlv-transition); }
.jlv-depth.open .jlv-depth__trigger svg { transform: rotate(180deg); }
.jlv-depth__menu {
  position: absolute; top: calc(100% + 4px); right: 0; z-index: 30;
  min-width: 100%; padding: 3px;
  background: var(--jlv-panel-bg);
  border: 1px solid var(--jlv-border);
  border-radius: var(--jlv-radius-2);
  box-shadow: var(--jlv-shadow-2);
  display: flex; flex-direction: column;
}
.jlv-depth__item {
  display: flex; align-items: center; gap: 6px; padding: 4px 10px;
  border: none; border-radius: var(--jlv-radius-1); background: transparent;
  color: var(--jlv-fg); font-family: inherit; font-size: var(--jlv-font-size-sm);
  text-align: left; cursor: pointer; white-space: nowrap;
  transition: background var(--jlv-transition);
}
.jlv-depth__item:hover { background: var(--jlv-card-hover); }
.jlv-depth__item.selected { background: var(--jlv-selection); color: var(--jlv-selection-fg); font-weight: 600; }

/* ---------------- JSON 树（原型 .tree-body） ---------------- */
.jlv-tree-body {
  flex: 1; min-height: 0; min-width: 0; max-width: 100%;
  padding: 16px 20px 20px;
  overflow-y: auto;
  overflow-x: hidden;
  font-family: var(--jlv-mono); font-size: 13px; line-height: 1.8;
  box-sizing: border-box;
}
/* 树节点容器（作为 flex 子项必须 min-width:0 否则会撑破父级宽度约束） */
.jlv-tree-node { min-width: 0; max-width: 100%; box-sizing: border-box; }

/* 切换记录：字段逐条出现（舒缓错峰） */
.jlv-tree-body.animating .jlv-tree-row { animation: jlv-row-in 420ms var(--jlv-ease) backwards; }
.jlv-tree-row {
  display: flex; align-items: flex-start; gap: 4px;
  padding: 2px 6px; border-radius: 5px;
  cursor: pointer; min-width: 0; width: 100%; box-sizing: border-box;
  transition: background .1s;
}
.jlv-tree-row:hover { background: rgba(255,255,255,0.04); }
.jlv-tree-row.selected { background: color-mix(in srgb, var(--jlv-focus) 10%, transparent); }
/* Toggler：SVG chevron 旋转 */
.jlv-tree-row .toggler {
  width: 14px; height: 14px; color: var(--jlv-dim); flex: 0 0 14px;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 0; border-radius: 3px; margin-top: 1px;
  transition: color .12s;
}
.jlv-tree-row:hover .toggler { color: var(--jlv-fg); }
.jlv-tree-row .toggler svg { transition: transform 150ms var(--jlv-ease); transform: rotate(0deg); }
/* 未展开朝右 ▶（默认 0°），已展开朝下 ▼（90°） */
.jlv-tree-row.expanded .toggler svg { transform: rotate(90deg); }
.jlv-tree-row .jlv-key {
  color: var(--jlv-key); flex: 0 1 auto; min-width: 0;
  font-weight: 600;
  white-space: normal; overflow-wrap: anywhere;
}
.jlv-tree-row .jlv-colon {
  color: var(--jlv-dim); opacity: .65; font-size: 12px;
  flex: 0 0 auto; min-width: 0;
}
.jlv-tree-row .jlv-value {
  font-size: 12.5px;
  flex: 1 1 0; min-width: 0;
  white-space: normal; overflow-wrap: anywhere;
}
.jlv-tree-row .jlv-value.str { color: var(--jlv-string); }
.jlv-tree-row .jlv-value.num { color: var(--jlv-number); }
.jlv-tree-row .jlv-value.bool { color: var(--jlv-bool); }
.jlv-tree-row .jlv-value.null { color: var(--jlv-null); font-style: italic; }
.jlv-tree-row .jlv-value.obj { color: var(--jlv-container); }
.jlv-tree-row .jlv-summary { font-style: italic; }
.jlv-tree-row .jlv-key.jlv-index { color: var(--jlv-number); opacity: .8; }

/* 子树块：抽屉动画（JS 内联控制高度） */
.jlv-tree-block { overflow: hidden; min-width: 0; max-width: 100%; box-sizing: border-box; }
.jlv-tree-block-inner {
  min-width: 0; max-width: 100%; box-sizing: border-box;
  margin-left: 14px;
  padding-left: 10px;
  border-left: 1px solid rgba(255,255,255,0.06);
  overflow: hidden;
}
.jlv-load-more {
  padding: 2px 0 2px 16px;
  color: var(--jlv-bool); cursor: pointer;
  font-size: var(--jlv-font-size-sm); user-select: none;
  border-radius: var(--jlv-radius-1);
}
.jlv-load-more:hover { text-decoration: underline; background: var(--jlv-card-hover); }

/* 空态 / 加载 / 错误 */
.jlv-tree-hint, .jlv-tree-loading, .jlv-tree-error {
  color: var(--jlv-dim); padding: var(--jlv-space-5) var(--jlv-space-3);
  display: flex; align-items: center; justify-content: center; gap: var(--jlv-space-2);
  min-height: 120px;
}
.jlv-tree-hint { font-style: italic; opacity: .85; }
.jlv-tree-loading { font-style: italic; }
.jlv-tree-error { color: var(--jlv-error-fg); font-style: normal; word-break: break-all; text-align: center; }
.jlv-progress-ring {
  width: 14px; height: 14px; flex: none;
  border-radius: 50%; border: 2px solid var(--vscode-progressBar-background, #0e639c);
  border-top-color: transparent; animation: jlv-ring .8s linear infinite;
}

/* ============================================================
 * 浮层面板（筛选 / 字段定制）——原型 .float-panel
 * ============================================================ */
.jlv-float-panel {
  position: fixed; z-index: 50;
  background: var(--jlv-panel-bg); border: 1px solid rgba(255,255,255,0.1);
  border-radius: var(--jlv-radius-4);
  box-shadow: var(--jlv-shadow-2);
  padding: 16px; min-width: 280px; max-width: 360px;
  font-size: 12px; color: var(--jlv-fg);
  transform-origin: top left;
  animation: jlv-pop-in var(--jlv-dur-base) var(--jlv-ease);
}
.jlv-float-panel.closing { animation: jlv-pop-out var(--jlv-dur-fast) ease-in forwards; }
.jlv-float-panel h3 {
  font-size: 13px; font-weight: 600; color: var(--jlv-fg);
  margin-bottom: 12px; display: flex; align-items: center; gap: 8px;
}
.jlv-float-panel h3 .jlv-panel-close {
  margin-left: auto; width: 22px; height: 22px; border-radius: 5px;
  background: rgba(255,255,255,0.04); border: none; cursor: pointer;
  color: var(--jlv-dim); font-size: 14px; display: flex; align-items: center; justify-content: center;
}
.jlv-float-panel h3 .jlv-panel-close:hover { background: rgba(255,255,255,0.1); color: var(--jlv-fg); }
.jlv-float-panel label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--jlv-dim); margin-bottom: 10px; width: 100%; }
/* 字段面板头部的横向标签（"展示字段数 [输入]"）不受纵向规则影响 */
.jlv-float-panel label.jlv-ctrl-label { flex-direction: row; align-items: center; gap: 8px; width: auto; margin-bottom: 0; }
.jlv-float-panel label.jlv-field-item { flex-direction: row; align-items: center; gap: 10px; margin-bottom: 0; width: 100%; }
.jlv-float-panel select, .jlv-float-panel input[type="text"], .jlv-float-panel input[type="number"] {
  width: 100%;
  background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 6px; padding: 6px 10px; color: var(--jlv-fg); font-size: 12px; font-family: inherit;
  color-scheme: inherit;
  transition: border-color .12s, box-shadow .12s;
}
/* 字段面板头部：展示字段数 + 恢复默认 */
.jlv-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.jlv-float-panel select {
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='6'><path d='M0 0l5 6 5-6z' fill='%23555'/></svg>");
  background-repeat: no-repeat; background-position: right 8px center;
  appearance: none; -webkit-appearance: none; cursor: pointer;
  padding-right: 28px;
}
.jlv-float-panel select:focus, .jlv-float-panel input:focus {
  outline: none; border-color: color-mix(in srgb, var(--jlv-focus) 50%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--jlv-focus) 15%, transparent);
}
.jlv-float-panel select option { background: var(--jlv-panel-bg); color: var(--jlv-fg); }
.jlv-float-panel select option:checked { background: color-mix(in srgb, var(--jlv-focus) 25%, transparent); color: var(--jlv-info); }
.jlv-panel-actions { display: flex; gap: 6px; margin-top: 14px; }
.jlv-btn-panel {
  flex: 1; padding: 7px 12px; font-size: 12px; border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.1);
  background: rgba(255,255,255,0.04); color: var(--jlv-fg);
  cursor: pointer; font-family: inherit;
  transition: background .12s;
}
.jlv-btn-panel:hover { background: rgba(255,255,255,0.08); }
.jlv-btn-panel.primary {
  background: color-mix(in srgb, var(--jlv-focus) 20%, transparent);
  border-color: color-mix(in srgb, var(--jlv-focus) 35%, transparent);
  color: var(--jlv-info);
}
.jlv-btn-panel.primary:hover { background: color-mix(in srgb, var(--jlv-focus) 30%, transparent); }

/* 字段定制列表 */
.jlv-layout-list { display: flex; flex-direction: column; gap: 4px; max-height: 300px; overflow-y: auto; margin-bottom: 8px; }
.jlv-layout-row {
  display: flex; align-items: center; gap: 10px; padding: 7px 10px;
  border-radius: 6px; cursor: pointer;
  transition: background .1s;
}
.jlv-layout-row:hover { background: var(--jlv-card-hover); }
.jlv-layout-row .jlv-layout-name {
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--jlv-key); font-family: var(--jlv-mono); font-size: var(--jlv-font-size-sm);
}
.jlv-layout-row input[type="checkbox"] { flex-shrink: 0; accent-color: var(--jlv-focus); }
.jlv-layout-row .jlv-tbtn { padding: 2px 6px; font-size: 11px; }
.jlv-ctrl-label { display: inline-flex; align-items: center; gap: 6px; color: var(--jlv-dim); white-space: nowrap; }

/* ============================================================
 * 文件变更 / 错误横幅（右上角浮层）
 * ============================================================ */
.jlv-banner {
  position: fixed; top: var(--jlv-space-3); right: var(--jlv-space-3); z-index: 30;
  max-width: min(420px, calc(100vw - 24px));
  display: flex; align-items: flex-start; gap: var(--jlv-space-2);
  padding: var(--jlv-space-2) var(--jlv-space-3);
  background: var(--jlv-panel-bg);
  border: 1px solid color-mix(in srgb, var(--jlv-warn) 40%, var(--jlv-border));
  box-shadow: var(--jlv-shadow-2);
  border-radius: var(--jlv-radius-2);
  color: var(--jlv-fg); font-size: var(--jlv-font-size-sm);
}
.jlv-banner::before {
  content: ''; width: 9px; height: 9px; border-radius: 50%;
  background: var(--jlv-warn); flex: none; margin-top: 3px;
}
.jlv-banner-text { flex: 1 1 auto; min-width: 0; overflow: hidden; line-height: 1.4; word-break: break-word; }
.jlv-banner-action { white-space: nowrap; align-self: center; }

/* ============================================================
 * 目录右键菜单
 * ============================================================ */
.jlv-ctx {
  position: fixed; z-index: 40; min-width: 150px;
  display: flex; flex-direction: column; gap: 2px; padding: 4px;
  background: var(--jlv-panel-bg); border: 1px solid var(--jlv-border);
  border-radius: var(--jlv-radius-2); box-shadow: var(--jlv-shadow-2);
  font-size: var(--jlv-font-size-sm); color: var(--jlv-fg);
}
.jlv-ctx-item {
  display: flex; align-items: center; width: 100%;
  padding: 5px 10px; text-align: left;
  border: none; border-radius: var(--jlv-radius-1); background: transparent;
  color: inherit; font-family: inherit; font-size: var(--jlv-font-size-sm); cursor: pointer;
  transition: background var(--jlv-transition);
}
.jlv-ctx-item:hover { background: var(--jlv-card-hover); }
.jlv-ctx-sep { height: 1px; background: var(--jlv-border); margin: 3px 4px; }
`;
