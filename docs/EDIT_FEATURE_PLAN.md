# JSONL Viewer 编辑能力扩展 —— 核实与方案

> 目标：在**不牺牲「多 GB 秒开、内存与可视区成正比」这一核心卖点**的前提下，为查看器增加编辑能力。
>
> 本文先给结论，再列**已核实的代码事实**（含文件与行号），最后给方案、风险与待决问题。
> 前端实现前另需读 [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)（设计契约）。

---

## 0. TL;DR

| # | 结论 |
|---|---|
| 1 | **不能用 `TextDocument` 路线**。项目当前刻意用 `CustomReadonlyEditorProvider` + 扩展自有文档模型绕开 VS Code 的文本模型，正是为了不让 200MB+ 文件被预载（`src/extension.ts:501-512` 注释已明确记录此踩坑史）。任何"改用 `CustomTextEditorProvider` 编辑"的方案都与产品核心正面冲突。 |
| 2 | **最优路线 = 升级为「可写但仍是扩展自有文档模型」的 `CustomEditorProvider`**。它同样不预载文件（`openCustomDocument` 由我们实现），却能白得 VS Code 的脏标记、撤销/重做、Ctrl+S、关闭提示、热退出备份。**这是"大文件能力"与"原生编辑体验"唯一能兼得的路线。** |
| 3 | **架构上最大的好消息**：`LineIndex` 是**稀疏检查点**（默认每 1024 行一个），不是全量偏移数组。因此"编辑后维护索引"的代价是 **O(行数/1024)** —— 千万行文件仅约 1 万个数字需要平移，微秒级。索引从来不是瓶颈。 |
| 4 | **真正的瓶颈是磁盘 IO**：修改行长度会要求搬移该行之后的全部字节。成本 = **改动点距文件末尾的字节数**（而非文件总大小）。因此"编辑最后一行"几乎免费，"编辑第一行"代价等同文件大小。**这是物理约束，不可绕过，只能分级应对。** |
| 5 | 建议按 **M1 只读安全的等长/小范围编辑 → M2 完整行级编辑 → M3 批量与字段级编辑** 三期推进，每期可独立交付、可随时刹车。 |
| 6 | **先修正文档**：`docs/CODE_WIKI.md` 有两处与代码不符（provider 类型、索引结构），会直接误导扩展决策，见 §1.2。 |

---

## 1. 现状核实

### 1.1 已核实事实（附位置）

| 项 | 事实 | 位置 / 证据 |
|---|---|---|
| 编辑器类型 | **`CustomReadonlyEditorProvider`**（只读），不是 `CustomTextEditorProvider` | `src/extension.ts:513` `class JsonlCustomEditorProvider implements vscode.CustomReadonlyEditorProvider` |
| 文档模型 | `openCustomDocument` **只持有 URI、不读文件**，`dispose` 为空实现 → **当前无脏状态、无备份、无撤销栈** | `src/extension.ts:523-525` |
| 数据来源 | 全程**绕开 `TextDocument`**，一律经 `DataService` 从磁盘按需随机读 | `src/extension.ts:150-159` 注释 + `mountViewer` |
| 读取器 | `ByteReader` 接口**只有 `readBytes`**；`FileByteReader` 以 **`open(path, 'r')`（只读句柄）** 打开 | `src/parser/jsonParser.ts:38-41`、`225-229` |
| 写入能力 | **全库零文件写入**。`grep` 无 `writeFile`/`createWriteStream`/`openSync(...,'w')`/`rename`/`truncate`（仅测试与性能脚本里有写操作） | 全仓检索 |
| 索引结构 | **稀疏检查点**：`{line, offset}` 每 `INDEX_CHECKPOINT_INTERVAL`(1024) 行记一个；类字段 `readonly`、构建后不可变 | `src/indexer/lineIndex.ts:78-99`、`src/constants.ts:15` |
| 行区间 | `scan()` 产出的 `end` 是**包含行尾符**的独占边界（`end = abs + nl + 1`）→ 天然就是"替换整行"所需的字节区间 | `src/indexer/lineIndex.ts:253-255` |
| 行尾处理 | `trimLineEnding` 剥离 `\n` / `\r\n`，但不记录**原本是哪种**（写回时需自行推断） | `src/parser/jsonParser.ts:87-93` |
| 单行上限 | `MAX_LINE_BYTES = 16 MiB`，超限行以"坏行"呈现 | `src/constants.ts:24` |
| 变更检测 | 5s **轮询 stat** 比对 `size`/`mtimeMs` 基线快照；只在"正常→走样"翻转时推一次 `FILE_STALE` | `src/host/dataService.ts:158-172`、`src/extension.ts:389-407` |
| 重载路径 | `reload()` = `dispose()` + 重建索引，即**整文件重扫**（O(文件大小)）；webview 点横幅按钮触发 | `src/host/dataService.ts:300-310` |
| RPC 协议 | `HostEndpoint` 共 13 个端点，**无任何编辑/写入端点** | `src/protocol/rpc.ts:19-37` |
| webview 交互 | 已有右键菜单（定位到源码行 / 复制行号 / 复制 JSON），**无编辑入口** | `docs/CODE_WIKI.md:394` |
| 现有编辑能力 | 唯一"写"是 `workspaceState`（UI 偏好持久化），与文件无关 | `src/extension.ts:352-357` |
| 测试与质量门 | 56 个测试套件；覆盖率门槛 lines 96 / branches 86 / functions 88 | `package.json:104` |

### 1.2 文档与代码不一致（**已修正** ✅ 2026-09-22）

| 文档原说法 | 代码实际 | 处理 |
|---|---|---|
| `docs/CODE_WIKI.md` 称使用 **`CustomTextEditorProvider`** | 实际是 **`CustomReadonlyEditorProvider`**（`src/extension.ts:513`） | ✅ 已改正（技术栈表、架构图、4.1 节、5.1 表，共 4 处） |
| `docs/CODE_WIKI.md`、`README.md` 称索引是**「扁平升序偏移数组，8B/行」** | 实际是**稀疏检查点**（≈16B/检查点，每 1024 行一个） | ✅ 已改正（性能设计、目录注释、4.3 节、5.1 表等，共 13 处） |
| `docs/CODE_WIKI.md` 列出的 `getOffsetAtLine` / `lineRange` / `getLineRangeAtOffset` / `contentLengthAt` | **这些方法都不存在**；实际 API 为 `offsetAtLine` / `scan` / `resolveRange` / `toStats` | ✅ 已改正（4.3 节 + 5.1 表） |
| `README.md` 的 perf 示例输出 `idxRows=60000 idxBytes≈469KB buildMs=74.5` | 实测重跑为 `checkpointRows=59 idxBytes≈1KB buildMs=48.3` | ✅ 已按实测更新 |

> 索引结构的认知偏差会直接影响编辑方案的可行性判断：按「8B/行」推算，编辑后维护索引看似 O(行数)、很贵；**实际是 O(行数/1024)、极廉价** —— 这正是本方案可行的前提。
>
> 说明：`docs/CODE_REVIEW.md` 中出现的 `contentLengthAt`（死代码记录）属**历史审计快照**，保留原貌不改。

---

## 2. 三条候选路线的取舍

### 路线 A：改用 `CustomTextEditorProvider`，编辑交给 `TextDocument`

- **做法**：把文档模型换成 VS Code 的 `TextDocument`，用 `WorkspaceEdit` 改文本，保存交给 VS Code。
- **优点**：脏标记、撤销、保存、备份、Hot Exit 全部白拿，零自研。
- **致命伤**：`resolveCustomTextEditor` 被调用前，VS Code **必须先把整个文件读成文本模型** → 200MB+ 文件直接弹 "too large to open"。**这正是项目阶段一踩过并已绕开的 P0 坑**（`src/extension.ts:504-511` 注释有记录）。
- **判定**：**❌ 否决**。等于放弃产品核心卖点。

### 路线 B：保持只读 provider，另起"自研编辑层"直接写盘

- **做法**：provider 不动，新增写入模块 + 自维护脏状态与撤销栈。
- **优点**：改动面最小，不动 provider 语义。
- **硬伤**：要为"脏标记 / Ctrl+S / 撤销重做 / 关闭时询问保存 / 崩溃恢复备份 / 关闭标签页前拦截"逐项自研，且**无法与 VS Code 原生体验对齐**（例如 Ctrl+Z 会落到编辑器之外、关标签不会提示保存）。工作量反而最大、体验最差。
- **判定**：**⚠️ 不推荐**（仅当坚决不动 provider 时才作为退路）。

### 路线 C：升级为**可写的 `CustomEditorProvider`**（文档模型仍是扩展自有）✅

- **做法**：实现 `vscode.CustomEditorProvider<T extends CustomDocument>`，`openCustomDocument` **依然只持有 URI、不读文件**；由我们实现 `saveCustomDocument` / `revertCustomDocument` / `backupCustomDocument`，并用 `onDidChangeCustomDocument` 上报可撤销的编辑事件。
- **优点**：
  1. **仍然不预载文件** → 多 GB 能力完整保留（`CustomEditorProvider` 的文档模型由扩展定义，与 `CustomTextEditorProvider` 的 `TextDocument` 模型是两回事）；
  2. **白得**脏圆点、Ctrl+S、Ctrl+Z/Y、关闭提示、Hot Exit 备份、`File: Revert File`；
  3. 撤销/重做栈由 VS Code 托管，我们只需把"行替换"表达为可逆操作。
- **代价**：需实现 5 个新方法 + 维护一份"待写编辑日志"，并把 undo/redo 映射回文件写入。
- **判定**：**✅ 推荐**。

---

## 3. 推荐路线与分期

```
M1  只读安全的地基              M2  完整行级编辑               M3  批量与字段级
──────────────────────          ──────────────────────        ──────────────────────
· 升级可写 provider（骨架）      · 任意长度行替换              · 详情树字段级编辑
· 写入模块 + 原子性策略          · 新增行 / 删除行             · 单行编辑的进度与取消
· 索引增量更新（检查点平移）     · 行内原始 JSON 编辑器
· selfWrite 抑制 stale           · 查找替换（批量原子重写）
· 并发冲突检测（写前 stat）      · 多选批量删除 / 复制
                                 · JSON 校验 / 撤销栈 / 进度
                                 · 会话编辑历史（M3 提前交付）
                                 · 坏行诊断（M3 提前交付）
```

**每期结束都保持"可发布"状态**：M1 完成后功能上仍是只读，但地基齐备；M2 完成即可日常使用。

### 实施进度（2026-09-22）

**M1 已交付，且范围上探至「最小可用编辑」** —— 用户已可端到端编辑，不再只是地基：

| 环节 | 产出 | 提交 |
|---|---|---|
| 写入层 | `src/host/fileWriter.ts`：等长原位覆写 / 变长「Δ>0 倒序、Δ<0 正序」搬移 / sidecar 崩溃备份 / errno 中文翻译 | `144fc4d` |
| 索引增量 | `LineIndex.applyLineReplace`：O(检查点数)；含「与重建索引扫描结果完全一致」的等价性验证 | `213a2d6` |
| 编辑链路 | `DataService.editRecord` + `EDIT_RECORD`/`EDIT_RESULT`：写前冲突检测、乐观锁、写后基线同步、`editing` 短路 | `213544a` |
| 可写 provider | `CustomEditorProvider<JsonlDocument>`（文档模型仍为扩展自有）：脏标记 / 撤销重做 / Ctrl+S / Hot Exit | `de3467c` |
| 原文回传 | `readRecord` 回 `rawText`/`rawBytes` —— 编辑初始文本必须是磁盘原文，另有乐观锁依据 | `de2f05f` |
| 编辑 UI | `editLogic.ts` + `editPanel.ts` + 列表右键/详情工具双入口 + `DOCUMENT_RESET` 处理 | `1e08859` |

**M2 部分交付（2026-09-22）：任意行增删已落地**

关键简化：插入与删除本质都是「用一段字节替换一个区间」——**插入是空区间、删除是空 replacement**。故把 `replaceLine` 泛化为写入层唯一原语 `replaceRange`，三者共用一套搬移/备份/错误翻译（否则会把「Δ>0 倒序、Δ<0 正序」这种易错细节复制三份）。

| 环节 | 产出 | 提交 |
|---|---|---|
| 写入原语 | `replaceRange(path, range, replacement)`；`replaceLine` 退化为薄封装 | `1c432ab` |
| 索引增量 | `applyLineInsert` / `applyLineDelete`（含空文件锚点、删末行检查点两个边界） | `4d9278f` |
| host 链路 | `DataService.deleteRecord` / `insertRecord` + `INSERT_RECORD`/`DELETE_RECORD` 端点；编辑事件加 `kind` 供撤销分派 | `7eb755e` |
| webview | 右键「在第 N 行前插入」/「删除第 N 行」+ 删除二次确认（复用横幅，webview 里 `confirm` 不可用） | `bac4afc` |
| harness | 数据源改可变行数组，增删可真实验证 | `d7873ee` |

### M2 查找替换交付（2026-09-22）

| 环节 | 产出 | 提交 |
|---|---|---|
| 写入原语 | `rewriteWithEdits` —— 写同目录临时文件 + 原子 rename；`IndexHost.releaseFile/reacquireFile` | `cb2e8f5` |
| 替换规则 | `src/core/replaceLogic.ts`（零依赖，宿主与 webview 共用判定规则） | `a976f21` |
| host 链路 | `DataService.replaceText` / `applyLineTexts` / 私有 `applyEdits` + `REPLACE_TEXT`/`REPLACE_RESULT` | `98adb10` |
| webview | 搜索框内互换图标展开替换行 + 「全部替换」+ 横幅二次确认 + 结果如实报跳过数 | `8cc7b5d` |
| harness | `replaceText` mock，按真实宿主语义实现 | `1c5357e` |

#### 关键设计：批量改写为什么不用「逐处倒序搬移」

M1/M2 的 `replaceRange` 一次只能改**一处**，成本是「改动点距 EOF 的字节数」。批量替换若逐处调用它：

| 维度 | 逐处倒序 `replaceRange` | **全量重写 + 原子 rename** |
|---|---|---|
| 成本 | `Σ(每处改动点距 EOF)`，命中行散落全文件时可达数十倍文件大小 | **O(文件大小)，与编辑处数无关** |
| 原子性 | ❌ 中途失败留下「改了一半」的半成品 | ✅ rename 之前目标文件始终原封不动 |
| 临时空间 | 无需求 | 需要等量空间（故设 `MAX_BATCH_REWRITE_BYTES` = 1GB 上限，超限**拒绝**而非降级） |

批量改写最怕的正是「改了一半」——所以这里宁可拒绝也不做无原子性的降级。撤消同理：`applyLineTexts` 走同一条原子路径，而不是逐行 `editRecord`（那会是 N 次尾部搬移）。

**一个平台细节**：Windows 会拒绝 `rename` 覆盖一个仍被其它句柄打开的文件（EPERM），而主线程 `DataService` 与索引宿主（主线程兜底或 worker）**各持一个 reader**。故重写前后必须`releaseFileHandles()` → 重写 → `acquireFileHandles()` 严格配对（放在 `finally` 里，失败也要拿回来）。

**一条不可让步的规则**：替换后 JSON 非法的行**跳过而非整批拒绝**（个别行失败不该拖垮整体），但结果文案必须如实报出跳过数 —— 用户点完「全部替换」后最危险的误解就是以为全改完了。

### M2 进度 / 成本分级 / 取消交付（2026-09-23）

| 环节 | 产出 | 提交 |
|---|---|---|
| host 进度与取消 | `EDIT_PROGRESS` 推送 + `ReplaceOpts.onProgress/shouldCancel` + 节流 + `WriteCancelledError` → `cancelled` | `b531b20` |
| 成本分级与进度 UI | `estimateBatchCost` / `replaceConfirmText` / `replaceProgressText` + `banner.setText` + 取消入口 | `b97387d` |
| harness | 模拟 4 拍进度与真实取消 | `d2e5164` |

**三条值得记住的判断**：

1. **成本按「文件大小」估算，而非命中行数** —— 这恰恰是选「全量重写 + 原子 rename」换来的性质。逐处倒序搬移才是 `Σ(改动点距 EOF)`，那时只能按命中分布估；现在成本与命中数**无关**，估算因此简单且准确。
2. **取消与失败必须严格分开** —— 批量重写在 `rename` **之前**中止，目标文件从未被触碰，是**零风险**的。把它报成「失败」会让用户以为文件可能损坏，那是与事实相反的恐慌。UI 文案因此是「已取消：文件未被修改」。
3. **进度终态不节流** —— 底层按 4MB 分块回调（1GB 文件 250 次），故按 100ms 节流；但 `processed === total` 那次必发。**停在 96% 的进度条比没有进度条更糟**，用户会以为卡死了。

**一个易错细节**：进度更新必须走 `banner.setText()` 而非 `banner.show()` —— 后者会重设 action 按钮，表现为「取消」按钮每次进度回调都闪烁/被重建。集成测试用「按钮必须是同一个节点」把这条钉住了。

### M2 多选批量删除 / 复制交付（2026-09-23）

| 环节 | 产出 | 提交 |
|---|---|---|
| host 链路 | `deleteRecords`（相邻区间合并）+ `insertRanges`（撤销）+ `readLinesText` + 协议端点 | `44f5104` |
| webview | Ctrl/Shift 多选 + 选区操作条 + 右键批量项 + 复制/删除 + `deleteMany` 撤销 | `921590d` |
| harness | `deleteRecords` / `copyLines` mock | `1c4ca92` |

#### 关键设计：删除与撤销**共用同一组区间偏移**

删除多行与恢复多行看似是两件事，其实是同一次编辑的两个方向：

| 操作 | 编辑列表 |
|---|---|
| 删除 | `{ start, end, replacement: 空 }` |
| 撤销 | `{ start: start, end: start, replacement: 原内容 }` |

之所以能用**同一组 `start`**：删除不会改变「删除点之前」的任何偏移。于是撤销与删除一样是**一次原子重写**，而不是 N 次逐行插入 —— 撤销掉 5000 行的删除，代价仍是 O(文件大小)。

**第二个优化**：**相邻行合并成连续区间**。框选一整段连续行是最常见的多选场景（如「删掉第 100–600 行这批坏数据」），合并后编辑数从 N 降到 1。测试里专门验证「80 个连续行 → 1 个区间」。

**两个必须精确的地方**（都靠测试钉住）：
- 索引删行要**倒序**应用 `applyLineDelete` —— 它的语义是「在现有索引上删第 line 行」，倒序才能保证每次的行号还没被后面的删除影响。
- 撤销时 `applyLineInsert` 必须**逐行给出精确字节数**（故 `DeletedRange` 回传 `lineBytes`）。用「总字节 ÷ 行数」的平均值平移检查点会让检查点错位，`scan` 随即读到错误位置 —— 测试用长度刻意不同的一组行（`1`/`22`/`333`/`4444`/`55555` 字节）来暴露这个错误。

**一条 UI 一致性约束**：选中视觉**以选区为准**，选区为空时才退化为「当前行」单选视觉。若两者都标记，会出现「视觉上是选中的、选区里却没有它」—— 而用户接下来的批量操作按选区执行，那种不一致的后果是**删错行**。

### 会话编辑历史交付（2026-09-23，M3 提前）

| 环节 | 产出 | 提交 |
|---|---|---|
| 索引缺陷修复 | `applyLineInsert(0)` 补回第 0 行锚点（**由本轮测试逮出的真实缺陷**） | `38554f8` |
| host 历史模型 | `HistoryOp` 双向操作 + `historyCursor` 单一光标 + `undoStep/redoStep/setHistoryCursor/revertTo` + 协议端点 | `b138463` |
| provider 收敛 | `reportEdit` 由「按 kind 分派五套逆操作」收敛为**委托宿主同一光标** | `b138463` |
| webview 浮层 | 工具栏「历史」入口 + 倒序列表 + 单步撤销/重做 + 「停在这一步」 | `d1905dc` |
| harness | 快照式历史 mock（光标语义与宿主一致） | `bf00ba6` |

#### 关键设计：**单一光标模型**

`history` 数组 + `historyCursor`（之前的为「已应用」、之后的为「已撤销」）。于是：

| 操作 | 实现 |
|---|---|
| `Ctrl+Z` | 光标 −1 |
| 历史浮层「停在这一步」 | 光标移到目标位置 |
| 重做 | 光标 +1 |

**只有一份状态，所以不可能各说各话。** 若做成「VS Code 撤销栈 + 独立历史面板」两套，用户按了 Ctrl+Z 而面板仍标「已应用」是迟早的事 —— 这正是本轮把 provider 的撤销逻辑一并收敛的原因（删掉了按 kind 分派的五套逆操作）。

**语义必须跨层对齐**：`revertTo(id)` 定为「让该条成为**最新已应用**」（光标 = idx+1），与浮层文案「停在这一步」一致。若用「撤销该条本身」（光标 = idx），点最新一条会**意外触发一次撤销** —— 这个差一步的不一致是在写测试时才被发现的。

**上限并用条数与总字节**（50 条 / 16MB）：批量删除的每一条都可能携带 MB 级原文，只限条数的话 50 条足以吃光内存。超限从最旧丢弃并同步光标，同时标记 `dropped`。

**重新加载即作废历史**：行号与偏移在重载后整体失效，用旧历史回退会**改到错误的行**上 —— 这比「不能撤销」危险得多。

#### 本轮测试逮出的真实缺陷（值得记住的案例）

「五种操作混合后一路撤销到底」这条测试首次运行就失败了。根因**不在本轮新代码**，而在 M2 就存在的 `LineIndex.applyLineInsert`：

> 检查点平移条件是 `cp.line >= line`。当 `line === 0` 时，唯一的 `{line:0, offset:0}` 锚点被平移到 `{line:1}`，索引失去「≤ 目标行的最近起点」—— `scan` **找不到顺读起点，静默返回空**（不报错）。

外部表现极具迷惑性：`totalLines` 说 4 行，`readRecord(0)` 却报「行不存在」。排查时先怀疑了「行过大」「reader 失效」，最后才回到索引。这也暴露了 `probeLine` 的文案问题（三种失败原因共用一句「无法定位该行（可能过大）」），已一并细分为越界 / 行过大 / 索引不一致。

该路径由「撤销批量删除」真实触发（把被删的行插回文件开头），M2 的测试之所以没覆盖，是因为那里的插入点是 1（在锚点之后，不受影响）。

**教训**：单个操作的往返测试**不足以**发现问题，需要**多个不同性质的操作串起来跑一遍**（这里恰好是「先改、再插、再删、再批量替换、再批量删除，然后一路撤销到底」）。

**剩余**：详情树字段级编辑、单行编辑的进度与取消。

### 坏行诊断交付（2026-09-23）

`DataService.knownBadLines` 从「只写不读的死状态」变成了数据清洗的入口 —— 补齐了它当初设计时留下的最后一段链路（`inferFields` 早已算出 `errorLines` 却只被倒进这个黑洞，`OverviewPayload` 里那句「将来可扩展：坏行集合」也一直没接上）。

| 环节 | 产出 | 提交 |
|---|---|---|
| host 查询 + 全文件扫描 + 协议 | `getBadLines` / `scanBadLines` / `HostReply.BAD_LINES` | `12a3728` |
| webview 徽章 + 诊断浮层 + 全选清除 | `badLinesPanel.ts` / 工具栏徽章 | `c3bb5ff` |
| harness mock（含 4 拍进度与可取消） | `getBadLines` / `scanBadLines` 分支 | `ef34e03` |

**核心是一条语义纪律：把「已发现」与「全量」严格分开。**

`knownBadLines` 只覆盖**已检查范围**（用户读过 / 抽样过的行）。据它判断「文件是否干净」会得出与事实相反的结论 —— 而「这文件到底有多少坏行」恰恰是数据清洗的第一问。故两条能力分开提供，界面上也必须一眼可分：

| 状态 | 徽章 | 浮层状态行 | 额外提示 |
|---|---|---|---|
| 未扫描 | `⚠ 3+ 坏行`（虚线边框） | 已发现 3 个坏行（仅在已浏览范围内） | 「这不代表文件只有这些坏行」 |
| 已扫描 | `⚠ 3 坏行` | 共 3 个坏行 | — |

一个偏小的确数比一个诚实的下界危险得多：用户可能据此认定「文件基本干净」，从而放过整批脏数据。

**另外三条判断**：

- **只回行号、不回错误摘要**：扫描时若同时收集每行错误消息，20 万行的内存与载荷都要翻倍；而用户真正需要的是「坏在哪」—— 点击即跳转，跳过去就看到真实错误。不编造摘要，就不会有摘要是错的。
- **扫描判定口径必须与列表红标完全一致**：超长行按 `isOversized` 视作合法（列表同样不解析它）。否则会出现「列表说好、扫描说坏」这类最难解释的不一致。
- **取消不替换已发现集合**：半份扫描结果看起来像「文件很干净」，比没有结果更糟。

**一处刻意的复用**：扫描进度复用 `EDIT_PROGRESS` 通道（`kind` 由 `'replace'` 扩为 `'replace' | 'scanBadLines'`）。该通道表达的本就是「长任务的字节级进度」，与任务语义无关 —— 加一种长任务不该再造一条推送链路。

**完整性标记的失效收口**：`badLinesComplete` 在 `refreshSnapshot`（写盘成功的唯一收口点）与 `dispose` 里降级。放在收口点而非 7 个写方法里各写一遍 —— 漏掉任何一处，都会让前端拿一份过期的「全量」结论去说服用户。


---

## 4. 关键设计

### 4.1 写入层：把"成本"算清楚

编辑一行的物理动作分两种：

| 情形 | 条件 | 磁盘动作 | 成本 |
|---|---|---|---|
| **等长覆写** | 新行字节数 == 旧行字节数 | `fd.write` 直接覆盖 `[start, end)` | **O(1) + 落盘**，最快路径 |
| **变长替换** | Δ = 新长 − 旧长 ≠ 0 | 倒序分块搬移 `[end, EOF)` → `[end+Δ, EOF+Δ)`，再写入新行 | **O(文件末尾 − 改动点)** |

**关键认知**：变长编辑的代价取决于**改动点距 EOF 的字节数**，不是文件总大小。所以分级阈值应按这个量算，而不是按文件大小：

```
cost = totalBytes - lineEnd(line)      // 需要搬移的尾部字节数
```

建议分级（阈值可配）：

| `cost` | 策略 |
|---|---|
| == 0（末行） | 直接写，无搬移 |
| ≤ 32 MB | 同步原地搬移，用户无感 |
| ≤ 512 MB | 后台执行 + 进度条 + 可取消 |
| > 512 MB | 明确提示预计代价，由用户确认后再执行 |

**为什么不用"写临时文件 + rename"**：那必然 O(文件大小) 全量复制，对 GB 级文件不可接受。原地搬移虽非原子，但配合下述备份策略足够安全。

**崩溃安全**：变长写入前，把**被搬移的尾部区域的字节数**记入 sidecar journal，并备份被替换原行的原始字节（undo 必需）。真正恢复能力有限（GB 级尾部无法全量备份），因此：
- 变长编辑前给用户一次"可撤销提示"；
- 提供配置项 `jsonlViewer.editing.backupBeforeWrite`（默认 `true`）：写入前把**原文件**复制为 `<name>.jsonl.bak`（仅当文件 ≤ 可配阈值，默认 64 MB；超过则只记 journal）。

### 4.2 索引增量更新：稀疏检查点的红利

修改第 `L` 行、长度变化 `Δ`：

```
for cp of checkpoints where cp.line > L:  cp.offset += Δ
totalBytes += Δ
totalLines 不变            // 行替换不增删行
```

- 复杂度 **O(总行数 / 1024)**：1000 万行文件 ≈ 1 万次加法，微秒级。
- `LineIndex` 当前字段为 `readonly` 且类不可变 → 建议**新增方法而非改字段**：
  - `LineIndex.applyLineReplace(line, deltaBytes): LineIndex`（返回新实例，共享未受影响部分或复制检查点数组）；
  - 复制检查点数组的成本同样是 O(检查点数)，可接受。
- 由于 `DataService` 按引用持有 `index`，需保证**替换是原子引用切换**（写完盘 → 换新 index → 再回执），避免"读了新索引、写了旧文件"的窗口。

**插入/删除行的额外处理**（M2）：

```
插入第 L 行（Δ = 新行字节数）:
  cp.line  += 1   for cp.line >= L
  cp.offset += Δ  for cp.line >= L
  totalLines += 1; totalBytes += Δ
```

**重要洞察**：插入行会让检查点间隔变得**不均匀**（有的 1023、有的 1025 行）。这**不会破坏正确性**——`scan()` 只要求"从 ≤ 目标行的最近检查点开始顺读"，并不要求间隔均匀（`src/indexer/lineIndex.ts:154-164, 197-201`）。代价仅是长期频繁插入后个别区间变长、顺读略慢。可在 `totalLines` 变化累计超过阈值时提示"建议重新加载以重采样索引"。

### 4.3 脏状态 / 撤销 / 保存（升级可写 provider）

需要实现：

```ts
interface CustomEditorProvider<T extends CustomDocument> {
  openCustomDocument(uri, openContext, token): T | Thenable<T>;
  resolveCustomEditor(document: T, panel: WebviewPanel, token): void | Thenable<void>;
  saveCustomDocument(document: T, cancellation: CancellationToken): Thenable<void>;
  saveCustomDocumentAs(document: T, destination: Uri, cancellation): Thenable<void>;
  revertCustomDocument(document: T, cancellation): Thenable<void>;
  backupCustomDocument(document: T, context: CustomDocumentBackupContext, cancellation):
      Thenable<CustomDocumentBackup>;
  onDidChangeCustomDocument: Event<CustomDocumentEditEvent<T> | CustomDocumentContentChangeEvent<T>>;
}
```

设计要点：
- 每次"行替换"包装成一个 `CustomDocumentEditEvent`，其 `undo()` / `redo()` 回调反向（或再次）执行同一次写入；`label` 用中文，如 `编辑第 N 行`。
- **撤销栈由 VS Code 托管**，我们只在对象里保存 `{line, before, after}` 即可，无需自研栈。
- `saveCustomDocument`：把内存中的"待写编辑"批量落盘（若采用"即时写盘 + 仅标记脏"策略，则此方法只需更新基线快照并清脏）。
- **推荐策略：即时写盘**（编辑即写入）+ 用 `onDidChangeCustomDocument` 上报以驱动脏标记与撤销。理由：可避免"关闭时批量写 GB 级文件"的最坏体验，且实现最简单。
- `backupCustomDocument`：把未保存编辑序列化为 JSON 落盘（VS Code 指定路径），供 Hot Exit 恢复。
- **`supportsMultipleEditorsPerDocument` 需改为 `false`**：同一文件多编辑器会共享同一 document 与撤销栈，"仅查看"场景能容忍，编辑场景容易产生语义混乱。

### 4.4 自写抑制与并发冲突

**必须解决**：自己写完盘 → `mtime` 变化 → 5s 轮询立刻推 `FILE_STALE` 横幅（误报）。

正确解法（不是"抑制 N 秒"，而是**同步基线**）：

```
写入成功
  → 重新 stat，把 DataService.snapshot 重置为写入后的 size/mtime
  → 同步更新索引（§4.2）
  → 完成。轮询下一拍自然返回 changed:false
```

**并发冲突检测**（外部程序也改了文件）：

```
写入前：stat 与当前基线比对
  不一致 → 拒绝写入，回执 conflict，webview 提示"文件已被外部修改，请先重新加载"
  一致   → 执行写入
```

注意 `checkStale()` 的 `staleSignaled` 防抖逻辑（`src/extension.ts:391-403`）在编辑场景下需要能复位——写入后应允许"正常态"重置。

### 4.5 校验、编码与行尾

| 关注点 | 设计 |
|---|---|
| JSON 校验 | 保存前 `parseJsonLine()` 复用（`src/parser/jsonParser.ts:47`），`ok=false` 时**默认拒绝**并回显 `error`（已含列号）；另给"强制保存"逃生门（明确告知该行将变为坏行） |
| 行尾符 | `scan()` 的 `end - start` 减去 `trimLineEnding` 后长度即可推断原行尾是 `\n` 还是 `\r\n`；**替换时保留原风格**；末行原本无换行则保持无换行。（建议顺手把该推断补成 `lineIndex` 的一个小工具函数） |
| BOM | `parseJsonLine` 走 `String.prototype.trim()`，会吃掉 `\uFEFF`，故解析不受影响；**原地写入不触碰文件头，BOM 天然保留**（整文件重写方案才需要专门处理） |
| 编码 | 假定 UTF-8（与现有 `toString('utf8')` 一致）。非 UTF-8 文件当前就会被视为坏行，编辑不改变这一边界 |
| 超长行 | 超过 `MAX_LINE_BYTES`(16 MiB) 的行**禁止编辑**（无法安全读回），给出明确提示 |
| 权限 | `EACCES`/`EPERM`/`EROFS` 需转成可读中文提示（如"文件只读或无写入权限"），并禁用编辑入口 |

### 4.6 协议扩展（RPC）

在 `HostEndpoint` / `HostReply` 各加端点，**照 `HostHandlerMap` 的注册表模式扩展即可，`dispatchMessage` 本体不需改动**（`src/protocol/rpc.ts:243-248` 已声明 OCP 设计意图）：

```ts
HostEndpoint.EDIT_RECORD   = 'editRecord'    // { line, text, expectedBytes? } → 单行替换
HostEndpoint.INSERT_RECORD = 'insertRecord'  // { at, text }                 → 在其前插入（M2）
HostEndpoint.DELETE_RECORD = 'deleteRecord'  // { line }                    → 删除（M2）
HostEndpoint.REPLACE_TEXT  = 'replaceText'   // { query, replacement }      → 全文批量替换（M2）
HostReply.EDIT_RESULT      = 'editResult'    // { line, ok, bytesDelta, costMs, conflict? }
HostReply.REPLACE_RESULT   = 'replaceResult' // { ok, replaced, skippedInvalid, unchanged, changes?, undoable }
```

要点：
- 请求体带上**期望的旧行字节长度**（乐观锁），与磁盘实际不符即判冲突；
- 编辑类请求纳入 `cancel` 集合（复用现有可中断机制）；
- 回执带上 `bytesDelta`，webview 可据此本地推算列表缓存是否需要失效。

### 4.7 UI 入口与交互（M2）

- **入口**：列表卡片右键菜单扩一项「编辑记录」（现有菜单已有"定位到源码行/复制行号/复制 JSON"）；详情树工具区加「编辑 JSON」按钮。
- **编辑器形态**：右栏详情区切换为"编辑态"——等宽字体的**原始 JSON 文本编辑器**（`textarea`）+ 行内错误提示 + 「格式化」+「保存/取消」。理由：字段级树编辑对大对象复杂度高、收益低；原始文本编辑语义清晰、实现可控、与 JSONL 的行粒度天然对齐。
- **保存快捷键**：`Ctrl+S` 交给 VS Code 的脏文档机制；编辑态内额外支持 `Esc` 取消、`Ctrl+Enter` 保存。
- **反馈**：写入进行中显示进度（大 `cost` 时）；失败给明确原因（冲突 / 权限 / 磁盘满 / 校验不过）。
- 视觉与动效**必须**遵循 `docs/DESIGN_SYSTEM.md`（令牌、动效只动 transform/opacity、`prefers-reduced-motion` 兜底）。

### 4.8 查找替换（M2 实际实现）

- **不另造预览机制**：`replaceText` 复用既有搜索定位命中行 —— 用户在工具栏已经看到命中数，搜索即预览。
- **入口**：搜索框内的互换图标展开「替换为…」输入行（默认收起，不长期占据工具区）；「全部替换」在搜索框为空时提示并自动展开替换行。
- **二次确认走顶部横幅**，不用 `window.confirm`（webview 沙箱拦截阻塞式对话框）。
- **失败与跳过必须如实报出**：文案形如「已替换 3 行；1 行因替换后 JSON 非法已跳过」，超限时追「未纳入撤销栈」。
- **撤销是整批的**：`replaceAll` 映射为一次 `applyLineTexts`，而非 N 次逐行撤销（后者会让用户看到「改了一半」的中间态）。
- **查询为空一律拒绝**：空串会匹配每一行的每个位置，那不是替换而是毁文件。命中数达搜索上限时同样拒绝（无法确认待改行的全集）。

---

## 5. 风险清单

| 风险 | 等级 | 对策 |
|---|---|---|
| 变长编辑产生 O(尾部) 搬移，大文件编辑首行极慢 | **高** | §4.1 分级阈值 + 进度 + 可取消 + 明确告知 |
| 原地搬移中途崩溃 → 文件损坏 | **高** | 写前 journal / 小文件全量备份；搬移采用分块倒序，缩小损坏窗口 |
| 自写被误判为外部变更（横幅误报） | 中 | §4.4 同步基线（不要用定时抑制） |
| 编辑与外部修改竞争 | 中 | 写前 stat 比对 + 乐观锁（期望旧长度） |
| 撤销/重做与磁盘状态不一致 | 中 | 即时写盘 + 每次编辑都可逆；`revertCustomDocument` 从磁盘重建索引与视图 |
| 索引与磁盘短暂不一致（读到新索引、写的是旧文件） | 中 | 严格时序：写盘成功 → 再换索引引用 → 再回执 |
| 文档过时误导后续实现 | 中 | 先修 §1.2 两处 |
| 覆盖率门槛（96/86/88）被新代码拉低 | 低 | 新模块按现有风格配 `__tests__`；写入逻辑用 `MemoryReader` + 临时文件做单测 |
| 前端风格漂移 | 低 | 实现前读 `DESIGN_SYSTEM.md` |
| 批量重写需要等量临时空间（1GB 文件即 1GB 临时文件） | 中 | `MAX_BATCH_REWRITE_BYTES` 设上限并拒绝；`ENOSPC` 翻译为「磁盘空间不足」；临时文件同目录以免跨分区 |
| Windows 下 `rename` 覆盖被占用文件会失败 | **高** | 重写前 `releaseFileHandles()` 松开**主线程与 worker 两侧**的 reader，重写后 `finally` 中拿回；`EPERM/EBUSY` 翻译为可操作提示 |
| 用户误以为「全部替换」改完了（实际有行被跳过） | 中 | 结果文案强制包含跳过数与原因；`skippedInvalid` 与 `replaced` 同等醒目 |

---

## 6. 决策记录（原「待决问题」，2026-09-22 已定）

| # | 问题 | 决策 | 落实位置 |
|---|---|---|---|
| 1 | 编辑范围 | 第一版为**行级替换（行数不变）**；增删行留到 M2 | `DataService.editRecord` |
| 2 | 大文件策略 | **提示代价 + 由用户确认**（按「剩余行数占比」保守估算，超 32MB 即提示）；不设硬性只读上限 | `editLogic.estimateEditCost` / `editCostWarning` |
| 3 | 写盘时机 | **即时写盘** —— 不会在关闭时批量写出 GB 级数据（延迟写盘在大文件上的真实风险） | provider 的 `saveCustomDocument` 为空实现 |
| 4 | 多编辑器开关 | `supportsMultipleEditorsPerDocument` 改 **false**（编辑语义下多编辑器共享撤销栈会错乱） | `extension.ts` |
| 5 | 格式化策略 | **默认保持原样**，格式化做成显式命令（重排会放大变长编辑的搬移成本） | `editPanel` 的「格式化」按钮 |
| 6 | M1 撤稿线 | M1 直接做到**最小可用编辑**（不止地基） | 本次交付 |
| 7 | 初始文本来源 | **磁盘原文**（`readRecord.rawText`），绝不用 `value` 重新序列化 | `jsonParser.readRecord` / `openEditForLine` |
| 8 | 批量替换的写入策略 | **全量重写 + 原子 rename**，不做逐处搬移的降级路径（宁可拒绝也不留在无原子性的路径上）；上限 1GB | `fileWriter.rewriteWithEdits` |
| 9 | 替换后 JSON 非法的行 | **跳过该行**并如实报出跳过数，而非整批拒绝 | `core/replaceLogic.planLineReplace` |
| 10 | 匹配语义 | **字面量、非重叠、大小写不敏感**（折叠只折 ASCII A-Z 且长度不变），与搜索保持一致 | 同上 |
| 11 | 批量撤销粒度 | **整批一次**（`applyLineTexts`），超 2000 行 / 8MB 时不入撤销栈并明确告知 | `DataService.applyLineTexts` / `MAX_REPLACE_UNDO_*` |
| 12 | 长任务的可取消性 | 批量替换**可取消** —— 它在 rename 之前中止，目标文件从未被触碰；取消与失败在协议与文案上**严格分开** | `ReplaceOpts.shouldCancel` / `ReplaceResultPayload.cancelled` |
| 13 | 进度上报策略 | 按 100ms 节流，但**终态必发**（停在 96% 的进度条比没有更糟）；进度更新只改文字、不重建按钮 | `throttleProgress` / `banner.setText` |
| 14 | 成本估算依据 | 批量替换按**文件大小**（与命中数无关），估算值写入确认文案并说明「为什么慢」 | `editLogic.estimateBatchCost` / `replaceConfirmText` |
| 15 | 多选上限 | 5000 行；前端拒绝并提示 + host 侧同样防御（不信任前端）；范围选取**先算长度再分配**（`Array.from({length: 1e6})` 会当场吃掉几十 MB） | `MAX_SELECTION_LINES` |
| 16 | 删除后选区处理 | **整体复位**而非按位移推算 —— 用户看到一批内容消失，把选中留在某个「碰巧算对」的行上比清空更令人困惑 | `applyBulkDelete` |
| 17 | 撤销机制的唯一性 | **单一光标模型**：Ctrl+Z 与历史浮层共用宿主同一份状态；provider 的撤销收敛为委托（删除按 kind 分派的五套逆操作） | `DataService.historyCursor` / `reportEdit` |
| 18 | 「回退到此处」的语义 | **让该条成为最新已应用**（光标 = idx+1），与「停在这一步」的文案对齐；用「撤销该条本身」会让点最新一条意外触发一次撤销 | `revertTo` / `historyPanel.requestStopAt` |
| 19 | 历史容量 | 条数（50）与总字节（16MB）**并用**；超限丢最旧并同步光标、标记 `dropped`（UI 必须如实标注） | `MAX_HISTORY_*` |
| 20 | 历史何时失效 | `reload` / `dispose` 即整体作废 —— 行号与偏移已失效，用旧历史回退会**改到错误的行**（比不能撤销危险得多） | `DataService.dispose` |
| 21 | `knownBadLines` 的出路 | **接入坏行视图**（出路 ①），而非删除或标注预留 —— 它不是冗余状态，而是 `inferFields.errorLines`（早已算出的坏行信息）唯一的落点；链路断在「没有出口」而非「算得不对」，删除只会把问题从「死状态」变成「白算一遍」 | §3「坏行诊断交付」 |
| 22 | 「已发现」与「全量」的区分 | 两者在协议（`partial`）、界面（`N+` vs `N`、虚线边框、提示语）上**都必须可分** —— 一个偏小的确数会让用户认定「文件基本干净」，比一个诚实的下界危险得多 | `BadLinesPayload.partial` / 工具栏徽章 |
| 23 | 坏行扫描的判定口径 | **与列表红标完全一致**：超长行按 `isOversized` 视作合法（列表同样不解析它），只有 scan 的 `error` 与 JSON 解析失败才算坏行 —— 否则会出现「列表说好、扫描说坏」这类最难解释的不一致 | `DataService.scanBadLines` |
| 24 | 扫描取消失败时的状态 | 取消**不替换**已发现集合（半份结果看起来像「文件很干净」，比没有结果更糟）；`cancelled` 与失败严格分开报 | 同上 |
| 25 | 完整性标记的失效收口 | `badLinesComplete` 只在 `refreshSnapshot`（写盘成功的唯一收口点）与 `dispose` 降级 —— 放在收口点而非 7 个写方法里各写一遍，漏一处就会让前端拿过期结论说服用户 | `DataService.refreshSnapshot` |

### 已知限制（会话编辑历史）

- **VS Code 撤销栈的深度可能与宿主光标错位**：若用户先在历史浮层里跳着回退了若干步，再按 Ctrl+Z，VS Code 认为在撤销「第 N 步」而宿主的光标已退了几步。**状态始终一致**（都以宿主为准），只是 VS Code 显示的 label 可能对不上。要对齐需要能读 VS Code 的栈深度 —— 那属于未公开 API，不做。
- **历史不跨会话**：标签页关闭即丢失（不做持久化：回退数据可能达 MB 级，落盘需要额外的容量与隐私考量）。

### 仍未决（待实机验证后再定）

- **provider 运行时行为**：沙箱无直连外网，`@vscode/test-electron` 集成测试跑不了 → 需本机 F5 验证大文件打开、编辑、`Ctrl+Z`、`File: Revert File`。
- **单行编辑的取消**：批量替换的取消已做（且是零风险的）。单行编辑不同——`replaceLine` 在变长搬移中途取消会留下**半搬移状态**（依赖 sidecar 备份恢复），产品语义尚不明确：是「保留 sidecar 并提示手动恢复」，还是「取消后立刻自动回滚」？后者需要把已搬移的部分搬回去，可能比原操作更慢。需先定这个语义再接线 UI。
- **单行编辑的进度**：`replaceRange` 已有 `onProgress`，但单行编辑多在毫秒级完成；只有「编辑大文件首行」这类极端情况才需要进度条，优先级低于上面的取消语义。
- **字段级替换**：当前替换作用于整行文本（不改动 JSON 结构外的语义）。若要「只替换某字段的值」，需要把字段值在原文中的位置映射出来，复杂度明显更高。
- **正则替换**：刻意未做（见 §4.8 与 `replaceLogic` 文件头规则 1）。若后续要加，需先设计「预览全部命中」的交互，否则一次错误的正则就是一次不可控的大面积改写。
- **覆盖率统计口径**（2026-09-23 修正）：沙箱环境下 `node --test-coverage` 会把 WorkBuddy 注入的外部 shim（`broker-ipc-client.cjs` 等，覆盖率仅 15%~44%）一并计入，把整体从 96% 拉到 89% 制造假警报。已在 `package.json` 的 `test:coverage*` 脚本加 `--test-coverage-include="src/**/*.ts"` 限定，只统计项目源码。**修正后的真实基线是 96.13 / 86.46 / 88.66**（此前记录的 97.01 是不同环境下的口径，不作对比基准）。
