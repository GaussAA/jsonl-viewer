/**
 * workerProtocol.ts — 索引 Worker（worker_threads）与主线程之间的消息协议。
 *
 * 2b 目标：把「索引构建 + 全文/字段搜索 + 字段过滤」这三件重活从扩展宿主主线程
 * 下沉到 worker，使主线程（含 webview 消息循环、其它扩展）在扫几 GB 文件时不被阻塞。
 *
 * 设计要点：
 *   - worker 自持 LineIndex + FileByteReader（构建一次，后续搜索/过滤复用）；
 *   - 主线程仅拿回「稀疏检查点」重建 LineIndex 用于轻量随机读（详情/虚拟滚动），
 *     不重复扫文件；
 *   - 取消：主线程把 shouldCancel 经 30ms 轮询转发为 `{type:'cancel', requestId}`，
 *     worker 侧以 cancelled 集合驱动 searchLines/filterLines 的 shouldCancel 提前终止。
 */

import type { SearchScope, SearchLinesResult, FilterLinesResult } from './searchEngine.ts';
import type { FieldCondition } from '../webview/queryLogic.ts';

/** 主线程 → worker 的请求。 */
export type WorkerRequest =
  | { type: 'build'; requestId: number; path: string }
  | {
      type: 'search';
      requestId: number;
      query: string;
      field?: string;
      scope?: SearchScope;
      maxResults: number;
    }
  | { type: 'filter'; requestId: number; cond: FieldCondition | null; maxResults: number }
  | { type: 'cancel'; requestId: number }
  | { type: 'dispose' };

/** worker → 主线程的响应。 */
export type WorkerResponse =
  | {
      type: 'built';
      requestId: number;
      checkpoints: { line: number; offset: number }[];
      totalBytes: number;
      totalLines: number;
      buildMs: number;
      eof: boolean;
      interval: number;
    }
  | { type: 'searchResult'; requestId: number; result: SearchLinesResult }
  | { type: 'filterResult'; requestId: number; result: FilterLinesResult }
  | { type: 'error'; requestId?: number; message: string };

/** 索引构建产物（主线程侧）：重建的 LineIndex + 概要统计。 */
export interface BuildResult {
  index: import('../indexer/lineIndex.ts').LineIndex;
  stats: { buildMs: number; eof: boolean; totalBytes: number; totalLines: number };
}
