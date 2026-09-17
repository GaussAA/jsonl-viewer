# Tasks

> 范围：纯视觉 / 排版层重构，跟随 VS Code 主题；不改协议、不改纯逻辑（`logic.ts` / `detailLogic.ts` / `queryLogic.ts`）、不改后端。每个任务完成需 `pnpm typecheck` 无类型错误。

- [x] Task 1: 设计 token 层与基础样式
  - [x] 在 `styles.ts` `:root` 引入派生自 `--vscode-*` 的 token：间距刻度 `--jlv-space-*`、圆角 `--jlv-radius-*`、字号 `--jlv-font-size-*`、过渡 `--jlv-ease*`、微阴影 `--jlv-shadow-*`、语义色（string/number/key/bool/null 复用现有）。
  - [x] 新增滚动条定制（`::-webkit-scrollbar`）、`:focus-visible` 焦点环、`*` 过渡最小化，以及 `@media (prefers-reduced-motion)` 关闭动画。
  - [x] 建立统一的行高/间距/圆角/阴影应用到各组件，形成一致的排版节奏。

- [x] Task 2: 顶栏分层与信息分组重构
  - [x] `toolbar.ts`：把「文件名+状态（主要行）」与「统计芯片 + 搜索 + 筛选/字段（信息/工具区）」重组为结构化的分组 DOM（引入 `.jlv-topbar__primary` / `.jlv-topbar__stats` 等类名）。
  - [x] 统计项改为图标化芯片（`.jlv-stat-chip`，含 总数 / 已解析 / 可见范围 / 打开耗时）。
  - [x] 搜索框升级：带清除按钮 + 命中计数胶囊（`.jlv-search-box`）；筛选/字段按钮强化 active 态。
  - [x] 保持对外接口（`update` / `setFields` / `setLayout` / `setSearchResult` / `searchInput`）签名不变，`webviewEntry.ts` 调用处不改协议。

- [x] Task 3: 左侧记录列表卡片重构
  - [x] `virtualScroll.ts` `fill()`：卡片改通行号左侧等宽导轨（`.jlv-card__lno`），字段行分 key 标签 + 值主体（`.jlv-kv__key` / `.jlv-kv__val`）。
  - [x] 依字段值附加语义徽标类（如字符串命中 active/pending/inactive 等附徽标着色；`virtualScroll.ts` 内新增轻量映射，不改 `logic.ts`）。
  - [x] `styles.ts`：卡片行号导轨、字段层级、选中（强调边框+底色）、悬停、错误卡（`.jlv-card.error`）、加载骨架（`.jlv-skeleton`）样式与过渡。
  - [x] 不动滚动 / 缓存 / 摘编译逻辑，仅改 DOM 标记与类名。

- [x] Task 4: 右侧 JSON 树 + 面包屑视觉强化
  - [x] `detailTree.ts`：树行加缩进层级数据（沿用 `--indent`），工具按钮保留功能但视觉图标化（内联 SVG），面包屑分段微调。
  - [x] `styles.ts`：树行缩进引导线（`.` / 子项虚线）、行进选中/悬停强调、类型配色微调、空态/加载态/错误态重做。
  - [x] 不动 `detailLogic.ts` 的树状态/路径逻辑，仅渲染标记与样式。

- [x] Task 5: 布局整合与细节
  - [x] `webviewEntry.ts`：横幅（`.jlv-banner`）与主体（`.jlv-body`）类名对齐新样式；布局 spacer/断点微调。
  - [x] `styles.ts`：横幅、启/停滚动条、`@media (max-width:700px)` 堆叠断点、整体间距/圆角/阴影统一收尾。

- [x] Task 6: 校验
  - [x] `pnpm typecheck` 通过。
  - [x] `pnpm test` 全绿（纯逻辑测试应完全不受视觉改动影响）。

# Task Dependencies
- Task 1 是所有样式任务的前置（token 先行）。
- Task 2/3/4 相互独立，可在 Task 1 后并行推进（同一 `styles.ts` 需注意合并，建议按上述顺序串行编辑或由单个子代理统一收尾）。
- Task 5 依赖 Task 2/3/4 的类名稳定。
- Task 6 依赖全部任务完成。