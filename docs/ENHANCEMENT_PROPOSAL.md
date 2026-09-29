# JSONL Viewer — 功能增强建议（基于当前代码实测）

> 日期：2026-09-28 · 基线：`v1.10.0`（`package.json`）· 源文件 **46 个非测试模块 / 约 18k 行**，测试 **45 个文件**，运行时依赖 **0**，覆盖率门槛 **96 / 86 / 88**。
> 方法：通读 `host` / `webview` / `core` / `protocol` 全量源 + 既有 9 篇文档（重点避开已记录、已修复、已决策项），关键结论**回读代码逐条核实**；未能实测（需 F5/集成环境）的推断在 §5 明确标注。
> 证据格式：`文件:行`。定位以当前工作树为准。

---

## 0. 速览

### 0.1 产品定位（一句话）

在 VS Code 里用「记录列表 + 可折叠 JSON 树详情」**秒开多 GB 级** `.jsonl / .ndjson`，且已经**具备写能力**（行级编辑 / 批量替换 / 字段级替换 / 会话撤销）。核心卖点是「打开 = 一遍流式扫描 + 永不整文件载入」（`docs/EDIT_FEATURE_PLAN.md:16` 正是以这一点论证编辑方案可行）。

### 0.2 能力边界（已从代码确认，避免重复造轮子）

| 维度 | **已有**（备注 / 位置） | **确认没有**（空白即可做的新功能） |
|---|---|---|
| 索引与 IO | 稀疏检查点（每 1024 行，`constants.ts:15`）、按需随机读、记录分组（多行 pretty，`lineIndex.ts:104-126`） | 增量追加（tail -f 式跟进）；只有全量重建 |
| 列表 | 分页目录 20 条/页（`constants.ts:197`）、LRU 600 条（`appState.ts:28`）、跳**页码**（`virtualScroll.ts:694-712`） | 连续滚动；**跳记录号/行号**；命中高亮；表格/列视图 |
| 查询 | 全文 / 字段搜索、字段值过滤（`searchEngine.ts`）；单条件 `FieldCondition`（`core/query.ts:26`） | **多条件组合过滤（AND/OR）**；详情树内查找 |
| 编辑 | 行级编辑/插入/删除、批量文本替换、批量字段替换、会话历史 undo/redo/revert（`HostEndpoint` 全集） | 导出子集到新文件（详见 F5）；跨会话撤销 |
| 诊断 | 坏行徽章 + 全文件扫描（`scanBadLines`）；字段推断仅抽样**前 200 条**（`inferFields.ts:174`、`constants.ts:200`） | **全量 Schema / 数据质量画像** |
| 变更感知 | 5s `stat` 轮询 → `FILE_STALE` 横幅（`dataService.ts:421-435`） | 文件增长自动跟进；sidecar 孤儿备份检测 |
| 偏好 | 按文件 URI 持久化（字段布局 / 过滤 / 搜索词，`persistence.ts`） | 命名视图 / 书签（跨文件复用） |

### 0.3 总优先级表（价值 / 成本降序）

| # | 项 | 类别 | 价值 | 成本 | 比 | 批次 |
|---|---|---|---|---|---|---|
| 1 | ~~**O1** 修复「写后 `host` 索引永远陈旧」~~ ✅ **已修（2026-09-29）** | 优化·正确性 | 极高 | 中 | ★★★★★ | ~~批次 0~~ |
| 2 | ~~**O2** 修复 `rebuildIndex` 泄漏旧 IndexHost/worker~~ ✅ **已修（2026-09-29）** | 优化·正确性 | 极高 | 极小 | ★★★★★ | ~~批次 0~~ |
| 3 | ~~**F2** 跳转记录号 / 行号~~ ✅ **已交付（2026-09-29）** | 新增 | 高 | 极小 | ★★★★★ | ~~批次 1~~ |
| 4 | ~~**O10** 浮层焦点落在「关闭」按钮~~ ✅ **已交付** | 优化·可达性 | 中 | 极小 | ★★★★☆ | ~~批次 1~~ |
| 5 | ~~**O3** 多行文件退化：`applyLine*` 丢弃记录分组~~ ✅ **已交付** | 优化·正确性 | 高 | 小–中 | ★★★★☆ | ~~批次 1~~ |
| 6 | ~~**F1** 搜索命中高亮 + 详情内查找~~ ✅ **已交付（2026-09-29）** | 新增 | 高 | 中 | ★★★★☆ | ~~批次 2~~ |
| 7 | ~~**O4** 被取消的查询结果被缓存 / 被批量替换采用~~ ✅ **已交付** | 优化·数据一致性 | 高 | 小 | ★★★★☆ | ~~批次 1~~ |
| 8 | ~~**O7** 写端点乐观锁覆盖不全~~ ✅ **已交付（2026-09-29）** | 优化·数据安全 | 高 | 中 | ★★★☆☆ | ~~批次 2~~ |
| 9 | ~~**F5** 导出子集到新文件~~ ✅ **已交付（2026-09-29）** | 新增 | 高 | 中 | ★★★☆☆ | ~~批次 2~~ |
| 10 | ~~**O5** `inferFields` 逐行重扫（读放大）~~ ✅ **已交付** | 优化·性能 | 中高 | 小 | ★★★☆☆ | ~~批次 2~~ |
| 11 | ~~**O6** `applyEdits` 索引更新 O(命中×检查点)~~ ✅ **已交付** | 优化·性能 | 中 | 小 | ★★★☆☆ | ~~批次 2~~ |
| 12 | ~~**O11** 错误被静默为「0 匹配」/ 永久「加载中…」~~ ✅ **已交付**（编辑/概览校正两处余留） | 优化·交互 | 中高 | 小–中 | ★★★☆☆ | ~~批次 2~~ |
| 13 | ~~**F3** 多条件组合过滤~~ ✅ **已交付（2026-09-29）** | 新增 | 高 | 中–大 | ★★★☆☆ | ~~批次 3~~ |
| 14 | ~~**F4** 全量 Schema / 质量画像~~ ✅ **已交付（2026-09-29）** | 新增 | 高 | 中 | ★★★☆☆ | ~~批次 3~~ |
| 15 | ~~**O8** sidecar 备份只写不读~~ ✅ **已交付（2026-09-29）** | 优化·数据安全 | 中 | 中 | ★★☆☆☆ | ~~批次 3~~ |
| 16 | ~~**O9** 分页器重建吞掉正在输入的页码~~ ✅ **已交付（随 F2 一并）** | 优化·交互 | 中 | 小 | ★★☆☆☆ | ~~批次 3~~ |
| 17 | **F6** 追尾模式（增量索引） | 新增 | 高 | 大 | ★★☆☆☆ | 批次 4 |
| 18 | **O13** ARIA/键盘 ~~✅ 已交付~~ · **O12** 详情树重建（未做） | 优化·体验 | 中 | 中 | ★★☆☆☆ | 批次 4（O12 留下） |
| 19 | **F7** 表格/列视图、**F8** 命名视图 | 新增 | 中 | 中–大 | ★☆☆☆☆ | 备选 |

> **批次 3 已交付三项（2026-09-29）**：F3（多条件组合过滤）、O8（遗留备份检测与恢复）、
> F4（全量 Schema / 数据质量画像）。**O14（`extension.ts` 单测）未做**，顺延 ——
> 它需要先把 handler 表从主入口抽成可测模块，动的是结构而非功能，单独一轮更稳妥。
>
> - **F4 的交付形态**：`host/profileEngine.ts` 照抄 `scanBadLines` 的骨架（同一条
>   `scanRecords` 记录分组路径 —— pretty 文件按物理行统计会把中间行全当垃圾），
>   完整性语义也对齐（`cancelled` = 没扫完 / `fieldsTruncated` = 扫完了但只留了这些）。
>   **内存有界是这个功能的生命线**（它是在多 GB 文件上跑全量）：只统计顶层 key、
>   每字段 top 5 且互异值容量 200（溢出归入「其他」并标记）、值文本截断 60 字符、
>   字段数上限 200、**不落盘缓存**。统计口径上 present / missing / nulls / empties
>   **四者互不混淆** —— 「键不存在」「显式 null」「空串」是三种不同的质量问题。
>   前端拆成 profileOps（域）/ profilePanel（浮层）/ profileLogic（纯展示文案）三层，
>   与 badLinesOps 同一分层；进度只改文案不重建节点；「筛选」用 exists 语义并复用
>   既有的筛选链路（不另开一条）；**中断的结果自曝**（抬头第一句就是「请勿据此判断」）。
>
> - **F3 的交付形态**：`core/query.ts` 的 `Condition = FieldCondition | ConditionGroup`，
>   组算子按「数组 + 量词」定义（and = every / or = some / not = !some），空 and 为真、
>   空 or 为假是量词的定义而非特例分支；空叶子求值为「不约束」（否则界面会表现为
>   「刚点 + 条件、结果集瞬间清空」）。宿主链路（searchEngine → IndexHost → worker →
>   dataService）全改收 `Condition`，启停判据换成 `hasAnyRealCondition`（组没有 field 字段，
>   沿用旧判据会把整组条件当成空条件、静默清掉过滤）。协议加 `condition?` 与旧扁平字段
>   二选一，两条通道都在入口经 `normalizeCondition` 净化（协议入参不可信）。
>   面板为「一行一条」+ 且/或切换 + 每项可非（最多 8 行，一层设界），单条件仍产出叶子
>   —— 与历史序列化形状逐字段一致。持久化加版本信封 `version: 2`；叶子的形状未变，
>   故 v1 偏好**无需迁移**即合法。
> - **O8 的交付形态**：备份**起点从 `range.end` 前移到 `range.start`**（即含被编辑的那一行）
>   —— 否则崩溃在「新行写了一半」时，只备尾部根本恢复不出那一行，而**半吊子恢复比不恢复
>   更危险**；同时写「元数据旁车」（`backupStart / backupLen / fileSize`），因为没有起点
>   信息，孤儿备份只是一段不知从何拼起的字节。打开文件时检测 → 横幅给出「恢复 / 丢弃」
>   （横幅因此扩成**多动作**：单动作横幅两次 show 会互相覆盖，用户只会看到后一个）。
>   三条原则写进代码注释：不自动恢复、不假装能恢复（校验不过就只给「丢弃」）、
>   恢复走与取消回滚**同一份**字节搬运实现。
> 全套 845 例 / 844 通过 / 0 失败，覆盖率 97.31 / 88.18 / 91.64（门槛 96/86/88）。
>
> **批次 2 完成（2026-09-29）**：F5（导出子集）与 O7（调用方视图基线）补齐。
> F5 的形态：`host/exporter.ts` 以「写同名临时文件 → 原子 rename」产出新文件，
> **源文件一个字节都不动**，取消/失败时目标文件从未被创建，取不出原文的记录如实跳过并计数；
> 入口在列表多选右键菜单；目标路径由宿主侧保存对话框决定（webview 不该有权决定往哪写文件）。
> O7 的形态：乐观锁补上**调用方一侧** —— 前端随写请求带上「本视图看到多少行」
> （`viewBaseline()`），宿主并入既有的 `detectWriteConflict` 一并判定，
> 拦住「同一文件被两个视图打开、B 视图仍按旧行号写入」这类**宿主自己看不见**的过期。
> 顺带**新发现**一处既有缺陷（跨块超长行之后行号漂移）记为 O16，未夹带修复。
> 全套 770 例 / 0 失败，覆盖率 97.36 / 88.32 / 91.71。
>
> **批次 2 已交付（2026-09-29，部分）**：F1（命中高亮 + 详情内查找）、O5、O6、O11 落地并配回归测试；
> **F5（导出子集）与 O7（写端点乐观锁）未做**，顺延到下一批。交付形态：
> `findRanges()` 成为宿主搜索与前端高亮的共同语义来源，`renderHighlight()` 用 DOM 节点而非拼 HTML
> 承担渲染（用户数据永不进 HTML 解析器）；详情树 Ctrl+F 查找条只匹配已渲染部分、重渲染后自动重新套用；
> 字段抽样改一次顺序扫描（读量回归测试钉住 < 文件大小 × 3）；`applyLineDeltas()` 把批量替换的
> 索引更新从 O(命中×检查点) 降到单次遍历；工具栏 `setQueryError()` 让「失败」不再冒充「0 匹配」。
> 全套 759 例 / 0 失败，覆盖率 97.54 / 88.27 / 91.94。
>
> **批次 1 已交付（2026-09-29）**：F2、O3、O4、O9、O10、O13 六项全部落地并配回归测试
> （**逐项回滚验证过**：把源码 stash 回上一状态，相关用例全数失败，恢复后全过）。
> 交付形态：`commitIndex()` 成为索引维护的唯一分流点（多行走重建、紧凑走增量）；
> `searchEngine` 输出 `cancelled` 并与 `truncated` 严格分开，宿主据此不缓存、批量替换拒绝；
> `parseJumpTarget()` 纯函数承载三种跳转语义；浮层焦点排除关闭按钮 + Tab 循环 + 关闭归还；
> 树/横幅/分隔条补 ARIA 与键盘等价入口。全套 735 例 / 0 失败，覆盖率 97.43 / 88.20 / 91.88。
>
> **批次 0 已交付（2026-09-29）**：O1 / O2 已修复并配回归测试（8 例，**修复前 8/8 失败、修复后 8/8 通过**，
> 回滚验证过）。实现要点：新增 `IndexDeltaOp` + 共用纯函数 `LineIndex.applyIndexOps`（两侧索引同源的单一算法），
> `IndexHost.applyIndexOps` 作为回填通道（worker 走 `applyIndexOps` 消息），`DataService` 以
> `stageIndexOps()` 收口全部写路径、经 `refreshSnapshot()` 统一回填，失败则置 `hostDirty`
> 并在下一次 `search` / `filter` 前重建兜底；`rebuildIndex()` 先 dispose 旧宿主再换新的。
> 至此批次 1 起的功能可以安全开工。

> **批次 0 必须先于任何新功能**：O1 / O2 会让「先编辑、再搜索」这条最常见的组合路径给出错误结果，在其之上做任何搜索相关的增强（F1、F3）都等于在有裂缝的地基上加盖楼层。

---

## 1. 新增功能

每项给：解决什么问题 → 实现思路 → 涉及模块 → 取舍。

### F1 · 搜索命中高亮 + 详情树内查找 ★★★★☆

- **问题**：`runSearch` 拿到命中行号后只做「翻页 + 选中」（`webview/queryActions.ts:89-133`）—— **没有任何一处会把命中的那几个字标出来**：用户翻到卡片只看到一行选中标，还得自己在几十个字段里用眼睛找关键词在哪；详情树里更是完全没有查找能力（`detailTree.ts` 全文无 find 路径）。多 GB 文件里「为什么这行算命中」只能纯人肉比对。
- **思路**：
  1. **列表层**：卡片预览已有 `summary[]`（`RecordsPayloadItem.summary`，`protocol/rpc.ts:176`），在 `virtualScroll.ts:520-527` 的预览渲染里对 `escapeHtml` 后的文本做安全高亮（切成 `[文本, <mark>, 文本]` 三段再 `appendChild`，**不拼 innerHTML** —— 保住 `utils.escapeHtml` 这个唯一出口）。
  2. **详情层**：`Ctrl+F` 呼起详情内的查找条，只对**已渲染**节点做遍历匹配 + `<mark>` + 上下条滚动定位；未展开的子树标一个「命中 N 处」徽章（用 `TreeState` 现成的深度/展开结构，`detailLogic.ts`）。
  3. 两者共用新的纯函数 `core/query.ts: findRanges(value, needle, ci) -> [start,end][]`，可单测。
- **模块**：`core/query.ts`（纯逻辑）、`webview/virtualScroll.ts`、`webview/detailTree.ts` + `detailLogic.ts`、`webview/toolbar.ts`（复用既有 `setSearchResult` 计数）。**不动 RPC、不动宿主**。
- **取舍**：**只高亮已渲染部分，不为命中预取数据**（否则一次搜索就把整份文件的数据搬进前端，违背「内存与可视区成正比」这一核心约束）。全文搜索仍旧在宿主侧以 Buffer 匹配（`searchEngine.ts:100`），前端不重复扫一遍原文。

### F2 · 跳转到记录号 / 行号 ★★★★★（成本极低）

- **问题**：3000 万行的文件，导航只有「上一页 / 下一页 / 跳至**页码**」（`virtualScroll.ts:648-718`）。用户手里往往是一条**记录号**（来自日志、报错、别人给的行号），当前只能心算 `记录号 ÷ 20`。这是「多 GB 秒开」卖点在导航上的最后一公里断头路。
- **思路**：把既有页码输入框（694-712）扩展为「复合跳转框」：接受 `123`（页码）、`#1234` / `L1234`（记录号）、`50%`（比例）。解析放纯函数 `webview/logic.ts`，走现成的映射链路 `recordIdx → 展示位 → goToPage`（过滤态下已有 `translation` 双向映射，`virtualScroll.ts:104-106`），再 `focusTarget.set` 联动详情。
- **模块**：`virtualScroll.ts`（≈40 行）、`logic.ts`（解析器 + 单测）、`styles.ts`（少量）。**零 RPC 改动**。
- **取舍**：不新增一个「转到行」命令/输入框，改在既有输入框内做多语义 —— 少一个控件就少一处 state duplication（`toolbar.readLayoutFromDom` 那种「从 DOM 反解状态」的反模式别再复制）。

### F3 · 多条件组合过滤（AND / OR / NOT）★★★☆☆

- **问题**：现在是**单条件**（`FieldCondition` 单结构，`core/query.ts:26`；RPC `filter` 端点也是单条件，`protocol/rpc.ts:463-468`）。数据筛选的真实形态是「`level=error` **且** `msg` 包含 timeout **且** 不含重试」，当前做不到，只能先过滤再在列表里人工挑。
- **思路**：协议向后兼容地引入联合类型 —— `type Condition = FieldCondition | { kind: 'and'|'or'|'not'; items: Condition[] }`；求值在 `core/query.ts` 加 `matchesCondition(record, cond)`（纯函数，宿主与 webview 共用，正是本文件存在的理由：`query.ts:5-11` 明写「两侧需要一致求值」）；`filterLines` 只需把单条件入口换成复合入口（`searchEngine.ts:184`）；UI 在工具栏筛选面板（`toolbar.ts:370-452`）加「+ 条件」行。
- **模块**：`core/query.ts`、`host/searchEngine.ts`、`protocol/rpc.ts`（`FILTER` 载荷加 `condition?`，保留旧三字段）、`webview/toolbar.ts`、`webview/queryLogic.ts`、`webview/persistence.ts`（**持久化要做版本信封**，见下）。
- **取舍**：
  - **旧偏好迁移**：现有 workspaceState 里存的是扁平 `{field, op, value}`（`persistence.ts:47-51`）。方案 A：读取时判定形状，缺 `v` 字段即视为 v1 并 upgrade；方案 B：新键名 `jsonlViewer.state.v2.<uri>`。推荐 **A + `version` 字段**（B 会让老用户的偏好静默丢失，与本库「如实告知」的一贯原则相悖）。
  - **UI 复杂度**：条件的嵌套超过两层后收益急剧递减，建议明确限制为「一层 AND / OR + 每项可 NOT」，不支持多层嵌套 —— 不设界的通用做法会让面板变成一个没人看得懂的表达式盒子，这里选择主动设界。
  - 与搜索的关系：**搜索与过滤保持两个入口不动**（现状语义清晰：过滤改变列表全集，搜索只是在全集中跳点），组合过滤不承担搜索职责。

### F4 · 全量 Schema / 数据质量画像 ★★★☆☆

- **问题**：字段推断只抽样**前 200 条**（`inferFields.ts:174`、`jsonlViewer.sampleLines` 默认 200）。LLM 数据集/日志里「第 30 万行才出现的可选字段」「某字段 60% 为空」这类结论，抽样永远看不见 —— 而这类脏数据体检正是查看器的典型用途（`samples/` 里放着 `现网多轮已规整数据.jsonl`、`query处置全景…jsonl` 这类真实业务数据）。
- **思路**：**照抄 `scanBadLines` 的骨架**（`dataService.ts:2100-2167`）—— 它已经有：全文件流式扫描、进度推送（`EDIT_PROGRESS`）、`shouldCancel`，以及把「范围不完整（`partial`）」与「容量被截断（`truncated`）」严格分开的完整性语义。新增 `SCAN_PROFILE`：遍历同样的 `scanRecords`，累计每字段的出现次数、类型分布、top-k 取值（有界，如每字段 top 5）、空值率；结果面板复用 `fieldPanel.ts` 的渲染风格，并用 `partial=false` 表明它是权威全量。
- **模块**：新增 `host/profileEngine.ts`（比照 `searchEngine.ts`）、`protocol/rpc.ts`（新端点 + `PROFILE` 回执）、新 `FieldAnalysisPanel`（比照 `badLinesPanel.ts`）、`toolbar.ts`（入口徽章）。
- **取舍**：内存必须有界 —— 只对**顶层 key** 做统计（深层字段的组合爆炸），值分布用固定容量 top-k；不落盘缓存（容量/隐私双考虑，与「会话历史不持久化」的既有决策 EDIT_FEATURE_PLAN 决策 20 同调）。

### F5 · 导出子集到新文件 ★★★☆☆

- **问题**：现在「把筛选/选中的记录另存」只有两条路 —— 复制到剪贴板（`COPY_LINES`，硬上限 8MB，`constants.ts:81`），或**在原文件上做破坏性操作**。`saveCustomDocument` 明确拒绝另存为（`extension.ts:935`）。数据清洗的真实闭环是「筛出 3000 条脏数据 → **导出**看/给同事/喂下游」，当前缺这一环。
- **思路**：新端点 `EXPORT_LINES {lines, targetUri?}` —— 宿主用 `showSaveDialog` 拿目标路径，**流式写**：按行号升序、`scan` 一次、`readBytes` 边读边写（`fileWriter.ts` 的分块 IO 惯例，但不复用它的「原位搬移」语义）。带进度 + 取消（复用 `EDIT_PROGRESS` + `cancelled` 语义）；默认 `.jsonl`，可选 JSON 数组包装。
- **模块**：`extension.ts`（dialog + handler）、`protocol/rpc.ts`、`host/dataService.ts`（薄编排）、新增 `host/exporter.ts`（纯写路径，可 `MemoryReader` 单测）。
- **取舍**：
  - **与既有写链路严格隔离**：本操作**只创建新文件、绝不改写源文件**，不进 `runExclusive` 写链、不进撤销历史 —— 若把它混进撤销栈，用户会以为 Ctrl+Z 能「撤回导出」（实际只能手动删文件），那是一次误导。
  - 8MB 以上的搬运不要走剪贴板（有 `COPY_MAX_BYTES = 8MB` 硬上限），导出到文件才是正解：流式写不驻留内存。

### F6 · 追尾模式：增量索引（可选的大招）★★☆☆☆

- **问题**：JSONL 的很大一部分是**正在增长的日志**。现在文件一长，5s 轮询（`dataService.ts:421-435`）只会弹「文件已更改，请重新加载」横幅 —— 而整文件 reload 在 GB 级是秒到数十秒。用户想看「最新的几十条」，成本却是整重扫。
- **思路**：给 `LineIndex` 加 **`appendFrom(offset)`**（只在「尾部增长且未截断」这一前提下成立）：从已知 `totalBytes` 续扫新字节，追加检查点 + 记录分组终点，返回新的不可变实例（沿用既有不可变语义，`lineIndex.ts:425`）。宿主在 `checkStale` 命中 size 增大且 mtime 变新时，调 `TAIL_POLL` 增量跟进并推新的 `totalLines`；webview 提供「跟随末尾」开关。
- **模块**：`indexer/lineIndex.ts`（新原语 + 单测）、`host/dataService.ts`、`host/indexHost.ts` / `indexWorker.ts`（worker 侧同样需要，否则又双份）、`protocol/rpc.ts`、`webview/toolbar.ts`。
- **取舍与风险**：必须处理「最后一行没换行」「文件被轮转/truncate（size 变小）」「写入一半的残行」三种脏情形 —— 任一种都要退回整量 reload 而非硬凑。**编辑/批量重写期间禁止增量**（写链正在进行 revert/commit，本库已有 `editing` 标志可复用）。这是本表成本最高的一项，建议先做最小版本：**只追加、不自动滚动**，把 UI 跟随放到下一批。

### 备选（价值较低 / 成本较大，此处只登记）

| 项 | 说明 | 为何排在后面 |
|---|---|---|
| **F7 表格/列视图** | 用既有 `readRecords` 摘要字段渲染成列式表格（复用同样的分页 + 同样的 LRU） | 本产品的差异化是「树详情」，表格与卡片重叠度高且与 `fieldLayout` 定制部分重复；真需要时优先考虑导出成 CSV 喂 Excel（F5 的子集） |
| **F8 命名视图 / 书签** | 把当前「字段布局 + 过滤 + 搜索词」存为具名视图（`persistence.ts` 里三样数据都已现成） | 锦上添花，依赖 F3 先落地才能体现价值 |
| **F9 记录对比 diff** | 选中两条做结构化差异 | 复用 `detailTree` 但要新建 diff 视图另一个渲染体系，收益面窄 |

---

## 2. 现有实现的可改进点

> 每条给：**证据 → 后果 → 修法 → 取舍**。标注 ✅ = 臣已回读代码核实；⚠️ = 静态推断（未实机跑）。

### P0

#### O1 · 写操作后 `host` 内的索引永远陈旧 → 搜索/过滤（含批量替换）结果错误 ✅ **（已修 2026-09-29）**

- **证据**：所有编辑都只**(re)assign `DataService.index`**（`dataService.ts:714 / 856 / 945 / 1962`）；而 `search` / `filter` 委托给 `this.host`（`dataService.ts:2192-2217`），`ensureIndex`（359-403）**只在 index 为空时**构建；`IndexHost` 接口**没有任何回写索引的通道**（`indexHost.ts:38-71`）；`MainThreadIndexHost.index` 只在 `build()` 里赋值（`indexHost.ts:100`），worker 路径同理（`indexWorker.ts` 内部持有自己的 `li`，`indexHost.ts:232-239`）。
- **后果**：
  - 插入/删除后，`host` 侧的 `totalRecords` 仍是旧值 → 新增的记录**搜不到**，已删的行仍在结果里；
  - 变长编辑后，其后检查点偏移失配 → 从该检查点起的**行号系统性错位**（每个检查点块整体偏移一行；内容大体正确，但贴错了行号）；
  - **最危险的是批量替换**：`replaceText` 的第一步就是 `await this.search(...)`（`dataService.ts:1016`） —— 索引漂移会直接落到磁盘写入上，变成「改了一批不该改的行」。
- **修法（两案）**：
  - **方案 A（推荐）**：给 `IndexHost` 加 `syncIndex(patch)`（`checkpoints + totalBytes + totalLines [+ records]`），worker 侧经 `workerProtocol.ts` 下发。增量数据就是一串检查点，几十 KB 级别，与现有协议形态一致。
  - **方案 B（兜底）**：`DataService` 记 `hostDirty`，`search`/`filter` 前若 dirty 就 `rebuildIndex()`（须先修 O2）。
- **取舍**：本项目的立身之本是「编辑后维护索引 O(行数/1024)、极廉价」（`EDIT_FEATURE_PLAN.md:16`，第 3 条把这点称为方案可行的前提）。选 B 等于在每次编辑后的第一次搜索上还回去一次全文件重扫 —— 项目文档明确否定的路径。故**推荐 A**；多行（pretty）文件**沿用既有的 `rebuildIndex` 兜底**（那里本来就在这么做，`dataService.ts:699 / 1709`）。
- **影响范围**：`host/*` + `protocol` + 测试；**改动 中**；**难度 中–高**（worker 两侧都要同步）；**价值 极高**。
- **已落地形态（方案 A + B 兜底合用）**：`indexer` 新增 `IndexDeltaOp` 与共用纯函数 `applyIndexOps()`（两侧索引只能同步演化）；`IndexHost` 加 `applyIndexOps()` 通道，worker 经新消息下发给 `indexWorker`；`DataService` 以 `stageIndexOps()` 收口全部 7 处写路径（禁止再直接 `this.index = li.applyLineXxx()`），经 `refreshSnapshot()` 统一回填；回填失败不抛给调用方（磁盘已是新内容），而是置 `hostDirty`，下一次 `search` / `filter` 前经 `ensureFreshHost()` 重建 —— 快路径与兜底路径同时具备。

#### O2 · `rebuildIndex` 泄漏旧 IndexHost / worker 线程 ✅ **（已修 2026-09-29）**

- **证据**：`dataService.ts:1306-1316` 直接 `this.host = built.host`，**旧 host 从未 dispose**（对比 `dispose()` 里是做了的，`dataService.ts:2255-2256`）。
- **后果**：多行文件里每编辑一条跨行记录就建一个新 worker（`indexHost.ts:191` `activeWorkers++`），旧的（含其文件句柄）永不释放。超过 `MAX_ACTIVE_WORKERS = 8`（`indexHost.ts:80`）后，`createIndexHost` **永久退化主线程**（`indexHost.ts:405-420`）—— 也就是前 8 次编辑后，本项目花了大力气保证的 worker 并行（含 `STABILITY_AUDIT.md` 专门修过的 worker 可用性防线）对用户静默失效。
- **修法**：`rebuildIndex` 里先 `await prev.dispose().catch(() => {})` 再赋值（注意与 `releaseFileHandles` 的先后顺序：先关 reader 再 dispose host）。
- **影响范围**：单点；**改动 极小**；**难度 低**；**价值 极高**。
- **已落地形态**：`rebuildIndex()` 先 `dispose()` 旧宿主再换新的，并清空待回填队列、复位 `hostDirty`。顺手修掉同源隐患：`indexWorker` 的 error 回执此前只对 build/search/filter 带 `requestId`，`releaseFile` / `reacquireFile` 失败会让主线程 pending **永不结算**（表现为批量替换卡在释放句柄且无报错），现改为对所有带 `requestId` 的消息统一回传。

### P1

#### O3 · 多行文件的引擎税：`applyLine*` 丢弃记录分组 ✅

- **证据**：三个增量方法构造新 `LineIndex` 时都**未传第 6 个 `records` 参数**（`lineIndex.ts:438-441 / 477-483 / 515-521`），而构造函数中 `multiline = records !== undefined`（`lineIndex.ts:125`）、`totalRecords` 在 `multiline=false` 时退化为 `totalLines`（`lineIndex.ts:129-131`）。调用点：`deleteRecordInternal`（`dataService.ts:856`）、`insertRecordInternal`（945）、`insertRangesInternal` 撤销路径（1796-1810）、以及混合文件里编辑**单行**记录（`dataService.ts:694` 的 else 分支，条件为 `li.multiline && isMultiline` 不成立时）。
- **后果**：pretty/含空行文件里，任一上述操作之后，索引**静默从「记录语义」塌回「物理行语义」** —— 此后 `readRecords` 的记录号全部错位，UI 上看不出任何异常。
- **修法**：
  - **短期（推荐）**：凡是 `li.multiline === true` 的文件，这三个路径一律走 `rebuildIndex()`。`deleteRecords` 已经在这么做（`dataService.ts:1707`），属于把既有正确姿势推广到剩余 4 处，改动小、语义一致。
  - **长期**：给 `applyLine*` 加记录分组平移（`recordEndLines`/`recordEndOffsets`）—— 更优但要处理「插入一行可能改变分组」的重算，复杂度不低。
- **取舍**：多行文件是次要场景且编辑低频，「正确性优先 + 接受一次几秒的重扫」明显优于「为了省这一次重扫而引入二级增量平移」。这与项目一贯的取舍同调 —— 宁可拒绝，也不留在一条没有正确性保证的降级路径上（`EDIT_FEATURE_PLAN.md` 决策 8）。
- **影响范围**：`indexer` + `host`；**改动 小**（短期）；**难度 低**。

#### O4 · 被取消 / 半途终止的查询结果进了缓存，并被批量替换采用 ✅

- **证据**：`searchLines` 只有 `truncated` 一个完整性标志（`searchEngine.ts:91-98`），被 `shouldCancel` 中断时是**正常 return**（`searchEngine.ts:124-126` / `jsonParser.ts:212`），返回 `{truncated:false}`；而 `dataService.search` 的缓存判据只有 `if (!res.truncated)`（`dataService.ts:2191-2194`）。`filter` 同构（2205-2213）。
- **后果**：半份结果既写进 `queryCache`（容量 8、键 = size+mtime+查询，`dataService.ts:800-818`），也会被 `replaceText`（`dataService.ts:1016`）当作「命中全集」使用 —— 用户「全部替换」以为改完了，实际漏改了半文件。
- **修法**：让 `scanRecords` 回传「是否扫完」，`searchLines`/`filterLines` 输出 `cancelled` 标志（`BadLinesPayload.cancelled` 已是现成先例，`protocol/rpc.ts:430`）；`DataService` 据此**不缓存、且批量替换直接拒绝**（与既有「命中达上限即拒绝替换」的口径一致，`dataService.ts:1017-1021`）。
- **取舍**：不要试图「从半份结果续扫」——被截断处的边界行不可信；重扫一遍的开销，远小于一次基于残缺命中集的大面积重写。
- **影响范围**：`searchEngine` + `dataService` + 协议；**改动 小–中**；**难度 低**。

#### O5 · `inferFields` 逐行重扫 → 打开路径上的读放大 ✅

- **证据**：`inferFields.ts:180-198` 对每行独立调 `readRecord(line, li, reader)`，而 `readRecord` 的实现是「从 ≤ 该行的最近检查点顺读」（`jsonParser.ts` + `lineIndex.scan`），于是第 N 行会把前 N-1 行又读一遍。总读量 ≈ `O(sample² × 行长 / 2)`。
- **后果**：默认抽样 200 条 × 检查点间隔 1024（前 200 行都在同一个块内）：行长 1KB 时约 20MB 冗余读（尚可）；但 `RECORD_INLINE_MAX_BYTES = 256KB`（`constants.ts:29`）允许每行 256KB，此时约 **5GB** —— 落在**打开文件的关键路径**上（`getSampleFields`），机械盘/网络盘上会表现为「打开卡一下」。
- **修法**：改用一次 `scanRecords(0, scanned, li, reader)`（`jsonParser.ts:188`）顺序扫完，读放大随之下降约两个数量级；只动 I/O 入口，统计逻辑一行不改。
- **顺带的小优化**：`jsonParser.ts:213` 对每个元组的每一行都 `r.bytes.toString('utf8')`，但**全文搜索只用 `rec.buf`**（`searchEngine.ts:138-139`） —— 把 `text` 改成惰性 getter（访问时才 decode/join）可让纯全文扫描免掉全文件的 UTF-8 解码。
- **影响范围**：`inferFields.ts` / `jsonParser.ts`（后者需确认全部消费方）；**改动 小**；**难度 低–中**。

#### O6 · `applyEdits` 的索引更新是 O(命中数 × 检查点数) ✅

- **证据**：`dataService.ts:1961-1963` —— `for (const {line, delta} of deltas) idx = idx.applyLineReplace(line, delta)`，每次调用都是一次全数组 `map` + 新对象分配（`lineIndex.ts:435-441`）。
- **后果**：5 万命中 × 1 万检查点 ≈ 5×10⁸ 次操作 —— 一次批量替换后宿主明显卡顿。对一个把「多 GB 秒开」写进产品描述的扩展来说，这是用户能直接感知的体感损失。
- **修法**：新增 `LineIndex.applyLineDeltas(sortedDeltas)`（只针对「行数不变」的批量替换场景；插入/删除的行号平移语义不同，不并入同一方法）：把 deltas 升序扫描一次，构造「每段检查点应累加的偏移」，最后**单次** `map`。纯函数，配 3–5 个单测即可。
- **影响范围**：`lineIndex.ts` + 一处调用；**改动 小**；**难度 低**。

#### O7 · 写端点的乐观锁只覆盖 `editRecord` ✅

- **证据**：`expectedBytes` 的断言只出现在 `editRecordChecked`（`dataService.ts:679`）；`deleteRecord` / `insertRecord` / `deleteRecords` / `replaceText` / `replaceField` / 撤销回滚（`rollbackLineEdit` `dataService.ts:1322+`）都只走「size + mtime」的粗粒度 `detectWriteConflict`（`dataService.ts:766-779`）。
- **后果**：会话期间文件被外部程序重写成**同尺寸**内容时，前述操作会以过期视图定位 —— 删错行、插错位置，且不可自愈。
- **修法**：
  - 单行操作（删除/插入/字段级替换）沿用 `expectedBytes`（前端已有 `detailRaw.bytes` 作为同类断言源头）；
  - 批量操作改为断言 `expectedTotalBytes` + `expectedTotalLines`（宿主侧一行即得，无需前端传），既能覆盖绝大多数外部改动，又不要求 MB 级的状态搬移。
- **取舍**：不做「全文签名 / 哈希比对」——那要为冲突检测去读一遍整个文件，与本产品核心（永不整文件载入）正面对抗。既有的 size+mtime 冲突检测语义不变，只是在它之前再加一道便宜的一致性断言；宁可多做一次检查，也远好过把改动落到错误的行上。
- **影响范围**：协议 + `dataService` 各写端点 + webview 传参；**改动 中**；**难度 中**。

#### O16 · 跨块超长行之后，行号与记录内容会整体漂移（**新发现，2026-09-29**）⚠️

- **发现经过**：写 F5 导出的「超长记录跳过」用例时，顺手构造了「首行 1.2MB + 后跟两行正常记录」的样本，
  结果发现——只要**存在一条跨读取块边界（>1MB）的超长行**，其后所有行的**行号与内容都会错位**。
- **证据**：`lineIndex.scan` 在「缓冲区内无换行且长度已达 `maxLineBytes`」时报一条 error 计为一行
  （`lineIndex.ts:354-370`），随后 `abs += buf.length` 继续前进 —— 但真实行并未在此处结束，
  于是**后续行的起点落在该超长行中间**，边界判断自此整体偏移一行。
- **影响**：`readRecord` / 导出 / 复制该类文件里超长行**之后**的记录都会取到错误内容
  （且不报错）；列表因「超长行按坏行呈现」而不明显，但**导出/复制会把错内容写成文件**。
- **未修原因**：这不是 F5 引入的，且修它要动 `scan` 的推进语义（需要把超长行「吞到真正换行为止」并
  按字节数计数），牵动 `totalLines` / 检查点 / 坏行集合三处口径 —— 属独立立项，不宜夹带。
- **已做**：把当时的失败用例删掉（不锁死坏行为），改记于此，并在 `exporter.test.ts` 里保留
  「超长记录被如实跳过」与「只导出正常记录」两条不触及该缺陷的边界用例。

### P2

#### O8 · sidecar 备份「只写不读」：崩溃后没有恢复路径 ✅

- **证据**：变长替换前会把尾部备份到 `${path}.jlv-tail-bak`（`fileWriter.ts:229-232`，常量 `constants.ts:41`）；但全库（除去测试里的 `existsSync` 断言）**没有任何读回它的代码**。
- **后果**：进程崩溃或被强杀恰好落在搬移窗口内时，用户磁盘上会留下一个孤儿备份文件 + 一个改写了一半的文件，而查看器对此一字不提 —— 既没有提示，也没有任何恢复手段。
- **修法**：open/build 时检测同名 sidecar → 顶部横幅提示「发现上次中断编辑的备份（N 字节）」+ 「恢复 / 丢弃」两按钮（横幅基建已有，`webviewEntry.ts:88-132`）；恢复走既有 `rollbackToBackup` 语义。
- **取舍**：**不自动恢复**（备份可能属于另一个会话/已被后续外部写入覆盖），保持「告知 + 显式授权」，与项目对破坏性操作的一贯态度一致。
- **影响范围**：`dataService` + `extension`（UI 流）+ 前端横幅；**改动 中**；**难度 中**。

#### O9 · 分页器每次重建，吞掉用户正在输入的页码 ✅

- **证据**：`updatePager` 先 `sideEl.textContent = ''` 再重建输入框并 `input.value = String(p + 1)`（`virtualScroll.ts:694-712`）；而 `fetchWindow` 成功后必然 `list.refresh()`（`webviewEntry.ts:796-799`）。
- **后果**：输入页码的过程中数据到达 → 输入被打断、值被重置成当前页。
- **修法**：两条廉价路径 —— (a) 重建时把 draft 值回填（若与新页码不同则保留 draft）；(b) 改成增量更新（只改文本/活性，不重建节点）。推荐 (a) 先行，成本 5 行。
- **改动 极小**；**难度 低**。

#### O10 · 浮层打开时焦点落在「关闭」按钮，而非第一个表单控件 ✅

- **证据**：`panelShell.open()` 用 `panel.querySelector('button, input, select')` 求焦点（M9 的可达性修复，`toolbar.ts:342-347`）；但 `h3`（内含 `closeBtn`）**先于**表单节点被 append（`toolbar.ts:325-331`），故选择器命中的正是 closeBtn —— 这次「让键盘焦点进入面板」的修复实际把焦点放到了关闭按钮上，紧接着按 Enter 就把面板关了。
- **修法**：把选择器限定到表单容器，或 `querySelector('button:not(.jlv-panel-close), input:not(.jlv-panel-close), select')`；顺手补 **focus trap + 关闭后焦点归还触发元素**（四个浮层共用同一个 shell，改一处全受益）。
- **取舍**：不建议引入完整 focus-trap 库（0 运行时依赖是本项目资产），手写 Tab 循环的十几行足够。
- **改动 极小**；**难度 低**。

#### O11 · 失败被静默成「0 匹配」/永久「加载中…」（可观测性）✅

- **证据**：
  - 搜索失败 → `catch` 里 `setSearchResult(0, 0)`（`queryActions.ts:129-132`），与「真的没匹配」在 UI 上完全同形；
  - 过滤失败 → 只关掉截断提示并**保留旧的 `filterMap`**（`queryActions.ts:182-185`）；
  - `readRecords` 失败 → `catch { return false }`（`webviewEntry.ts:801-803`），卡片停留在「加载中…」，无错误态、无重试；
  - 概览校正失败（`editOps.ts:174-176`）、`JUMP_TO_SOURCE` 失败（`webviewEntry.ts:390`）同样静默。
- **后果**：用户无法区分「没数据」「取数失败」「请求超时」；重试只能靠重开文件。
- **修法**：把「无数据」「成功」「失败」做成三态并统一到横幅/卡片呈现；用已具备的 `RpcErrorCode`（`protocol/rpc.ts:582-598`）分支：`CANCELLED` 静默、`TIMEOUT` 给「重试」按钮、其余给错误态。**不要**改造现有 `bus.onError` 的分派逻辑，只需在每条「静默 catch」处补一句显式的状态更新。
- **取舍**：错误文案必须是人话且与本库一贯口径一致（例：「文件已被外部修改，请重新加载」而非「CONFLICT」）；`RpcErrorCode` 已有承诺，别再造第四套。
- **改动 小–中**；**难度 低**。

#### O12 · 详情树「加载更多」在「全部展开」下退化为整树同步重建 ⚠️

- **证据**：`expandAll()` 把 `TreeState.depthLimit` 提到 `MAX_RENDER_DEPTH = 400`（`detailLogic.ts:150-154`），而「加载更多」走 `render()` → `renderBody` 重建已展开子树（`detailTree.ts:778 / 385`）。
- **后果**：深度展开态下点「加载更多」，会对整棵已展开树做一次同步重建 —— 与 `chunkedExpand`（分批 + `requestIdleCallback`，`detailTree.ts:640-661`）的分批初衷相互抵消；宽记录/深树时会直接冻结主线程。
- **修法**：把「加载更多」改成**向既有容器增量 append 节点**（容器元素已有缓存 `__innerEl`，`detailTree.ts:708-735`）。
- **改动 中**；**难度 中**。

#### O13 · ARIA / 键盘可达性缺口 ⚠️

- **证据**：
  - 树：`body` 是 `role=tree`（`detailTree.ts:220`）、行是 `role=treeitem`（480），但中间容器**无 `role=group`**，父子关系断裂；且无 `aria-selected`（477），选中态只有 class；
  - 横幅无 `role` / `aria-live`（`webviewEntry.ts:88-132`）→ 文件变更/超时/进度对读屏完全不可见；
  - 右键菜单无键盘入口（无 Shift+F10 / contextmenu 键，`virtualScroll.ts:939+`）；
  - 分栏拖拽无键盘替代、无 `role=separator` / `aria-valuenow`（`columnLayout.ts:184-209`）。
- **修法**：按上述四处逐一补 `role=group`、`aria-selected`、`aria-live` 容器、菜单键盘入口、`separator` 语义。
- **改动 小**（分散）；**难度 低**。建议作为批次内的随手项。

#### O14 · 测试缺口：`extension.ts`（1058 行）零单测 ✅

- **证据**：`src/` 下 45 个测试文件，**无 `extension.test.ts`**；而 `extension.ts` 承载 `mountViewer` / 20+ handler 分发 / cancel 集合 / stale 定时器 / provider `save·revert·backup` / 撤销栈桥接。
- **修法**：不必追求完整覆盖，先补「可拆出来测」的三块：handler 注册表完整性（每个 `HostEndpoint` 都有可用 handler —— 这正是能把 `NOT_IMPLEMENTED` 这类「两端版本不匹配」症状测出来的地方）、cancel 集合的兴衰、stale 定时器的启停。这基本是纯逻辑，不需要真 VS Code（集成测试的运行路径此前已验证，见 `docs/error_ledger.md`）。
- **改动 中**；**难度 中**。

#### O15 · 死字段与空操作（低价值，但应与上述某次改动顺手清）⚠️

- `state.searchTruncated` / `state.maxLoaded` / `info.loadedLines` **只写不读**（对照 `MAINTENANCE_AUDIT.md` §2.2 的「零引用导出」清理先例 —— 本项目对此事是有既定标准的）；`toolbar.refresh: () => update({})`（`toolbar.ts:770`）是空操作（`update` 对 `undefined` 全跳过）。
- 取舍：单独立项不值当，建议挂在各自所属模块的改动里顺手处理，避免下次又有人对着它们推理半天。

---

## 3. 建议实施路线

| 批次 | 内容 | 目标状态 |
|---|---|---|
| **批次 0（地基）** | O1 + O2 | 「编辑 → 再搜索/替换」这条最短路径恢复正确；worker 不再泄漏 |
| ~~**批次 1（廉价高收益）**~~ ✅ **已交付** | ~~F2、O3、O4、O10、O13~~ + O9 | 导航补齐记录号/百分比；多行文件不再静默塌语义；取消的查询不再被误用 |
| ~~**批次 2（可见价值）**~~ ✅ **已交付** | ~~F1、F5、O5、O6、O7、O11~~ | 高亮/查找闭环 + 导出闭环 + 热路径瘦身 + 调用方视图基线 |
| **批次 3（能力扩展）** ◐ **部分交付** | ~~F3、O8、F4~~ ✅ + O14（顺延） | 组合过滤 / 备份恢复 / 全量画像已通；剩 extension 单测 |
| **批次 4（选做）** | F6、O12 | 追尾模式（不确定性最大，建议先做「只追加、不自动滚动」的最小版） |

每批次的执行纪律（沿用本项目既有约定）：

1. 纯逻辑先行 + `__tests__` 同批落地，覆盖率门槛 `test:coverage:gate`（96 / 86 / 88）不许倒退；
2. 涉及协议的改动：`PROTOCOL_VERSION` 遵从既有纪律（破坏性 +1、纯增量不变，`protocol/rpc.ts:19-30`），偏好持久化必须带 `version` 信封；
3. 新增写端点一律并入 `runExclusive` 并明确 `cancelled` ≠ `失败` 的三态语义（本库已在这两件事上反复决策，见 `docs/EDIT_FEATURE_PLAN.md` 决策 12/32/34）；
4. 收尾同步 `docs/CODE_WIKI.md` 与 `README.md` 的「已知限制」（文档漂移本项目此前已专门修过一次，`MAINTENANCE_AUDIT.md:123`）。

---

## 4. 与既有文档的关系（避免重复劳动）

- `CODE_REVIEW.md`（P0–P2 已全修）、`STABILITY_AUDIT.md`（P0/P1 已全修）、`ARCHITECTURE_REVIEW.md`（八笔重构已落地）中的条目**本报告不再重复**；上述 O1–O15 均为这些文档之外的**新增**发现。
- `EDIT_FEATURE_PLAN.md` 已决策的事项（如 `saveCustomDocument` 为空实现、不支持正则替换、批量重写需等量临时空间）本报告**遵从其决策**，不再翻案。
- 一条贯穿性观察：`EDIT_FEATURE_PLAN.md:16` 以「索引是稀疏检查点、编辑后维护极廉价」作为编辑能力可行性的全部依据 —— 而 **O1 恰好让这份廉价只兑现在 `DataService` 侧，`host` 侧从未兑现**。修掉它，等于把文档里那份承诺真正补全。

---

## 5. 核验说明（哪些是亲眼所见，哪些是推断）

| 结论 | 核验方式 |
|---|---|
| O1 / O2 / O3 / O4 / O5 / O6 / O7 / O8 / O9 / O10 / O11 / O14 | ✅ 已回读源码逐条确认（含行号） |
| O12 / O13 / O15 | ⚠️ 静态追查（DOM 行为未经实机/集成测试验证） |
| 全部时间/内存量化（如「5GB 读放大」「5×10⁸ 次操作」） | ⚠️ 按代码路径推算的量级估算，**未实测**；建议动手前用既有 `src/perf/__tests__/bigFilePerf.test.ts` 与 `scripts/validate-300mb.ts` 各跑一次取基线 |
| 「不存在某功能」类判断（排序 / 组合过滤 / 导出 / tail / 表格视图 / 全量统计） | ✅ 已用全仓检索（`.ts` 源码，`git log` 近 25 笔提交）双向确认 |

> 一句话总结：**这个项目的工程质量在设计文档与防错细节上明显高于平均水平（每个魔数都有存在理由、每条「取消」都与「失败」分家），现存的头号风险不在 UI，而在于「编辑之后宿主搜索索引从未同步」这一条地基裂缝 —— 它静默地让新增最多的编辑能力与新增最早的搜索能力互相背叛。先补它，再谈增强。**
