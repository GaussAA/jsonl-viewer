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
#app { display: flex; flex-direction: row; align-items: stretch; min-width: 0; position: relative; }
/* 以容器宽度为响应式基准（而非视口）：#app 作为 size container，
 * 下方所有窄/宽屏规则用 @container 查询，布局随 webview 面板实际可用宽度自适应
 * （并排双栏时左右面板各自独立缩放、不同尺寸的嵌入口也有相同的降级行为）。 */
#app { container-type: inline-size; }

/* 系统减弱动效：全部关闭 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}

/* 窄容器（宽度 < NARROW_BREAKPOINT_PX）：off-canvas 抽屉 —— 详情常驻为主视图；目录左栏收进左上角「汉堡菜单」，
 * 点开从左侧滑入为抽屉；选中记录后抽屉收起回到详情。
 * （窄屏 master–detail 的主流推荐模式，同 iOS 邮件 / Material 导航抽屉 / Bootstrap offcanvas。）
 * 容器查询：断点取 #app 容器宽度，而非视口。
 * ⚠️ CSS 无法引用 TS 常量，故 699/700 系硬编码 —— 必须与 constants.ts 的 NARROW_BREAKPOINT_PX（700）保持同步。 */
@container (max-width: 699px) {
  .jlv-resizer,
  .jlv-resizer__toggle,
  .jlv-col-list__expand { display: none !important; }    /* 隐藏分栏条与桌面折叠/展开按钮 */

  /* 汉堡菜单：仅窄容器显示（左上角，位于详情头部左侧） */
  .jlv-hamburger { display: inline-flex !important; }

  /* 详情铺满作为主视图（inset:0 + width:100% 覆盖基础 .jlv-col-detail{width:0}） */
  .jlv-col-detail {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    width: 100% !important;
    max-width: none;
    margin: 0;
    flex: none;
  }

  /* 目录 = 左侧抽屉：默认移出屏外（translateX(-100%)），开合滑入/滑出。
   * 必须给不透明背景（基样式是 transparent），否则会与下方被遮罩压暗的详情内容重叠、文字混杂。 */
  .jlv-col-list {
    position: absolute;
    top: 0; left: 0; bottom: 0;
    width: min(320px, 88vw) !important;
    max-width: none;
    margin: 0;
    flex: none;
    transform: translateX(-100%);
    z-index: 40;
    background: var(--jlv-panel-bg) !important;   /* 不透明面板底，覆盖下方详情（须 !important 压过基础 transparent） */
    border-right: 1px solid var(--jlv-border);
    transition: transform var(--jlv-dur-slow) var(--jlv-ease);
    box-shadow: var(--jlv-shadow-2);
  }
  #app.list-open .jlv-col-list { transform: translateX(0); }
}

/* 宽容器：隐藏汉堡菜单与抽屉遮罩（无论 JS 状态） */
@container (min-width: 700px) {
  .jlv-hamburger,
  .jlv-drawer-backdrop { display: none !important; }
}

/* 汉堡菜单按钮（默认隐藏，仅窄容器显示；图标为三横线） */
.jlv-hamburger {
  display: none;
  flex: none; width: 28px; height: 28px;
  align-items: center; justify-content: center;
  border-radius: 6px; border: 1px solid transparent; background: transparent;
  color: var(--jlv-dim); cursor: pointer;
  transition: background .12s, color .12s, border-color .12s;
}
.jlv-hamburger:hover { background: rgba(255,255,255,0.1); color: var(--jlv-fg); border-color: rgba(255,255,255,0.08); }
.jlv-hamburger svg { flex: none; }

/* 抽屉遮罩：打开时铺在详情之上、抽屉之下，点击可关闭 */
.jlv-drawer-backdrop {
  display: none;
  position: fixed; inset: 0;
  z-index: 35;
  background: rgba(0,0,0,0.45);
}
#app.list-open .jlv-drawer-backdrop { display: block; }

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
/* 收起/展开期间由 JS 注入 margin-right + opacity 过渡（内容宽度保持不变，右栏平滑跟随移动，且无 reflow 抖动） */

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
  transition: width var(--jlv-transition), flex-basis var(--jlv-transition), background var(--jlv-transition);
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

/* resizer 上的折叠按钮 */
.jlv-resizer__toggle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 16px; height: 28px;
  padding: 0;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.07);
  background: rgba(255,255,255,0.04);
  color: var(--jlv-dim);
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--jlv-transition), background var(--jlv-transition), color var(--jlv-transition), border-color var(--jlv-transition);
  z-index: 5;
}
.jlv-resizer:hover .jlv-resizer__toggle,
.jlv-resizer.active .jlv-resizer__toggle { opacity: 1; }
.jlv-resizer__toggle:hover { background: rgba(255,255,255,0.1); color: var(--jlv-fg); border-color: rgba(255,255,255,0.12); }
.jlv-resizer__toggle svg { flex: none; }

/* 左栏折叠态 */
.jlv-col-list.collapsed {
  flex-basis: 0 !important;
  width: 0 !important;
  min-width: 0 !important;
  padding-left: 0;
  padding-right: 0;
  overflow: hidden;
  gap: 0;
  opacity: 0;
  pointer-events: none;
}

/* 折叠后的展开按钮（悬浮在右栏左边缘） */
.jlv-col-list__expand {
  position: absolute;
  left: 0;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 22px; height: 48px;
  padding: 0;
  border-radius: 0 8px 8px 0;
  border: 1px solid rgba(255,255,255,0.07);
  border-left: none;
  background: rgba(255,255,255,0.04);
  color: var(--jlv-dim);
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer;
  z-index: 10;
  transition: background var(--jlv-transition), color var(--jlv-transition), border-color var(--jlv-transition);
}
.jlv-col-list__expand:hover { background: rgba(255,255,255,0.1); color: var(--jlv-fg); border-color: rgba(255,255,255,0.12); }
.jlv-col-list__expand svg { flex: none; }

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

/* 查询失败态：与「有结果」「0 匹配」在视觉上必须可分 ——
   失败是「这次没跑成功」，不是「文件里没有」，用户据此做的后续判断完全不同。 */
.jlv-search-count.error {
  color: var(--jlv-error, #f87171);
  font-weight: 600;
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
.jlv-replace-toggle.active { background: color-mix(in srgb, var(--jlv-focus) 22%, transparent); color: var(--jlv-info); }

/* 替换行（默认收起，点搜索框内的互换图标展开） */
.jlv-replace {
  display: flex; align-items: center; gap: 8px; margin-top: 6px;
  animation: jlv-reveal .16s ease both;
}
.jlv-replace-input {
  flex: 1; min-width: 0;
  background: rgba(0,0,0,0.35); border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px; padding: 8px 12px;
  color: var(--jlv-fg); font-size: 11px; font-family: inherit;
  transition: border-color .15s, box-shadow .15s;
}
.jlv-replace-input::placeholder { color: var(--jlv-dim); }
.jlv-replace-input:focus {
  outline: none; border-color: color-mix(in srgb, var(--jlv-focus) 60%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--jlv-focus) 18%, transparent);
}
.jlv-replace-input:disabled { opacity: .55; }
.jlv-replace-go { flex: none; }
.jlv-replace-go:disabled { opacity: .5; cursor: default; }

/* 展开动效：只动 opacity/transform，避免布局抖动 */
@keyframes jlv-reveal {
  from { opacity: 0; transform: translateY(-3px); }
  to   { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .jlv-replace { animation: none; }
  .jlv-selbar { animation: none; }
}

/* 选区操作条（列表下方；选中 > 1 行时出现） */
.jlv-selbar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  padding: 7px 10px; margin-top: 6px;
  background: color-mix(in srgb, var(--jlv-info) 12%, var(--jlv-panel-bg));
  border: 1px solid color-mix(in srgb, var(--jlv-info) 30%, transparent);
  border-radius: 8px;
  animation: jlv-reveal .16s ease both;
}
.jlv-selbar-text {
  flex: 1; min-width: 0;
  font-size: 11px; color: var(--jlv-info); font-family: var(--jlv-mono);
}
.jlv-selbar .jlv-btn { padding: 4px 10px; }
/* 破坏性操作（删除）：用错误色描边，与普通按钮一眼可分 */
.jlv-btn.jlv-btn-danger {
  color: var(--jlv-error-fg);
  border-color: color-mix(in srgb, var(--jlv-error-fg) 35%, transparent);
  background: color-mix(in srgb, var(--jlv-error-fg) 10%, transparent);
}
.jlv-btn.jlv-btn-danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--jlv-error-fg) 18%, transparent);
  color: var(--jlv-error-fg);
}
/* 多选时额外标出「详情正在展示这一行」：用 outline（不占布局、不与 .selected 的
 * box-shadow / ::before 左高亮条冲突） */
.jlv-record-card.current {
  outline: 1px solid color-mix(in srgb, var(--jlv-fg) 40%, transparent);
  outline-offset: 2px;
}

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
/* 选中：整张卡片背景变亮的高亮（实色蓝底 + 亮边框 + 左高亮条 + 外发光），保留语义配色并整体提亮 */
.jlv-record-card.selected {
  background: color-mix(in srgb, var(--jlv-info) 26%, var(--jlv-panel-bg));
  color: var(--jlv-fg);
  border: 1px solid var(--jlv-info);
  border-radius: 10px;
  border-left: 3px solid var(--jlv-info);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--jlv-info) 50%, transparent),
    0 0 18px color-mix(in srgb, var(--jlv-info) 42%, transparent);
}
/* 保留各 token 的语义色，但整体提亮，让选中项在亮蓝底上更醒目 */
.jlv-record-card.selected /* 详情内查找条（Ctrl+F）：只在需要时占据一条窄栏 */
.jlv-find {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--jlv-border, rgba(128, 128, 128, 0.18));
  background: var(--jlv-surface-2, rgba(128, 128, 128, 0.06));
}
.jlv-find-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid var(--jlv-border, rgba(128, 128, 128, 0.28));
  border-radius: 5px;
  background: var(--jlv-input-bg, transparent);
  color: inherit;
  font: inherit;
}
.jlv-find-count {
  flex: 0 0 auto;
  min-width: 42px;
  text-align: right;
  opacity: 0.72;
  font-variant-numeric: tabular-nums;
}
.jlv-find-btn {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  border: 1px solid var(--jlv-border, rgba(128, 128, 128, 0.28));
  border-radius: 5px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  line-height: 1;
}
.jlv-find-btn:hover {
  background: rgba(128, 128, 128, 0.16);
}
/* 当前跳到的命中：比其余命中更醒目（否则「3/17」看不出是在看哪一处） */
mark.jlv-hit.active {
  background: rgba(249, 115, 22, 0.55);
  outline: 1px solid rgba(249, 115, 22, 0.8);
}

/* 命中高亮：卡片预览与详情树共用同一个标记元素（.jlv-hit）。
   用半透明黄底 + 继承文字色 —— 纯色字（如亮黄）在浅底与深底上总有一边看不清。 */
.jlv-hit,
mark.jlv-hit {
  background: rgba(250, 204, 21, 0.32);
  color: inherit;
  border-radius: 2px;
  padding: 0 1px;
}
.jlv-record-card.selected .jlv-hit {
  background: rgba(250, 204, 21, 0.5);
}

.jlv-card-preview { color: #ffffff; filter: brightness(1.35); }
.jlv-record-card.selected .jlv-card-preview .str { color: var(--jlv-string); }
.jlv-record-card.selected .jlv-card-preview .num { color: var(--jlv-number); }
.jlv-record-card.selected .jlv-card-preview .bool { color: var(--jlv-bool); }
.jlv-record-card.selected .jlv-card-preview .key { color: var(--jlv-key); }
/* 类型徽章：提亮保留取色 */
.jlv-record-card.selected .jlv-type-badge { filter: brightness(1.3); }
.jlv-record-card.selected .jlv-type-badge.object { color: var(--jlv-good); }
.jlv-record-card.selected .jlv-type-badge.array { color: var(--jlv-warn); }
.jlv-record-card.selected .jlv-type-badge.string { color: var(--jlv-info); }
.jlv-record-card.selected .jlv-type-badge.error { color: var(--jlv-bad); }
.jlv-record-card.selected .jlv-type-badge.number { color: var(--jlv-number); }
/* 选中：左高亮条生长 */
.jlv-record-card.selected::before {
  content: '';
  position: absolute; left: -1px; top: 20%; bottom: 20%; width: 3px;
  background: var(--jlv-info);
  border-radius: 0 3px 3px 0;
  transform-origin: center;
  animation: jlv-bar-grow var(--jlv-dur-base) var(--jlv-ease);
}
.jlv-record-card.error { background: color-mix(in srgb, var(--jlv-bad) 6%, transparent); border-color: color-mix(in srgb, var(--jlv-bad) 18%, transparent); }

.jlv-card-head { display: flex; align-items: center; gap: 7px; margin-bottom: 5px; }
.jlv-line-badge { font-family: var(--jlv-mono); font-size: 10px; font-weight: 600; color: var(--jlv-dim); }
.jlv-record-card.selected .jlv-line-badge {
  color: #ffffff;
  background: color-mix(in srgb, var(--jlv-info) 36%, var(--jlv-panel-bg));
  padding: 1px 7px; border-radius: 4px;
}
.jlv-type-badge { font-size: 9px; padding: 1px 6px; border-radius: 4px; font-family: var(--jlv-mono); }
.jlv-type-badge.object { background: color-mix(in srgb, var(--jlv-good) 15%, transparent); color: var(--jlv-good); }
.jlv-type-badge.array { background: color-mix(in srgb, var(--jlv-warn) 15%, transparent); color: var(--jlv-warn); }
.jlv-type-badge.string { background: color-mix(in srgb, var(--jlv-info) 15%, transparent); color: var(--jlv-info); }
.jlv-type-badge.error { background: color-mix(in srgb, var(--jlv-bad) 15%, transparent); color: var(--jlv-bad); }
.jlv-type-badge.number { background: color-mix(in srgb, var(--jlv-number) 15%, transparent); color: var(--jlv-number); }
.jlv-type-badge.boolean { background: color-mix(in srgb, var(--jlv-info) 15%, transparent); color: var(--jlv-info); }
.jlv-type-badge.null { background: color-mix(in srgb, var(--jlv-muted) 15%, transparent); color: var(--jlv-muted); }
.jlv-type-badge.truncated { background: color-mix(in srgb, var(--jlv-warn) 22%, transparent); color: var(--jlv-warn); border: 1px dashed color-mix(in srgb, var(--jlv-warn) 55%, transparent); }

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
/* 展开/折叠切换按钮的高亮态（展开中） */
.jlv-dh-tool.active {
  background: color-mix(in srgb, var(--jlv-focus) 26%, transparent);
  border-color: color-mix(in srgb, var(--jlv-focus) 55%, transparent);
  color: var(--jlv-info);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--jlv-focus) 25%, transparent);
}
.jlv-dh-tool:disabled { opacity: .32; cursor: default; }

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

/* 筛选面板（F3 多条件）：比通用浮层宽一档 —— 一行要放下「非 + 字段 + 运算符 + 值 + 删除」。
   max-width 只是上限，内容少的面板不会被撑开。 */
.jlv-panel-filter { max-width: 460px; }
.jlv-cond-group {
  display: flex; align-items: center; gap: 6px; margin-bottom: 8px; opacity: 0.9;
}
.jlv-cond-group select { flex: 1 1 auto; min-width: 0; }
.jlv-cond-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.jlv-cond-row { display: flex; align-items: center; gap: 6px; }
.jlv-cond-row select,
.jlv-cond-row input[type='text'] {
  flex: 1 1 0; min-width: 56px;
  padding: 3px 6px; border-radius: 5px;
  border: 1px solid var(--jlv-border, rgba(128,128,128,0.28));
  background: transparent; color: inherit; font: inherit;
}
.jlv-cond-neg {
  flex: 0 0 auto; display: inline-flex; align-items: center; gap: 2px;
  cursor: pointer; user-select: none;
}
.jlv-cond-del {
  flex: 0 0 auto; width: 22px; height: 22px; line-height: 1;
  border: 1px solid var(--jlv-border, rgba(128,128,128,0.28));
  border-radius: 5px; background: transparent; color: inherit; cursor: pointer;
}
.jlv-cond-del:hover { background: rgba(128,128,128,0.16); }
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

/* ---------------- 行编辑浮层（editPanel.ts） ----------------
 * 全屏遮罩 + 居中卡片。弹出沿用设计体系 §3.6 浮层语义（缩放 + 上浮 180ms），
 * 关闭走快速淡出 120ms；编辑区用等宽字体，聚焦蓝色描边与搜索框一致。
 * [hidden] 由全局规则处理，此处不再重复声明。 */
.jlv-edit-backdrop {
  position: fixed; inset: 0; z-index: 80;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, .45);
  opacity: 0;
  transition: opacity var(--jlv-dur-fast) ease-in;
}
.jlv-edit-backdrop.open { opacity: 1; }

.jlv-edit-panel {
  display: flex; flex-direction: column; gap: 10px;
  width: min(680px, 100%); max-height: 100%;
  padding: 16px;
  background: var(--jlv-panel-bg);
  border: 1px solid rgba(255, 255, 255, .1);
  border-radius: var(--jlv-radius-4);
  box-shadow: var(--jlv-shadow-2);
  color: var(--jlv-fg); font-size: var(--jlv-font-size-sm);
  transform: scale(.96) translateY(6px);
  opacity: 0;
  transition: transform var(--jlv-dur-base) var(--jlv-ease), opacity var(--jlv-dur-base) var(--jlv-ease);
}
.jlv-edit-panel.open { transform: none; opacity: 1; }

/* 会话编辑历史浮层（结构复刻编辑浮层，仅列表部分不同） */
.jlv-hist-backdrop {
  position: fixed; inset: 0; z-index: 80;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, .45);
  opacity: 0;
  transition: opacity var(--jlv-dur-fast) ease-in;
}
.jlv-hist-backdrop.open { opacity: 1; }
.jlv-hist {
  display: flex; flex-direction: column; gap: 10px;
  width: min(560px, 100%); max-height: 100%;
  padding: 16px;
  background: var(--jlv-panel-bg);
  border: 1px solid rgba(255, 255, 255, .1);
  border-radius: var(--jlv-radius-4);
  box-shadow: var(--jlv-shadow-2);
  color: var(--jlv-fg); font-size: var(--jlv-font-size-sm);
  transform: scale(.96) translateY(6px); opacity: 0;
  transition: transform var(--jlv-dur-base) var(--jlv-ease), opacity var(--jlv-dur-base) var(--jlv-ease);
}
.jlv-hist.open { transform: none; opacity: 1; }
.jlv-edit-head-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }

.jlv-hist-list {
  display: flex; flex-direction: column; gap: 2px;
  overflow-y: auto; min-height: 60px; max-height: 46vh;
  padding-right: 2px;
}
.jlv-hist-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px;
  background: transparent; border: none; border-radius: 6px;
  color: var(--jlv-fg); font-family: inherit; font-size: var(--jlv-font-size-sm);
  text-align: left; cursor: pointer;
  transition: background var(--jlv-transition);
}
.jlv-hist-row:hover { background: var(--jlv-card-hover); }
/* 已撤销的条目：降低存在感但仍可点击（点它即「停在这一步」= 重做到该条） */
.jlv-hist-row.undone { opacity: .45; }
.jlv-hist-row.undone .jlv-hist-label { text-decoration: line-through; }
.jlv-hist-badge {
  flex: none; min-width: 34px; text-align: center;
  padding: 1px 6px; border-radius: var(--jlv-radius-full);
  font-size: 9px; font-family: var(--jlv-mono);
  background: color-mix(in srgb, var(--jlv-info) 16%, transparent);
  color: var(--jlv-info);
}
.jlv-hist-badge.kind-delete,
.jlv-hist-badge.kind-deleteMany {
  background: color-mix(in srgb, var(--jlv-error-fg) 14%, transparent);
  color: var(--jlv-error-fg);
}
.jlv-hist-badge.kind-insert {
  background: color-mix(in srgb, var(--jlv-good) 16%, transparent);
  color: var(--jlv-good);
}
.jlv-hist-label {
  flex: 1 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.jlv-hist-meta { flex: none; font-size: 9px; font-family: var(--jlv-mono); color: var(--jlv-dim); }
.jlv-hist-note { font-size: 10px; color: var(--jlv-warn); padding: 4px 2px; }
.jlv-hist-empty {
  padding: 18px 8px; text-align: center;
  color: var(--jlv-dim); font-size: var(--jlv-font-size-sm);
}
@media (max-width: 700px) {
  .jlv-hist-backdrop { padding: 12px; }
}

/* ---------------------------- 坏行诊断 ---------------------------- */
/* 徽章：工具栏状态行里的坏行计数（无坏行时整体隐藏）。 */
.jlv-bad-chip {
  margin-left: 4px; padding: 0 6px;
  background: color-mix(in srgb, var(--jlv-warn) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--jlv-warn) 30%, transparent);
  border-radius: var(--jlv-radius-full);
  color: var(--jlv-warn);
  font-family: inherit; font-size: 10px; line-height: 16px;
  cursor: pointer;
  transition: background var(--jlv-transition);
}
.jlv-bad-chip:hover { background: color-mix(in srgb, var(--jlv-warn) 26%, transparent); }
/* 未做过全文件扫描：虚线边框提示「这是下界，不是确数」 */
.jlv-bad-chip.partial { border-style: dashed; }

.jlv-bad-backdrop {
  position: fixed; inset: 0; z-index: 80;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, .45);
  opacity: 0;
  transition: opacity var(--jlv-dur-fast) ease-in;
}
.jlv-bad-backdrop.open { opacity: 1; }
.jlv-bad {
  display: flex; flex-direction: column; gap: 10px;
  width: min(480px, 100%); max-height: 100%;
  padding: 16px;
  background: var(--jlv-panel-bg);
  border: 1px solid rgba(255, 255, 255, .1);
  border-radius: var(--jlv-radius-4);
  box-shadow: var(--jlv-shadow-2);
  color: var(--jlv-fg); font-size: var(--jlv-font-size-sm);
  transform: scale(.96) translateY(6px); opacity: 0;
  transition: transform var(--jlv-dur-base) var(--jlv-ease), opacity var(--jlv-dur-base) var(--jlv-ease);
}
.jlv-bad.open { transform: none; opacity: 1; }

.jlv-bad-status {
  padding: 0 2px;
  font-size: 10px; font-family: var(--jlv-mono);
  color: var(--jlv-dim);
}
/* 语义提示（「这不是全量结论」）：必须显眼，否则用户会据一个偏小的数字下结论 */
.jlv-bad-note { padding: 4px 2px; font-size: 10px; color: var(--jlv-warn); }

.jlv-bad-list {
  display: flex; flex-direction: column; gap: 2px;
  overflow-y: auto; min-height: 60px; max-height: 46vh;
  padding-right: 2px;
}
.jlv-bad-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px;
  background: transparent; border: none; border-radius: 6px;
  color: var(--jlv-fg); font-family: inherit; font-size: var(--jlv-font-size-sm);
  text-align: left; cursor: pointer;
  transition: background var(--jlv-transition);
}
.jlv-bad-row:hover { background: var(--jlv-card-hover); }
.jlv-bad-lno { font-family: var(--jlv-mono); }
.jlv-bad-hint {
  margin-left: auto;
  font-size: 9px; color: var(--jlv-info);
  opacity: 0;
  transition: opacity var(--jlv-transition);
}
.jlv-bad-row:hover .jlv-bad-hint { opacity: 1; }
.jlv-bad-empty {
  padding: 18px 8px; text-align: center;
  color: var(--jlv-dim); font-size: var(--jlv-font-size-sm);
}
@media (max-width: 700px) {
  .jlv-bad-backdrop { padding: 12px; }
}

/* ---------------------------- 字段级编辑 ---------------------------- */
/* 树行上的编辑入口：平时隐形，行悬停/按钮聚焦时显形（否则整棵树布满图标） */
.jlv-field-edit {
  flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; margin-left: 6px;
  padding: 0;
  background: transparent; border: none; border-radius: 4px;
  color: var(--jlv-dim);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--jlv-transition), background var(--jlv-transition), color var(--jlv-transition);
}
.jlv-field-edit svg { width: 10px; height: 10px; }
.jlv-tree-row:hover .jlv-field-edit { opacity: 1; }
/* 键盘用户：聚焦即显形（按钮始终在 tab 序列中，故键盘可达） */
.jlv-field-edit:focus-visible { opacity: 1; outline: 1px solid var(--jlv-focus); }
.jlv-field-edit:hover { background: rgba(255, 255, 255, .08); color: var(--jlv-fg); }

.jlv-field-backdrop {
  position: fixed; inset: 0; z-index: 85;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, .45);
  opacity: 0;
  transition: opacity var(--jlv-dur-fast) ease-in;
}
.jlv-field-backdrop.open { opacity: 1; }
.jlv-field {
  display: flex; flex-direction: column; gap: 10px;
  width: min(460px, 100%); max-height: 100%;
  padding: 16px;
  background: var(--jlv-panel-bg);
  border: 1px solid rgba(255, 255, 255, .1);
  border-radius: var(--jlv-radius-4);
  box-shadow: var(--jlv-shadow-2);
  color: var(--jlv-fg); font-size: var(--jlv-font-size-sm);
  transform: scale(.96) translateY(6px); opacity: 0;
  transition: transform var(--jlv-dur-base) var(--jlv-ease), opacity var(--jlv-dur-base) var(--jlv-ease);
}
.jlv-field.open { transform: none; opacity: 1; }
/* 原值提示：确认「改的是哪个字段的什么值」，长值换行而非撑破面板 */
.jlv-field-meta {
  padding: 6px 8px;
  background: rgba(255, 255, 255, .04);
  border-radius: 6px;
  font-size: 10px; font-family: var(--jlv-mono);
  color: var(--jlv-dim);
  overflow-wrap: anywhere;
}
.jlv-field-body { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.jlv-field-input {
  width: 100%; box-sizing: border-box;
  padding: 8px 10px;
  background: rgba(0, 0, 0, .25);
  border: 1px solid rgba(255, 255, 255, .12);
  border-radius: 6px;
  color: var(--jlv-fg);
  font-family: var(--jlv-mono); font-size: var(--jlv-font-size-sm);
  resize: vertical;
}
.jlv-field-input:focus { outline: none; border-color: var(--jlv-focus); }
.jlv-field-error { padding: 4px 2px; font-size: 10px; color: var(--jlv-error-fg); }
.jlv-field-actions { display: flex; justify-content: flex-end; }
.jlv-field-save {
  background: color-mix(in srgb, var(--jlv-focus) 20%, transparent);
  border-color: color-mix(in srgb, var(--jlv-focus) 35%, transparent);
  color: var(--jlv-info);
}
.jlv-value.inline-editable { cursor: text; }
.jlv-value.editing { min-width: 80px; }
.jlv-value.editing .jlv-inline-edit {
  width: 100%; min-width: 120px;
  font: inherit; color: inherit;
  background: var(--jlv-bg);
  border: 1px solid var(--jlv-focus);
  border-radius: 3px;
  padding: 1px 4px;
  outline: none;
}
.jlv-value.error .jlv-inline-edit { border-color: var(--jlv-error); }

.jlv-field-bool { display: flex; gap: 8px; }
.jlv-field-applyall {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 2px;
  font-size: 10px; color: var(--jlv-dim);
  cursor: pointer;
  user-select: none;
}
.jlv-field-applyall:hover { color: var(--jlv-fg); }
.jlv-field-applyall input { accent-color: var(--jlv-focus); margin: 0; }
@media (max-width: 700px) {
  .jlv-field-backdrop { padding: 12px; }
}

.jlv-edit-head { display: flex; align-items: center; gap: 8px; }
.jlv-edit-title { font-size: var(--jlv-font-size-md); font-weight: 600; }
.jlv-edit-close {
  margin-left: auto; width: 22px; height: 22px; border-radius: 5px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(255, 255, 255, .04); border: none; cursor: pointer;
  color: var(--jlv-dim); font-size: 14px;
}
.jlv-edit-close:hover { background: rgba(255, 255, 255, .1); color: var(--jlv-fg); }

.jlv-edit-hint {
  padding: 8px 10px; border-radius: var(--jlv-radius-2); line-height: 1.5;
  background: rgba(255, 255, 255, .03);
  border: 1px solid rgba(255, 255, 255, .07);
  color: var(--jlv-dim);
}
.jlv-edit-hint.warn {
  background: color-mix(in srgb, var(--jlv-warn) 12%, transparent);
  border-color: color-mix(in srgb, var(--jlv-warn) 35%, transparent);
  color: var(--jlv-warn);
}

.jlv-edit-input {
  flex: 1; min-height: 160px; resize: vertical;
  padding: 10px;
  background: rgba(0, 0, 0, .35);
  border: 1px solid rgba(255, 255, 255, .1);
  border-radius: var(--jlv-radius-2);
  color: var(--jlv-fg);
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: var(--jlv-font-size-sm); line-height: 1.6; tab-size: 2;
  transition: border-color .12s, box-shadow .12s;
}
.jlv-edit-input:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--jlv-focus) 50%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--jlv-focus) 15%, transparent);
}

.jlv-edit-error {
  padding: 8px 10px; border-radius: var(--jlv-radius-2);
  white-space: pre-wrap; line-height: 1.5;
  background: color-mix(in srgb, var(--vscode-errorForeground, #f48771) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--vscode-errorForeground, #f48771) 35%, transparent);
  color: var(--vscode-errorForeground, #f48771);
}

.jlv-edit-foot { display: flex; align-items: center; gap: 8px; }
.jlv-edit-spacer { flex: 1; }
.jlv-edit-btn {
  padding: 7px 14px; border-radius: var(--jlv-radius-2);
  border: 1px solid rgba(255, 255, 255, .1);
  background: rgba(255, 255, 255, .04); color: var(--jlv-fg);
  font-size: var(--jlv-font-size-sm); font-family: inherit; cursor: pointer;
  transition: background .12s, transform .12s var(--jlv-ease);
}
.jlv-edit-btn:hover:not(:disabled) { background: rgba(255, 255, 255, .08); }
.jlv-edit-btn:active:not(:disabled) { transform: translateY(1px); }
.jlv-edit-btn:disabled { opacity: .55; cursor: default; }
.jlv-edit-btn.jlv-edit-primary {
  background: color-mix(in srgb, var(--jlv-focus) 20%, transparent);
  border-color: color-mix(in srgb, var(--jlv-focus) 35%, transparent);
  color: var(--jlv-info);
}

/* 窄容器（与其余响应式规则一致，以 #app 容器宽度为基准） */
@container (max-width: 700px) {
  .jlv-edit-backdrop { padding: 12px; }
  .jlv-edit-input { min-height: 120px; }
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
