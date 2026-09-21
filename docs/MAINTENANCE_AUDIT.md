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
| 运行时依赖 | **0**（devDependencies 10 个：类型声明 / 打包 / 测试 / 质检） |

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
- ~~无 **ESLint / Prettier / EditorConfig / pre-commit**（旧评审 P2 已提，仍未做）。~~
  **✅ 已落地（2026-09-21，提交 `37e6a2a` + `bca004e`）**：新增 `.editorconfig`、`.prettierrc.json`、`.prettierignore`、`.oxlintrc.json`；`package.json` 增 `lint` / `lint:ci` / `format` / `format:check`；CI 增 `lint` job（oxlint + `prettier --check`）。
- **为何用 oxlint 而非 ESLint（重要，勿重复踩坑）**：
  `typescript-eslint@8.70` 在加载时**硬性拒绝 TS 7.0** —— 报
  `typescript-eslint does not support TS 7.0.`，而本项目 `devDependencies` 用 `typescript@7` 原生编译器，上游尚未跟进（issue #10940 追踪 TS ≥ 7.1）。
  故本次先落地 **oxlint**（Rust 实现，**不依赖 `typescript` 包**，规则集与 ESLint 兼容，实测全仓 58 文件约 **20ms**）；**待上游支持后可平滑回归 ESLint**（两者规则名兼容，`eslint-config-prettier` 语义等价于关闭格式规则）。
- **门禁强度**：`correctness` 类为 error（**阻断合并**），`suspicious` / `perf` 为 warn（提示不阻断）。
  首次运行得 4 error + 65 warning；4 error 已修（见下），并按项目设计关闭 4 条噪音规则 ——
  `no-underscore-dangle`（`_` 前缀是既有约定）、`no-await-in-loop`（逐段串行拉取系刻意语义）、
  `unicorn/consistent-function-scoping`（闭包捕获状态即设计）、`unicorn/require-post-message-target-origin`（VS Code webview 的 `postMessage` 非 `window.postMessage`，属误报）。
  当前余 11 warning（`toSorted`/`toReversed`/`prefer-Set` 等风格建议），不阻断。
- **格式化范围与代价**：一次性 `prettier --write` 覆盖 59 文件（+888/−357 行）——**因参数按现有风格实测选定**（58 文件全 LF、单引号为主、行长多在 100 内），改动面远小于预期。排除 `docs/`、`.trae/`（编辑器工作流文档）与两个 HTML 设计资产；纯格式化提交已记入 `.git-blame-ignore-revs`（`git config blame.ignoreRevsFile .git-blame-ignore-revs` 后 blame 可跳过）。
- **pre-commit 本地门禁（✅ 已接入，提交 `e962291`）**：`.husky/pre-commit` 在提交前跑 `oxlint` + `prettier --check`（约 2s）。
  钩子**直调 `node_modules` 下二进制而非 `pnpm lint`** —— 钩子由 git 以独立 shell 调起，`PATH` 中未必有 pnpm，且本仓库对 `pnpm run` 有「冻结安装校验」副作用。
  范围取舍：`typecheck` 与 290 个单测交由 CI 矩阵与编辑器实时诊断，不放进 pre-commit（避免每次提交等数秒）。
  已用 `git hook run pre-commit` 与一次真实提交双重验证生效。
  与 CI 的关系：**CI 保证仓库终态**（Node 22/24 双版本 + 覆盖率门槛），**pre-commit 提供本地秒级反馈**，二者互补而非替代。

**P2 — 零引用导出：8 项已全部核实并清理（提交 `0c3eec1`）**

前置核查推翻「死代码」的简单假设 —— **8 项全为真问题，无一属预留 API**，处置如下：

| 类别 | 项 | 处置 |
|---|---|---|
| **重复实现** | `logic.ts` 的 `formatBuildMs` / `formatCount` 零引用，而 `toolbar.ts` 自写 `formatMs`（与前者逐字等价）并直接调 `toLocaleString('en-US')`（与后者同一实现） | 删除 toolbar 的本地实现，两处改用 `logic.ts` 的导出（显示行为不变，现有 `/1,000/`、`/12ms/` 断言即回归保护） |
| **语义封装未启用** | `recordSummary.ts` 的 `isOversized` 零引用，而 `dataService.ts` 直接判 `byteLen > RECORD_INLINE_MAX_BYTES` | 改用 `isOversized(byteLen)`，阈值判断收敛为单处表达 |
| **误导常量** | `SAMPLE_SCAN_LINES = 1_000` 零引用，而实际抽样行数由 `jsonlViewer.sampleLines`（默认 200）决定 —— 值与实现不符 | 改为 200 并更正注释；`dataService` / `inferFields` 的硬编码 `?? 200` 改用之 |
| **误导常量** | `FILE_STALE_DEBOUNCE_MS = 1_000` 零引用，且实现中并无 debounce（陈旧检测为 5s 轮询，「只推一次」由 `staleSignaled` 保证） | 删除；新增 `FILE_STALE_POLL_MS = 5_000` 并在 `extension.ts` 使用（行为不变） |
| **重复事实源** | `NARROW_BREAKPOINT_PX = 700` 零引用，而断点 700 在 `columnLayout.ts` 硬编码两处 | 两处改用该常量；`styles.ts` 的 `@container 699/700` 保留但加注释注明须与其同步（CSS 无法引用 TS 常量，属必要重复） |
| **未使用协议类型** | `protocol/rpc.ts` 的 `ErrorPayload` / `RequestEnvelope`（实际以内联类型与 `Extract` 表达） | 删除 |

> 说明：`extension.ts` 的 `deactivate` 虽零引用，但属 VS Code 生命周期钩子（由宿主调用），**非死代码**，保留。

**P3 — 结构性观察（暂不必动）**
- 4 个视图文件 722–878 行：属组件内聚（渲染 + 交互同源），非上帝对象；`webviewEntry` 已由 T5 分片减负 26%。
- `addEventListener` 计数：toolbar 18 / virtualScroll 14 / columnLayout 10 / detailTree 8（均为静态节点绑定，未做事件委托；卡片级监听已按 20/页 有界，收益有限）。
- 文档漂移：`docs/CODE_WIKI.md` 含机器绝对路径；本次已修正 `scripts/test-integration.mjs` 的缓存路径注释（见 2.4）。

### 2.4 本次顺带修正

- `scripts/test-integration.mjs` 头注释原写缓存位置 `~/.vscode-test/vscode-<version>-<platform>/`，**与实测不符**：`@vscode/test-electron` 默认以**当前工作目录**为 cachePath，实际落在项目根 `.vscode-test/vscode-<platform>-archive-<version>/`（实测 `...\vscode-win32-x64-archive-1.100.0`）。
  该错误曾直接导致「本地无缓存 → 集成测试不可跑」的误判，故更正。
- **`lint` 首次运行暴露的真问题（4 处，已修）**：`scripts/validate-300mb.ts` 死变量 `bruteBuf`（仅声明、零引用）；`src/host/__tests__/indexHostWorker.test.ts` 三处 `emit*` 多余的 `[...handlers]` 复制；`src/webview/toolbar.ts` 解构变量 `label` 遮蔽；`src/webview/__tests__/{toolbar,virtualScroll}.test.ts` 局部变量 `before` 遮蔽 `node:test` 的 `before` 钩子。
- **CI pnpm 版本不一致（已修）**：`.github/workflows/ci.yml` 三处写死 `12.4.2`，而 `package.json` 的 `packageManager` 在依赖规范化后已是 `12.5.1` —— 不改会导致 CI 版本不符而失败。两处必须同步修改。
- **文档机器绝对路径（已修，提交 `9a7dc8c`）**：`docs/CODE_WIKI.md`（15 处）与 `docs/CODE_REVIEW.md`（25 处）使用 `file:///c:/WorkSpace/...` 绝对链接 —— 换机器或他人 clone 后全部失效、无法在 GitHub 点击。统一改为相对路径 `../src/...`（行号锚点保留）；复核残留 0、失效相对链接 0。
- **数组 API 现代化（提交 `5f8178d`）**：6 处 `[...arr].sort()` / `[...arr].reverse()` → `toSorted()` / `toReversed()`（ES2023 非变异方法，行为等价）；`tsconfig` 的 `lib` 由 ES2022 提至 ES2023（仅新增 API 类型、无新语法；运行时基线 Node 22.18+ 与 VS Code 1.100+ 均支持）。oxlint 警告 8 → 2。
- **余下 2 处 lint 警告的判定（保留不改）**：`unicorn/prefer-set-has` 的两处属**过度建议** —— 一处是 4 元素数组上的 `includes`，一处是「数组拼接 + 另建 Set 去重」的正常写法。规则保留（不阻断），未来若真出现 O(n²) 场景仍能提示。

### 2.5 集成测试：沙箱内不可跑，但 **CI 已覆盖（✅ 已闭环，2026-09-21 修正）**

- 沙箱内跑不通：`.vscode-test/` 缓存**确有两版 VS Code**（1.100.0 与 1.138.0），脚本也能识别（`Found existing install in ...\vscode-win32-x64-archive-1.100.0`），但沙箱把 `Code.exe` 拦成不识别参数的包装程序：`bad option: --disable-extensions / --no-sandbox / --extensionTestsPath=...`，`Exit code: 9`。
- **修正结论**：本次工作流修复后，CI 的 9 个 `integration-test` 矩阵组合（Ubuntu / Windows / macOS × VS Code 1.100.0 / stable / insiders）**均已真实执行并通过**（步骤 `Run integration tests (...)` 结论为 success，非 skipped）。
- → **无需大帅本机补跑**：集成测试本就有 CI 矩阵覆盖，此前只因工作流失效而**从未真正运行过一次**（连 `pnpm install --frozen-lockfile` 都没跑成）。本机运行仍适用于本地调试。

### 2.6 CI / Release 工作流失效（本次推送时发现并修复）

现象：45 笔提交推送至 `origin/main` 后，远程出现两笔红色运行 —— `CI` 与 `Release`。

| 工作流 | 失败形态 | 根因 | 修正 |
|---|---|---|---|
| `ci.yml` | `verify (22)`、`lint` 在 **Setup pnpm** 步骤即失败；`verify (24)` 因 fail-fast 被取消；`coverage`、`integration-test` 因 `needs: verify` 跳过 | `pnpm/action-setup@v4` 的 `cache` 入参是**布尔**（`action.yml` 默认 `'false'`，语义为「是否缓存 pnpm store」）。沿用 v2/v3 时代的 `cache: 'pnpm'` **字符串**，会让 action 内部 `getBooleanInput` 抛 `TypeError: Input does not meet YAML 1.2 "Core Schema" specification: cache` | 四处 `cache: 'pnpm'` → `cache: true` |
| `release.yml` | **无任何 job**、结论直接为 failure；`gh run view` 提示 "This run likely failed because of a workflow file issue" | 步骤级 `if` 引用了 `secrets.VSCE_PAT` —— GitHub 上下文可用性表中 `jobs.<job_id>.steps.if` **不含 `secrets`**（官方原文：*Secrets cannot be directly referenced in `if:` conditionals*），整份工作流被判无效（`Unrecognized named-value: 'secrets'`）。文件既无效，其 `on:` 声明的 tag 触发条件一并失效，于是**每次 push 都产生一个失败运行** | 按官方建议把 secret 映射到 **job 级 `env`**，`if` 改判 `env.VSCE_PAT` |

附带修正：

- 两处工作流**均不再写死 pnpm 版本**，改由 `package.json` 的 `packageManager`（`pnpm@12.5.1`）唯一决定 —— 消除「清单与工作流两处手工同步」的漂移（`release.yml` 长期停留在 `12.4.2` 即其明证）。
- `release.yml` 发布步骤改为 `npx @vscode/vsce publish`（去掉 `-p ${{ secrets.VSCE_PAT }}`）：vsce 本就识别 `VSCE_PAT` 环境变量，且官方建议避免把密钥放到命令行（会进入进程表 / 审计日志）。
- `release.yml` 头部注释原称「手动触发 → 自动发布」，**与实际行为不符**：发布步骤以 `github.event_name == 'push'` 为闸，手动触发只构建并上传 VSIX、不会发布。已按实际行为改写注释。
  **是否让手动触发也能发布，属行为决策，本次未改，待大帅定夺。**
- `release.yml` 的 `if` 条件未动语义（仍限 `push` 事件），故**发布行为与修复前一致**，仅从「整份工作流失效」恢复为「按预期工作」。

**修复验证（实测）**：修复后推送 `a6602a8`，CI run `35616227491` **13/13 全绿** —— `lint`、`verify (22)`、`verify (24)`、`coverage` 及 9 个 `integration-test` 组合全部 success。两项旁证：

- 该次 push **未再触发 `Release`** —— 直接印证「文件有效后其 `on:` 声明的 tag 触发恢复生效」（此前每次 push 都有一个无 job 的失败运行）；
- `Install dependencies`（`pnpm install --frozen-lockfile`）**首次真正执行并通过** —— 即清单与锁文件确为一致，此前的「一致性」从未被 CI 真正校验过。

**为何能潜伏两天而无人察觉**：仓库未启用分支保护 / 必需状态检查，红色 CI **不阻断任何操作**（连 `--frozen-lockfile` 之类的约束都未曾真正执行过）。建议在仓库设置中把 `verify`、`lint`、`coverage` 设为必需检查 —— 属仓库设置，非代码。

**排查手段留档**（可复用）：`gh run list --json` 定位失败运行 → `gh run view <id> --log-failed` 取失败步骤的首条错误 → `gh api .../commits/<sha>/check-runs` 看 job 粒度与注解 → 最后**回官方文档核对**（本次即靠「上下文可用性表」定性 `secrets` 不可用于 `steps.if`），而非凭记忆猜。

**预防措施（本次一并落地，三类互补）**

| 措施 | 作用面 | 说明 |
|---|---|---|
| `lint` job 增 **actionlint 1.7.12** 步骤 | **静态拦截（对症）** | 专治本类「只在运行时暴露、且会静默令整份工作流失效」的错误。用官方镜像**钉死版本**，不采官方示例里「从 `main` 分支下载脚本」的写法（避供应链风险与版本漂移） |
| 新增 **`.husky/pre-push`** 本地门禁 | **对「本人直推」唯一真正生效的强制** | 分支保护默认对管理员**豁免**（见下），故必需状态检查约束不了本人直推；本地钩子跑 actionlint + `tsc` + 全量单测（约十秒），缺工具则跳过并提示 |
| `main` 分支保护（必需检查 `verify (22)` / `verify (24)` / `lint` / `coverage`） | **对协作者与未来贡献者生效** | 已设置；并禁强制推送、禁删除分支；**不强制 PR**（保留直推） |

**⚠️ 必须记牢的实测事实 —— 分支保护对管理员是「空门」**：GitHub 文档原文 *"By default, the restrictions of a branch protection rule **don't apply to people with admin permissions**"*。本仓库唯一协作者即管理员，故上述保护**拦不住大帅自己的直推**。要真约束本人，须把 `enforce_admins` 置 `true`，**但代价是直推 `main` 会被拦**（工作流须改为「推分支 → 开 PR → 合并」）。故本次采**非破坏形态**，该权衡留待大帅定夺。

**排查中臣自设的一处陷阱（值得记牢）**：用 PowerShell `Set-Content -Encoding utf8` 写出的样本带 **UTF-8 BOM**，actionlint 读之**静默返回零问题**，一度令臣误判「该工具不查此规则」。改用 Node 写**无 BOM** 样本后即正确报错并**精确定位到原第 74 行第 44 列**。→ 给静态检查工具喂样本，务必确认编码与 BOM。

---

## 三、提交记录（本次）

| 提交 | 类型 | 内容 |
|---|---|---|
| `2c4145c` | `chore(deps)` | 接纳 pnpm 自动规范化（`packageManager` 12.4.2 → 12.5.1、devDeps 字典序、锁文件 453 行同步） |
| `b56ac23` | `docs(scripts)` | 修正集成测试缓存路径注释；`.gitignore` 收编 `.integration_*.txt` |
| `4f27273` | `docs` | 新增本维护审计文档 |
| `37e6a2a` | `chore(tooling)` | 引入 oxlint + prettier + editorconfig，新增 CI `lint` job；修正 CI pnpm 版本 |
| `bca004e` | `style` | prettier 全量格式化 59 文件 + 修正 lint 暴露的 4 处问题 |
| `de731ca` | `docs(tooling)` | 维护审计同步 P1 落地；新增 `.git-blame-ignore-revs` |
| `0c3eec1` | `refactor` | 清理 8 项零引用导出（重复实现 / 语义封装 / 误导常量 / 断点常量 / 协议类型） |
| `e962291` | `chore(tooling)` | 接入 husky pre-commit 本地门禁 |
| `2b0d190` | `docs` | 维护审计同步本轮清理与 pre-commit |
| `c35731f` | `chore` | 新增 `.gitattributes` 统一 LF 行尾（修复 checkout 后 prettier 误报） |
| `9a7dc8c` | `docs` | 修正 40 处机器绝对路径链接为相对路径 |
| `5f8178d` | `refactor` | 6 处改用非变异数组 API（toSorted / toReversed）+ tsconfig lib 提至 ES2023 |
| `597b430` | `fix(ci)` | 修复 `ci.yml` 的 `cache` 布尔语义与 `release.yml` 的 `secrets` 误用；两处 pnpm 版本改由 `packageManager` 唯一决定；新增 §2.6 |
| `8afa191` | `chore` | `.gitignore` 增补临时产物命名，固化 `.scratch/` 统一入口 |
| `a6602a8` | `docs` | 维护审计补记工作流修复的 SHA 与后续建议 |
| `4a135c7` | `docs` | 补记 CI 修复验证（13/13 全绿），并修正「集成测试须本机补跑」的旧判断 |
| `daa24b1` | `fix(release)` | 手动触发默认不发布：新增 `workflow_dispatch.inputs.publish`，须显式勾选 |
| `cc0b33d` | `ci` | `lint` job 引入 actionlint 1.7.12 静态校验（钉版官方镜像） |
| `fbd85e7` | `chore(tooling)` | 新增 `.husky/pre-push` 本地门禁（actionlint + typecheck + 单测） |
| `29dd9f1` | `chore(tooling)` | `pre-push` 增探测仓库内本地 actionlint 二进制（PATH 缺失时亦可启用） |

> 说明：`package.json` / `pnpm-lock.yaml` 的改动**非人工编辑**，系安装 `jsdom` 与 `@types/jsdom` 时 pnpm 自动重写。清单与锁文件必须一致，否则 CI 以 `--frozen-lockfile` 安装会失败，故予接纳入库。

---

## 四、后续事项（含已完成与待定夺）

1. ~~**补工程化基线**：ESLint + Prettier + EditorConfig + CI lint job + pre-commit~~ **✅ 已完成**（lint 改用 oxlint，原因见 2.3；pre-commit 见同节）。
2. ~~**清 8 个零引用导出**~~ **✅ 已完成（`0c3eec1`）** —— 核查后确认 8 项全为真问题（非预留 API），处置见表。
3. ~~**统一断点常量**：JS 侧改用 `NARROW_BREAKPOINT_PX`~~ **✅ 已完成（`0c3eec1`）** —— CSS 侧保留硬编码但已加同步注释。
4. ~~**本机补跑集成测试**：`pnpm test:integration`（沙箱受限，见 2.5）~~ **✅ 已闭环** —— 集成测试本就有 CI 矩阵覆盖，2026-09-21 工作流修复后 9 个组合全部真实跑通并通过（见 2.5）。仅在需本地调试时执行。
5. **按需回收磁盘**：`.vscode-test`（1.4 GB，可联网重下）与 `samples` 中可再生大样本（340 MB）——按需执行。
6. **待确认后再动**：`samples/现网多轮已规整数据.jsonl`（232 MB）与 `query处置全景_...jsonl`（2.6 MB）疑为真实业务数据，删除前请确认是否另有留存。
7. ~~**启用分支保护 / 必需状态检查**~~ **✅ 已完成（2026-09-21）** —— `main` 已设必需检查（`verify (22)` / `verify (24)` / `lint` / `coverage`）+ 禁强制推送 + 禁删除分支，且**不强制 PR**（保留直推）。**但须知**：GitHub 默认**对管理员豁免**，故对本人直推无效（详解见 §2.6）；要真约束本人须 `enforce_admins=true`，代价是直推被拦 —— 见第 11 条。
8. ~~**把工作流静态校验纳入 lint job**~~ **✅ 已完成（`cc0b33d`）** —— actionlint 1.7.12 钉版官方镜像；并补 `pre-push` 本地门禁（`fbd85e7`）作为「对本人直推」的实际强制。
9. ~~**待定夺：release 手动触发是否发布**~~ **✅ 已决策（`daa24b1`）** —— 采「默认安全 + 显式授权」：新增 `workflow_dispatch.inputs.publish`（boolean，默认 `false`），勾选才发布；tag push 行为不变。
10. ~~**可选后续**：`docs/CODE_WIKI.md` 含机器绝对路径~~ **✅ 已修（`9a7dc8c`）**；余留 2 处 `prefer-set-has` 警告经复核属过度建议，保留不改（判定见 §2.4）。
11. **待定夺（范式级）**：若要让分支保护真正约束**本人**的直推，把 `main` 的 `enforce_admins` 置 `true`（一条 `gh api -X PUT` 即可）。**代价**：直推 `main` 会被拦，工作流须改为「推分支 → 开 PR → 合并」。此属工作流范式的改变，须大帅明确认可后再行。
