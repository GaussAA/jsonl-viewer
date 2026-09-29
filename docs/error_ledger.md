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


---

## [多行文件写后「记录」变「行」] → [applyLine* 只维护检查点，不维护记录分组] → [索引维护收口到 commitIndex，多行走重建]

- **现象**：pretty 文件上做一次插入/删除/（混排文件里）单行编辑之后，`totalRecords`
  从「记录分组数」变成「物理行数」——`readRecords` 取回的是行、历史重放的行号也一并错位。
  **不报错、不崩，界面上看不出异常**，只有把「编辑 → 再读记录」串起来看才暴露。
- **根因**：`LineIndex.applyLineReplace/Insert/Delete` 只平移**检查点**，而
  `multiline` 由构造函数第 6 参 `records` 是否存在决定 —— 三个增量方法都没传，
  于是每调用一次，索引就静默退化为「一行一记录」。
- **正解**：新增 `DataService.commitIndex(li, ops)` 作为索引维护的**唯一分流点**：
  `li.multiline` 走 `rebuildIndex()`，紧凑文件才走 `stageIndexOps()` 增量；
  7 处维护点（编辑/删除/插入/批量删除/区间插回/批量改写/回滚）全部改走它。
  取舍：多行文件编辑低频，宁可多一次全量扫描，也不为省它去实现「记录分组的增量平移」
  （插入一行是否改变分组需要重算深度）。
- **预防**：`multilineIndex.test.ts` 用**不变式**断言而非快照 ——
  「任何写操作后 `peekIndex().multiline === true` 且 `totalRecords` 仍是记录数」。
  回滚验证：修复前 4/4 失败。（2026-09-29）

---

## [取消的搜索被当成「没有命中」缓存下来] → [取消是正常 return，与 truncated 同形] → [cancelled 独立成字段]

- **现象**：用户发起搜索后立刻改词/关闭（触发 cancel），随后**再搜同一词**，
  拿到的仍是那份空/残缺结果 —— 因为残缺结果已按「快照 + 查询词」进了查询缓存。
  更危险的一面：`replaceText` 的第一步就是 `search()`，基于半份命中集改写 =
  漏改一批行却报成功。
- **根因**：`searchLines`/`filterLines` 只有 `truncated` 一个完整性标志，
  而被取消时是**正常 return**（不抛错、也不置 truncated）——于是「扫到一半」与
  「扫完无命中」在返回值上完全同形。
- **正解**：结果增加 `cancelled`（与 `truncated` 严格分开：后者是「可信子集，只是没列尽」，
  前者是「此后的命中一无所知」）；宿主只在 `!truncated && !cancelled` 时入缓存；
  `replaceText` 见 `cancelled` 直接拒绝。协议侧加可选字段（纯增量，不改版本号）。
- **预防**：`queryCancellation.test.ts`（service 层：取消后不缓存）+ `searchEngine.test.ts`
  （engine 层：取消与截断的语义分界）。回滚验证：修复前 6/6 失败。（2026-09-29）


---

## [「陈旧视图」的写入会改错行] → [乐观锁只锁了宿主一侧，锁不住调用方视图] → [写请求带上「本视图看到多少行」]

- **现象**（未爆发，推演 + 用例复现）：同一个文件被两个视图打开时，A 视图编辑后宿主基线会刷新，
  而 B 视图的界面仍是旧行号。此时 B 视图发起的删除/插入会**畅通无阻**：
  宿主侧的 size/mtime 检查全部通过（在宿主看来文件一切正常），B 视图却拿旧行号去删 —— 删掉的是另一行。
- **根因**：既有乐观锁只覆盖「宿主基线 vs 磁盘」（拦外部程序改动），
  而「调用方视图 vs 宿主基线」这一段是空的。二者是**两类不同的过期**，
  只用一侧的检查拦不住另一侧。
- **正解**：前端随写请求带上 `expectedTotalLines`（`viewBaseline()`，取自本视图的概览），
  宿主并入既有的 `detectWriteConflict` 一处判定，不符即拒（`conflict: true`）并给出
  「你看到的 N 行，磁盘上已是 M 行」的可行动文案。**不阻塞**正常编辑：尚无概览时不带该字段。
- **为何不用全文哈希**：那要为每次写入读一遍整个文件，与「永不整文件载入」的产品核心正面冲突。
  行数（+既有的 size/mtime）覆盖了绝大多数真实场景，代价是常数级。
- **预防**：`dataServiceHostSync.test.ts` 三例（单行/批量/不带基线各一）。
  回滚验证：修复前 3 例失败。（2026-09-29）

---

## [导出子集：取消与失败必须分开报，且不能留下半截文件] → [原子 rename + 目标文件「从未存在过」] → [先写临时文件再改名]

- **设计要点**（新能力，非事故，但值得留档）：
  1. **源文件一个字节都不动** —— 导出走独立的 `host/exporter.ts`，刻意**不复用** `fileWriter`：
     后者的全部复杂度（尾部搬移 / sidecar / 原地 rename）都来自「源既目标」，导出没有这个前提；
  2. **原子落地**：先写 `${target}.jlv-export-tmp`，成功后 `rename` —— 取消/失败时删临时文件，
     用户选定的路径**从头到尾没有被创建过**（「取消」因此是零风险的，与失败严格分开报）；
  3. **一条都取不出来时不创建目标文件**：留一个空文件比明说失败更糟（用户会以为导出成功但内容没了）；
  4. **目标 = 源路径直接拒绝**：那是覆写原数据，属编辑能力，不该从导出入口进来；
  5. 目标路径由**宿主侧保存对话框**决定，协议里**不带** targetPath —— webview 既拿不到文件系统，
     也不该有权决定往哪里写文件。（2026-09-29）


---

## [崩溃后遗留的备份无法恢复：只备尾部 + 无元数据] → [备份区间不含被编辑行、且偏移只在内存] → [备份前移到行起点 + 元数据旁车]

- **现象**（设计缺陷，非崩溃实录）：变长替换在搬移前把尾部备份到 `${path}.jlv-tail-bak`，
  成功即删。进程崩溃 / 被强杀落在搬移窗口内时，磁盘上留下一个孤儿备份 + 一个改了一半
  的文件 —— 而查看器对它**一字不提**：用户看见一个不明文件，既不知道它是什么，
  也不知道手上的文件可能不是它以为的样子。
- **根因（两层）**：
  1. **备份区间不对**：备份的是 `[range.end, EOF)`（纯尾部）。崩溃可能停在
     「新行已写入一半」—— 此时 `[range.start, range.end)` 那一行本身是坏的，
     而它**不在备份里**，恢复出来的文件里那一行仍然错。**半吊子恢复比不恢复更危险**：
     用户以为已经还原了，实际只是把错误换了个地方。
  2. **没有起点信息**：`tailStart` / `tailLen` 只存在于内存。被强杀后，磁盘上那段字节
     无从拼回 —— 即使用户想手工恢复，也不知道该往哪个偏移写。
- **正解**：
  1. 备份起点由 `range.end` **前移到 `range.start`**（含被编辑的那一行），
     恢复 = 「写回该区间 + 截断回编辑前大小」，一次到位；
  2. 搬移前写**元数据旁车** `${path}.jlv-tail-bak.json`（`backupStart / backupLen / fileSize`），
     与备份同生共死（成功、回滚成功、丢弃三条路径都清）；
  3. 打开文件时检测 → 横幅给「恢复 / 丢弃」（横幅因此扩成**多动作**：单动作横幅
     连续两次 `show` 会互相覆盖，界面看起来「只剩一个按钮」）；
  4. **不自动恢复**（备份可能属于另一个会话或已被后续外部写入覆盖）。
- **边界（写进代码而非只写文档）**：不假装能恢复 —— 元数据缺失/损坏、备份大小与元数据不符、
  目标文件短于备份起点，任一不满足就明说「无法自动恢复」并只提供「丢弃」。
  恢复走 `copyRangeFromFile`（与取消回滚**同一份**实现），不另写一套字节搬运。
- **预防**：`host/__tests__/backupRecovery.test.ts`（9 例：逐字节还原、截断回原大小、
  缺元数据/大小不符/文件过短三种拒绝路径、丢弃、重复恢复）；`fileWriter.test.ts` 补 2 例
  （备份区间**含被编辑行** —— 用取消回调在搬移途中读备份内容比对；元数据三项值的正确性）
  并在既有成功用例上补「元数据同样被清理」。回滚验证：只回滚源码后两个测试文件整体失败，
  恢复后 39/39 通过。（2026-09-29）


---

## [全量统计在多 GB 文件上会把内存吃光] → [字段/取值都是无界维度] → [三处容量上限 + 如实标记截断]

- **场景**（新能力的设计要点，非事故）：给查看器加「全量 Schema / 数据质量画像」——
  用户显式触发，扫完整文件统计每个字段的出现率、类型分布、top 取值与空值率。
  与抽样推断（前 200 条）不同，它必须真的把整个文件读一遍。
- **风险**：报表天然是**无界**的 —— 顶层字段数、每个字段的互异取值数、单个值的文本长度，
  三者都可以随文件规模无限增长。一个 `timestamp` 或 `request_id` 字段就能产生数百万个
  互异取值；一个存 base64 的字段能把单值撑到 MB 级。任何一处不设界，
  「体检功能」本身就会把内存吃光。
- **正解（三处设界 + 一处结构性约束）**：
  1. **只统计顶层 key** —— 深层字段的组合会爆炸（`a.b.c` 与 `a.b.d` 各自计数），
     而真实数据的质量问题绝大多数在顶层就看得见；
  2. 每字段 top N（默认 5）+ 互异值容量上限（默认 200）：超出的取值**汇总为「其他」**
     并置 `valuesTruncated` —— 汇总而非丢弃，用户仍知道「还有别的值」；
  3. 值文本截断（默认 60 字符）；
  4. 顶层字段数上限（默认 200），触顶后置 `fieldsTruncated` **如实标记**而不是静默忽略。
- **完整性语义**：与 `scanBadLines` 对齐 —— `cancelled`（用户中断，**结果不可信**）
  与 `fieldsTruncated`（扫完了，只是没全列）严格分开。前端把这一点做成硬约束：
  **抬头第一句**在中断时就说「请勿据此判断数据质量」—— 半份统计与全量统计在界面上
  长得一模一样，用户会据此对数据下判断。
- **统计口径**：`present / missing / nulls / empties` 四者互不混淆。
  「键不存在」「显式 null」「空串」是三种不同的质量问题，合并计数等于把诊断信息丢掉。
- **预防**：`profileEngine.test.ts` 把上述每一条都写成断言（含「字段数触顶」与
  「去重容量触顶」两条防御路径）。（2026-09-29）


---

## [超长行之后每一次读取都取到错内容（且不报错）] → [建索引按换行数行，读行却按读取块切段各计一行] → [scan 加跳过态，吞到真正的换行]

- **现象**：文件里只要存在一条满足触发条件的超长行，其后**每一条**记录经 `readRecord` /
  导出 / 复制取回的都是错内容 —— 不是报错、不是空，而是「看起来正常、其实是别的记录的一部分」。
  列表侧反而不明显：超长行本身按坏行呈现，掩盖了它后面的错位。
- **触发条件（实测修正过两次，比最初判定更窄）**：行必须**跨过 `SCAN_CHUNK_SIZE`（1MB）的
  读取块边界**且累计 ≥ 阈值。默认阈值（16MB）下要 >16MB 的行才踩得到；
  而**传小阈值**的调用方（校验脚本、导出测试）用 1MB+ 的行就能触发。
- **根因**：同一个文件有**两套行计数口径**。
  ①  `build` 逐字节扫描，只在遇到 `\n` 时闭合行 → 超长行算**一行**；
  ②  `scan` 在「已读满一块仍无换行且超阈值」时就地计一行、`abs += buf.length` 继续前进
  → 超长行算**N 行**（N = 块数）。
  于是扫描给出的行号多于索引的，其后每次读取都从「索引认为的行」偏移出去。
- **正解**：`scan` 加**跳过态** —— 确认超长行后不保留正文（内存仍恒定有界），
  但继续读到**真正的换行**才闭合，整行只占**一个**行号，`error` 标记照旧
  （且报的是整行真实长度而非「某一块的长度」）。
  跳过态里只 `indexOf(10)` + 累加长度，**绝不 concat** —— 否则一个 GB 级无换行行会把
  内存吃光，直接违背本模块「扫描期内存恒定有界」的承诺。
- **为何潜伏至今**：默认阈值下的触发门槛（>16MB 的单行）在日常数据里罕见，
  而真遇到那条路径的用户又很少去核对「我导出的真是我选的那几行吗」。
- **预防**：`lineIndex.test.ts` 三例 + 把 F5 时为不锁死坏行为而删除的那条导出用例加回来。
  回滚验证：回滚 `lineIndex.ts` 后 3 例失败，恢复后 52/52 通过。
  **教训**：任何「按块处理字节」的实现，都必须与「按换行定义行」的上游口径对齐 ——
  块是 IO 的单位，不是语义的单位；把块当行用，就是拿物理实现去定义业务语义。

---

## [看门狗用例在 Windows 上必红（单独跑 100% 复现）] → [按「间隔 × N」推算定时器触发次数] → [等待式断言（waitUntil 条件 + settle 反证）]

- **现象**：`staleWatch.test.ts` 的「checkStale 抛错按没变化处理」在 Windows 上失败：
  20ms 内 `calls` 停在 1，断言 `calls >= 2` 必红。批次 3 交付时是绿的（当时恰好 tick 足），
  之后随时会红 —— 典型的 flaky。
- **根因**：测试写的是 `pollMs=5` + `await wait(20)` 后数触发次数。**Windows 上 libuv
  的定时器分辨率约 15ms**，实测 `setInterval(fn,5)` 在 20ms 内只 tick 2 次、且可能只 1 次。
  「5ms × 4 = 20ms 应触发 4 次」是把 Linux 的定时器行为当成了普适事实。
- **正解**：所有依赖触发次数的断言改成 `waitUntil(条件)` 轮询等待；「反证型」断言
  （证明某事**没有**发生，如「不再重复推」「停止后不再检测」）用 `settle()` 放够轮数。
  连跑三次稳定通过。
- **预防**：涉及定时器 / 轮询的测试，**一律不按固定时长推算触发次数** —— 等条件成立，
  或给足轮数后做反证。（2026-09-29）

---

## [嵌套容器上的「加载更多」静默失效（退回整树重建或错插节点）] → [pathKey 以 NUL 分隔，CSS.escape 会把 NUL 转成 U+FFFD] → [父容器元数据直接挂在入口元素上，不做属性反查]

- **现象**：按 `data-parent`（pathKey）反查父容器行的方案在嵌套容器上永远匹配不到 ——
  两段以上的路径含 NUL 分隔符。
- **根因**：`pathKey` 用 `\u0000` 拼接段（避免与 key 内容歧义），而 CSS 标识符里
  **NUL 必须转义成 U+FFFD**（`CSS.escape` 的规范行为）。于是
  `[data-tree-key="\ufffd…"]` 与属性值里的真实 NUL 永不相等 —— `querySelector`
  不报错，只是返回 null，调用方再「兜底」就整树重建，性能优化静默失效。
- **正解**：不为「点击时反查」设计数据流。创建入口时（三处渲染点本就**手里有**
  父容器的值 / 路径 / 子级深度）把元数据直接挂在元素上（`LoadMoreMeta`），
  点击时零查询、零编码歧义。
- **预防**：凡是「自定义分隔符拼出的字符串要做 DOM 属性查找」的设计，先问一句
  **分隔符经不经得起 CSS 转义**；更普适的答案是：能在创建时挂上的引用，就不要在
  使用时反查。（2026-09-29）
