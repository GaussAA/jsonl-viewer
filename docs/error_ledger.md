# 错误台账（error_ledger）

> 格式：`[现象] → [根因] → [正解]`。凡连续 ≥2 次调试的顽固 Bug、或「发布/破坏性链路」
> 上的一次性事故，均在此沉淀。修复前先查此文件，禁盲写。

---

## [vsix 里混进 9MB 临时产物] → [`.vscodeignore` 不读 `.gitignore`，两边得各写一遍] → [把开发资产显式列进 .vscodeignore]

- **现象**：`vsce ls` 的清单里出现 `.scratch/actionlint_1.7.12_windows_amd64.zip`、
  `.husky/_/*`、`.github/workflows/*` 等一堆本不该进安装包的文件 —— 其中 `.scratch/`
  是 9MB 的一次性产物（下载的工具二进制、诊断输出）。
- **根因**：`.scratch/` 已在 `.gitignore` 里，于是"它不会进仓库"的印象很深；但
  **`.vscodeignore` 是独立的一套规则，不读 `.gitignore`**，未显式排除就会被打包。
  体积只是表象，更麻烦的是把开发期的临时/二进制内容发到用户机器上。
- **正解**：在 `.vscodeignore` 显式列出 `.scratch/**`、`.husky/**`、`.github/**`、
  `harness.html`、`prototype.html`、`docs/**`，以及 `.oxlintrc.json` /
  `.prettierignore` / `.git-blame-ignore-revs` 这类只服务研发流程的配置
  （与既有的 `.workbuddy/**`、`scripts/**`、`releases/**`、`samples/**` 同一处）。
  清单由数十条降到 **9 条**、打包产物 122KB —— 包内只剩「运行时 + 用户文档」：
  `dist/*.js`、`media/*`、`LICENSE`、`README.md`、`RELEASE.md`、`package.json`。
  若将来要随包分发某篇文档，用取反例外单独放行：`!docs/DESIGN_SYSTEM.md`。
- **预防**：新增任何"仓库里但非发布物"的目录时，**两处都要加**；CI 的 `vsce ls` 步骤
  会把清单打进日志，复查时一眼能看出多余条目。（2026-09-28）

---

## [集成测试启动即失败：Code.exe 对所有参数报 bad option] → [ELECTRON_RUN_AS_NODE=1 污染子进程] → [脚本主动清除该变量]

- **现象**：`pnpm test:integration` 下载 VS Code 成功后，Extension Host 启动失败 ——
  `Code.exe: bad option: --disable-extensions`（`--extensionTestsPath` / `--user-data-dir`
  等**每一个**参数都同样报错），exit code 9。最迷惑的一点：`Code.exe --version` 输出的是
  **Node 的版本号**（`v24.20.0`）而不是 VS Code 版本，极易误判为"下载损坏/版本不兼容"。
- **根因**：VS Code / Electron 宿主会向它派生的**所有**进程注入 `ELECTRON_RUN_AS_NODE=1`
  （本意是把 Electron 二进制当 Node 解释器用）。带着这个变量去启动真正的 VS Code 主进程时，
  `Code.exe` 退化为 Node，所有 CLI 参数落到 Chromium 的参数解析器上 → 逐个 `bad option`。
  **在 VS Code 集成终端（以及任何 VS Code 派生的 shell）里跑集成测试必然踩到**。
- **正解**：`scripts/test-integration.mjs` 在调用 `runTests` 之前
  `delete process.env.ELECTRON_RUN_AS_NODE` —— 由脚本自身免疫，不依赖使用者手动 `env -u`。
  验证：直接 `pnpm test:integration` 通过（`✓ extension registered` / `✓ activated` /
  `✓ isActive === true`，exit 0）。
- **附带结论**：此项正是 `ARCHITECTURE_REVIEW.md` §七 记录的**唯一未验证项**
  （"集成测试需本机网络…本地未能执行"）——现已验证通过，Extension Host 真实路径没问题。
  （2026-09-28）

---

## [行数校正收敛了选中行，详情却停在旧行] → [selectedLine 与 detailRaw 的同步靠"调用方自觉"] → [选中行收敛为唯一写入口，配套动作内置]

- **现象**（未爆发，静态追查发现）：末行被删、或批量删除因"行过大"跳过部分行后，
  `refreshOverview` 依据宿主权威行数把选中行收敛到新末行 —— 但**详情面板与
  `detailRaw` 仍是旧行的内容与原文**。用户在此状态下点字段编辑，
  `commitFieldEdit` 会拿新行号 + 旧行原文，**基于 A 行原文把改动写到 B 行上**
  （不可逆的错改）。
- **根因**：`selectedLine` 与 `detailRaw`（详情那行的磁盘原文）是一对**必须同步**的状态，
  而原实现把它们的写入散在 **11 处、跨 5 个模块**，配套动作（作废原文 / 取消在途详情 /
  重拉详情）全靠每个调用方自己记得 —— 13 处里漏 1 处就是这类静默错改。
  触发条件②（同一字段 ≥3 处写入且定位困难）实测已远超阈值。
- **正解**：新增 `src/webview/focusTarget.ts` 作为选中行的**唯一写入口**，
  把配套动作**内置**到写路径里（`invalidateDerived()`：作废原文 + 通知取消在途 + 本地标记无条件清空），
  11 处写入全部改经它；`clampTo` 路径顺带修掉缺陷（收敛即重拉详情）。
  同时清掉 `queryActions.jumpToMatch` 的一处**重复拉取**（它既走 `selectLine`
  又自己 `showDetailForLine`，收敛后会导致双请求互相 supersede）。
- **验证方式（值得沿用）**：新增集成用例断言"收敛后必须重拉详情且行号为新行"；
  再做**反向验证** —— 临时把实现改回旧行为（只改行号不重拉），确认该用例**失败**，
  证明它不是"假通过"。恢复后全量 699 用例通过。
- **普适规则**：两个必须同步的状态，**不要靠调用方记性**——把它们的写收敛成一个动作，
  让"漏一步"在结构上不可能发生。（2026-09-28）

---

## [批量字段替换取消后，横幅只剩「已取消」] → [浮层把装配层写好的完整文案覆盖成更含糊的一条] → [信息只能由最知情的一层播报一次]

- **现象**：批量字段替换被取消后，用户看到的横幅是「已取消」，而不是
  「已取消：文件未被修改」。后者明确告诉用户**文件没被动过**；前者让人无从判断
  到底改没改 —— 在「不可逆写入」场景下，这是两类完全不同的心理后果。
- **根因**：装配层（commitFieldReplaceAll）先 `banner.show('已取消：文件未被修改')`，
  随后浮层（fieldPanel.save）在 `!res.ok && applyAll` 分支又
  `deps.notify(res.error)`（= `'已取消'`）—— 后者把前者的信息**覆盖**了。
  浮层的本意是「失败要让人看见」，但它拿到的只是被简化过的错误码，不知道上下文。
- **正解**：批量模式下**浮层不再播报**（`else if (applyAll) { /* 什么都不做 */ }`）——
  装配层持有完整上下文（取消 / 冲突 / 宿主原始错误），横幅只应由它写一次。
  对应测试改为断言 `calls.notify` 为空。
- **普适规则**：一次用户可见的反馈**只由最知情的一层播报一次**；下游层重复播报
  等于把信息降级。（2026-09-28，前端装配层拆分时发现）

---

## [给写操作加互斥锁后 37 个用例「cancelled」] → [setHistoryCursor 内部二次索取同一把锁 = 自死锁] → [加锁只在对外入口，内部一律调 Internal 版]

- **现象**：为消除并发写 TOCTOU，把 editRecord/deleteRecord/…/undoStep/redoStep/revertTo
  改为 `runExclusive()` 排队后，单测从「598 全绿」变成 **pass 560 / cancelled 37**，
  失败类型是 `cancelledByParent` + `Promise resolution is still pending but the event loop
  has already resolved`（从 `history：revertTo …` 起整段被取消）。
- **根因**：`revertTo` 持锁后调用 `setHistoryCursor`，而后者循环里调的是**已加锁**的
  `undoStep()` / `redoStep()` —— 第二次索取同一把 promise-chain 锁，永远等不到自己释放。
  表现为请求永不 settle（不是报错，是静默挂起），故测试框架只能把它判成 cancelled。
- **正解**：**加锁只发生在对外入口**，对外入口内部一律调用不加锁的 `*Internal` 实现；
  `applyHistoryOp` 里的 edit/insert/delete/deleteMany 分支同样改调 Internal 版。
  现约定：editRecord/deleteRecord/insertRecord/replaceText/replaceField/deleteRecords/
  insertRanges/undoStep/redoStep/setHistoryCursor/revertTo 加锁；
  `editRecordChecked/editRecordInternal/deleteRecordInternal/insertRecordInternal/
  replaceTextInternal/replaceFieldInternal/deleteRecordsInternal/insertRangesInternal/
  applyLineTexts/undoStepInternal/redoStepInternal/setHistoryCursorInternal/revertToInternal`
  均**不加锁**，只供锁内调用。
- **识别要点**：`cancelled N` 且 `failureType: cancelledByParent` **不是**测试本身的问题，
  而是前面某个用例留下了永不 settle 的 Promise。定位办法：找第一个 `not ok` 的用例，
  它挂起后其后的用例会被连带取消。
- **预防**：新增写端点时，问自己「这个方法会不会被另一个已加锁的方法调用」；
  会 → 必须提供 Internal 版并只调它。（2026-09-28，写串行化改造时）

---

## [发布半途失败：vsce 拒绝打包] → [@types/vscode 版本漂移超出 engines.vscode] → [锁类型包回引擎版本，而非抬引擎线]

- **现象**：`node scripts/release.mjs` 在 `vsce package` 一步失败：
  `@types/vscode ^1.138.0 greater than engines.vscode ^1.100.0`。typecheck/tsc 全绿，
  问题只在打包时暴露。
- **根因**：依赖漂移。某次「同步依赖声明与实际安装版本」把 @types/vscode 一并升到
  1.138；tsc 不校验「类型包与引擎声明的一致性」，于是平时毫无症状。
- **正解**：`pnpm add -D @types/vscode@~1.100.0` 锁回引擎版本。**不要升 engines.vscode**
  —— `^1.100` 是 ESM 扩展入口的最低要求（RELEASE.md §1），抬高会无谓排除旧宿主用户；
  类型包降级反而更安全（不允许引用运行时可能不存在的 API）。降级后 tsc 全绿即佐证。
- **预防**：~~可考虑在 CI 加一步 `npx vsce ls`（不打包、只校验清单一致性）~~
  **已落地（2026-09-28）**：`ci.yml` 的 verify job 增加了
  `pnpm exec vsce ls --no-dependencies` —— 只列清单、不打包，秒级，让漂移在**提交时**
  就失败，而不是等到发布当天。
- **复发与处置（2026-09-28）**：工作区再次出现 `@types/vscode: ^1.138.0`
  （lock 记录 `version: 1.138.0`），`vsce ls` 复现同一报错。复位三步（**工具行为有坑，
  照抄**）：
  1. `git checkout -- package.json pnpm-lock.yaml` 还原声明与 lock；
  2. `pnpm update -D "@types/vscode@1.100.0"` —— **必须用 `update`**：
     `pnpm add` 与 `pnpm install` 都会因「lock 里 1.138.0 已满足 caret 范围」而打印
     "Lockfile is up to date, resolution step is skipped" 直接跳过，版本纹丝不动；
  3. `pnpm pkg set 'devDependencies["@types/vscode"]=~1.100.0'` 把声明从 `^` 收紧为 `~`
     （caret 才是漂移的入口）。注意键路径含 `@` 时**必须用括号记法**
     `["@types/vscode"]`，点号路径会报 `ERR_PNPM_PKG_INVALID_PROPERTY_PATH`。

---

## [发布在最后一步失败：spawnSync cmd.exe EBUSY] → [Windows 瞬时资源占用打断 git status] → [核对产物完整性后手动补 tag]

- **现象**：release.mjs 跑完 typecheck/test/build/vsce/sha256/LATEST 后，在
  `git status --porcelain`（58 行）抛 `spawnSync cmd.exe EBUSY (errno -4082)`，
  退出码 1 —— **tag 还没打**。
- **根因**：Windows 下 cmd.exe 被瞬时占用（常为杀软/索引服务扫描刚生成的大文件，
  此刻恰是 5MB vsix 落盘后一秒内）。脚本对这一步无重试。
- **正解**：产物本身已完整（vsix + sha256 + LATEST 都在），只差 tag。核对
  `ls releases/ | grep <ver>` 与 `cat releases/LATEST` 后，手动 `git tag v<version>`
  并 `sha256sum -c` 校验即可；不必重跑整个发布（重跑会因「vsix 已存在」被脚本拒绝）。
- **预防**：~~遇到 release.mjs 中途失败，先核对产物清单再决定重跑还是续尾~~
  **已治本（2026-09-25）**：`release.mjs` 的所有命令执行统一走 `execWithRetry`——
  EBUSY 自动等 1 秒重试（至多 3 次），非 EBUSY 错误照常抛出。三个版本连续在同一
  位置手工续尾后，不能再靠人肉兜底。（2026-09-24 首记，2026-09-25 修复）
