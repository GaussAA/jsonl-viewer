# JSONL Viewer

面向大文件的 VS Code 扩展：以「记录列表 + 可折叠 JSON 树详情」的方式打开 `.jsonl` / `.ndjson` / `.jsonlines` 文件。为**多 GB 级**大文件设计，打开秒级、滚动流畅、内存与可视区成正比。

- 语言：TypeScript
- 打包：esbuild（扩展主进程 CJS + webview IIFE）
- 测试：`node --test`（Node 原生 test runner，类型擦除运行，**构造函数不用参数属性语法**）

## 相关文档

- **[设计体系规范](docs/DESIGN_SYSTEM.md)**：前端（webview）的唯一设计契约——设计令牌、组件规范、动效规范、架构与适配约束、新增功能检查清单。任何前端改动先读它，保证实现与设计不偏移、整体风格可持续一致。

## 功能特性

- **高吞吐打开**：流式扫描建行偏移索引，多 GB 文件秒开（只扫一遍、单字节切行）。
- **按需惰性解析**：任意行用随机的「字节区间」读回并单行 JSON 解析，绝不整文件载入。
- **分页式记录目录**：固定每页 20 条卡片，窗口式页码跳转；DOM 节点数恒为 O(每页)，与总行数无关。
- **JSON 树详情**：可折叠、全部展开/折叠、展开到第 N 层、路径面包屑、大数组分段预览。
- **搜索 / 过滤 / 字段定制**：全文/字段搜索、字段值过滤、字段显隐/排序/固定，偏好持久化。
- **坏行定位**：非法行红标，一键跳转到源文件对应行。
- **稳定与可打断**：请求可真正中断（CancelToken）、请求超时、文件变更检测 + 「重新加载」、结果数组封顶（防内存失控）。

## 界面说明

- **列表（左）**：每张卡片展示行号 + 字段摘要（依据字段推断与你的显示定制）；坏行红标并显示错误。
- **详情树（右）**：选中某行后按需拉取并展示该行完整 JSON：可折叠树、面包屑导航、大数组「加载更多」。
- **工具栏（顶）**：文件名 / 总行数 / 已解析行数 / 当前可见范围 / 打开耗时 + 状态指示灯；含搜索、筛选、字段定制入口。
- **错误横幅**：文件被更改 / 删除或发生错误时，顶部出现提示与「重新加载」按钮，点击即重建索引。

## 性能设计

1. **行偏移索引（`LineIndex`）**：一次流式扫描得到 `行号 → 字节偏移` 扁平升序数组，任意行 O(log n) 二分定位。
   - 内存只与**行数**成正比（约 8B/行），与文件字节数无关。
   - 说明：数 GB 文件行通常较大（KB~MB），行数适中，偏移数组开销可接受（例：5GB、2KB/行 ≈ 250 万行 ≈ 20MB）。
2. **按需惰性解析（`jsonParser`）**：给定行号，从索引取 `[start,end)` 区间做一次随机读 + 单行解析；逐行读回成本与可视区成正比。
3. **分页式目录（`virtualScroll`）**：固定每页 20 条，滚动/翻页只按需拉取可视窗口（节流 + 合并调度，滚动再快也只发 1~2 个读批请求）；过滤态下按命中行分段拉取，稀疏匹配不拉横跨大文件的连续区间。
4. **可中断执行**：搜索/过滤/读批逐行检查宿主 CancelToken，被取消立即停（不占 CPU），并用 requestId 校验丢弃迟到响应，杜绝 UI 污染。
5. **内存有界**：列表 LRU 缓存容量上限、详情树大数组分段、搜索/过滤结果行号数组封顶（各 5 万，超出标记 truncated）。

### 性能验证要点

`src/perf/__tests__/bigFilePerf.test.ts` 会在本地写一个**中等规模** JSONL 临时文件（默认 6 万行 × 约 0.5KB ≈ 30MB）来验证打开耗时 / 内存 / 随机访问正确性，并输出指标：

```
[perf/JSONL] lines=60000 bytes=29.7MB buildMs=74.5 idxRows=60000 idxBytes≈469KB heapΔ=1.6MB
```

- **打开耗时**随文件大小线性；30MB 构建 ~75ms，等价量级下 GB 级在亚秒到数秒（受磁盘 IO 影响）。把环境变量 `JSONL_PERF_LINES` 调到 5_000_000（约 2.5GB）可做多 GB 延展测量，方法论一致。
- **随机访问正确性**：对多个伪随机关口做 `readBatch` 并逐字段校验，保证任意行可精确读回。
- **滚动窗口内存有界**：偏移数组只随行数增长（idxBytes≈行数×8B）；进程堆增量远小于文件体积。

## 安装与开发

```bash
# 1) 安装依赖
pnpm install

# 2) 日常一次性编译（非 minify，产出 sourcemap，便于 F5 调试）
pnpm compile        # 等价 node build.mjs

# 3) 倒模式编译（监视 src 变更）
pnpm watch

# 4) 生产打包（minify + tree-shake）
pnpm build          # 等价 node build.mjs --minify

# 5) 类型检查
pnpm typecheck      # 等价 tsc --noEmit

# 6) 测试（Node 原生 test runner）
pnpm test           # node --test "src/**/*.test.ts"
```

### F5 调试

项目自带 `.vscode/launch.json`（`Run Extension`，`preLaunchTask: compile`）与 `.vscode/tasks.json`。按 **F5** 即在新的「扩展开发宿主」中打开一个带本扩展的 VS Code 实例；打开任意 `.jsonl` 文件即进入 JSONL Viewer 界面。

- 非 minify 构建会输出 `dist/**/*.js.map`，断点可映射回 TypeScript 源码。
- `.vscodeignore` 已排除 `src/**`、`*.map`、`*.ts` 等发布冗余，仅保留 `dist/extension.js` 与 `dist/webview.js`。

## 打包体积（minify）

> 数值随功能演进变化，以 `pnpm build` 后 `dist/` 实际体积为准（约 20–90 KB 量级）。

| 产物 | 体积 |
| --- | --- |
| `dist/extension.js`（扩展主进程） | ~20 KB 量级 |
| `dist/webview.js`（webview 前端） | ~80 KB 量级 |

## 已知限制

- **超大单行**：超过 `maxLineBytes`（默认 16MiB）的单行会以「坏行 + 友好提示」呈现，不会崩溃；但不适合在该行内部做树展示。
- **深搜 / 深过滤**：结果行号数组有 5 万上限，超限以 `truncated` 标记，仅提示「未列尽」；全量续取需按范围查询。
- **文件热更新**：通过轮询 stat（约 5s）检测文件大小 / 修改时间变化，并给出「重新加载」；检测非实时，极端高频写入可能短暂看到过期内容。
- **大数组树**：详情树对超大数组采用分段预览（首屏 + 加载更多），不一次性展开全部，避免 DOM 与内存失控。
- 关闭编辑器前若仍有在途长搜索，会在 `dispose` 时释放句柄；已在途的 Host 请求自然终止/忽略。

## 发布与版本管理规范

版本号**单一事实来源**为 `package.json` 的 `version`（遵循语义化版本 SemVer）。

发布产物统一落在 `releases/`，**不入 git**（由脚本重建），每个版本对应一个 git tag：

```
releases/
  jsonl-viewer-<version>.vsix        # 发布产物
  jsonl-viewer-<version>.vsix.sha256 # 该产物的 SHA-256 校验和（可追溯）
  LATEST                             # 最新版本号（install.cmd 默认读取它）
scripts/
  release.mjs                        # 一键发布
  install.cmd                        # 安装（默认最新版，可传版本号 install.cmd 1.0.4）
```

发布一个版本：

```bash
# 1) 修改 package.json 的 version（如 1.0.5）
# 2) 先提交代码（git commit）——release 脚本会打 tag v<version>，需指向本次代码
git add -A && git commit -m "release: v1.0.5"
# 3) 发布（typecheck → build → 打包 → 入 releases/ → 更新 LATEST → git tag v1.0.5）
pnpm release
# 4) 安装（可选）
scripts\install.cmd
```

约定：

- 每个已发布的版本必须有对应的 `v<version>` git tag；
- `releases/` 为构建产物目录，全部由 `scripts/release.mjs` 一键重建，请勿手改；
- 遇到 TRAE 安装器的 `targetPlatform="undefined"` 缺陷时，用 `scripts/install.cmd` 安装会自动修复。

## 许可证

ISC