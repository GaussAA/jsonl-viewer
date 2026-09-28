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
  **一轮修复（2026-09-25）**：`release.mjs` 的所有命令执行统一走 `execWithRetry`——
  EBUSY 自动等 1 秒重试（至多 3 次），非 EBUSY 错误照常抛出。
- **二轮复发（2026-09-28，v1.10.0）**：同一位置再次失败，但**形态不同** ——
  `execSync` 报 `spawnargs: ['/d','/s','/c','"git status --porcelain"']`、`pid: 0`，
  是 **shell 进程根本没起来**（非 EBUSY，故重试机制救不了）。产物、SHA-256、LATEST
  仍然齐全，只有 tag 缺失 —— 第三次手工续尾，证明"加长重试"治不了根。
- **二轮治本（2026-09-28，同版本内）**：git 调用**一律不经 shell** ——
  `execFileSync('git', [...], { cwd: root })` 直调（`gitOut` / `gitRun` 两个助手）。
  既绕开 cmd.exe 的启动风险，也顺带免疫引号/转义与 PATH 差异。
  适用范围：**只对 git 这类"本身是独立可执行文件"的命令直调**；`pnpm typecheck && pnpm test`
  这类依赖 shell 语义（`&&`）的仍走 `execWithRetry`。（2026-09-28）

---

## [编辑之后搜索/过滤给出错行号（且不报错）] → [索引有两份实例，编辑只 patch 了一份] → [增量 op 回填 + 失同步重建兜底]

- **现象**（静态追查发现，未由用户报告 —— 正因它不报错）：任何**长度发生变化**的编辑
  （变长替换 / 插入 / 删除）之后，宿主内的索引仍停在搬迁前的偏移上，于是
  `search` / `filter` 顺着旧检查点读搬迁后的文件：
  - 增删行后 `totalLines` 是旧值 → **新插入的行搜不到**（实测命中集为空）；
  - 变长编辑后其后每个检查点整体失配 → 行号**系统性偏移**（块内偏移一位）；
  - `replaceText` 的第一步就是 `search()` → 命中集错位会**把改动写到错误的行上**
    （实测残留未替换行 `{"i":1062,"status":"pending"}`）。
- **根因**：进程内存在**两份** `LineIndex` —— `DataService.index`（随机读/编辑定位）
  与 `IndexHost` 内部那份（`search`/`filter` 唯独用它）。编辑只做
  `this.index = li.applyLineXxx(...)`，而 `IndexHost` 接口自始至终**没有任何回写通道**，
  worker 线程内那份更是只能靠 `build()` 赋值。既有测试恰好用等长编辑
  （`{"id":2}`→`{"id":3}`，偏移不变）掩盖了它。
- **正解**：
  1. `indexer` 新增 `IndexDeltaOp` 与**共用的** `applyIndexOps()` —— 把「如何应用 op」
     收敛成一个函数，主线程与 worker 两侧才可能同步演化（各写一份循环 = 迟早漂移）；
  2. `IndexHost.applyIndexOps()` 作为回填通道，worker 侧经新消息 `applyIndexOps` 下发给
     `indexWorker`；传 op 而非整份索引（检查点可达数万条，跨线程序列化整份纯属浪费）；
  3. `DataService` 以 `stageIndexOps()` **收口全部 7 处写路径**（此后禁止再直接赋值
     `this.index`），经既有的 `refreshSnapshot()` —— 所有写路径共同的唯一收口点 —— 统一回填；
  4. 回填失败**不向上抛**（此刻磁盘已是新内容，抛出去就是把内部不一致谎报成写入失败），
     而是置 `hostDirty`，下一次 `search` / `filter` 前经 `ensureFreshHost()` 重建兜底。
- **预防**：新增 `src/host/__tests__/dataServiceHostSync.test.ts`（8 例），全部是
  「**先编辑 → 再查询 → 逐字节核对磁盘**」的形态 —— 单看编辑或单看查询都正确，
  只有相连才暴露，这正是它能潜伏至今的原因。**回滚验证过：修复前 8/8 失败、修复后 8/8 通过。**
  给 `DataServiceOptions` 加了 `hostFactory` 测试接缝（与既有 `WorkerLike` 接缝同理念），
  使「是否 dispose 旧宿主」这类生命周期正确性可被测到；伪 worker 采用
  「协议通道是真的 + 计算由真引擎承担」的替身写法，不 spawn 线程也能测通消息链路。
  （2026-09-29）

---

## [多行文件反复编辑后插件退化主线程] → [rebuildIndex 覆写 this.host，旧宿主/worker 从不释放] → [换宿主前先 dispose]

- **现象**：多行（pretty）文件每做一次破坏行号结构的编辑（`deleteRecords` / 多行记录编辑）
  就新建一个索引宿主 —— worker 路径下即一根新线程 + 新文件句柄，旧的永不 `terminate`。
  累计超过 `MAX_ACTIVE_WORKERS=8` 后，`createIndexHost` **永久退化主线程**，
  `STABILITY_AUDIT` 里专门修过的 worker 可用性防线对用户静默失效。
- **根因**：`rebuildIndex()` 直接 `this.host = built.host` 覆盖，与 `dispose()` 里
  「先关 reader 再 dispose host」的写法不一致 —— 生命周期的**收口点只有一处，却漏了这一处**。
- **正解**：`rebuildIndex()` 先 `await prev.dispose()` 再换新宿主，并清空待回填队列、
  复位 `hostDirty`（旧 op 随旧宿主一并作废，重放只会把新索引搞坏）。
- **顺带修掉同源隐患**：`indexWorker` 的 error 回执此前只对 `build` / `search` / `filter`
  带 `requestId`，`releaseFile` / `reacquireFile` 一旦失败，主线程对应的 pending
  **永不结算** → `rewriteAtomic` 永久挂起，且**无任何报错**（表现为批量替换卡住）。
  现改为对所有带 `requestId` 的消息统一回传（`const requestId = 'requestId' in msg ? ... : undefined`）。
- **预防**：同上的回归测试文件另设两例 —— `SpyHost`（主线程路径）与伪 worker（worker 路径）
  分别断言「第 N 次重建前，第 N-1 个宿主已被 dispose / 上一根 worker 已 terminate」。（2026-09-29）
