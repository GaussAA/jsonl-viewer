/**
 * indexWorker.ts — 索引计算 Worker 入口（运行于 worker_threads）。
 *
 * 仅依赖 Node 内置与项目纯逻辑模块（绝不 import `vscode`），由 build.mjs 单独打包为
 * `dist/indexWorker.js`（ESM / node 平台 / vscode + node:* 外置）。主线程通过
 * `new Worker(dist/indexWorker.js)` 拉起，消息协议见 workerProtocol.ts。
 */

import { parentPort } from 'node:worker_threads';
import { createReadStream } from 'node:fs';
import { LineIndex } from '../indexer/lineIndex.ts';
import { openFileReader, type ByteReader } from '../parser/jsonParser.ts';
import { searchLines, filterLines, type SearchScope } from './searchEngine.ts';
import type { FieldCondition } from '../webview/queryLogic.ts';
import { INDEX_CHUNK_SIZE, INDEX_REPORT_INTERVAL } from '../constants.ts';
import type { WorkerRequest, WorkerResponse } from './workerProtocol.ts';

const port = parentPort;
if (!port) {
  // 非 worker 上下文运行（理论不会发生）：直接退出，避免挂起。
  throw new Error('indexWorker 必须在 worker_threads 上下文中运行');
}

let li: LineIndex | undefined;
let reader: ByteReader | undefined;
/** 已收到取消请求的行号集合（驱动 searchLines/filterLines 的 shouldCancel）。 */
const cancelled = new Set<number>();

function post(msg: WorkerResponse): void {
  port!.postMessage(msg);
}

port.on('message', (msg: WorkerRequest) => {
  void handle(msg);
});

async function handle(msg: WorkerRequest): Promise<void> {
  try {
    switch (msg.type) {
      case 'build': {
        const stream = createReadStream(msg.path);
        try {
          li = await LineIndex.build(stream, {
            chunkSize: INDEX_CHUNK_SIZE,
            reportInterval: INDEX_REPORT_INTERVAL,
            // 进度回传：主线程据此反馈构建进展。
            // 此前该链路缺失 → worker 路径的 onProgress 参数被静默忽略，大文件构建期无任何反馈。
            onProgress: (info) =>
              post({
                type: 'progress',
                requestId: msg.requestId,
                bytesRead: info.bytesRead,
                lines: info.lines,
              }),
          });
        } finally {
          stream.destroy();
        }
        reader = await openFileReader(msg.path);
        post({
          type: 'built',
          requestId: msg.requestId,
          checkpoints: li.checkpoints.map((c) => ({ line: c.line, offset: c.offset })),
          totalBytes: li.totalBytes,
          totalLines: li.totalLines,
          buildMs: li.buildMs,
          eof: li.eof,
          interval: li.interval,
        });
        return;
      }
      case 'search': {
        // 索引未就绪（build 未完成或失败）时必须**回执错误**：
        // 此前直接 return，主线程 pending 永不结算 → 调用方永久挂起（webview 要等 15s 超时）。
        if (!li || !reader) {
          post({ type: 'error', requestId: msg.requestId, message: '索引尚未就绪（构建未完成或失败）' });
          return;
        }
        try {
          const result = await searchLines(reader, li, {
            query: msg.query,
            field: msg.field,
            scope: msg.scope as SearchScope | undefined,
            maxResults: msg.maxResults,
            shouldCancel: () => cancelled.has(msg.requestId),
          });
          post({ type: 'searchResult', requestId: msg.requestId, result });
        } finally {
          // 防取消集合无界增长：请求结算后立刻摘除自己的标记。
          cancelled.delete(msg.requestId);
        }
        return;
      }
      case 'filter': {
        if (!li || !reader) {
          post({ type: 'error', requestId: msg.requestId, message: '索引尚未就绪（构建未完成或失败）' });
          return;
        }
        try {
          const result = await filterLines(reader, li, msg.cond as FieldCondition | null, {
            maxResults: msg.maxResults,
            shouldCancel: () => cancelled.has(msg.requestId),
          });
          post({ type: 'filterResult', requestId: msg.requestId, result });
        } finally {
          cancelled.delete(msg.requestId);
        }
        return;
      }
      case 'cancel': {
        cancelled.add(msg.requestId);
        // 兜底剪枝：取消请求可能在结果已发出之后才到达，仅靠各请求的 finally 无法清理这些残留。
        // requestId 单调递增，故早于 (当前 - 1024) 的标记不可能仍在使用。
        const watermark = msg.requestId - 1024;
        if (cancelled.size > 1024) {
          for (const id of cancelled) {
            if (id < watermark) cancelled.delete(id);
          }
        }
        return;
      }
      case 'dispose': {
        await reader?.close?.().catch(() => {});
        reader = undefined;
        li = undefined;
        cancelled.clear();
        port!.close();
        return;
      }
    }
  } catch (e) {
    post({
      type: 'error',
      requestId: msg.type === 'build' || msg.type === 'search' || msg.type === 'filter' ? msg.requestId : undefined,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
