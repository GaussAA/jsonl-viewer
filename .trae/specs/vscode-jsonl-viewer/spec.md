# VSCode JSONL Viewer Spec

## Why
VS Code 原生编辑器无法高效查看 JSONL：大文件打开卡顿、深层嵌套 JSON 无法用平铺表格展示、缺少数行/字段搜索与校验。需要一个 VS Code 插件，将 JSONL 以「记录列表 + 可折叠 JSON 树详情」的方式清晰呈现，且**多 GB 级文件也能秒级打开、低内存占用流畅滚动**。

## What Changes
- 新增一个 VS Code 扩展，注册对 `.jsonl`（以及可选的 `.ndjson`、`.jsonlines`）文件的激活。
- 通过自定义文档（Custom Editor / Webview）提供 UI：
  - **记录列表面板**：虚拟滚动，仅渲染可视行；每条记录一条卡片，显示可定制的摘要字段。
  - **JSON 树详情面板**：点击记录以可折叠树展示完整 JSON，适配深层嵌套，支持展开/折叠、路径面包屑、语法高亮。
  - **顶部工具栏**：文件概要（总行数/已解析行）、搜索（跳转/过滤）、字段过滤器、字段显示定制（列显隐/固定）。
  - **校验与报错定位**：解析失败的行标记为错误，可一键跳转到源文件对应行。
- **性能架构（核心）**：
  - **行偏移索引（Lazy Index）**：打开时仅做一次快速顺序扫描，建立「行号 → 文件字节偏移」索引，不做整文件解析。
  - **按需惰性解析**：只解析当前可见/聚焦的记录；通过偏移二分定位任意行。
  - **字段推断抽样**：只取前 N 行（如 200 行）推断常用字段/类型，用于摘要卡片与字段定制，不扫描全部。
  - 虚拟滚动 + 记录对象对象池，保证仅渲染可视区。
- 打包使用 esbuild 压缩、tree-shaking，最小化 webview bundle 体积。

## Impact
- Affected specs: 无既有能力，全新扩展。
- Affected code:
  - `src/extension.ts` — 扩展入口，命令与事件注册。
  - `src/indexer/lineIndex.ts` — 行偏移索引构建与二分定位。
  - `src/parser/jsonParser.ts` — 按需 JSON 解析与校验。
  - `src/infer/inferFields.ts` — 抽样字段推断。
  - `src/webview/*` — webview 前端（列表、树、工具栏、虚拟滚动）。
  - `package.json` — 扩展清单、激活事件、contributes。
  - `build.mjs` / tsconfig — esbuild 打包配置。
- **BREAKING**: 全新项目，无历史兼容负担。

## ADDED Requirements

### Requirement: 大文件秒级打开与低资源占用
系统 SHALL 在多 GB 级 JSONL 文件上做到秒级打开、滚动流畅、内存占用与可视区成正比（而非与文件总行数成正比）。

#### Scenario: 打开大文件
- **GIVEN** 一个数 GB、数十万行的 `.jsonl` 文件
- **WHEN** 用户在 VS Code 中打开它
- **THEN** 在数秒内显示界面（行号/概要立即可用），且滚动时无明显卡顿、内存不随总行数线性增长

#### Scenario: 行偏移索引
- **WHEN** 文件首次打开
- **THEN** 系统仅执行一次流式顺序扫描生成「行号→偏移」索引，不整文件载入内存

#### Scenario: 按需解析
- **WHEN** 用户滚动到某一行或点击某条记录
- **THEN** 系统只解析并渲染该可见/聚焦记录，其余记录不占用内存

### Requirement: 记录列表 + JSON 树详情的展示形态
系统 SHALL 提供适配深层嵌套 JSON 的展示：列表卡片 + 可折叠 JSON 树详情。

#### Scenario: 查看嵌套记录
- **GIVEN** 一条含多层级嵌套数组/对象的 JSONL 记录
- **WHEN** 用户在列表中选中它
- **THEN** 详情面板以可折叠树完整展示其嵌套结构，支持逐层展开、全部展开/折叠、路径显示

#### Scenario: 摘要卡片
- **WHEN** 列表渲染每条记录
- **THEN** 每条记录以摘要卡片展示（由字段定制决定的显式字段），深层值用省略/可展开处理

### Requirement: 字段筛选与搜索
系统 SHALL 提供全文/字段级搜索、字段值过滤与跳转。

#### Scenario: 搜索跳转
- **WHEN** 用户输入搜索词
- **THEN** 系统在已解析范围内查找匹配行并高亮/跳转，支持按字段限定

#### Scenario: 字段过滤
- **WHEN** 用户按某字段设置过滤条件
- **THEN** 列表仅展示满足条件的记录

### Requirement: JSON 校验与报错定位
系统 SHALL 校验每行 JSON 合法性，并对解析失败的行提供定位与说明。

#### Scenario: 坏行标记与定位
- **GIVEN** 文件中有解析失败的行
- **WHEN** 用户在插件中查看
- **THEN** 该行被标记为错误并显示错误信息，用户可一键跳转到源文件对应行号

### Requirement: 列/字段显示定制
系统 SHALL 允许用户控制摘要面板中显示哪些字段及其顺序、可见性。

#### Scenario: 字段显隐
- **WHEN** 用户打开字段定制面板
- **THEN** 用户可勾选显示/隐藏字段、调整顺序、将某字段固定，并持久化其偏好

### Requirement: 语法与交互（开发与文档）
系统 SHALL 提供清晰的代码结构与构建流程。

#### Scenario: 构建与开发
- **WHEN** 开发者运行 `pnpm install` 与 `pnpm compile`/`pnpm build`
- **THEN** 能生成可加载到 VS Code 进行扩展宿主调试的产物