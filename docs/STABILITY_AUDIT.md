# JSONL Viewer 稳定性 / 可用性审计报告

> 审计日期：2026-09-20 ｜ 版本：v1.5.1 ｜ 方法：静态阅读 + 可复现探针实测
> 探针脚本：`scripts/audit-stability.ts`（`node scripts/audit-stability.ts` 可复现）
> 免责：本机无图形 VS Code，涉及「扩展宿主进程」与「webview 渲染」的条目为静态推断 + 官方文档佐证，
> 标注为「推断」；其余条目均有实测证据。

---

## 一、结论摘要

性能问题（阶段一~三）已解决；**本轮审计聚焦「不崩溃、不假死、不静默失败」**，共识别 **12 项**问题。

| 级别 | 数量 | 摘要 |
|---|---|---|
| **P0** | 2 | ① 宿主未捕获异常可致扩展宿主崩溃（影响其它扩展）；② worker 加载失败不回退，插件彻底不可用 |
| **P1** | 4 | ③ 取消轮询定时器泄漏；④ worker 侧静默吞掉请求致挂起；⑤ 超时阈值与 GB 级文件不匹配致误报；⑥ 读批无上限 |
| **P2** | 6 | ⑦ worker 无 exit 兜底；⑧ cancelled 集合泄漏；⑨ worker/内存无多开约束；⑩ 搜索朴素匹配性能；⑪ 大文件无进度反馈；⑫ scheme 未校验 / 日志不可开启 / 编码无提示 |

**实测已排除**（确认安全，无需再查）：空文件、纯换行文件、UTF-8 BOM、深嵌套 JSON（5000 层）、非法与越界参数、dispose 后调用、文件删除、GBK 容错、不存在的路径 / 目录路径。

---

## 二、P0 — 高危（可致崩溃或完全不可用）

### P0-1 宿主侧未捕获异常 → 可能击穿扩展宿主（影响所有扩展）

**位置**

- `src/extension.ts` · `mountViewer()` 消息回调尾部：
  ```ts
  try { response = (await dispatchMessage(...)).response; }
  catch (e) { hostErr(...); response = errReply(...); }
  if (response) post(response);   // ← 在 try 之外
  ```
- `src/extension.ts` · `activate()`：
  ```ts
  vscode.commands.registerCommand(OPEN_COMMAND, (uri) => { void openJsonlViewer(context, uri); });
  ```
  `openJsonlViewer()` 内部无 try/catch，而 `showOpenDialog` / `createWebviewPanel` 均可能 reject（如 webview 配额、面板创建失败）。
- `src/extension.ts` · `post()`：`void webview.postMessage(msg)` 丢弃返回值，未 `.catch()`。
- `src/extension.ts` · `staleTimer`：`setInterval(async () => { ... post(...) })` 的 `post` 在面板销毁竞态窗口内可能失败。

**根因**：Node ≥15 的 `unhandledRejection` 默认行为是**抛出未捕获异常**（`--unhandled-rejections=throw`）。
上述任一路径产生未处理的 Promise rejection，即可能使**扩展宿主进程**退出。
扩展宿主是**所有扩展共享的进程**——一旦退出，用户其它扩展的临时状态一并丢失。VS Code 可能拦截部分情况，但不应依赖宿主兜底。

**影响**：偶发、难复现的「整片扩展集体失灵」。属于本次审计最严重项。

**修复建议**（低成本、高收益）

1. `post()` 改为 `void webview.postMessage(msg).then(undefined, () => {})`，彻底吞掉已销毁面板的发送失败。
2. `mountViewer()` 内 `post(response)` 移入 `try`，或整体包裹 try/catch。
3. `registerCommand` 回调改为 `void openJsonlViewer(...).catch((e) => hostErr(...))`。
4. `openJsonlViewer()` 主体包 try/catch，失败弹 `showErrorMessage` 而非冒泡。
5. `staleTimer` 回调内 `post` 同样加防护。

---

### P0-2 worker 加载失败**不回退**主线程 → 插件彻底不可用

**实测证据**（探针 A 段）

```
· createIndexHost kind = worker
❌ worker 脚本缺失 → build 直接失败（未回退主线程）
    ↳ Cannot find module 'c:\definitely\not\exists\indexWorker.js'
```

**位置**：`src/host/indexHost.ts` · `createIndexHost()`

```ts
try { return new WorkerIndexHost(workerScriptPath); }
catch (e) { console.warn('...回退主线程...'); }
return new MainThreadIndexHost();
```

**根因**：`new Worker(path)` 对**不存在的路径不会同步抛错**，而是异步 emit `'error'`。
因此 `try/catch` 形同虚设：`createIndexHost` 返回 `kind='worker'` 的宿主，随后 `build()` 的 Promise 被 `onError` reject →
`DataService.ensureIndex()` 抛出 → 整个插件**打不开任何文件**，且**不会**降级到主线程。

**影响**：任何 worker 加载失败（脚本缺失 / 打包遗漏 / 文件损坏 / 权限 / Node 不支持 ESM worker）都是**断崖式不可用**，
而非设计中所说的「保底可打开」。v1.5.0 那次 `.vscodeignore` 漏打包 `indexWorker.js`，用户遇到的就是这个——
**更正此前记录**：那不是「静默回退主线程」，而是「彻底打不开」。

**修复建议**：把降级从「构造期同步判断」改为「**首次 build 异步探测 + 失败重试主线程**」：
`WorkerIndexHost.build()` 失败且属「worker 不可用」类错误时，`DataService.ensureIndex()` 自动换 `MainThreadIndexHost` 重建一次。
另加「启动期自检」：`activate()` 时后台预热一次 worker 探针，日志记录实际生效路径。

---

## 三、P1 — 中危（假死、泄漏、误报）

### P1-1 取消轮询定时器泄漏（`setInterval` 永不停止）

**位置**：`src/host/indexHost.ts`
- `onError()`：`for (const p of this.pending.values()) p.reject(e);` —— **未调用 `p.stop?.()`**
- `dispose()`：末尾同样的遍历 reject —— **同样未调用 `p.stop?.()`**

**根因**：`search()` / `filter()` 在传入 `shouldCancel` 时会起一个 30ms 的 `setInterval` 轮询；
`stop` 只在「正常收到结果」路径被调用。异常 / 释放路径遗漏 → 定时器永久存活。

**影响**：每发生一次「搜索出错」或「面板关闭时搜索在途」，就泄漏一个 30ms 定时器；
闭包同时持有 `shouldCancel` → 连带持有整个 `DataService`（含索引与 reader），**阻止 GC**。
长时间使用后表现为 CPU 空转 + 内存不降。

**修复建议**：`onError` / `dispose` 遍历时先 `p.stop?.()`；`pending` 的清理统一走一个 `settleAll()` 私有方法。

---

### P1-2 worker 侧静默吞掉请求 → 调用方永久挂起

**位置**：`src/host/indexWorker.ts`

```ts
case 'search': { if (!li || !reader) return;   // ← 直接 return，不回任何响应
case 'filter': { if (!li || !reader) return;   // ← 同上
```

**根因**：`build` 失败（或尚未完成）时 `li`/`reader` 为 `undefined`，`search`/`filter` 静默返回。
主线程 `pending` 表项永不结算 → 上层 `await` 永久挂起。

**影响**：宿主侧内存中堆积悬挂 Promise；webview 侧要等 15s 超时才恢复（表现「搜索点了没反应」）。

**修复建议**：改为 `post({ type:'error', requestId, message:'索引尚未就绪' })`。

---

### P1-3 超时阈值与 GB 级文件不匹配 → 把「正常」误报成「故障」

**位置**：`src/constants.ts` · `INIT_TIMEOUT_MS = 8_000`、`RPC_TIMEOUT_MS = 15_000`

**实测基准**：315MB / 307200 行 → 索引构建 **326ms**（≈ 1ms/MB）。

**推算**

| 文件 | 预计索引耗时 | 是否触发 8s INIT 超时 |
|---|---|---|
| 1 GB | ≈ 1.1s | 否 |
| 5 GB | ≈ 5.3s | 否 |
| **8 GB** | **≈ 8.5s** | **是 → 误报「未收到宿主数据响应（8s 超时）」** |
| 10 GB | ≈ 10.6s | 是 |

慢盘（HDD / 网络盘 / 加密卷 / 首次冷读）可再慢 5~10×，则 1~2GB 文件也可能误报。

**影响**：用户在**一切正常**的情况下看到红色错误横幅「未收到宿主数据响应」，直接判定「插件坏了」——
恰是可用性最忌讳的「伪故障」。

**修复建议**：超时改为**自适应**：以文件大小估算基准（≈1ms/MB，含安全系数 5×，下限 15s、上限 120s），
或把 INIT 超时从「连接失败」改为「仍在构建中」的**柔性提示**（区分「无响应」与「索引构建中」）。

---

### P1-4 `readRecords` 无批量上限（实测）

**实测证据**（探针 F 段）

```
❌ readRecords 无批量上限：一次请求可解析并回传整个文件
   ↳ 请求 1e6 → 实际返回 20000 条，耗时 76ms（webview 端将整批序列化/缓存）
```

**位置**：`src/host/dataService.ts` · `readRecords()`：`const n = Math.min(count, Math.max(0, li.totalLines - startLine));`

**根因**：只受「文件总行数」约束，没有独立的单次上限。

**影响**：当前 webview 只传 `PAGE_SIZE=20`，正常路径安全；但这层**协议边界没有任何防护**——
一旦前端被改动、消息被伪造或出现 bug 传入大 `count`，会一次性解析数十万行并整批 `postMessage`，
webview 侧 `LRU(600)` 逐出压力与序列化开销瞬间打满 → 卡死 / OOM。

**修复建议**：`RECORDS_MAX_COUNT = 2000`（或 `PAGE_SIZE` 的 10 倍），超出即截断并复用 `hasMore` 语义。

---

## 四、P2 — 低危（健壮性、体验）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| P2-1 | `indexHost.ts` 构造函数 | 只监听 `'message'` / `'error'`，**未监听 `'exit'`**。worker 正常退出（`port.close()`）或 `process.exit()` 时 `'error'` 不触发 → pending 悬挂 | 加 `on('exit')`：非 dispose 阶段的退出一律 reject 全部 pending |
| P2-2 | `indexWorker.ts` | `cancelled: Set<number>` 只在 `dispose` 清空；每次取消都 `add`，永不 `delete` → 缓慢内存泄漏 | `search`/`filter` 结算后 `cancelled.delete(requestId)` |
| P2-3 | `extension.ts` / `indexHost.ts` | **每个挂载点一个 worker**（每个标签页 1 个 worker + 2 个文件句柄：worker 内 1 + 主线程 1）；`retainContextWhenHidden: true` 常驻内存 | 设 worker 并发上限 / 隐藏时释放；或复用索引宿主池 |
| P2-4 | `searchEngine.ts` · `bufferIncludesCI` | 朴素 `O(行字节 × query 长度)` 匹配。315MB 文件 + 长 query 可达数十秒，叠加 15s 超时 → 「搜索无响应」 | 改 `latin1` 视图 + `toLowerCase()` + 原生 `includes()`（1:1 字节映射，语义等价，原生化加速） |
| P2-5 | `indexHost.ts` · `WorkerIndexHost.build` | `_onProgress` **参数被忽略** → GB 级文件构建期间 UI 无任何进展反馈 | worker 内周期性 `post({type:'progress'})`，主线程转发 |
| P2-6 | `package.json` · `menus` / `openJsonlViewer` | 未校验 `uri.scheme`。对 `untitled:` / `vscode-vfs:` / 远程等非 `file` 资源，`uri.fsPath` 无效 → 底层报错无友好提示 | 校验 `scheme === 'file'`，否则 `showWarningMessage` 明确说明「仅支持本地文件」 |
| P2-7 | `extension.ts` | `debugLogging` 恒为 `false`，注释称「可在 devtools 设置 `__JLV_DEBUG__`」——该变量在**宿主侧模块作用域**，webview devtools 无法触及 → 用户排障时拿不到任何宿主日志 | 绑定配置项 `jsonlViewer.debug`（默认 false），或在 OutputChannel 始终输出关键路径 |
| P2-8 | `jsonParser.ts` / webview | GBK 等非 UTF-8 文件「乱码但静默」（实测：不崩溃，但首行可能报「非法字符」而用户不知是编码问题） | 检测到高比例坏行时，提示「文件可能不是 UTF-8 编码」 |

---

## 五、实测已排除（确认安全）

| 场景 | 结果 |
|---|---|
| 空文件（0 字节） | ✅ `totalLines=0`，`readRecords` 返回空批，`getSampleFields` 不抛错 |
| 纯换行文件 | ✅ 行数正确 |
| UTF-8 BOM | ✅ 首行解析成功（`parseJsonLine` 的 `trim()` 覆盖 `\uFEFF`） |
| 深嵌套 JSON（5000 层） | ✅ 宿主不爆栈、不误判；webview 侧另有 `MAX_RENDER_DEPTH` + 分批展开 |
| 非法 / 越界参数（NaN、负数、0、1e9） | ✅ 全部优雅返回，无挂起 |
| `dispose()` 后调用 | ✅ 自愈重建，不抛错 |
| 索引构建后文件被删除 | ✅ `checkStale` 检出；已建索引仍可读，不崩溃 |
| GBK 文件 | ✅ 不崩溃（容错解析） |
| 不存在的路径 / 目录路径 | ✅ 明确抛错，调用方可捕获提示 |
| `LineIndex.build` 超大单行 | ✅ 纯流式（chunk 内 `indexOf`，无跨块拼接），不会 OOM |

---

## 六、建议修复批次

| 批次 | 内容 | 风险 | 价值 |
|---|---|---|---|
| **第一批（建议立即）** | P0-1 未捕获异常防护 + P0-2 worker 失败回退 | 低（局部加固，不改架构） | 消除「崩溃」与「彻底不可用」两类致命问题 |
| **第二批** | P1-1 定时器泄漏 + P1-2 静默挂起 + P1-4 读批上限 | 低 | 消除泄漏与悬挂 |
| **第三批** | P1-3 自适应超时 + P2-5 进度反馈 + P2-7 日志开关 | 中（改交互语义） | 消除「伪故障」，大文件体感可用 |
| **第四批** | P2-1/2/3/4/6/8 | 低~中 | 长稳与体验收口 |

**验收口径**：每批修复后，`scripts/audit-stability.ts` 对应条目转绿 + `tsc --noEmit` 零错误 + 全量测试不回归；
探针脚本保留为长期回归网（其中的检查项逐步转成 `src/**/__tests__` 正式用例）。

---

## 七、修复状态（2026-09-20 全部落地）

| 编号 | 问题 | 状态 | 验收证据 |
|---|---|---|---|
| P0-1 | 宿主未捕获异常 | ✅ 已修 | `post()` 吞失败 / 回执入 try / 命令回调 catch / `openJsonlViewer` 与 `resolveCustomEditor` 加边界 |
| P0-2 | worker 失败不回退 | ✅ 已修 | 新增 `buildIndexWithFallback()`；探针 A 段实测 `fellBack=true`，配坏 worker 路径仍可打开读批；`indexHostFallback.test.ts` 3 用例 |
| P1-1 | 取消定时器泄漏 | ✅ 已修 | 统一 `settleAll()`（先 stop 再 reject 再 clear），`onError`/`dispose`/`exit` 三路径共用 |
| P1-2 | worker 静默吞请求 | ✅ 已修 | `search`/`filter` 索引未就绪时回执 error |
| P1-3 | 超时误报 | ✅ 已修 | INIT 改柔性「正在构建索引…」提示 + `RPC_HEAVY_TIMEOUT_MS=120s` 专用于重活请求 |
| P1-4 | 读批无上限 | ✅ 已修 | `RECORDS_MAX_COUNT=2000`；探针 F 段转绿；单测断言钳制与 `hasMore` |
| P2-1 | worker 无 exit 兜底 | ✅ 已修 | 新增 `worker.on('exit')` + `disposing` 标志区分正常/异常退出 |
| P2-2 | cancelled 集合泄漏 | ✅ 已修 | 请求结算后 delete + cancel 时按 requestId 水位线剪枝 |
| P2-4 | 搜索 O(n×m) | ✅ 已修 | 三级策略（原生 includes / 非字母快速否定 / ASCII 折叠后原生 includes）；4 条语义回归锁定；300MB 搜索与暴力解**逐条一致** |
| P2-5 | worker 进度被忽略 | ✅ 已修 | 协议补 `progress` 消息，主线程按 requestId 转发，宿主编入输出面板（限速 1 次/秒） |
| P2-6 | 未校验 scheme | ✅ 已修 | 新增 `isFsReadable()`；命令路径明确警告，自定义编辑器渲染占位页 |
| P2-7 | 日志无法开启 | ✅ 已修 | 绑定配置 `jsonlViewer.debug`，支持变更监听即时生效 |

**最终验证**：`tsc --noEmit` 零错误 ｜ 全量 **149/149** 通过 ｜ 探针 **0 失败** ｜ 300MB 门禁全绿。

### 尚未处理（需大帅决策，非崩溃类）

- **P2-3 worker / 内存无多开约束**：每个打开的标签页各自持有 1 个 worker + 2 个文件句柄，且 `retainContextWhenHidden: true` 使其常驻。
  闲置 worker 开销有限，但「同时打开数十个大文件」时内存会累积。
  可选方案：① 扩展级活跃 worker 上限（超额退化主线程）；② 标签不可见时释放 worker（需接管 onDidChangeViewState）。
  两者各有取舍（前者让第 N+1 个文件变慢，后者增加状态复杂度），建议后续单独评估。
- **P2-8 非 UTF-8 编码提示**：GBK 文件表现「乱码但不崩溃」（已实测）。可靠判定编码的成本高于收益，暂缓。

