/**
 * indexHost.ts — 索引宿主抽象：把「索引构建 + 搜索 + 过滤」这三类重活统一到一个接口，
 * 提供两种实现：主线程兜底（MainThreadIndexHost）与 worker 下沉（WorkerIndexHost）。
 *
 * 为何两种实现：
 *   - 单元测试与「不传 worker 脚本路径」的场景走主线程，行为等价于旧实现，零回归；
 *   - 运行时（extension 传入 dist/indexWorker.js 路径）走 worker，扫几 GB 文件时
 *     主线程（含 webview 消息循环、其它扩展）不被阻塞；
 *   - WorkerIndexHost 构造若抛错（worker 不可用），createIndexHost 自动回退主线程，
 *     保证扩展「打得开、用得了」这条底线不被 worker 异常击穿。
 */

import { createReadStream } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { LineIndex } from '../indexer/lineIndex.ts';
import { openFileReader, type ByteReader } from '../parser/jsonParser.ts';
import { searchLines, filterLines, type SearchScope } from './searchEngine.ts';
import type { SearchLinesResult, FilterLinesResult } from './searchEngine.ts';
import type { FieldCondition } from '../webview/queryLogic.ts';
import { INDEX_CHUNK_SIZE, INDEX_REPORT_INTERVAL } from '../constants.ts';
import type { BuildResult, WorkerRequest, WorkerResponse } from './workerProtocol.ts';

/** 索引宿主统一接口。 */
export interface IndexHost {
  /** 'worker' | 'main'，便于诊断与日志。 */
  readonly kind: 'worker' | 'main';
  /** 流式构建行索引；返回主线程侧重建的 LineIndex + 概要统计。 */
  build(path: string, onProgress?: (info: { bytesRead: number; lines: number; done: boolean }) => void): Promise<BuildResult>;
  /** 全文/字段搜索（worker 内部顺序扫全文件；主线程版同）。 */
  search(
    query: string,
    field: string | undefined,
    scope: SearchScope | undefined,
    maxResults: number,
    shouldCancel?: () => boolean
  ): Promise<SearchLinesResult>;
  /** 字段值过滤。 */
  filter(cond: FieldCondition | null, maxResults: number, shouldCancel?: () => boolean): Promise<FilterLinesResult>;
  /** 释放资源（关闭 reader / 终止 worker）。 */
  dispose(): Promise<void>;
}

/** 主线程兜底实现（复用 2a 既有逻辑，无 worker 依赖）。 */
export class MainThreadIndexHost implements IndexHost {
  readonly kind = 'main' as const;
  private index: LineIndex | undefined;
  private reader: ByteReader | undefined;

  async build(
    path: string,
    onProgress?: (info: { bytesRead: number; lines: number; done: boolean }) => void
  ): Promise<BuildResult> {
    const stream = createReadStream(path);
    try {
      this.index = await LineIndex.build(stream, {
        chunkSize: INDEX_CHUNK_SIZE,
        reportInterval: INDEX_REPORT_INTERVAL,
        onProgress,
      });
    } finally {
      stream.destroy();
    }
    this.reader = await openFileReader(path);
    const li = this.index;
    return {
      index: li,
      stats: { buildMs: li.buildMs, eof: li.eof, totalBytes: li.totalBytes, totalLines: li.totalLines },
    };
  }

  async search(
    query: string,
    field: string | undefined,
    scope: SearchScope | undefined,
    maxResults: number,
    shouldCancel?: () => boolean
  ): Promise<SearchLinesResult> {
    return searchLines(this.reader!, this.index!, { query, field, scope, maxResults, shouldCancel });
  }

  async filter(cond: FieldCondition | null, maxResults: number, shouldCancel?: () => boolean): Promise<FilterLinesResult> {
    return filterLines(this.reader!, this.index!, cond, { maxResults, shouldCancel });
  }

  async dispose(): Promise<void> {
    if (this.reader && this.reader.close) await this.reader.close().catch(() => {});
    this.reader = undefined;
    this.index = undefined;
  }
}

/** worker 下沉实现：spawn dist/indexWorker.js，按 requestId 派发并回收 Promise。 */
export class WorkerIndexHost implements IndexHost {
  readonly kind = 'worker' as const;
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      stop?: () => void;
      /** 构建进度回调（仅 build 请求携带）。 */
      progress?: (info: { bytesRead: number; lines: number; done: boolean }) => void;
    }
  >();
  private nextId = 1;
  /** 是否已进入主动释放流程：用于区分「正常退出」与「意外崩溃」。 */
  private disposing = false;

  constructor(scriptPath: string) {
    this.worker = new Worker(scriptPath);
    this.worker.on('message', (m: WorkerResponse) => this.onMessage(m));
    this.worker.on('error', (e: Error) => this.onError(e));
    // worker 也可能在**不触发 'error'** 的情况下直接退出（脚本内 process.exit、
    // 模块加载失败后的静默退出等）。不兜底的话，等待中的请求会永久悬挂。
    this.worker.on('exit', (code: number) => this.onExit(code));
  }

  /**
   * 结算全部在途请求。
   *
   * 关键：**必须先调用 `stop()` 取消取消轮询定时器**。此前在 onError/dispose 路径遗漏，
   * 导致每发生一次「搜索出错」或「带搜索关闭面板」就泄漏一个 30ms 的 setInterval；
   * 该闭包持有 shouldCancel → 连带持有整个 DataService（索引 + reader），阻止 GC。
   */
  private settleAll(err: Error): void {
    for (const p of this.pending.values()) {
      p.stop?.();
      p.reject(err);
    }
    this.pending.clear();
  }

  /** worker 进程退出且非我方主动释放 → 拒绝所有在途请求。 */
  private onExit(code: number): void {
    if (this.disposing) return;
    this.settleAll(new Error(`index worker exited unexpectedly (code=${code})`));
  }

  private onMessage(m: WorkerResponse): void {
    if (m.type === 'progress') {
      // 构建进度：转发给该请求的 onProgress（大文件构建期间供宿主反馈进展）。
      this.pending.get(m.requestId)?.progress?.({ bytesRead: m.bytesRead, lines: m.lines, done: false });
      return;
    }
    if (m.type === 'built') {
      const p = this.pending.get(m.requestId);
      if (p) {
        this.pending.delete(m.requestId);
        const index = new LineIndex(m.checkpoints, m.totalBytes, m.totalLines, m.interval, {
          buildMs: m.buildMs,
          eof: m.eof,
        });
        p.resolve({
          index,
          stats: { buildMs: m.buildMs, eof: m.eof, totalBytes: m.totalBytes, totalLines: m.totalLines },
        });
      }
      return;
    }
    if (m.type === 'searchResult' || m.type === 'filterResult') {
      const p = this.pending.get(m.requestId);
      if (p) {
        p.stop?.();
        this.pending.delete(m.requestId);
        p.resolve(m.result);
      }
      return;
    }
    if (m.type === 'error') {
      if (m.requestId != null) {
        const p = this.pending.get(m.requestId);
        if (p) {
          p.stop?.();
          this.pending.delete(m.requestId);
          p.reject(new Error(m.message));
        }
      }
    }
  }

  private onError(e: Error): void {
    // worker 进程级崩溃：拒绝所有在途请求（含取消定时器清理），避免调用方永久挂起与定时器泄漏。
    this.settleAll(e);
  }

  async build(
    path: string,
    onProgress?: (info: { bytesRead: number; lines: number; done: boolean }) => void
  ): Promise<BuildResult> {
    const requestId = this.nextId++;
    return new Promise<BuildResult>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (v) => resolve(v as BuildResult),
        reject,
        progress: onProgress,
      });
      this.post({ type: 'build', requestId, path });
    });
  }

  async search(
    query: string,
    field: string | undefined,
    scope: SearchScope | undefined,
    maxResults: number,
    shouldCancel?: () => boolean
  ): Promise<SearchLinesResult> {
    const requestId = this.nextId++;
    return new Promise<SearchLinesResult>((resolve, reject) => {
      let stop: (() => void) | undefined;
      if (shouldCancel) {
        // 主线程轮询 shouldCancel（webview 取消置位），命中即转发 cancel 给 worker 提前终止扫描。
        const timer = setInterval(() => {
          if (shouldCancel()) {
            this.post({ type: 'cancel', requestId });
            if (timer) clearInterval(timer);
          }
        }, 30);
        stop = () => clearInterval(timer);
      }
      this.pending.set(requestId, { resolve: (v) => resolve(v as SearchLinesResult), reject, stop });
      this.post({ type: 'search', requestId, query, field, scope, maxResults });
    });
  }

  async filter(cond: FieldCondition | null, maxResults: number, shouldCancel?: () => boolean): Promise<FilterLinesResult> {
    const requestId = this.nextId++;
    return new Promise<FilterLinesResult>((resolve, reject) => {
      let stop: (() => void) | undefined;
      if (shouldCancel) {
        const timer = setInterval(() => {
          if (shouldCancel()) {
            this.post({ type: 'cancel', requestId });
            if (timer) clearInterval(timer);
          }
        }, 30);
        stop = () => clearInterval(timer);
      }
      this.pending.set(requestId, { resolve: (v) => resolve(v as FilterLinesResult), reject, stop });
      this.post({ type: 'filter', requestId, cond, maxResults });
    });
  }

  async dispose(): Promise<void> {
    this.disposing = true; // 先置位：随后的 'exit' 属正常退出，不当作崩溃
    try {
      this.post({ type: 'dispose' });
    } catch {
      /* worker 可能已退出 */
    }
    // 给 worker 一点时间自行清理并 close，再 terminate 兜底，避免句柄泄漏。
    await new Promise<void>((res) => setTimeout(res, 50));
    await this.worker.terminate().catch(() => {});
    // 统一走 settleAll：确保取消轮询定时器一并停止（此前遗漏 → setInterval 泄漏）。
    this.settleAll(new Error('worker disposed'));
  }

  private post(msg: WorkerRequest): void {
    this.worker.postMessage(msg);
  }
}

/**
 * 选择索引宿主：传入 worker 脚本路径则尝试 worker，否则主线程。
 *
 * ⚠️ 注意：`new Worker(path)` 对**不存在的脚本不会同步抛错**，而是异步 emit `'error'`；
 * 因此本函数的 try/catch **抓不到「worker 加载失败」**。真正的兜底在
 * `buildIndexWithFallback()`（首次构建失败时回退主线程重试）。
 */
export function createIndexHost(workerScriptPath?: string): IndexHost {
  if (workerScriptPath) {
    try {
      return new WorkerIndexHost(workerScriptPath);
    } catch (e) {
      // 仅能捕获同步失败（如参数非法）；异步加载失败见 buildIndexWithFallback。
      console.warn('[indexHost] worker 无法启动（同步错误），改用主线程索引：', e instanceof Error ? e.message : String(e));
    }
  }
  return new MainThreadIndexHost();
}

/**
 * 构建索引，并在 worker 不可用时**自动回退主线程重试一次**。
 *
 * 为何必须存在：worker 加载失败（脚本缺失 / 打包遗漏 / 文件损坏 / 受限运行时 / Node 不支持 ESM worker）
 * 只会在首次 `build()` 时以异步 error 暴露。若不做兜底，`build` 会直接 reject，
 * `DataService.ensureIndex` 随之抛出 → **插件彻底打不开任何文件**，与「保底可打开」的设计初衷相悖。
 *
 * 语义：仅当主宿主是 worker 且失败时才重试；主线程实现失败属真实失败（文件不存在 / 权限等），原样上抛。
 */
export async function buildIndexWithFallback(
  workerScriptPath: string | undefined,
  path: string,
  onProgress?: (info: { bytesRead: number; lines: number; done: boolean }) => void
): Promise<{ host: IndexHost; result: BuildResult; fellBack: boolean }> {
  const primary = createIndexHost(workerScriptPath);
  try {
    const result = await primary.build(path, onProgress);
    return { host: primary, result, fellBack: false };
  } catch (e) {
    if (primary.kind !== 'worker') throw e; // 主线程也失败：真实错误，交给上层提示
    console.warn(
      '[indexHost] worker 索引失败，回退主线程重试：',
      e instanceof Error ? e.message : String(e)
    );
    await primary.dispose().catch(() => {});
    const fallback = new MainThreadIndexHost();
    try {
      const result = await fallback.build(path, onProgress);
      return { host: fallback, result, fellBack: true };
    } catch (e2) {
      await fallback.dispose().catch(() => {});
      throw e2;
    }
  }
}
