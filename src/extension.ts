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

/** The `viewType` used by the custom editor, must match `contributes.customEditors` in package.json. */
export const VIEW_TYPE = 'jsonlViewer.customEditor';

/** Command id, must match `contributes.commands` in package.json. */
export const OPEN_COMMAND = 'jsonlViewer.open';

const WEBVIEW_SCRIPT = 'webview.js';

/** Supported extension globs, must mirror the custom editor selector. */
const SUPPORTED_GLOB = /\.(jsonl|ndjson|jsonlines)$/i;

/**
 * Custom editor provider backed by `CustomTextEditorProvider`.
 *
 * We chose a *custom editor* over a plain *view* because the user opens a
 * `.jsonl` **file**. A custom editor binds directly to a workspace file
 * (document) and renders inside the editor tab, which is the natural
 * "open the file and see records" interaction. An editor also gives us the
 * file's on-disk URI (`document.uri`) needed later for lazy line indexing
 * and "jump to source line" error location.
 */
export class JsonlCustomEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      // Restrict to our own generated bundle & static assets under dist/.
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', WEBVIEW_SCRIPT)
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
  <main id="app">
    <div style="font-family: var(--vscode-font-family); padding: 1rem;">
      <h2>JSONL Viewer — placeholder</h2>
      <p>Loaded file: ${escapeHtml(document.uri.toString())}</p>
      <p>The record list + JSON tree UI is implemented in a later task.</p>
    </div>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;

    // Data host: builds a lazy line-offset index on demand and serves records
    // requested by the webview's virtual scroll. Also hosts field-inference
    // sampling, the bad-line (validation-error) set, and source-line jump.
    const sampleLines = vscode.workspace
      .getConfiguration('jsonlViewer')
      .get<number>('sampleLines', 200);
    const data = new DataService(document.uri.toString(), document.uri.fsPath, { sampleLines });
    const post = (msg: RpcMessage): void => void webviewPanel.webview.postMessage(msg);
    const cancel = new Set<string>();

    // Clicking a bad row opens the on-disk file and reveals that line.
    const jumpToSource = async (line: number): Promise<void> => {
      const doc = await vscode.workspace.openTextDocument(document.uri);
      const editor = await vscode.window.showTextDocument(doc, { preserveFocus: true });
      const pos = new vscode.Position(line, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    };

    webviewPanel.webview.onDidReceiveMessage(
      (message: unknown) => {
        void (async () => {
          let response: RpcMessage | undefined;
          try {
            response = (
              await dispatchMessage(
                message,
                async () => {
                  const init = initReply(await data.getOverview());
                  // 随 init 主动推送一次抽样窗口的错误统计（webview 顶栏红标 / 概要）。
                  void data
                    .getErrorSummary()
                    .then((payload) =>
                      post({ type: HostReply.ERROR_SUMMARY, payload } as RpcMessage)
                    )
                    .catch(() => {});
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
                  // NOTE: 具体的在途请求中断由 Task 7 落地（如 AbortController）。
                },
                async (_r, count) => data.getSampleFields(count),
                async (_r, range) => data.getErrorLines(range),
                async (line) => void (await jumpToSource(line)),
                // Task 6：全文/字段搜索（宿主流式扫描；被 cancel 则中断）。
                async (_r, query, field, scope) => {
                  const p = await data.search(query, field, scope, () => cancel.has(_r));
                  cancel.delete(_r);
                  return p;
                },
                // Task 6：字段值过滤。
                async (_r, field, op, value) => {
                  const cond =
                    field && (op === 'eq' || op === 'contains' || op === 'exists' || op === 'type')
                      ? ({ field, op, value: value ?? '' } as FieldCondition)
                      : null;
                  const p = await data.filter(cond, () => cancel.has(_r));
                  cancel.delete(_r);
                  return p;
                },
                // Task 6/7：偏好持久化到 workspaceState（按 uri 命名空间键）。
                async (_k, key, val) => {
                  await this.context.workspaceState.update(key, val);
                },
                async (_k, key) => this.context.workspaceState.get(key),
                // Task 7：文件变更后 webview 点「重新加载」→ 重建索引并返回新概览。
                async (_r) => data.reload()
              )
            ).response;
          } catch (e) {
            response = errReply(undefined, e instanceof Error ? e.message : String(e));
          }
          if (response) post(response);
        })();
      },
      undefined,
      this.context.subscriptions
    );

    // Task 7：定期检测文件是否被更改 / 删除（只有索引构建后才有比对基线）。
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
      post({ type: HostReply.FILE_STALE, payload: res } as RpcMessage);
    }, 5000);

    // Tear down the underlying file handles (and the stale detector) on editor close.
    webviewPanel.onDidDispose(
      () => {
        clearInterval(staleTimer);
        void data.dispose();
      },
      undefined,
      this.context.subscriptions
    );
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new JsonlCustomEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    })
  );

  // Command: open the active (or chosen) file in the JSONL Viewer editor.
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_COMMAND, async (uri?: vscode.Uri) => {
      let resource: vscode.Uri | undefined = uri;

      if (!resource) {
        resource = vscode.window.activeTextEditor?.document.uri;
      }

      if (!resource) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectMany: false,
          title: 'Open file with JSONL Viewer',
        });
        resource = picked?.[0];
      }

      if (resource) {
        await vscode.commands.executeCommand('vscode.openWith', resource, VIEW_TYPE);
      }
    })
  );

  // Optional: auto-open supported files in the custom editor when toggled on.
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      const enabled = vscode.workspace
        .getConfiguration('jsonlViewer')
        .get<boolean>('autoOpenCustomEditor', false);
      if (enabled && SUPPORTED_GLOB.test(document.fileName)) {
        void vscode.commands.executeCommand(
          'vscode.openWith',
          document.uri,
          VIEW_TYPE,
          vscode.ViewColumn.Beside
        );
      }
    })
  );
}

export function deactivate(): void {
  // Nothing to tear down yet; the provider/webviews are disposed via context.subscriptions.
}

function getNonce(): string {
  const text = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += text[Math.floor(Math.random() * text.length)];
  }
  return out;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}