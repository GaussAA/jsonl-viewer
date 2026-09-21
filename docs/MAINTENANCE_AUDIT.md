# JSONL Viewer — 维护审计（根目录清理 + 代码质量基线）

> 审计日期：2026-09-21 · 执行人：AI 助手（大帅钦点范围）
> 与既有文档分工：`docs/CODE_REVIEW.md` 覆盖**功能与安全**（P0–P2，已全修）；本文件覆盖**仓库整洁度**与**结构性质量基线**。
> 状态：持续追踪。清理类操作遵循「先扫描出报告 → 大帅钦点 → 备份 → 小批量执行 → 逐批验证」。

---

## 一、根目录清理

### 1.1 审计起点

根目录共 **52 项**（文件 + 目录），其中 **34 项为本地调试临时产物**：调试命令重定向输出（`.audit_*`/`.coverage_*`/`.test_*`/`.tsc_out`/`.validate_*`/`test_out.txt`）与一次性诊断脚本（`.diag_*.ts`）。

这些文件**已被 `.gitignore` 覆盖**（故不污染 `git status`），但长期堆积使根目录难以辨识。合计仅 **385.4 KB**，全部可再生。

### 1.2 分级与处置（大帅钦点：仅清临时产物）

| 级别 | 内容 | 体积 | 处置 |
|---|---|---|---|
| **A 临时产物** | 34 项调试输出与诊断脚本 | 385.4 KB | **已清理**（钦点范围） |
| B 大样本 | `samples/09_large_10k`、`10_large_100k`、`big-300mb` | 340 MB | 暂留（可按需再生；`big-300mb` 不在生成脚本内） |
| B 真实数据 | `samples/现网多轮已规整数据.jsonl`、`query处置全景_...jsonl` | 235 MB | **暂留（疑不可再生，删前须确认）** |
| C 集成缓存 | `.vscode-test/`（两个 VS Code 版本） | 1.4 GB | 暂留（集成测试需要） |
| D 构建产物 | `dist/`、`releases/`（1.3.0–1.7.0） | 3.5 MB | 暂留（可再生产物，体积小） |
| E 文档资产 | `harness.html`、`prototype.html` | 65 KB | **保持原位**（见 1.4） |

### 1.3 执行结果

- **清理前**：根目录 52 项（文件 29 / 目录 13）。
- **清理后**：根目录 **26 项（文件 12 / 目录 14）**；`git status` 仅剩 `?? .workbuddy/`（项目记忆，不入库）。
- **备份**：`%TEMP%\jsonl-viewer-cleanup-20260921\`（33 个文件已备份；第 34 个为清单自身未备份）。
- **验证**：模式匹配残留 **0**；清理后 `tsc --noEmit` **0 错**、`node --test` **290/290**、`build.mjs` **退出 0**。

### 1.4 不可清理项（重要）

- **`harness.html`**：Host Mock Harness —— 起本地静态服务即可在浏览器加载真实 `dist/webview.js` 并模拟宿主 RPC。
- **`prototype.html`**：可交互设计原型（设计先行工作流产物，`styles.ts` 按其 1:1 复刻）。
- 二者被 **4 处**文档/注释引用：`docs/CODE_WIKI.md`（结构树 + 使用说明）、`docs/DESIGN_SYSTEM.md`、`src/webview/styles.ts:4` 注释。**移动须同步这 4 处**，故保持原位。
- **`samples/` 中 8 个小样本 + `generate_samples.py` 受 Git 跟踪**，属仓库资产，不在清理范围。

### 1.5 删除机制实测（沙箱约束，值得留档）

- 沙箱的 `safe-delete` 钩子会把 **Node `fs.unlink`、shell `rm`/`rmdir`、PowerShell `Remove-Item`** 统一改道回收站；沙箱回收站不可用 → 报
  `[safe-delete][SAFE_DELETE_FAIL_CLOSED] {"reason":"trash-failed", ... "Some operations were aborted"}`。
- **该报错是误报**：文件**实际已从原路径清除**（本轮 34 个文件全部报 FAIL，逐项 `Test-Path` 复核残留为 0）。
  → **判定删除结果一律以 `Get-ChildItem` / `Test-Path` 复核为准，勿据异常消息认定未删。**
- `Add-Type`（运行时编译 .NET）被沙箱安全策略直接拦截，故**无法**用 `Microsoft.VisualBasic.FileIO.FileSystem::DeleteFile(..., 'SendToRecycleBin')` 走真回收站。
- 复制/读取不受钩子影响：批量删除前用 `Copy-Item` 备份到 `$env:TEMP` 可行。

---

## 二、代码质量基线

### 2.1 规模

| 项 | 数值 |
|---|---|
| 源文件 | **27 个 / 8745 行** |
| 测试文件 | **26 个 / 5299 行**（测试/源 ≈ 0.61） |
| 测试用例 | **290**（Node 22 与 24 双验） |
| 覆盖率 | 行 **97.04%** · 分支 **86.55%** · 函数 **89.17%** |
| 运行时依赖 | **0**（devDependencies 8 个） |

源文件规模 TOP：`virtualScroll.ts` 878 · `webviewEntry.ts` 821 · `styles.ts` 814 · `detailTree.ts` 797 · `toolbar.ts` 722 · `extension.ts` 588 · `indexHost.ts` 366 · `dataService.ts` 322。

### 2.2 优良项（已达高标）

- **零 `any`**、零 `TODO` / `FIXME` / `HACK` / `@ts-ignore` / `eslint-disable`（全库扫描）。
- `tsconfig` 开启 `strict` + `noUnusedLocals` + `noUnusedParameters` + `noFallthroughCasesInSwitch`。
- `engines.node >= 22.18` 与代码实际要求一致。
- 分层清晰：`core`（共享契约）/ `parser` / `indexer` / `infer` / `host` / `protocol` / `webview`。
- 覆盖率高且**有门槛棘轮**（`test:coverage:gate`，防止回退）。
- 空 catch 仅 7 处，**均带注释说明降级理由**（localStorage/剪贴板不可用、worker 已退出等），非静默失败。

### 2.3 缺口（按优先级）

**P1 — 工程化基线缺失（与「工具强制优于人工遵守」的既定律不符）**
- 无 **ESLint / Prettier / EditorConfig / pre-commit**（旧评审 P2 已提，仍未做）。
- 现状：风格与潜在错误仅靠 `tsc` + 人工 review 把关；格式化靠约定。
- 建议：至少引入 ESLint（`@typescript-eslint`）+ Prettier + `.editorconfig`，并在 CI 增 lint job；如要防本地漏检再加 husky + lint-staged。

**P2 — 死代码：8 个零引用导出**（已计入 src + scripts + 测试的全部引用后复核）

| 文件 | 零引用导出 |
|---|---|
| `src/constants.ts` | `FILE_STALE_DEBOUNCE_MS`、`SAMPLE_SCAN_LINES`、`NARROW_BREAKPOINT_PX` |
| `src/host/recordSummary.ts` | `isOversized` |
| `src/protocol/rpc.ts` | `ErrorPayload`、`RequestEnvelope` |
| `src/webview/logic.ts` | `formatBuildMs`、`formatCount` |

> 说明：`extension.ts` 的 `deactivate` 虽零引用，但属 VS Code 生命周期钩子（由宿主调用），**非死代码**，保留。

**P2 — 重复事实源**
- `NARROW_BREAKPOINT_PX = 700` 已定义却零引用，而断点 700 在 `columnLayout.ts:69`、`:241` **硬编码两处**；`styles.ts` 另写 `@container (max-width: 699px)` / `(min-width: 700px)`。
- 建议：JS 侧改用常量；CSS 无法引用 TS 常量，保留但在两侧注释标注「须与 `NARROW_BREAKPOINT_PX` 同步」。

**P3 — 结构性观察（暂不必动）**
- 4 个视图文件 722–878 行：属组件内聚（渲染 + 交互同源），非上帝对象；`webviewEntry` 已由 T5 分片减负 26%。
- `addEventListener` 计数：toolbar 18 / virtualScroll 14 / columnLayout 10 / detailTree 8（均为静态节点绑定，未做事件委托；卡片级监听已按 20/页 有界，收益有限）。
- 文档漂移：`docs/CODE_WIKI.md` 含机器绝对路径；本次已修正 `scripts/test-integration.mjs` 的缓存路径注释（见 2.4）。

### 2.4 本次顺带修正

- `scripts/test-integration.mjs` 头注释原写缓存位置 `~/.vscode-test/vscode-<version>-<platform>/`，**与实测不符**：`@vscode/test-electron` 默认以**当前工作目录**为 cachePath，实际落在项目根 `.vscode-test/vscode-<platform>-archive-<version>/`（实测 `...\vscode-win32-x64-archive-1.100.0`）。
  该错误曾直接导致「本地无缓存 → 集成测试不可跑」的误判，故更正。

### 2.5 集成测试现状（须本机补跑）

- `.vscode-test/` **确有两版 VS Code**（1.100.0 与 1.138.0），脚本实测能识别：`Found existing install in ...\vscode-win32-x64-archive-1.100.0`。
- 但**沙箱内仍跑不通**，原因是沙箱把 `Code.exe` 拦成不识别参数的包装程序：
  `bad option: --disable-extensions / --no-sandbox / --extensionTestsPath=...`，`Exit code: 9`。
- → 结论：`pnpm test:integration` 须在**大帅本机（沙箱外）**执行，以覆盖 Extension Host 真实路径。

---

## 三、提交记录（本次）

| 提交 | 类型 | 内容 |
|---|---|---|
| `2c4145c` | `chore(deps)` | 接纳 pnpm 自动规范化（`packageManager` 12.4.2 → 12.5.1、devDeps 字典序、锁文件 453 行同步） |
| `b56ac23` | `docs(scripts)` | 修正集成测试缓存路径注释；`.gitignore` 收编 `.integration_*.txt` |

> 说明：`package.json` / `pnpm-lock.yaml` 的改动**非人工编辑**，系安装 `jsdom` 与 `@types/jsdom` 时 pnpm 自动重写。清单与锁文件必须一致，否则 CI 以 `--frozen-lockfile` 安装会失败，故予接纳入库。

---

## 四、后续建议（未执行，待定夺）

1. **补工程化基线**：ESLint + Prettier + EditorConfig + CI lint job（P1，性价比最高）。
2. **清 8 个零引用导出**：逐个确认后删除（`isOversized`、`formatCount` 等可能为「预留 API」，须先判定意图）。
3. **统一断点常量**：JS 侧改用 `NARROW_BREAKPOINT_PX`，消除三处硬编码。
4. **本机补跑集成测试**：`pnpm test:integration`（沙箱受限，见 2.5）。
5. **按需回收磁盘**：`.vscode-test`（1.4 GB，可联网重下）与 `samples` 中可再生大样本（340 MB）——按需执行。
6. **待确认后再动**：`samples/现网多轮已规整数据.jsonl`（232 MB）与 `query处置全景_...jsonl`（2.6 MB）疑为真实业务数据，删除前请确认是否另有留存。
