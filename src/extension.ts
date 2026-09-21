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
function makeDataService(key: string, uri: vscode.Uri, context: vscode.ExtensionContext): DataService {
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
    bodyStyle: 'font-family:var(--vscode-font-family);padding:16px;line-height:1.6;color:var(--vscode-foreground)',
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
): void {
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
  const data = runtime.services.acquire(serviceKey, () => makeDataService(serviceKey, uri, context));
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

  const messageSub = registerHostHandlers({ webview, data, uri, context, cancel, post });

  const staleTimer = startStaleWatch({ data, post });

  // Tear down：停止 stale 检测、注销消息订阅，并**释放一次引用**
  // （引用计数归零时才真正关 worker / 释放文件句柄——见 serviceRegistry.release）。
  target.onDispose(() => {
    clearInterval(staleTimer);
    messageSub.dispose();
    runtime.services.release(serviceKey);
  });
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
}

/**
 * 注册 webview→宿主的消息处理（RPC 分发）。返回订阅 Disposable，销毁时由调用方 dispose。
 *
 * 职责单一：仅做「消息分发 + 调用 dataService」，不负责 HTML / stale 检测 / teardown。
 */
function registerHostHandlers(deps: HostHandlerDeps): vscode.Disposable {
  const { webview, data, uri, context, cancel, post } = deps;

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
      hostErr('jumpToSource 失败: ' + (e instanceof Error ? (e.stack || e.message) : String(e)));
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
              const p = await data.readRecords(req.startLine, req.count, () => cancel.has(req.requestId));
              cancel.delete(req.requestId);
              return okReply(HostReply.RECORDS, req.requestId, p);
            },
            [HostEndpoint.READ_RECORD]: async (req) =>
              okReply(HostReply.RESULT, req.requestId, await data.readRecord(req.line)),
            [HostEndpoint.CANCEL]: (req) => {
              cancel.add(req.requestId);
              // 可中断链路：readRecords/search/filter 逐行检查 cancel 集合，
              // 被取消即提前返回；其余轻量请求（抽样/详情/偏好）不响应中断。
              return undefined;
            },
            [HostEndpoint.GET_SAMPLE_FIELDS]: async (req) =>
              okReply(HostReply.SAMPLE_FIELDS, req.requestId, await data.getSampleFields(req.count)),
            [HostEndpoint.JUMP_TO_SOURCE]: async (req) => {
              await jumpToSource(req.line);
              return okReply(HostReply.RESULT, req.requestId, { jumped: true });
            },
            // 全文/字段搜索（宿主流式扫描；被 cancel 则中断）。
            [HostEndpoint.SEARCH]: async (req) => {
              const p = await data.search(req.query, req.field, req.scope, () => cancel.has(req.requestId));
              cancel.delete(req.requestId);
              return okReply(HostReply.SEARCH_RESULTS, req.requestId, p);
            },
            // 字段值过滤。
            [HostEndpoint.FILTER]: async (req) => {
              const cond =
                req.field &&
                (req.op === 'eq' || req.op === 'contains' || req.op === 'exists' || req.op === 'type')
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
          })
        ).response;
      } catch (e) {
        hostErr('处理消息时异常: ' + (e instanceof Error ? (e.stack || e.message) : String(e)));
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
  }, 5000);
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
    hostErr('openJsonlViewer 异常: ' + (e instanceof Error ? (e.stack || e.message) : String(e)));
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

/**
 * 只读自定义编辑器：`.jsonl` / `.ndjson` / `.jsonlines` 的**默认**打开方式（双击即用）。
 *
 * 为何用 `CustomReadonlyEditorProvider` 而非 `CustomTextEditorProvider`：
 * 后者的文档模型是 VS Code 的 `TextDocument`——`resolveCustomTextEditor` 被调用前，
 * VS Code 必须先把整个文件读成文本模型；这既让 200MB+ 文件直接弹「too large to open」
 * （阶段一 P0），也让内存与文件大小成正比。
 *
 * 只读提供者使用**扩展自带的文档模型**：`openCustomDocument` 只拿到一个 URI，
 * 我们不做任何读取，文件始终由 `DataService` 按需从磁盘随机读。于是
 * 「双击即用」与「数 GB 文件可开」不再互斥。
 */
class JsonlCustomEditorProvider implements vscode.CustomReadonlyEditorProvider {
  private readonly context: vscode.ExtensionContext;
  private readonly runtime: HostRuntime;

  constructor(context: vscode.ExtensionContext, runtime: HostRuntime) {
    this.context = context;
    this.runtime = runtime;
  }

  /** 只持有 URI，不读取文件内容（此即超大文件亦可双击打开的关键）。 */
  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
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
      mountViewer(
        { webview: panel.webview, onDispose: (cb) => panel.onDidDispose(cb) },
        document.uri,
        this.context,
        this.runtime
      );
    } catch (e) {
      // 挂载失败（webview 配额 / 已销毁竞态）同样不得冒泡到扩展宿主。
      hostErr('resolveCustomEditor 异常: ' + (e instanceof Error ? (e.stack || e.message) : String(e)));
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('JSONL Viewer');
  syncDebugFlag();

  // T4/A4：共享状态在此**显式创建**并注入各调用路径（替代此前的模块级隐式全局单例）。
  const runtime: HostRuntime = {
    panels: new Map<string, vscode.WebviewPanel>(),
    services: createServiceRegistry<DataService>((e) =>
      hostErr('DataService dispose 失败: ' + (e instanceof Error ? (e.stack || e.message) : String(e)))
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
        hostErr('命令执行失败: ' + (e instanceof Error ? (e.stack || e.message) : String(e)));
      });
    })
  );

  // 默认编辑器关联：双击 .jsonl / .ndjson / .jsonlines 直接进入本查看器
  // （package.json contributes.customEditors，priority=default）。
  // 只读文档模型 ⇒ VS Code 不会预载整文件 ⇒ 超大文件同样可双击打开。
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      CUSTOM_EDITOR_VIEW_TYPE,
      new JsonlCustomEditorProvider(context, runtime),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: true,
      }
    )
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
