# JSONL Viewer — 技术债务与架构评审

> 评审日期：2026-09-20 ｜ 基准版本：v1.7.0 ｜ 范围：全部 `src/**`
> 方法：静态阅读 + 关键事实实测（含 `npm test` glob 递归性核验、依赖方向核查），非凭印象。

---

## 一、结论摘要（TL;DR）

当前架构**整体健康**：分层清晰（host / webview / protocol / indexer / parser / infer）、宿主层无 `vscode` 依赖（可独立单测）、算法层 DRY 良好（搜索/过滤/缓存/调度均单份）、协议类型单一来源。

但存在**四类值得治理的债务**，按 ROI 排序：

1. **host 层反向依赖 webview 层**（DIP 违反）—— `searchEngine.ts` 直接 import `webview/queryLogic.ts` 的**运行时函数** `matchesFilter`/`recordFieldValue`。这是最该修的一项：核心层依赖了 UI 层，且为"保持前后端过滤一致"的 DRY 动机所驱动，应抽到共享 `core/` 层。
2. **`extension.ts:mountViewer` 上帝函数 + `dispatchMessage` 12 参数巨型 switch**——端点概念在"常量 / switch / 内联 handler"三处表达，新增功能成本高、易漏改。
3. **`webviewEntry.ts` 1100 行协调层膨胀 + 30+ 字段手写状态机**——可靠性靠纪律，功能继续增长会抬升认知负担。
4. **模块级隐式全局状态**（`serviceRegistry` / `openPanels`）+ 个别防御性 `.catch` 缺失。

**原则立场**：本扩展是「单功能、单作者主导、性能/稳定性优先」的小型工具，**SOLID 宜作方向性指引而非达标强制**。最该采纳的是 A1（抽 core 层消反向依赖）与 A2/A3（端点映射集中、拆上帝函数）；**不应**引入 DI 容器、拆DataService、引前端框架、抽象存储后端——那属过度工程。

---

## 二、项目结构与依赖方向

```
protocol/rpc.ts        ← 叶子：纯类型 + 常量 + dispatchMessage（无业务依赖）
       ↑（单向）
host/                  ← DataService / indexHost / indexWorker / searchEngine / recordSummary
webview/               ← webviewEntry / logic / rpc / toolbar / detailTree / queryLogic / virtualScroll
       ↑（单向）
extension.ts           ← 穿透层：激活、命令、自定义编辑器、服务注册表、消息路由

indexer/ parser/ infer/ perf/ constants.ts  ← 共享叶子（被 host/webview 引用）
```

**实测发现的依赖异常**（打破单向）：

| 文件 | 反向 import | 性质 |
|---|---|---|
| `src/host/dataService.ts:21` | `../webview/queryLogic.ts` 的 `FieldCondition` | 类型（轻） |
| `src/host/indexHost.ts:19` | `../webview/queryLogic.ts` 的 `FieldCondition` | 类型（轻） |
| `src/host/searchEngine.ts:19-20` | `../webview/queryLogic.ts` 的 `matchesFilter` / `recordFieldValue` | **运行时函数（重）** |

即：宿主核心层（本应位于 webview 之上）反向依赖了 UI 层的**具体实现**。动机正当（前后端过滤规则单一事实来源），但归属错了位置。

---

## 三、主要技术债务清单

| # | 位置 | 问题 | 后果 | 等级 | 修复建议 |
|---|---|---|---|---|---|
| **T1** | `extension.ts:156-315` `mountViewer` | 上帝函数：webview HTML 注入 + CSP/nonce + 12 个内联 RPC handler + stale 定时器 + 跳源 + 偏好持久化 + 服务注册表调用，单函数 ~160 行 | 改动任何宿主行为必动中心函数；命令/编辑器两路径虽共享（好 DRY）但代价是中心化 | 中（SRP） | ~~A3：拆 buildWebviewHtml()/registerHostHandlers()/startStaleWatch()~~ **✅ 已修复（A3）** |
| **T2** | `protocol/rpc.ts:241-334` `dispatchMessage` | 12 参数位置化签名 + 巨型 switch；注释自承"实际处理器另行实现" → 路由与处理分离却散两处 | 加一个端点须改 3 处（常量 / union 类型 / switch / 调用点内联 handler），易漏改 | 中（OCP/ISP + 抽象泄漏） | ~~A2：handler 注册表 Map<endpoint,fn>，dispatch 查表分发~~ **✅ 已修复（A2）** |
| **T3** | `host/* → webview/queryLogic.ts` | host 反向依赖 webview（见 §二） | 核心层依赖 UI 层；若 webview 引入浏览器专属依赖会污染宿主；层边界失真 | 中（DIP） | ~~A1：抽 core/ 共享 FieldCondition+matchesFilter+recordFieldValue~~ **✅ 已修复（A1）** |
| **T4** | `extension.ts:46,83-91` | 模块级全局单例 `serviceRegistry` / `openPanels` 未注入；`releaseService` 中 `void hit.svc.dispose()` 无 `.catch` | 隐式全局状态难测；dispose 当前不 reject（所有 await 已 `.catch`）但脆弱 | 低~中 | ~~A4：dispose 补 .catch~~ **✅ 部分修复（A4：dispose 已补 .catch；registry 显式持有/注入待办）** |
| **T5** | `webviewEntry.ts` + `AppState` | 前端协调层膨胀（样式/横幅/分栏动画/响应式/搜索/过滤/导航/持久化/生命周期）+ 30+ 字段手写状态机 | 认知负担高；一处 state 字段改动波及众多闭包 | 中（前端 God Object） | **增量+测试网（2026-09-20 钦定），进行中**：① 测试网基建 ✅ #29（domHarness + webviewEntry.test 冒烟测试）；② `webviewEntry` 导出化 ✅ #28（`main` 导出 + 条件挂载）；③ 抽 `columnLayout` ✅ #30（收起/展开动画 + 拖拽调宽 + 窄容器响应式抽屉 → 独立工厂 `createColumnLayout(deps)`，行为抽取**不搬 DOM 创建顺序**，`webviewEntry.ts` 1112→951 行，新增模块级回归测试 6 项）；④ 抽 `queryActions` ✅ #31（supersede/jumpToMatch/runSearch/stepSearch/runFilter/clearFilterForCond/applyLayout → 独立工厂 `createQueryActions(deps)`，list/toolbar 经访问器晚绑定，`webviewEntry.ts` 951→834 行，新增模块级回归测试 10 项）；⑤ 抽 `persistence` ✅ #32（偏好防抖写回 → `createPersistence(deps)`，`webviewEntry.ts` 834→822 行，新增模块级回归测试 3 项）。**T5 收尾：`webviewEntry.ts` 由 1112 → 822 行（−290，−26%），新增 3 模块（columnLayout/queryActions/persistence）+ 19 项模块级测试**。每步 tsc/test/build 全绿且独立提交 |
| **T6** | `extension.ts` 两处 webview HTML 模板（viewer 外壳 + notLocal 占位） | 模板结构内联两处，CSP/nonce 重复表达 | 轻微重复；模板改动要改两处 | 低 | ~~抽 renderWebviewHtml 工厂~~ **✅ 已修复（T6）：收敛为单一 `renderWebviewShell` 外壳工厂，`renderViewerHtml` 与 `notLocalHtml` 共用** |
| **T7** | `extension.ts` 消息处理外层 catch | 异常回执 `errReply(undefined, …)`，requestId 丢失 | webview 走全局 error handler 弹横幅，且该在途请求永不 settle（只能等超时） | 低 | ~~异常路径带 requestId~~ **✅ 已修复（T7）**：新增 `protocol/rpc.ts#requestIdOf(msg)` 安全取值；`extension.ts` 外层 catch 与 `dispatchMessage` 均改用它，异常回执保留 requestId → webview 命中 pending 即精确 reject 并早返回（不弹全局横幅）。新增 4 项回归测试 |
| **T8** | `package.json:98` `test` 脚本 | `node --test "src/**/*.test.ts"` 依赖 Node ≥22 的 glob 递归行为 | 实测 OK（收集 154/154）；但 CI 若用老 Node 会静默跑 0 测试 | 低（已核实有效） | CI 锁定 `node>=22.18`；脚本已加 `--experimental-transform-types`（webview 测试网引入 jsdom + 含不可剥离 TS 语法，需 transform 模式）；`engines` 已声明 `node>=22.18` |

> 实测已排除的疑似债务：`npm test` glob **确实递归**（150 全绿，非 0）；`DataService.dispose` 实际不 reject（`reader.close`/`host.dispose`/`building` 三处 await 均 `.catch`）；worker 与主线程双实现算法**未重复**（搜索/过滤单份 `searchEngine.ts`，build 单份 `LineIndex.build`）。

---

## 四、架构问题简述

### 4.1 端点概念的"二处表达"（A2 已收敛）
同一个 RPC 端点在两处声明：
1. `HostEndpoint` / `HostReply` 常量 + `HostRequest` / `HostResponse` 联合类型（`protocol/rpc.ts`）
2. `HostHandlerMap` 的对应字段 + 调用点（`registerHostHandlers`）注册的一个 handler（`extension.ts`）

`dispatchMessage` 已无 switch 分支，纯做「类型校验 → 查表 → 调用 → 异常兜底」。新增端点 = 改 2 处（常量/联合类型 + HostHandlerMap 字段与注册），`dispatchMessage` 本体不变（OCP）。这是 A2 对 T2 根源的修复。

### 4.2 隐式全局状态
`extension.ts` 模块顶层持有 `serviceRegistry`（uri→DataService 引用计数）、`openPanels`（uri→面板）。它们未被注入、不可在测试中隔离。当前单进程单扩展可接受，但与"显式优于隐式"相悖（T4）。

### 4.3 前端状态集中
`AppState` 是 30+ 字段的可变对象，被 `main()` 内所有闭包捕获。无框架、无 reducer，可靠性完全靠编码纪律。功能稳定时可控；继续膨胀则需抽"协调器/store"（T5）。

### 4.4 反向依赖（最关键）
§二已详述。host 依赖 webview 的具体函数，是架构卫生层面最该修的一项——它让"宿主核心"与"UI"在概念上倒置。

---

## 五、设计原则遵循现状

### SOLID

| 原则 | 现状 | 判定 |
|---|---|---|
| **S** 单一职责 | 宿主层内聚良好；`mountViewer` 已拆为 renderViewerHtml/registerHostHandlers/startStaleWatch（A3）；`dispatchMessage` 现为纯路由查表、handler 在调用点注册（A2） | **遵守（A3/A2 已修复）** |
| **O** 开闭 | 加端点只需扩展 `HostHandlerMap` + 调用点注册一个 handler，`dispatchMessage` 本体不变 | **已修复（A2）** |
| **L** 里氏替换 | `WorkerIndexHost` / `MainThreadIndexHost` 可互换，`DataService` 依赖 `IndexHost` 接口而非具体类（fallback 依赖此） | **遵守** |
| **I** 接口隔离 | `HostHandlerMap` 按端点逐字段声明 typed handler，调用点仅注册所需端点 | **已修复（A2）** |
| **D** 依赖倒置 | host 与 webview 均依赖 `core/query.ts` 共享纯层，层边界恢复单向 | **已修复（A1）** |

### DRY
- **良好**：`searchEngine`（搜索/过滤算法单份）、`logic.ts`（LRUCache/ThrottleQueue/窗口计算单份）、`protocol/rpc.ts`（协议类型单份）、`LineIndex.build`（构建单份）。
- **局部重复**：端点映射——常量+联合类型在 rpc.ts 单份、handler 注册在调用点（A2 已消除 dispatchMessage 内 switch 分支）；HTML 模板已收敛为单一 `renderWebviewShell` 外壳工厂（T6 已修复）。
- 总体：**DRY 达标**，T3 的动机恰是 DRY（前后端过滤一致），只是归属错了层；**A1 已将其归位到 `src/core/query.ts`**，两端仍共用单一事实来源，且层边界恢复单向。

### KISS
- **遵守（依赖层面）**：零运行时依赖、纯 TS + esbuild、手写轻量状态机而非引框架——故障面最小、bundle 最小、启动最快。
- **必要复杂（代码形态）**：虚拟滚动 + 双栏 + 响应式 + 搜索/过滤 + 持久化 + 大文件流式，复杂度有其功能来源；手写而非框架是 KISS 的另一种体现。
- 总体：**KISS 在"少依赖"层面遵守**；形态复杂是功能使然，非过度设计。

---

## 六、是否采用 / 严格遵守相关原则——具体建议与权衡

### A 组：建议采纳（高 ROI、低风险）

| 项 | 动作 | 解决 | 风险 | 权衡 |
|---|---|---|---|---|
| **A1** | 抽 `src/core/`（或并入 `protocol/`）放置 `FieldCondition` + `matchesFilter` + `recordFieldValue`；host 与 webview 均从 core 引用 | T3 反向依赖、DIP | 低（纯移动 + 改 import） | 消除层倒置，且保留"前后端过滤单一事实来源"的 DRY 收益 |
| **A2** | RPC handler 改为注册表：`type Handler = (payload, rid) => Promise<Response|void>`；`Map<endpoint, Handler>`；`dispatchMessage` 查表分发；新增端点只改 1 处 | T2、OCP、三处表达 | 中（需重构 dispatchMessage + mountViewer 调用点） | 若规划加功能（导出/聚合统计）应先做；端点稳定则可缓 |
| **A3** | `mountViewer` 拆 `buildWebviewHtml()` / `registerHostHandlers()` / `startStaleWatch()` | T1、SRP | 低 | 降中心函数体积，命令/编辑器共享点保留 |
| **A4** | `releaseService` 的 `dispose` 补 `.catch`；`serviceRegistry` 改为显式持有（如挂到 context 或闭包注入） | T4 | 低 | 消除隐式全局 + 防御性兜底 |

> **建议优先级**：A1 > A3 ≈ A4 > A2。A1 是架构卫生且最低风险；A2 仅在"要加端点"时紧迫。

### B 组：不建议严格遵守（低 ROI / 过度工程）

| 项 | 为什么不采 | 权衡 |
|---|---|---|
| **B1** 引入 DI 容器 / 抽象工厂 | 单扩展单作者，手动构造已清晰；DI 增加样板与学习成本 | 过度设计 |
| **B2** 拆 `DataService` → `IndexService`/`ReadService`/`SearchService` | 当前 `DataService` 内聚为"数据宿主"单一概念，拆了反而接口爆炸、调用方混乱 | 违反 KISS |
| **B3** 引 React/Svelte 替代手写 webview | bundle/启动/依赖成本上升；`logic.ts` 已隔离纯逻辑，组件化边际收益低 | 性能/体积优先场景下得不偿失 |
| **B4** 抽象"存储后端"多态（本地/远程/对象存储） | 当前仅 `file` + `vscode-remote` 且都走 `fsPath`；抽象过早 | YAGNI |

### C 组：当前不必做
- ~~`dispatchMessage` 重构（A2）~~ **✅ 已修复（A2）**：端点映射已收敛为 `HostHandlerMap` 注册表，详见 §4.1；原"可暂缓"项已落地。
- `webviewEntry` 拆分（T5）**已完成（增量+测试网）**——`logic.ts` 已抽纯逻辑；协调层按"先测试网、后分片抽"推进：✅ #28 导出化 + #29 测试网 + #30 `columnLayout` + #31 `queryActions` + #32 `persistence`。`webviewEntry.ts` 1112→822 行（−26%），新增 3 模块 + 19 项模块级测试；每步行为不变、三道门全绿、独立提交。

---

## 七、验收与下一步

- 当前门禁有效：`tsc --noEmit` 零错误；`node --experimental-transform-types --test "src/**/*.test.ts"` **177/177**（含 webview jsdom 测试网；实测递归正常）；探针 `scripts/audit-stability.ts` 0 失败；300MB 回归全绿。
- **A 组已全部落地**（独立提交、每步全量测试不回归）：A1（抽 `core/query.ts` 消除 host→webview 反向依赖）、A3（拆 `mountViewer` 上帝函数）、A4（`releaseService.dispose` 补 `.catch`）、A2（`dispatchMessage` 改为 `HostHandlerMap` 注册表查表分发）。T1–T4 债务状态见 §三表格。
- 报告与既有 `docs/STABILITY_AUDIT.md` 互补：稳定性审计关注"不崩溃"，本评审关注"结构可维护"。
