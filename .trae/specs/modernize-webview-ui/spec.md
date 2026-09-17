# JSONL Viewer 前端界面现代化重构 Spec

## Why
当前 webview 前端（`#app` 内以程序化 DOM 组装）：顶栏把文件名 + 4 项统计 + 搜索 + 筛选/字段 + 状态挤在单行且依赖 `flex-wrap` 兜底，信息不分组、视觉密度失衡；左侧记录列表是扁平「key: value」卡片，选中态仅为单一背景色，无状态语义色彩、无分层、缺行为动效；右侧 JSON 树功能完整但视觉平淡（无缩进引导线、无悬停/选中反馈、空态与加载态简陋）。整体虽「能用」但缺乏现代产品形态的排版节奏、层级与设计感，实际体验有提升空间。

经用户确认：本次仅做**视觉与排版层面的全面重构**，保持现有数据结构、交互逻辑与 RPC 协议不变；配色继续**跟随 VS Code 主题**（`--vscode-*` 变量，不写死色值）。

## What Changes
- 建立一套**设计 token 层**（间距刻度、圆角、字号层级、过渡/缓动、微高程阴影），统一植入手写 CSS，全部以 `--vscode-*` 变量派生。
- **顶栏分层重构**：将「文件名 / 状态」与「统计 / 工具」拆分为清晰分组；统计改为图标化芯片（chip）；搜索框升级为带清除按钮与命中计数的搜索条；筛选/字段按钮强化 active 态。
- **左侧记录列表卡片重构**：行号改为左侧等宽导轨（rail）；字段行做视觉主次层级；按字段值附加语义徽标着色；强化选中态（强调边框 + 底色）、悬停态、错误行、加载骨架。
- **右侧 JSON 树 + 面包屑美化**：工具按钮图标化；树行加缩进引导线、悬停/选中强调、类型配色微调；空态/加载态/错误态重做。
- **布局与细节**：沿用「左窄列表 + 右 JSON 树」master-detail；横幅、响应式断点、滚动条、焦点环、`prefers-reduced-motion` 尊重等统一定稿。
- 纯前端 CSS + 少量 DOM 结构/类名调整；**不改协议、不改行为函数、不改后端**。

## Impact
- Affected specs:
  - Task 5/6 摘要卡片与详情树（`queryLogic` / `detailLogic` 纯逻辑层不变，仅消费其输出的 DOM 展示层重做）。
  - Task 7 文件变更横幅（仅样式）。
- Affected code:
  - `src/webview/styles.ts`（主要，设计 token + 全部组件样式）
  - `src/webview/topbar → toolbar.ts`（顶栏 DOM 结构与类名；接口签名尽量兼容）
  - `src/webview/virtualScroll.ts`（卡片 DOM 标记，`fill()` 内摘要渲染；不动作何滚动/缓存逻辑）
  - `src/webview/detailTree.ts`（树行与工具 DOM 标记；不动作何树状态逻辑）
  - `src/webview/webviewEntry.ts`（布局组装、横幅类名；不动作何调用逻辑）
- Not changed: `logic.ts` / `detailLogic.ts` / `queryLogic.ts` / `rpc.ts` / `../protocol/*` / host 侧全部文件。

## ADDED Requirements

### Requirement: 统一设计 token 层
系统 SHALL 在 `styles.ts` 顶部提供一套派生自 `--vscode-*` 的设计 token（间距刻度 `--jlv-space-*`、圆角 `--jlv-radius-*`、字号 `--jlv-font-size-*`、过渡 `--jlv-ease`、微阴影 `--jlv-shadow-*`），并为所有组件样式建立一致的排版节奏与视觉层级，深浅主题自适应、无写死色值。

#### Scenario: 深浅主题下视觉一致
- **WHEN** 用户在浅色/深色 VS Code 主题间切换
- **THEN** webview 整体配色随 `--vscode-*` 自动适配，文字/边框/背景对比度清晰，无刺眼固定色。

### Requirement: 顶栏分层与信息分组
系统 SHALL 将顶栏重构成清晰分层的结构：主要行（文件名 + 状态 + 搜索）+ 信息/工具区以图标化芯片与分组呈现，减少 `flex-wrap` 依赖，层级分明。

#### Scenario: 大文件下的顶栏
- **WHEN** 打开 1 万行文件，窗口中等宽度
- **THEN** 顶栏信息按组呈现不拥挤，搜索可及、结果计数可见，文件名/统计不互相覆盖。

### Requirement: 记录列表卡片现代化
系统 SHALL 重构左侧卡片：行号左侧等宽导轨、字段行主次层级、按字段值语义徽标着色、明确的选中/悬停/加载/错误态与过渡反馈。

#### Scenario: 选中与状态识别
- **WHEN** 用户用鼠标划过某卡片再点击选中
- **THEN** 悬停有轻微抬升/点缀，选中态有强调边框 + 底色，且状态类字段（如 active/pending/inactive）有语义色徽标，一眼可辨。

### Requirement: JSON 树与面包屑视觉强化
系统 SHALL 强化右侧详情面板：树行缩进引导线、悬停/选中强调、类型配色微调、工具按钮图标化、重做空态/加载态/错误态，并让路径面包屑更可读。

#### Scenario: 深层嵌套导航
- **WHEN** 打开含多层 `meta` 嵌套的记录并沿面包屑点击
- **THEN** 树行有清晰缩进引导线逐级对齐，当前节点高亮，面包屑各段 hover 可点、层级可辨。

## MODIFIED Requirements

### Requirement: 主题跟随（保留/强化）
沿用并强化「全变量 `--vscode-*`、不写死色值、自动跟随主题」的既有约束；本次新增的设计 token 也一律由此派生。`@media (max-width:700px)` 的详情收窄断点保留并微调。

#### Scenario: 窄窗口
- **WHEN** webview 宽度 < 700px
- **THEN** 列表与详情纵向堆叠（列表在上），详情高度受限可滚动，行为与现状一致。

## REMOVED Requirements
（无被移除的功能性需求；仅存量视觉样式整体被新设计替换。）

**Reason**: 纯视觉重构，无功能删除。
**Migration**: 无。