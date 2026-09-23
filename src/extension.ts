import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DataService } from './host/dataService.ts';
import { createServiceRegistry, type ServiceRegistry } from './host/serviceRegistry.ts';
import {
  dispatchMessage,
  errReply,
  initReply,
  okReply,
  requestIdOf,
  HostEndpoint,
  HostReply,
  RpcMessage,
} from './protocol/rpc.ts';
import type { FieldCondition } from './core/query.ts';
import { FILE_STALE_POLL_MS } from './constants.ts';

/** The `viewType` used by the standalone webview panel (命令 / 资源管理器右键菜单路径). */
export const VIEW_TYPE = 'jsonlViewer.webview';

/**
 * The `viewType` contributed as the **default** editor for `*.jsonl` / `*.ndjson` / `*.jsonlines`
 * （package.json `contributes.customEditors`）。双击即进入本查看器。
 */
export const CUSTOM_EDITOR_VIEW_TYPE = 'jsonlViewer.customEditor';

/** Command id, must match `contributes.commands` in package.json. */
export const OPEN_COMMAND = 'jsonlViewer.open';

const WEBVIEW_SCRIPT = 'webview.js';

/**
 * 扩展运行期显式持有的共享状态（T4/A4）。
 *
 * 原先 `openPanels` / `serviceRegistry` 是 extension.ts 的**模块级隐式全局单例**——不可注入、
 * 无法单测。现由 `activate()` 创建唯一实例并通过参数注入到「命令」与「自定义编辑器」两条路径：
 * 生命周期仍与扩展一致，但来源显式、可替换、可测。
 */
interface HostRuntime {
  /** 多面板复用：同一 uri 只保留一个面板，重复打开则 reveal 而非新建。 */
  panels: Map<string, vscode.WebviewPanel>;
  /**
   * 按 uri 复用的 DataService 注册表（带引用计数）。
   *
   * 为何需要：
   *   1. 同一文件可能同时由「默认编辑器」与「命令/右键菜单」两条路径打开，
   *      若各自新建 DataService，会**重复建索引、重复起 worker、重复占文件句柄**；
   *   2. webview 内容在隐藏后重建时（`retainContextWhenHidden:false` 或编辑器重建）
   *      会再次挂载，不复用则要**重新扫描整个文件**——大文件代价极高。
   *
   * 引用计数归零时才真正释放（关 worker / 关联 reader 句柄），保证不做无用功。
   */
  services: ServiceRegistry<DataService>;
}

/** 构造该 uri 的 DataService（读取配置 + worker 脚本路径 + 限速进度日志）。 */
function makeDataService(
  key: string,
  uri: vscode.Uri,
  context: vscode.ExtensionContext
): DataService {
  const sampleLines = vscode.workspace
    .getConfiguration('jsonlViewer')
    .get<number>('sampleLines', 200);
  const workerScriptPath = path.join(context.extensionPath, 'dist', 'indexWorker.js');
  return new DataService(key, uri.fsPath, {
    sampleLines,
    workerScriptPath,
    // 构建进度写入输出面板（限速 1 次/秒，避免 GB 级文件刷屏）——仅 debug 开启时可见。
    onProgress: (() => {
      let lastLog = 0;
      return (info: { bytesRead: number; lines: number; done: boolean }) => {
        const now = Date.now();
        if (!info.done && now - lastLog < 1000) return;
        lastLog = now;
        hostLog(
          info.done
            ? `索引构建完成：${info.lines} 行 / ${info.bytesRead} 字节`
            : `索引构建中：${info.lines} 行 / ${info.bytesRead} 字节`
        );
      };
    })(),
  });
}

/** 日志输出面板：用户可在"输出 → JSONL Viewer"中查看宿主收发情况，便于排障。 */
let output: vscode.OutputChannel | undefined;
/**
 * 调试日志开关，绑定配置项 `jsonlViewer.debug`（在设置里可随时开启，立即生效）。
 *
 * 修正：此前写死 `false`，且注释称可在 webview devtools 设 `__JLV_DEBUG__` —— 该变量位于
 * **宿主侧模块作用域**，webview 根本触及不到，等于用户永远拿不到宿主日志、无法排障。
 */
let debugLogging = false;
function syncDebugFlag(): void {
  debugLogging = vscode.workspace.getConfiguration('jsonlViewer').get<boolean>('debug', false);
}
function hostLog(message: string): void {
  if (output && debugLogging) output.appendLine(message);
}
function hostErr(message: string): void {
  if (output) output.appendLine(`[ERROR] ${message}`); // 错误始终输出
}

/**
 * 该 URI 是否可由 Node fs 直接读取。
 *
 * - `file`：本地文件；
 * - `vscode-remote`：远程工作区——此时扩展宿主运行在远端，`uri.fsPath` 是远端真实路径，同样可读。
 *
 * 其余 scheme（`untitled` / `vscode-vfs` / `git` 等）没有真实磁盘路径，
 * 本查看器依赖「按需随机读磁盘」的核心机制，故不支持——必须给出明确提示，
 * 而不是让底层 fs 抛出难以理解的错误。
 */
function isFsReadable(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' || uri.scheme === 'vscode-remote';
}

/** 非本地资源的占位页面（自定义编辑器无法挂载查看器时展示）。 */
function notLocalHtml(rawScheme: string): string {
  const scheme = rawScheme.replace(/[^\w+.-]/g, ''); // 防御性清洗，仅保留合法 scheme 字符
  return renderWebviewShell({
    lang: 'zh',
    csp: `default-src 'none'; style-src 'unsafe-inline';`,
    viewport: false,
    title: 'JSONL Viewer',
    bodyStyle:
      'font-family:var(--vscode-font-family);padding:16px;line-height:1.6;color:var(--vscode-foreground)',
    bodyInner:
      '<p>JSONL Viewer 仅支持本地文件（或远程工作区中的文件）。</p>\n' +
      `  <p style="opacity:.75">当前资源类型：<code>${scheme}</code>，没有可随机读取的磁盘路径。</p>`,
  });
}

/** viewer 挂载目标：普通 WebviewPanel 与自定义编辑器面板的 webview 语义一致，统一抽象。 */
interface ViewerTarget {
  webview: vscode.Webview;
  /** 目标销毁时回调（用于清理 DataService / 定时器 / 消息订阅）。 */
  onDispose(cb: () => void): void;
  /**
   * 写操作成功后通知（**仅自定义编辑器路径**提供）：把这一步接到 VS Code 的撤销栈。
   *
   * 刻意**不传编辑详情** —— 宿主（DataService）已把该操作连回退数据一起记入会话历史，
   * 这里只需唤醒撤销栈；撤销/重做本身也一律委托给宿主的同一光标。
   *
   * 独立 WebviewPanel 路径（命令 / 右键菜单）没有对应 document，故为 undefined：
   * 编辑照旧落盘，只是不进 VS Code 撤销栈（仍可由历史浮层回溯）。
   */
  reportEdit?: (data: DataService) => void;
}

/**
 * 把 JSONL viewer 前端 + 宿主数据服务挂到给定 webview 上（面板路径与自定义编辑器路径共用）。
 *
 * 关键（阶段一 P0 根治 + 兼容双击）：宿主一律**按 URI 从磁盘按需读**，绝不经过
 * `TextDocument`、绝不 `getText()` 整个文件。因此 200MB~数 GB 文件也能打开，
 * 且内存与「当前请求的行」成正比，而非与文件大小成正比。
 */
function mountViewer(
  target: ViewerTarget,
  uri: vscode.Uri,
  context: vscode.ExtensionContext,
  runtime: HostRuntime
): { data: DataService; post: (msg: RpcMessage) => void } {
  const webview = target.webview;
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'dist', WEBVIEW_SCRIPT)
  );
  const cspSource = webview.cspSource;
  const nonce = getNonce();

  webview.html = renderViewerHtml(scriptUri, cspSource, nonce);

  // Data host: builds a lazy line-offset index on demand and serves records
  // requested by the webview's virtual scroll. Also hosts field-inference
  // sampling, the bad-line (validation-error) set, and source-line jump.
  // 2b：把「索引构建 + 搜索 + 过滤」下沉到 worker（dist/indexWorker.js），
  // 大文件扫描时主线程（webview 消息循环 / 其它扩展）不被阻塞；spawn 失败自动回退主线程。
  // 按 uri 复用：同一文件的多个视图（默认编辑器 / 命令面板）共享同一份索引与 worker。
  const serviceKey = uri.toString();
  const data = runtime.services.acquire(serviceKey, () =>
    makeDataService(serviceKey, uri, context)
  );
  /**
   * 向 webview 发送消息。
   *
   * 防御：面板/编辑器可能已被销毁（用户关闭标签时仍有在途请求完成），此时 postMessage 会失败。
   * 必须吞掉失败——Node ≥15 的 `unhandledRejection` 默认行为是**抛出未捕获异常**，
   * 而扩展宿主是所有扩展共享的进程，绝不能被一次「向已关闭面板发消息」击穿。
   */
  const post = (msg: RpcMessage): void => {
    void Promise.resolve(webview.postMessage(msg)).then(undefined, () => {});
  };
  const cancel = new Set<string>();

  const messageSub = registerHostHandlers({
    webview,
    data,
    uri,
    context,
    cancel,
    post,
    ...(target.reportEdit ? { reportEdit: target.reportEdit } : {}),
  });

  const staleTimer = startStaleWatch({ data, post });

  // Tear down：停止 stale 检测、注销消息订阅，并**释放一次引用**
  // （引用计数归零时才真正关 worker / 释放文件句柄——见 serviceRegistry.release）。
  target.onDispose(() => {
    clearInterval(staleTimer);
    messageSub.dispose();
    runtime.services.release(serviceKey);
  });

  return { data, post };
}

/**
 * 统一的 webview HTML 外壳工厂（T6 收敛：viewer 模板与 notLocal 占位共用同一套结构，
 * 仅 CSP / 是否加载脚本 / body 内容不同）。单一事实来源，模板改动只此一处。
 */
function renderWebviewShell(opts: {
  lang: string;
  csp: string;
  nonce?: string;
  title: string;
  /** 是否输出 viewport meta（占位页不需要自适应视口）。默认 true。 */
  viewport?: boolean;
  /** <body> 内联样式（占位页用）。 */
  bodyStyle?: string;
  /** 外部脚本入口（viewer 需要；占位页不需要）。 */
  scriptSrc?: string;
  bodyInner: string;
}): string {
  const viewportMeta =
    opts.viewport === false
      ? ''
      : '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n';
  const bodyStyle = opts.bodyStyle ? ` style="${opts.bodyStyle}"` : '';
  const scriptTag = opts.scriptSrc
    ? `  <script nonce="${opts.nonce ?? ''}" src="${opts.scriptSrc}"></script>\n`
    : '';
  return `<!DOCTYPE html>
<html lang="${opts.lang}">
<head>
  <meta charset="UTF-8">
${viewportMeta}  <meta http-equiv="Content-Security-Policy" content="${opts.csp}">
  <title>${opts.title}</title>
</head>
<body${bodyStyle}>
  ${opts.bodyInner}
${scriptTag}</body>
</html>`;
}

/**
 * 渲染 webview 的 HTML 外壳（CSP + nonce + 外部脚本入口）。纯函数，便于复用与单测。
 */
function renderViewerHtml(scriptUri: vscode.Uri, cspSource: string, nonce: string): string {
  return renderWebviewShell({
    lang: 'en',
    csp: `default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`,
    nonce,
    title: 'JSONL Viewer',
    scriptSrc: scriptUri.toString(),
    bodyInner: '<main id="app"></main>',
  });
}

interface HostHandlerDeps {
  webview: vscode.Webview;
  data: DataService;
  uri: vscode.Uri;
  context: vscode.ExtensionContext;
  cancel: Set<string>;
  post: (msg: RpcMessage) => void;
  /** 写操作成功后通知（仅自定义编辑器路径有值）。data 由调用方注入，避免依赖挂载结果。 */
  reportEdit?: (data: DataService) => void;
}

/**
 * 注册 webview→宿主的消息处理（RPC 分发）。返回订阅 Disposable，销毁时由调用方 dispose。
 *
 * 职责单一：仅做「消息分发 + 调用 dataService」，不负责 HTML / stale 检测 / teardown。
 */
function registerHostHandlers(deps: HostHandlerDeps): vscode.Disposable {
  const { webview, data, uri, context, cancel, post, reportEdit } = deps;

  // 点击坏行→在磁盘文件中定位该行（超大文件降级为提示，不抛错致面板崩溃）。
  const jumpToSource = async (line: number): Promise<void> => {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preserveFocus: true });
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch (e) {
      void vscode.window.showWarningMessage(
        `无法在编辑器中定位第 ${line + 1} 行：文件过大，VS Code 不能以文本文档打开。` +
          `可改用「复制该行 JSON」查看内容。`
      );
      hostErr('jumpToSource 失败: ' + (e instanceof Error ? e.stack || e.message : String(e)));
    }
  };

  return webview.onDidReceiveMessage((message: unknown) => {
    const incoming = (message as { type?: unknown }).type;
    hostLog(`收到消息: ${String(incoming)}`);
    void (async () => {
      let response: RpcMessage | undefined;
      try {
        response = (
          await dispatchMessage(message, {
            [HostEndpoint.READY]: async () => {
              // 诊断：确认宿主是否收到 webview 的握手消息。
              const st = Date.now();
              const init = initReply(await data.getOverview());
              hostLog(`init 回执构建完成 (${Date.now() - st}ms)`);
              return init;
            },
            [HostEndpoint.GET_OVERVIEW]: async (req) =>
              okReply(HostReply.OVERVIEW, req.requestId, await data.getOverview()),
            [HostEndpoint.READ_RECORDS]: async (req) => {
              // 真正的可中断：读批逐行检测 cancel 集合，被取消即提前返回。
              const p = await data.readRecords(req.startLine, req.count, () =>
                cancel.has(req.requestId)
              );
              cancel.delete(req.requestId);
              return okReply(HostReply.RECORDS, req.requestId, p);
            },
            [HostEndpoint.READ_RECORD]: async (req) =>
              okReply(HostReply.RESULT, req.requestId, await data.readRecord(req.line)),
            // 在第 at 行之前插入一行（编辑能力 M2）。
            [HostEndpoint.INSERT_RECORD]: async (req) => {
              const result = await data.insertRecord(req.at, req.text);
              if (result.ok && reportEdit) reportEdit(data);
              return okReply(HostReply.EDIT_RESULT, req.requestId, result);
            },
            // 删除第 line 行（编辑能力 M2）。
            [HostEndpoint.DELETE_RECORD]: async (req) => {
              const result = await data.deleteRecord(req.line);
              if (result.ok && reportEdit) reportEdit(data);
              return okReply(HostReply.EDIT_RESULT, req.requestId, result);
            },
            [HostEndpoint.CANCEL]: (req) => {
              cancel.add(req.requestId);
              // 可中断链路：readRecords/search/filter 逐行检查 cancel 集合，
              // 被取消即提前返回；其余轻量请求（抽样/详情/偏好）不响应中断。
              return undefined;
            },
            [HostEndpoint.GET_SAMPLE_FIELDS]: async (req) =>
              okReply(
                HostReply.SAMPLE_FIELDS,
                req.requestId,
                await data.getSampleFields(req.count)
              ),
            [HostEndpoint.JUMP_TO_SOURCE]: async (req) => {
              await jumpToSource(req.line);
              return okReply(HostReply.RESULT, req.requestId, { jumped: true });
            },
            // 全文/字段搜索（宿主流式扫描；被 cancel 则中断）。
            [HostEndpoint.SEARCH]: async (req) => {
              const p = await data.search(req.query, req.field, req.scope, () =>
                cancel.has(req.requestId)
              );
              cancel.delete(req.requestId);
              return okReply(HostReply.SEARCH_RESULTS, req.requestId, p);
            },
            // 字段值过滤。
            [HostEndpoint.FILTER]: async (req) => {
              const cond =
                req.field &&
                (req.op === 'eq' ||
                  req.op === 'contains' ||
                  req.op === 'exists' ||
                  req.op === 'type')
                  ? ({ field: req.field, op: req.op, value: req.value ?? '' } as FieldCondition)
                  : null;
              const p = await data.filter(cond, () => cancel.has(req.requestId));
              cancel.delete(req.requestId);
              return okReply(HostReply.FILTER_RESULTS, req.requestId, p);
            },
            // 偏好持久化到 workspaceState（按 uri 命名空间键）。
            [HostEndpoint.PERSIST_STATE]: async (req) => {
              await context.workspaceState.update(req.key, req.value);
              return okReply(HostReply.RESULT, req.requestId, { ok: true });
            },
            [HostEndpoint.LOAD_STATE]: async (req) =>
              okReply(HostReply.RESULT, req.requestId, await context.workspaceState.get(req.key)),
            // 文件变更后 webview 点「重新加载」→ 重建索引并返回新概览。
            [HostEndpoint.RELOAD]: async (req) =>
              okReply(HostReply.OVERVIEW, req.requestId, await data.reload()),
            // 就地替换某一行（编辑能力）。业务失败（冲突 / JSON 校验不过 / 无权限）同样
            // 走 EDIT_RESULT 回执，便于前端结构化提示；只有宿主内部异常才由
            // dispatchMessage 兜底成 ERROR 回执。
            [HostEndpoint.EDIT_RECORD]: async (req) => {
              const result = await data.editRecord(req.line, req.text, req.expectedBytes);
              // 成功即通知 VS Code（自定义编辑器路径），使其进入撤销栈。
              // 回退数据由宿主随操作一并记入会话历史，此处无需重复上报。
              if (result.ok && reportEdit) reportEdit(data);
              return okReply(HostReply.EDIT_RESULT, req.requestId, result);
            },
            // 全文查找替换（编辑能力 M2）：批量改写命中行，一次性原子落盘。
            // 仅当本批替换具备撤销能力时才上报 —— 超限时如实告知（undoable=false），
            // 而不是静默地让用户以为 Ctrl+Z 能救回来。
            // 坏行诊断（M3 收尾）：查询「已发现」集合。
            // 语义上**不等价于全量**（只含用户读过/抽样过的范围），故回执带 partial 标记 ——
            // 把它当全量会得出「文件挺干净」这种与事实相反的结论。
            [HostEndpoint.GET_BAD_LINES]: async (req) =>
              okReply(HostReply.BAD_LINES, req.requestId, data.getBadLines()),
            // 全文件扫描坏行：耗时只读操作，推进度并支持取消。
            // 取消时宿主**不**替换已发现集合（半份结果比没有结果更容易误导）。
            [HostEndpoint.SCAN_BAD_LINES]: async (req) => {
              const result = await (async () => {
                try {
                  return await data.scanBadLines({
                    onProgress: (info) =>
                      post({
                        type: HostReply.EDIT_PROGRESS,
                        payload: { kind: 'scanBadLines', ...info },
                      }),
                    shouldCancel: () => cancel.has(req.requestId),
                  });
                } finally {
                  // 与 REPLACE_TEXT 同理：摘除标记，否则 cancel 集合随请求次数无界增长。
                  cancel.delete(req.requestId);
                }
              })();
              return okReply(HostReply.BAD_LINES, req.requestId, result);
            },
            [HostEndpoint.REPLACE_TEXT]: async (req) => {
              const result = await (async () => {
                try {
                  return await data.replaceText(req.query, req.replacement, {
                    caseInsensitive: req.caseInsensitive,
                    // 全文件重写可能持续数秒，把节流后的进度推给 webview 显示可取消的进度条。
                    onProgress: (info) =>
                      post({
                        type: HostReply.EDIT_PROGRESS,
                        payload: { kind: 'replace', ...info },
                      }),
                    // 取消走既有 cancel 集合（webview 发 CANCEL 端点置位）。
                    shouldCancel: () => cancel.has(req.requestId),
                  });
                } finally {
                  // 无论成败都必须摘除取消标记，否则 cancel 集合会随编辑次数无界增长。
                  cancel.delete(req.requestId);
                }
              })();
              // 无论是否可撤销都通知撤销栈：宿主已把该操作记入历史，
              // 撤销仍可走历史光标（只是超出撤销数据上限时那一步回退可能失败并如实报错）。
              if (result.ok && reportEdit) reportEdit(data);
              return okReply(HostReply.REPLACE_RESULT, req.requestId, result);
            },
            // 批量删除多行（编辑能力 M2）：相邻行合并成连续区间后一次原子重写；
            // 回传的区间同时用于撤销（与删除共用同一组偏移）。
            [HostEndpoint.DELETE_RECORDS]: async (req) => {
              const result = await (async () => {
                try {
                  return await data.deleteRecords(req.lines, {
                    onProgress: (info) =>
                      post({
                        type: HostReply.EDIT_PROGRESS,
                        payload: { kind: 'replace', ...info },
                      }),
                    shouldCancel: () => cancel.has(req.requestId),
                  });
                } finally {
                  cancel.delete(req.requestId);
                }
              })();
              if (result.ok && reportEdit) reportEdit(data);
              return okReply(HostReply.DELETE_MANY_RESULT, req.requestId, result);
            },
            // 批量复制：宿主读取磁盘原文后由扩展侧写入剪贴板（vscode.env.clipboard
            // 比 webview 的 navigator.clipboard 可靠，不受 webview 权限限制）。
            [HostEndpoint.COPY_LINES]: async (req) => {
              const res = await data.readLinesText(req.lines);
              const payload: Record<string, unknown> = {
                ok: res.ok,
                count: res.count,
                bytes: res.bytes,
                truncated: res.truncated,
                skipped: res.skipped,
              };
              if (res.error) payload.error = res.error;
              if (!res.ok) return okReply(HostReply.COPY_RESULT, req.requestId, payload);
              try {
                await vscode.env.clipboard.writeText(res.text);
              } catch (e) {
                payload.ok = false;
                payload.count = 0;
                payload.error = `写入剪贴板失败：${e instanceof Error ? e.message : String(e)}`;
              }
              // 正文不回传：它已是剪贴板内容，MB 级文本再经 RPC 传一遍纯属浪费。
              return okReply(HostReply.COPY_RESULT, req.requestId, payload);
            },
            // 会话编辑历史：读取快照 / 单步撤销重做 / 回退到某点。
            // 三者共用宿主的**同一光标**，故历史面板与 Ctrl+Z 不会各说各话。
            [HostEndpoint.GET_HISTORY]: (req) =>
              okReply(HostReply.HISTORY, req.requestId, data.getHistory()),
            [HostEndpoint.UNDO_EDIT]: async (req) =>
              okReply(HostReply.HISTORY_RESULT, req.requestId, await data.undoStep()),
            [HostEndpoint.REDO_EDIT]: async (req) =>
              okReply(HostReply.HISTORY_RESULT, req.requestId, await data.redoStep()),
            [HostEndpoint.REVERT_TO]: async (req) =>
              okReply(HostReply.HISTORY_RESULT, req.requestId, await data.revertTo(req.id)),
          })
        ).response;
      } catch (e) {
        hostErr('处理消息时异常: ' + (e instanceof Error ? e.stack || e.message : String(e)));
        // T7：异常回执保留 requestId，使 webview 精确 reject 对应请求（而非升级为全局 error 横幅）。
        response = errReply(requestIdOf(message), e instanceof Error ? e.message : String(e));
      }
      // 回执发送同样纳入 try：避免「面板已销毁」等异常逃逸成未处理 rejection。
      if (response) {
        try {
          post(response);
        } catch (e) {
          hostErr('回执发送失败: ' + (e instanceof Error ? e.message : String(e)));
        }
      }
    })();
  });
}

interface StaleWatchDeps {
  data: DataService;
  post: (msg: RpcMessage) => void;
}

/**
 * 定期检测文件是否被改 / 删（仅索引构建后有基线）。状态从正常转走样时推送一次 FILE_STALE。
 * 返回 stale 定时器句柄，调用方在 teardown 时 clearInterval。
 */
function startStaleWatch(deps: StaleWatchDeps): ReturnType<typeof setInterval> {
  const { data, post } = deps;
  let staleSignaled = false;
  return setInterval(async () => {
    let res;
    try {
      res = await data.checkStale();
    } catch {
      res = null;
    }
    if (!res || res.changed === false) {
      staleSignaled = false;
      return;
    }
    if (staleSignaled) return; // 已提示过，避免重复弹横幅
    staleSignaled = true;
    post({ type: HostReply.FILE_STALE, payload: { message: res.message, deleted: res.deleted } });
  }, FILE_STALE_POLL_MS);
}

/**
 * 打开指定文件到独立的 Webview 面板（命令 / 资源管理器右键菜单路径）。
 *
 * 对外是**永不冒泡异常**的边界：命令回调与右键菜单都直接调用它，任何内部失败
 * （对话框被取消以外的情况、面板创建失败、webview 配额超限…）都必须在此收口，
 * 否则会变成未处理的 Promise rejection，可能击穿扩展宿主进程。
 */
export async function openJsonlViewer(
  context: vscode.ExtensionContext,
  runtime: HostRuntime,
  fileUri?: vscode.Uri
): Promise<void> {
  try {
    await openJsonlViewerUnsafe(context, runtime, fileUri);
  } catch (e) {
    hostErr('openJsonlViewer 异常: ' + (e instanceof Error ? e.stack || e.message : String(e)));
    void vscode.window.showErrorMessage(
      `无法用 JSONL Viewer 打开该文件：${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/**
 * 与 `JsonlCustomEditorProvider` 共用 `mountViewer`：二者都从磁盘按需读，不绑定 TextDocument，
 * 故超大文件（数 GB）走此路径同样可用。
 */
async function openJsonlViewerUnsafe(
  context: vscode.ExtensionContext,
  runtime: HostRuntime,
  fileUri?: vscode.Uri
): Promise<void> {
  let uri = fileUri;

  if (!uri) {
    uri = vscode.window.activeTextEditor?.document.uri;
  }
  if (!uri) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      title: 'Open file with JSONL Viewer',
    });
    uri = picked?.[0];
  }
  if (!uri) return;

  // 仅有真实磁盘路径的资源可被「按需随机读」；否则给出明确提示而非底层报错。
  if (!isFsReadable(uri)) {
    void vscode.window.showWarningMessage(
      `JSONL Viewer 仅支持本地文件（当前资源类型：${uri.scheme}）。`
    );
    return;
  }

  const key = uri.toString();
  // 面板存活时必在 Map 中（onDidDispose 会同步删除），故以存在性判定即可，
  // 无需 isDisposed（WebviewPanel 无此属性）。
  const existing = runtime.panels.get(key);
  if (existing) {
    existing.reveal();
    return;
  }

  hostLog(`openJsonlViewer: ${uri.fsPath}`);
  const panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    `JSONL: ${uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
    }
  );
  runtime.panels.set(key, panel);

  mountViewer(
    { webview: panel.webview, onDispose: (cb) => panel.onDidDispose(cb) },
    uri,
    context,
    runtime
  );

  panel.onDidDispose(
    () => {
      runtime.panels.delete(key);
    },
    undefined,
    context.subscriptions
  );
}

/** 自定义编辑器文档：仅持有 URI（不读文件内容），并挂一个「从磁盘复位」的回调。 */
interface JsonlDocument extends vscode.CustomDocument {
  readonly uri: vscode.Uri;
  /** 由 `resolveCustomEditor` 注入：重建索引并通知 webview 复位。 */
  resetFromDisk?: () => Promise<void>;
}

/** 本 provider 发出的编辑事件类型（供 `onDidChangeCustomDocument` 类型收敛）。 */
type JsonlDocumentEdit = vscode.CustomDocumentEditEvent<JsonlDocument>;

/**
 * 可写自定义编辑器：`.jsonl` / `.ndjson` / `.jsonlines` 的**默认**打开方式（双击即用）。
 *
 * 为何**不用** `CustomTextEditorProvider`：后者的文档模型是 VS Code 的 `TextDocument` ——
 * `resolveCustomTextEditor` 被调用前，VS Code 必须先把整个文件读成文本模型；这既让
 * 200MB+ 文件直接弹「too large to open」（阶段一 P0），也让内存与文件大小成正比。
 *
 * 本实现使用**扩展自带的文档模型**：`openCustomDocument` 只拿到一个 URI、不做任何读取，
 * 文件始终由 `DataService` 按需从磁盘随机读。于是「双击即用」「数 GB 文件可开」与
 * 「原生编辑体验」三者不再互斥 —— 换来 VS Code 托管的脏标记、撤销/重做、Ctrl+S、
 * 关闭提示与 Hot Exit 备份。
 *
 * 写盘策略为**即时写盘**：每次行替换立即落盘（`DataService.editRecord`），同时以
 * `CustomDocumentEditEvent` 上报使其可撤销。故 `saveCustomDocument` 只需清脏 ——
 * 绝不会在关闭时批量写出 GB 级数据（那正是「延迟写盘」在大文件上的真实风险）。
 */
class JsonlCustomEditorProvider
  implements vscode.CustomEditorProvider<JsonlDocument>, vscode.Disposable
{
  private readonly context: vscode.ExtensionContext;
  private readonly runtime: HostRuntime;

  /** provider 级编辑事件源；事件体自带 document，VS Code 据此定位到具体编辑器。 */
  private readonly editEmitter = new vscode.EventEmitter<JsonlDocumentEdit>();

  readonly onDidChangeCustomDocument = this.editEmitter.event;

  constructor(context: vscode.ExtensionContext, runtime: HostRuntime) {
    this.context = context;
    this.runtime = runtime;
  }

  /** 只持有 URI，不读取文件内容（此即超大文件亦可双击打开的关键）。 */
  openCustomDocument(uri: vscode.Uri): JsonlDocument {
    return { uri, dispose: () => {} };
  }

  resolveCustomEditor(document: JsonlDocument, panel: vscode.WebviewPanel): void {
    try {
      // 非本地资源（untitled / vscode-vfs / git…）无磁盘路径：展示占位说明，不挂载查看器。
      if (!isFsReadable(document.uri)) {
        panel.webview.html = notLocalHtml(document.uri.scheme);
        return;
      }
      panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
      };
      const mounted = mountViewer(
        {
          webview: panel.webview,
          onDispose: (cb) => panel.onDidDispose(cb),
          reportEdit: (ds) => this.reportEdit(document, ds),
        },
        document.uri,
        this.context,
        this.runtime
      );
      // 供 revertCustomDocument 使用：从磁盘重建索引并通知 webview 整体复位。
      document.resetFromDisk = async () => {
        await mounted.data.reload();
        mounted.post({
          type: HostReply.DOCUMENT_RESET,
          payload: { message: '已放弃更改并从磁盘重新加载。' },
        });
      };
    } catch (e) {
      // 挂载失败（webview 配额 / 已销毁竞态）同样不得冒泡到扩展宿主。
      hostErr(
        'resolveCustomEditor 异常: ' + (e instanceof Error ? e.stack || e.message : String(e))
      );
    }
  }

  /**
   * 即时写盘策略下内容早已落盘，此处直接返回即视为「已保存」（VS Code 据此清除脏标记）。
   */
  saveCustomDocument(_document: JsonlDocument, _token: vscode.CancellationToken): Promise<void> {
    return Promise.resolve();
  }

  /**
   * 明确不支持「另存为」：本查看器绑定的是 workspace 中的真实文件，改变落盘目标会让
   * 行索引、变更检测与撤销栈全部失准。抛错让 VS Code 如实提示，而不是静默做半套。
   */
  saveCustomDocumentAs(
    _document: JsonlDocument,
    _destination: vscode.Uri,
    _token: vscode.CancellationToken
  ): Promise<void> {
    return Promise.reject(
      new Error('JSONL Viewer 暂不支持「另存为」；如需副本请在资源管理器中复制文件。')
    );
  }

  /** 放弃改动：从磁盘重建索引，并让 webview 清空缓存/搜索/过滤后重拉。 */
  async revertCustomDocument(
    document: JsonlDocument,
    _token: vscode.CancellationToken
  ): Promise<void> {
    await document.resetFromDisk?.();
  }

  /**
   * Hot Exit 备份：即时写盘下不存在「未保存内容」，故无备份文件可产出 ——
   * 返回空备份以满足 API 契约（重开窗口无需额外恢复动作）。
   */
  backupCustomDocument(
    document: JsonlDocument,
    _context: vscode.CustomDocumentBackupContext,
    _token: vscode.CancellationToken
  ): Promise<vscode.CustomDocumentBackup> {
    return Promise.resolve({ id: document.uri.toString(), delete: () => {} });
  }

  /**
   * 把一步成功的写操作接到 VS Code 的撤销栈上。
   *
   * **收敛为委托**：撤销/重做一律走宿主的 `undoStep` / `redoStep`（**同一光标**），
   * 而不是在此按操作类型自建逆操作。理由：两套撤销机制并存**必然不一致** ——
   * 用户按 Ctrl+Z 撤销了，历史浮层却仍标着「已应用」。
   *
   * 由于 VS Code 以 LIFO 调用、宿主的 `historyCursor` 也是 LIFO，两者天然同步；
   * 描述文案直接取宿主记录的最新一条，无需在此重复推导。
   *
   * 已知限制：若用户先在历史浮层里跳着回退了若干步，VS Code 撤销栈的深度会与光标
   * 错位 —— 状态仍然一致（都以宿主为准），只是 VS Code 显示的 label 可能对不上。
   */
  private reportEdit(document: JsonlDocument, data: DataService): void {
    const h = data.getHistory();
    const latest = h.entries[h.cursor - 1];
    const label = latest?.label ?? '编辑';
    this.editEmitter.fire({
      document,
      label,
      undo: async () => {
        const r = await data.undoStep();
        if (!r.ok) throw new Error(r.error ?? '撤销失败');
      },
      redo: async () => {
        const r = await data.redoStep();
        if (!r.ok) throw new Error(r.error ?? '重做失败');
      },
    });
  }

  dispose(): void {
    this.editEmitter.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('JSONL Viewer');
  syncDebugFlag();

  // T4/A4：共享状态在此**显式创建**并注入各调用路径（替代此前的模块级隐式全局单例）。
  const runtime: HostRuntime = {
    panels: new Map<string, vscode.WebviewPanel>(),
    services: createServiceRegistry<DataService>((e) =>
      hostErr(
        'DataService dispose 失败: ' + (e instanceof Error ? e.stack || e.message : String(e))
      )
    ),
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('jsonlViewer.debug')) {
        syncDebugFlag();
        hostLog(`调试日志已${debugLogging ? '开启' : '关闭'}`);
      }
    })
  );
  hostLog('extension 已激活');

  // Command: open the chosen (or active / picked) file in the JSONL Viewer webview panel.
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_COMMAND, (uri?: vscode.Uri) => {
      // 双层防护：openJsonlViewer 自身已收口异常，此处再兜一道，杜绝未处理 rejection。
      void openJsonlViewer(context, runtime, uri).catch((e) => {
        hostErr('命令执行失败: ' + (e instanceof Error ? e.stack || e.message : String(e)));
      });
    })
  );

  // 默认编辑器关联：双击 .jsonl / .ndjson / .jsonlines 直接进入本查看器
  // （package.json contributes.customEditors，priority=default）。
  // 扩展自有文档模型 ⇒ VS Code 不会预载整文件 ⇒ 超大文件同样可双击打开。
  const editorProvider = new JsonlCustomEditorProvider(context, runtime);
  context.subscriptions.push(
    editorProvider,
    vscode.window.registerCustomEditorProvider(CUSTOM_EDITOR_VIEW_TYPE, editorProvider, {
      webviewOptions: { retainContextWhenHidden: true },
      // 编辑语义下同一文档的多个编辑器会共享同一撤销栈，容易出现「在 A 撤销、B 未同步」
      // 的混乱；查看场景能容忍，编辑场景不能，故关闭。
      supportsMultipleEditorsPerDocument: false,
    })
  );
}

export function deactivate(): void {
  // context.subscriptions 会自动清理命令 / 文件事件；
  // 这里额外关闭 OutputChannel（它不在 subscriptions 里）。
  output?.dispose();
  output = undefined;
}

function getNonce(): string {
  return randomBytes(16).toString('base64');
}
