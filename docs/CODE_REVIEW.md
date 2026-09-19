# JSONL Viewer — 深度审查报告

> 审查日期：2026-09-19 · 审查范围：全部源码（宿主侧 / webview 纯逻辑 / DOM 层 / 工程化）
> 状态：**持续追踪**。修复完成后在对应条目旁标注 ✅ 与修复 commit。

---

## P0 严重（功能性缺陷 / 资源泄漏 / 安全）

### P0-1 XSS 注入面：字段名未转义直接拼 innerHTML
- 位置：[virtualScroll.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/webview/virtualScroll.ts) 摘要预览 `${it.key}` 未经过 escapeHtml（值已转义）。
- 影响：恶意 JSONL `{"<img src=x onerror=…>": 1}` 可注入 HTML；CSP 挡脚本但 `style-src 'unsafe-inline'` 允许 CSS 注入（UI 伪造/钓鱼）。
- 修复：✅ `escapeHtml(it.key)`（virtualScroll.ts:387）。

### P0-2 dispose/reload 与在途索引构建竞态 → 文件句柄泄漏
- 位置：[dataService.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/host/dataService.ts) `ensureIndex`。
- 影响：快速开关面板 / 反复 reload 大文件累积泄漏 fd。
- 修复：✅ generation/epoch 计数，build 完成检测代际变化则自关 reader 并丢弃结果；`dispose()` await 在途 build 并递增代际。

### P0-3 ensureIndex 失败后永久卡死
- 位置：[dataService.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/host/dataService.ts) `ensureIndex`。
- 影响：build 抛错（文件被删/EMFILE/权限）后 `building` 永久 rejected，全部请求失败，只能手动 reload。
- 修复：✅ catch 后重置 `building = undefined` 允许重试；`finally` destroy stream。

### P0-4 过滤视图下稀疏匹配 → 巨量窗口拉取
- 位置：[webviewEntry.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/webview/webviewEntry.ts) `onRangeChange`。
- 影响：稀疏匹配（如命中分布在第 100 与第 500 万行）时 count 达数百万，宿主全量读+解析、LRU 抖动、易超时。
- 修复：✅ 新增 `segmentSortedLines` 纯函数（logic.ts），过滤态只按相邻性分段拉取实际命中行；调度器改为多段串行窗口（webviewEntry.ts）。

### P0-5 supersede 请求不立即结算 → unhandled rejection + pending 滞留
- 位置：[rpc.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/webview/rpc.ts) `supersede`；[webviewEntry.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/webview/webviewEntry.ts) `fetchWindow`。
- 影响：宿主取消后响应永不回来，Promise 挂到 15s 超时才 reject；`fetchWindow` 无 catch，拒绝穿透 ThrottleQueue 成 unhandled rejection。快速翻页/切换行必现。
- 修复：✅ supersede 立即 `reject(CancelledError)` + 清 timer + 删表项；`fetchWindow` 补 catch 并返回状态。

### P0-6 详情树标量值不截断
- 位置：[detailTree.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/webview/detailTree.ts) `formatScalar`。
- 影响：10MB 字符串 → 10MB 文本节点，卡顿耗内存。
- 修复：✅ 文本截断到 MAX_SCALAR_TEXT（400 字 + …），全文放 title。

### P0-7 ERROR_SUMMARY 死链路（每次打开白扫一次全文件）
- 位置：[extension.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/extension.ts) 推送；[webview/rpc.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/webview/rpc.ts) 未消费。
- 影响：宿主每次打开都全文件扫坏行，webview 侧静默丢弃。
- 修复：✅ 删除推送、`getErrorSummary`/`getErrorLines`、协议端点/类型/分发分支及相应 handler（顺带清理 `peekIndex` 死三元）。

### P0-8 键盘导航不联动详情面板 + Enter 无实现
- 位置：[virtualScroll.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/webview/virtualScroll.ts) `reveal()`。
- 影响：↑↓/PageUp/Home/End 选行后右栏不加载详情；Enter 无实现。
- 修复：✅ `reveal()` 末尾补 `cb.onSelect(real)`；PageDown/PageUp、Home/End 分支同步补 onSelect；新增 Enter 激活选中行。

### P0-9 JSON 树完全不可键盘访问
- 位置：[detailTree.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/webview/detailTree.ts) 树行/toggler。
- 影响：无 tabIndex/role/aria-expanded，键盘与读屏用户无法操作树。
- 修复：✅ 树容器 `role="tree"` + aria-label；行 `role="treeitem"` + aria-level + aria-expanded（容器行 tabindex=0 可聚焦）；Enter/Space 触发展开/折叠与「加载更多」；expandNodeLocal/collapseNodeLocal 同步 aria-expanded。

---

## P1 中等

**后端**
- **M1 maxResults 不提前终止扫描**：[searchEngine.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/host/searchEngine.ts) 命中达上限后仅停止 push 不 break，全文件扫完；`total` 被覆盖为 MAX_SAFE_INTEGER。→ 达限即 break。
- **M2 取消契约不完整**：[extension.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/extension.ts) `cancel.delete` 只在 readRecords/search/filter 执行；getSampleFields/getErrorLines 内部无视 shouldCancel。→ dispatch 层 finally 统一 delete。
- **M3 参数无入口校验**：[rpc.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/protocol/rpc.ts) + [dataService.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/host/dataService.ts)：脏行号可入 knownBadLines；scope end 注释"含"实际"开"。→ 整数化校验 + 统一语义。
- **M4 错误信息含原始数据片段**：[jsonParser.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/parser/jsonParser.ts) `friendlyJsonError` 保留 V8 原文回显。→ 剥离引号内原文。
- **M5 post 未捕获 + 隐藏时仍轮询**：[extension.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/extension.ts) 面板关闭后 post reject；5s stat 轮询在 hidden 时仍运行。→ 面板 hidden 暂停轮询 + post 兜底 catch。

**前端**
- **M6 ThrottleQueue 失败死循环重试**：[logic.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/webview/logic.ts) worker 抛错后 finally 重排 → 无限重试。→ drain 捕获错误并丢弃当前 latest。
- **M7 过滤截断无提示**：[webviewEntry.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/webview/webviewEntry.ts) `runFilter` 忽略 truncated。→ 展示提示。
- **M8 全量展开同步构建整棵子树**：[detailTree.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/webview/detailTree.ts) depthLimit=400 一次性同步建 DOM。→ 分批。
- **M9 浮层面板无焦点管理/Esc/外点关闭**：[toolbar.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/webview/toolbar.ts)。→ ✅ panelShell 新增 `open()`（聚焦首个控件）、面板内 Esc 关闭、外点（非面板非触发按钮）关闭。
- **M10 ARIA 基线缺失**：→ ✅ 图标按钮补 aria-label（复制行号/展开/折叠/清除/搜索导航）；listbox 同步 `aria-activedescendant`；空态 `role="status"`；搜索计数 `aria-live="polite"`。
- **M11 长 key 硬截断**：[styles.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/webview/styles.ts) `.jlv-key` 无 ellipsis/title。→ ✅ max-width:42% + ellipsis + nowrap；keyEl 设完整 title。
- **M12 分页条窄屏溢出**：[styles.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/webview/styles.ts) 210px > 左栏最小 180px。→ 窄时隐藏省略号/折行。
- **M13 持久化脏数据覆盖当前布局**：[queryLogic.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/webview/queryLogic.ts) 校验通过才采纳。
- **M14 reloadFile 复位不完整**：[webviewEntry.ts](file:///c:/WorkSpace/TraeSpace/jsonl-viewer/src/webview/webviewEntry.ts) 未重置 searchQuery、未清 persistTimer。

**工程化**
- **M15 核心链路测试零覆盖**：→ ✅ 补 26 个测试——dispatchMessage 全端点参数化（rpc.test.ts）、RpcBus 成功/超时/supersede/迟到丢弃/ERROR/订阅/dispose（rpcBus.test.ts）、DataService 概览/读批/字段/搜索过滤/checkStale/reload/dispose 复用/失败自愈（dataService.test.ts）。顺带修复 RpcBus/DataService/extension 构造函数参数属性语法（Node 类型擦除不支持，违反自有约定）。
- **M16 README 与实现漂移**：→ ✅ 删除 `VirtualListLayout`/`OVERSCAN_ROWS`/`DEFAULT_ROW_HEIGHT` 死代码及其测试；README 更新为分页式目录描述、体积表改为量级并注明以实际为准。
- **M17 Node 版本要求失实**：→ ✅ package.json 加 `engines.node: ">=22.18"`；RELEASE.md 修正并说明原因。
- **M18 release.mjs 可追溯性缺口**：→ ✅ 发布前串入 `pnpm test`；tag 已存在必须指向当前 HEAD 否则退出；sha256 改标准 `<hash>  <filename>` 格式。
- **M19 未使用依赖**：→ ✅ 移除 `@vscode/webview-ui-toolkit` 并重建锁文件。
- tsconfig 严格度：→ ✅ 开启 `noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch`，清理暴露的 4 处死代码。

---

## P2 轻微

- 死代码：`peekIndex` 三元 no-op、`contentLengthAt` 无调用、`eof` 恒 true、`dispatchMessage` default 不可达、`okReply` 用 `as`。
- tsconfig 未开 `noUnusedLocals/noUncheckedIndexedAccess` 等。
- 无 ESLint/Prettier/CI/husky。
- `pnpm-workspace.yaml` 的 `allowBuilds` 非官方键。
- sha256 文件格式非标准（夹带字节数）。
- reduced-motion 下动画仍等满时长（`animateClose` 220ms / 翻页 exitMs）。
- 面板关闭 100ms 与动画 120ms 不符，淡出截断。
- 跳页 NaN 直接 return 不回退原页码。
- ⌘K 提示无对应快捷键实现。
- 浅色主题未验证（rgba 白边框、%23555 箭头）。
- 卡片逐张绑定监听器（可事件委托）。
- 文档漂移：CODE_WIKI 含机器绝对路径、DESIGN_SYSTEM 部分规范未落地。
- extension.ts Task 7 注释过期。

---

## 修复路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| ① 立即（安全+止血） | P0-1 / P0-3 / P0-7 | ✅ 完成 |
| ② 短期（正确性） | P0-2 / P0-4 / P0-5 / P0-6 | ✅ 完成 |
| ③ 中期（可访问性） | P0-8 / P0-9 / M9 / M10 / M11 | ✅ 完成 |
| ④ 中期（工程基建） | M15-M19、严格 tsconfig | ✅ 完成 |
| ⑤ 持续（增强） | M1/M3/M6/M7/M8/M12-M14 + P2 清理 | ✅ 完成 |

### 阶段⑤ 修复明细（均已完成）
- **M1** 搜索/过滤达 maxResults 立即 break（高频词不再整文件 O(bytes) 浪费）；修正 `SearchScope.endLine` 为开区间注释。
- **M3** `readRecords`/`readRecord` 行号参数整数化校验（脏行号不进读批、不污染 knownBadLines）。
- **M6** `ThrottleQueue` worker 失败丢弃当前值，杜绝宿主持续报错时的无限重试。
- **M7** 过滤结果截断提示（toolbar 新增 `setFilterTruncated` + `.jlv-filter-note` 样式 + aria-live）。
- **M8** 全量展开/展开到 N 层分批构建（每批 50 行 + requestIdleCallback 让出主线程）。
- **M12** 分页条导航/侧栏允许折行（窄屏不溢出）。
- **M13** 持久化 fieldLayout 仅接受合法对象（脏数据不覆盖当前布局）。
- **M14** reloadFile 复位搜索词 + 清持久化定时器 + 重置截断提示。
- **P2 清理**：跳页非法/越界回退原页码；`animateClose`/换页动画 reduced-motion 直接完成；删除无实现的 ⌘K 提示；面板关闭时长 100→120ms 对齐 `--dur-fast`；更新 Task 7 过期注释。
- **未做（记录）**：卡片事件委托（20 卡×2 事件量级小）、浅色主题系统性验证（建议在浅色主题下手动回归）。
