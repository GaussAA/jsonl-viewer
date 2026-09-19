/**
 * rpc.ts（webview 侧）— 与扩展宿主之间的消息收发封装。
 *
 * - createVSCodeApi(): 适配 `acquireVsCodeApi()`（VS Code 注入的全局）。抽出便于注入假实现单测。
 * - RpcBus: 用 requestId 关联异步响应；支持超时、(以覆盖方式实现的)在途取消、错误回执；
 *           以及 init / jumpToSource 等「push」型消息的事件订阅。
 *
 * 协议类型与端点常量复用 ../protocol/rpc.ts（单一来源）。
 */

import {
  HostEndpoint,
  HostReply,
  isRpcMessage,
  makeRequestId,
} from '../protocol/rpc.ts';
import type { InitPayload, JumpToSourcePayload, RpcMessage, StaleFilePayload } from '../protocol/rpc.ts';

/** webview 侧向宿主发消息 API 的最小接口（即 acquireVsCodeApi 的返回）。 */
export interface VSCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

type ApiFactory = () => VSCodeApi;

interface Pending {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  superseded: boolean;
  settled: boolean;
}

/** 请求被覆盖式取消（supersede）时抛出的错误类型。 */
export class CancelledError extends Error {
  constructor(message = 'request superseded') {
    super(message);
    this.name = 'CancelledError';
  }
}

/**
 * 从全局取出 VS Code 注入的 acquireVsCodeApi 并生成 API。
 * 传入可选的 global 对象以便单测注入假实现；默认读 globalThis。
 */
export function createVSCodeApi(
  source?: { acquireVsCodeApi?: ApiFactory }
): VSCodeApi | null {
  const ctx = (source ?? globalThis) as { acquireVsCodeApi?: ApiFactory };
  if (typeof ctx.acquireVsCodeApi !== 'function') return null;
  return ctx.acquireVsCodeApi();
}

export type InitHandler = (payload: InitPayload) => void;
export type JumpHandler = (payload: JumpToSourcePayload) => void;
export type StaleHandler = (payload: StaleFilePayload) => void;
export type ErrorHandler = (e: { requestId?: string; message: string }) => void;

export interface RequestOptions {
  /** 超时（毫秒）。默认 15s；解析大行或构建索引时可放宽。 */
  timeoutMs?: number;
  /** 请求已发出前调用的 onCancel（用于 supersede 时本地标记）。 */
  onCancel?: () => void;
  /** 若为真，一旦该请求响应到达会直接丢弃（配合覆盖式取消）。 */
  initialSuperseded?: boolean;
}

export class RpcBus {
  private readonly pending = new Map<string, Pending>();
  private readonly initHandlers = new Set<InitHandler>();
  private readonly jumpHandlers = new Set<JumpHandler>();
  private readonly staleHandlers = new Set<StaleHandler>();
  private readonly errorHandlers = new Set<ErrorHandler>();
  private readonly api: VSCodeApi;

  // 注意：不用参数属性语法（Node 类型擦除运行 TS 单测时不支持）。
  constructor(api: VSCodeApi) {
    this.api = api;
    // 防御：非浏览器环境（如 node:test 单测）可能没有全局 message 事件，降级为 no-op。
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('message', this.onMessage);
    }
  }

  dispose(): void {
    if (typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('message', this.onMessage);
    }
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
    }
    this.pending.clear();
    this.initHandlers.clear();
    this.jumpHandlers.clear();
    this.staleHandlers.clear();
    this.errorHandlers.clear();
  }

  onInit(cb: InitHandler): void {
    this.initHandlers.add(cb);
  }
  onJump(cb: JumpHandler): void {
    this.jumpHandlers.add(cb);
  }
  onStale(cb: StaleHandler): void {
    this.staleHandlers.add(cb);
  }
  onError(cb: ErrorHandler): void {
    this.errorHandlers.add(cb);
  }

  /**
   * 主动向宿主发一条「请求」消息并返回其 requestId（用于 supersede 取消）与响应的 Promise。
   * 回执与 requestId 关联，自动匹配到该 Promise 上。
   */
  request<TPayload = unknown>(
    type: string,
    payload: unknown,
    opts: RequestOptions = {}
  ): { requestId: string; promise: Promise<TPayload> } {
    const requestId = makeRequestId('req');
    const p: Pending = {
      resolve: () => {},
      reject: () => {},
      superseded: !!opts.initialSuperseded,
      settled: false,
    };
    const promise = new Promise<TPayload>((resolve, reject) => {
      p.resolve = resolve as (v: unknown) => void;
      p.reject = reject;
    });
    const timeoutMs = opts.timeoutMs ?? 15_000;
    p.timer = setTimeout(() => {
      if (p.settled) return;
      p.settled = true;
      this.pending.delete(requestId);
      p.reject(new Error(`request ${type} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    this.pending.set(requestId, p);

    this.api.postMessage({ type, requestId, ...(payload as object) });
    return { requestId, promise };
  }

  /** 向宿主发「通知」类消息（无回执）。 */
  post(type: string, payload?: object): void {
    this.api.postMessage(payload ? { type, ...payload } : { type });
  }

  /**
   * 请求在途取消：示意宿主中断（宿主可能忽略），并立即结算本地 Promise
   * （抛 CancelledError），使迟到的响应被丢弃——不残留 pending 表项，也不等 15s 超时。
   */
  supersede(requestId: string): void {
    const p = this.pending.get(requestId);
    if (p && !p.settled) {
      p.settled = true;
      this.pending.delete(requestId);
      if (p.timer) clearTimeout(p.timer);
      p.reject(new CancelledError());
    }
    this.api.postMessage({ type: HostEndpoint.CANCEL, requestId });
  }

  private readonly onMessage = (event: MessageEvent): void => {
    const data = (event as { data?: unknown }).data;
    if (!isRpcMessage(data)) return;
    const msg = data as RpcMessage;

    if (msg.type === HostReply.INIT) {
      for (const h of this.initHandlers) h((msg as { payload: InitPayload }).payload);
      return;
    }
    if (msg.type === HostReply.JUMP_TO_SOURCE) {
      for (const h of this.jumpHandlers) h((msg as { payload: JumpToSourcePayload }).payload);
      return;
    }
    if (msg.type === HostReply.FILE_STALE) {
      for (const h of this.staleHandlers) h((msg as { payload: StaleFilePayload }).payload);
      return;
    }
    if (msg.type === HostReply.ERROR) {
      const requestId =
        'requestId' in (msg as { requestId?: unknown }) && typeof msg.requestId === 'string'
          ? msg.requestId
          : undefined;
      if (requestId) {
        const p = this.pending.get(requestId);
        if (p) {
          this.pending.delete(requestId);
          if (p.timer) clearTimeout(p.timer);
          p.settled = true;
          p.reject(new Error(msg.message));
          return;
        }
      }
      for (const h of this.errorHandlers) h({ requestId, message: msg.message });
      return;
    }

    const withId = msg as { requestId?: unknown };
    const requestId = typeof withId.requestId === 'string' ? withId.requestId : undefined;
    if (requestId === undefined) return;
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    if (p.timer) clearTimeout(p.timer);
    p.settled = true;
    if (p.superseded) return; // 覆盖式取消：迟到响应直接丢弃
    p.resolve('payload' in msg ? msg.payload : undefined);
  };
}

export type { InitPayload, JumpToSourcePayload };