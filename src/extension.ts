import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DataService } from './host/dataService.ts';
import {
  dispatchMessage,
  errReply,
  initReply,
  HostReply,
  RpcMessage,
} from './protocol/rpc.ts';
import type { FieldCondition } from './webview/queryLogic.ts';

/** The `viewType` used by the standalone webview panel (no `customEditors` contribution needed). */
export const VIEW_TYPE = 'jsonlViewer.webview';

/** Command id, must match `contributes.commands` in package.json. */
export const OPEN_COMMAND = 'jsonlViewer.open';

const WEBVIEW_SCRIPT = 'webview.js';

/** 多面板复用：同一 uri 只保留一个面板，重复打开则 reveal 而非新建。 */
const openPanels = new Map<string, vscode.WebviewPanel>();

/** 日志输出面板：用户可在"输出 → JSONL Viewer"中查看宿主收发情况，便于排障。 */
let output: vscode.OutputChannel | undefined;
let debugLogging = false; // 生产默认关闭，用户可在 devtools console 设置 `__JLV_DEBUG__ = true` 临时开启
function hostLog(message: string): void {
  if (output && debugLogging) output.appendLine(message);
}
function hostErr(message: string): void {
  if (output) output.appendLine(`[ERROR] ${message}`); // 错误始终输出
}

/**
 * 打开指定文件到独立的 Webview 面板（不绑定 TextDocument）。
 *
 * 关键修复（阶段一 / P0）：原先走 `CustomTextEditorProvider`，VS Code 会在
 * `resolveCustomTextEditor` 之前先把整个文件以 `TextDocument` 形式全量载入扩展宿主
 * 内存；超过阈值（约 50MB 起）直接弹「too large to open」拒绝打开，未超阈值也整文件
 * 驻留，几 GB 必 OOM。改为 `createWebviewPanel` 命令驱动后，宿主按 URI 从磁盘按需读，
 * 文件不再预先进入 TextDocument，200MB~数 GB 文件即可打开。
 */
export async function openJsonlViewer(
  context: vscode.ExtensionContext,
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

  const key = uri.toString();
  // 面板存活时必在 Map 中（onDidDispose 会同步删除），故以存在性判定即可，
  // 无需 isDisposed（WebviewPanel 无此属性）。
  const existing = openPanels.get(key);
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
  openPanels.set(key, panel);

  const webview = panel.webview;
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, 'dist', WEBVIEW_SCRIPT)
  );
  const cspSource = webview.cspSource;
  const nonce = getNonce();

  webview.html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>JSONL Viewer</title>
</head>
<body>
  <main id="app"></main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;

  // Data host: builds a lazy line-offset index on demand and serves records
  // requested by the webview's virtual scroll. Also hosts field-inference
  // sampling, the bad-line (validation-error) set, and source-line jump.
  // 2b：把「索引构建 + 搜索 + 过滤」下沉到 worker（dist/indexWorker.js），
  // 大文件扫描时主线程（webview 消息循环 / 其它扩展）不被阻塞；spawn 失败自动回退主线程。
  const sampleLines = vscode.workspace
    .getConfiguration('jsonlViewer')
    .get<number>('sampleLines', 200);
  const workerScriptPath = path.join(context.extensionPath, 'dist', 'indexWorker.js');
  const data = new DataService(uri.toString(), uri.fsPath, { sampleLines, workerScriptPath });
  const post = (msg: RpcMessage): void => void panel.webview.postMessage(msg);
  const cancel = new Set<string>();

  // Clicking a bad row opens the on-disk file and reveals that line.
  // 超大文件 VS Code 无法以 TextDocument 打开→openTextDocument 会 reject；
  // 捕获后降级为友好提示，不再抛错致面板崩溃（Task #3）。
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

  panel.webview.onDidReceiveMessage(
    (message: unknown) => {
      const incoming = (message as { type?: unknown }).type;
      hostLog(`收到消息: ${String(incoming)}`);
      void (async () => {
        let response: RpcMessage | undefined;
        try {
          response = (
            await dispatchMessage(
              message,
              async () => {
                // 诊断：确认宿主是否收到 webview 的握手消息。
                const st = Date.now();
                const init = initReply(await data.getOverview());
                hostLog(`init 回执构建完成 (${Date.now() - st}ms)`);
                return init;
              },
              async (_r) => data.getOverview(),
              async (_r, startLine, count) => {
                // 真正的可中断：读批逐行检测 cancel 集合，被取消即提前返回。
                const p = await data.readRecords(startLine, count, () => cancel.has(_r));
                cancel.delete(_r);
                return p;
              },
              async (_r, line) => data.readRecord(line),
              (requestId) => {
                cancel.add(requestId);
                // 可中断链路：readRecords/search/filter 逐行检查 cancel 集合，
                // 被取消即提前返回；其余轻量请求（抽样/详情/偏好）不响应中断。
              },
              async (_r, count) => data.getSampleFields(count),
              async (line) => void (await jumpToSource(line)),
              // 全文/字段搜索（宿主流式扫描；被 cancel 则中断）。
              async (_r, query, field, scope) => {
                const p = await data.search(query, field, scope, () => cancel.has(_r));
                cancel.delete(_r);
                return p;
              },
              // 字段值过滤。
              async (_r, field, op, value) => {
                const cond =
                  field && (op === 'eq' || op === 'contains' || op === 'exists' || op === 'type')
                    ? ({ field, op, value: value ?? '' } as FieldCondition)
                    : null;
                const p = await data.filter(cond, () => cancel.has(_r));
                cancel.delete(_r);
                return p;
              },
              // 偏好持久化到 workspaceState（按 uri 命名空间键）。
              async (_k, key, val) => {
                await context.workspaceState.update(key, val);
              },
              async (_k, key) => context.workspaceState.get(key),
              // 文件变更后 webview 点「重新加载」→ 重建索引并返回新概览。
              async (_r) => data.reload()
            )
          ).response;
        } catch (e) {
          hostErr('处理消息时异常: ' + (e instanceof Error ? (e.stack || e.message) : String(e)));
          response = errReply(undefined, e instanceof Error ? e.message : String(e));
        }
        if (response) post(response);
      })();
    },
    undefined,
    context.subscriptions
  );

  // 定期检测文件是否被更改 / 删除（只有索引构建后才有比对基线）。
  // 仅在状态「从正常转为走样」时向 webview 推送一次 FILE_STALE（不刷屏）；
  // webview 点「重新加载」→ RELOAD → data.reload() 重建索引后基线更新，状态复位。
  let staleSignaled = false;
  const staleTimer = setInterval(async () => {
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

  // Tear down the underlying file handles (and the stale detector) on panel close.
  panel.onDidDispose(
    () => {
      clearInterval(staleTimer);
      openPanels.delete(key);
      void data.dispose();
    },
    undefined,
    context.subscriptions
  );
}

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('JSONL Viewer');
  hostLog('extension 已激活');

  // Command: open the chosen (or active / picked) file in the JSONL Viewer webview panel.
  // 不再走 customEditor，故超大文件不会在打开前被 TextDocument 全量载入。
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_COMMAND, (uri?: vscode.Uri) => {
      void openJsonlViewer(context, uri);
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
