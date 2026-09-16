/**
 * rpc.ts — 主进程(host) 与 webview 之间的消息协议。
 *
 * 本文件只包含：协议类型（TS 类型 + 常量）、requestId 关联、错误回执、取消
 * 在途请求的接口预留，以及一个最小、可跑通的请求分发器 `dispatchMessage`。
 * 具体事务逻辑（搜索/筛选/字段推断）由后续任务填充；本任务保证
 * ready / getOverview / readRecords / readRecord 能实际跑通并 postMessage 回去。
 *
 * 消息方向：
 *   webview -> host : HostRequest（含既往在途请求的取消）
 *   host -> webview : HostResponse（requestId 关联、可能带错误）
 */

import type { FieldInfo } from '../infer/inferFields.ts';

/* ------------------------------ 常量 ------------------------------ */

/** webview -> host 请求端点。 */
export const HostEndpoint = {
  READY: 'ready',
  GET_OVERVIEW: 'getOverview',
  GET_SAMPLE_FIELDS: 'getSampleFields',
  READ_RECORDS: 'readRecords',
  READ_RECORD: 'readRecord',
  SEARCH: 'search',
  FILTER: 'filter',
  /** 查询某一范围的坏行集合（红标错误行）。 */
  GET_ERROR_LINES: 'getErrorLines',
  /** 跳转到源文件对应行（坏行定位）。 */
  JUMP_TO_SOURCE: 'jumpToSource',
  /** 取消/中断某一在途请求（Task 7 使用，先留接口）。 */
  CANCEL: 'cancel',
  /** 持久化 UI 偏好（字段定制 / 搜索 / 过滤），存宿主 workspaceState。 */
  PERSIST_STATE: 'persistState',
  /** 读取已持久化的 UI 偏好。 */
  LOAD_STATE: 'loadState',
  /** 重建行偏移索引（文件被检测到变更后，webview 点「重新加载」触发）。 */
  RELOAD: 'fileReload',
} as const;

/** host -> webview 响应端点。 */
export const HostReply = {
  INIT: 'init',
  OVERVIEW: 'overview',
  SAMPLE_FIELDS: 'sampleFields',
  RECORDS: 'records',
  /** 坏行集合查询结果。 */
  ERROR_LINES: 'errorLines',
  /** 抽样范围错误统计（本次修改后由 host 主动推送）。 */
  ERROR_SUMMARY: 'errorSummary',
  /** 搜索结果（匹配行号 + 总数）。 */
  SEARCH_RESULTS: 'searchResults',
  /** 字段过滤结果（匹配行号，null 表示不过滤=全量）。 */
  FILTER_RESULTS: 'filterResults',
  /** 通用请求完成（后续任务可复用）。 */
  RESULT: 'result',
  ERROR: 'error',
  /** 跳转到源文件某一行（坏行红标定位用）。 */
  JUMP_TO_SOURCE: 'jumpToSource',
  /** host 主动推送：文件已变更，索引可能过期（webview 展示「重新加载」）。 */
  FILE_STALE: 'fileStale',
} as const;

/* ------------------------------ 类型 ------------------------------ */

export interface OverviewPayload {
  uri: string;
  totalLines: number;
  totalBytes: number;
  buildMs: number;
  eof: boolean;
  sampleLines?: number; // 采样行数上限（Task 3 填充）
  // 将来可扩展：已推断字段、坏行集合等。
}

export interface InitPayload extends OverviewPayload {}

export interface SampleFieldsPayload {
  fields: FieldInfo[];
  /** 抽样有效记录数（合法、非空记录数）。 */
  total: number;
  /** 实际扫描的行数上限（min 抽样数, 总行数）。 */
  scanned: number;
}

/** 坏行集合查询范围（半开区间 [startLine, startLine+count)）。 */
export interface ErrorLinesRange {
  startLine: number;
  count: number;
}

export interface ErrorLinesPayload {
  /** 升序的坏行 lineId 集合。 */
  lines: number[];
}

export interface ErrorSummaryPayload {
  /** 抽样有效记录数。 */
  totalValid: number;
  /** 抽样范围内坏行数（含空行）。 */
  totalInvalid: number;
  /** 抽样行数（min 抽样数, 总行数）。 */
  totalLines: number;
  /** 抽样范围坏行 lineId（升序）。 */
  errorLines: number[];
  /** 抽样行数上限。 */
  sampleLines: number;
}

export interface RecordsPayload {
  startLine: number;
  items: {
    line: number;
    ok: boolean;
    value?: unknown;
    error?: string;
  }[];
  hasMore: boolean;
}

export interface ErrorPayload {
  requestId?: string;
  message: string;
}

export interface JumpToSourcePayload {
  line: number;
}

/** 文件可能已变更的通告载荷（文件删除 / 大小或 mtime 变化）。 */
export interface StaleFilePayload {
  /** 人类可读的友好提示（如「文件已被删除」/「文件已更改」）。 */
  message: string;
  /** 是否检测到文件被删除（vs 内容变更）。 */
  deleted: boolean;
}

/** 携带 requestId（用于关联异步响应 / 取消）的请求体。 */
export interface RequestEnvelope {
  type: string;
  requestId: string;
  payload?: unknown;
}

/** 搜索结果有效载荷。 */
export interface SearchResultsPayload {
  /** 升序匹配的 lineId。 */
  matches: number[];
  /** 命中总数（可能大于 matches.length，当 truncated 时）。 */
  total: number;
  /** 是否因达到 maxResults 而提前终止（仍有更多命中未列出）。 */
  truncated: boolean;
}

/** 字段过滤结果有效载荷。matches 为 null 表示「不过滤 = 全量视图」。 */
export interface FilterResultsPayload {
  /** 升序匹配 lineId；null = 清空过滤恢复全量。 */
  matches: number[] | null;
  total: number;
  /** 是否因达到宿主结果上限而提前终止（仍有更多匹配未列出）。 */
  truncated?: boolean;
}

/* webview -> host 的具体请求消息。 */
export type HostRequest =
  | { type: typeof HostEndpoint.READY }
  | { type: typeof HostEndpoint.GET_OVERVIEW; requestId: string }
  | { type: typeof HostEndpoint.GET_SAMPLE_FIELDS; requestId: string; count?: number }
  | { type: typeof HostEndpoint.READ_RECORDS; requestId: string; startLine: number; count: number }
  | { type: typeof HostEndpoint.READ_RECORD; requestId: string; line: number }
  | { type: typeof HostEndpoint.SEARCH; requestId: string; query: string; field?: string; scope?: string }
  | { type: typeof HostEndpoint.FILTER; requestId: string; field?: string; op?: string; value?: string }
  | { type: typeof HostEndpoint.GET_ERROR_LINES; requestId: string; range?: ErrorLinesRange }
  | { type: typeof HostEndpoint.JUMP_TO_SOURCE; requestId: string; line: number }
  | { type: typeof HostEndpoint.CANCEL; requestId: string }
  | { type: typeof HostEndpoint.PERSIST_STATE; requestId: string; key: string; value: unknown }
  | { type: typeof HostEndpoint.LOAD_STATE; requestId: string; key: string }
  | { type: typeof HostEndpoint.RELOAD; requestId: string };

/* host -> webview 的具体响应消息。 */
export type HostResponse =
  | { type: typeof HostReply.INIT; payload: InitPayload }
  | { type: typeof HostReply.OVERVIEW; requestId: string; payload: OverviewPayload }
  | { type: typeof HostReply.SAMPLE_FIELDS; requestId: string; payload: SampleFieldsPayload }
  | { type: typeof HostReply.RECORDS; requestId: string; payload: RecordsPayload }
  | { type: typeof HostReply.ERROR_LINES; requestId: string; payload: ErrorLinesPayload }
  | { type: typeof HostReply.SEARCH_RESULTS; requestId: string; payload: SearchResultsPayload }
  | { type: typeof HostReply.FILTER_RESULTS; requestId: string; payload: FilterResultsPayload }
  | { type: typeof HostReply.ERROR_SUMMARY; payload: ErrorSummaryPayload }
  | { type: typeof HostReply.RESULT; requestId: string; payload: unknown }
  | { type: typeof HostReply.ERROR; requestId?: string; message: string }
  | { type: typeof HostReply.JUMP_TO_SOURCE; payload: JumpToSourcePayload }
  | { type: typeof HostReply.FILE_STALE; payload: StaleFilePayload };

export type RpcMessage = HostRequest | HostResponse;

/* ---------------------------- 工具函数 ---------------------------- */

let reqSeq = 0;
export function makeRequestId(prefix = 'req'): string {
  reqSeq = (reqSeq + 1) | 0;
  return `${prefix}-${Date.now().toString(36)}-${reqSeq.toString(36)}`;
}

/** 判断给定消息是否为请求分发所关心的 RPC 消息。 */
export function isRpcMessage(msg: unknown): msg is RpcMessage {
  return isObject(msg) && typeof (msg as { type?: unknown }).type === 'string';
}

export function isHostRequest(msg: unknown): msg is HostRequest {
  return isRpcMessage(msg) && hasOwn(HostEndpoint, (msg as { type: string }).type);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function hasOwn(obj: Record<string, string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** 校验并归一化一批待渲染记录，附带 hasMore 推断。 */
export function buildRecordsPayload(
  startLine: number,
  items: RecordsPayload['items'],
  totalLines: number
): RecordsPayload {
  const count = items.length;
  const last = startLine + count; // 已经处理到的下一行
  return { startLine, items, hasMore: last < totalLines };
}

/* ---------------------- 最小可跑通的请求分发 ---------------------- */

/**
 * 把一条 webview 消息交给 handlers 处理；请求类消息自动附带 requestId 回调。
 *
 * handlers 中每个方法返回 `Promise<HostResponse 的 payload>`；方法签名与各端点的
 * requestId 由系统注入。返回该请求的响应回执（含 requestId），供 postMessage。
 */
export type HostHandlers = { [K: string]: (payload: unknown, requestId: string) => Promise<unknown> };

export interface DispatchResult {
  /** 需要回给 webview 的消息；undefined 表示无需回执（如 ready 外的空响应）。 */
  response: HostResponse | undefined;
}

/**
 * 分发一条消息。lessTruely：READY/CANCEL 不产生回执。
 * 实际 dataService 的处理器另行实现（见 src/host/dataService.ts）。
 */
export async function dispatchMessage(
  msg: unknown,
  onReady: () => Promise<HostResponse> | HostResponse,
  onGetOverview: (r: string) => Promise<OverviewPayload>,
  onReadRecords: (r: string, startLine: number, count: number) => Promise<RecordsPayload>,
  onReadRecord: (r: string, line: number) => Promise<{ value?: unknown; error?: string; ok: boolean }>,
  onCancel: (requestId: string) => void,
  onGetSampleFields: (r: string, count?: number) => Promise<SampleFieldsPayload> | SampleFieldsPayload = async () =>
    ({
      fields: [],
      total: 0,
      scanned: 0,
    } satisfies SampleFieldsPayload),
  onGetErrorLines: (r: string, range?: ErrorLinesRange) => Promise<number[]> | number[] = async () => [],
  onJumpToSource: (line: number, requestId: string) => void | Promise<void> = () => {},
  onSearch: (r: string, query: string, field?: string, scope?: string) => Promise<SearchResultsPayload> | SearchResultsPayload = async () => ({ matches: [], total: 0, truncated: false }),
  onFilter: (r: string, field?: string, op?: string, value?: string) => Promise<FilterResultsPayload> | FilterResultsPayload = async () => ({ matches: null, total: 0 }),
  onPersistState: (r: string, key: string, value: unknown) => void | Promise<void> = () => {},
  onLoadState: (r: string, key: string) => Promise<unknown> | unknown = async () => undefined,
  /** 重建索引（文件变更后重新加载）。默认返回 null（未实现）。 */
  onReload: (r: string) => Promise<OverviewPayload | null> | OverviewPayload | null = async () => null
): Promise<DispatchResult> {
  if (!isHostRequest(msg)) return { response: undefined };

  switch (msg.type) {
    case HostEndpoint.READY:
      return { response: await onReady() };
    case HostEndpoint.CANCEL:
      onCancel(msg.requestId);
      return { response: undefined };
    case HostEndpoint.GET_OVERVIEW:
      return { response: okReply(HostReply.OVERVIEW, msg.requestId, await onGetOverview(msg.requestId)) };
    case HostEndpoint.READ_RECORDS:
      return {
        response: okReply(
          HostReply.RECORDS,
          msg.requestId,
          await onReadRecords(msg.requestId, msg.startLine, msg.count)
        ),
      };
    case HostEndpoint.READ_RECORD:
      return {
        response: okReply(HostReply.RESULT, msg.requestId, await onReadRecord(msg.requestId, msg.line)),
      };
    case HostEndpoint.GET_SAMPLE_FIELDS:
      return {
        response: okReply(
          HostReply.SAMPLE_FIELDS,
          msg.requestId,
          await onGetSampleFields(msg.requestId, msg.count)
        ),
      };
    case HostEndpoint.GET_ERROR_LINES:
      return {
        response: okReply(
          HostReply.ERROR_LINES,
          msg.requestId,
          { lines: await onGetErrorLines(msg.requestId, msg.range) } satisfies ErrorLinesPayload
        ),
      };
    case HostEndpoint.JUMP_TO_SOURCE:
      await onJumpToSource(msg.line, msg.requestId);
      return { response: okReply(HostReply.RESULT, msg.requestId, { jumped: true }) };
    case HostEndpoint.SEARCH:
      return {
        response: okReply(
          HostReply.SEARCH_RESULTS,
          msg.requestId,
          await onSearch(msg.requestId, msg.query, msg.field, msg.scope)
        ),
      };
    case HostEndpoint.FILTER:
      return {
        response: okReply(
          HostReply.FILTER_RESULTS,
          msg.requestId,
          await onFilter(msg.requestId, msg.field, msg.op, msg.value)
        ),
      };
    case HostEndpoint.PERSIST_STATE:
      await onPersistState(msg.requestId, msg.key, msg.value);
      return { response: okReply(HostReply.RESULT, msg.requestId, { ok: true }) };
    case HostEndpoint.LOAD_STATE:
      return {
        response: okReply(HostReply.RESULT, msg.requestId, await onLoadState(msg.requestId, msg.key)),
      };
    case HostEndpoint.RELOAD:
      return {
        response: okReply(HostReply.OVERVIEW, msg.requestId, await onReload(msg.requestId)),
      };
    default: {
      // 未知端点 → 回执 error/message。
      const m = msg as { type: string; requestId?: string };
      return {
        response: {
          type: HostReply.ERROR,
          requestId: m.requestId,
          message: `endpoint not implemented yet: ${m.type}`,
        },
      };
    }
  }
}

/** 构造一条带 requestId 的通行成功响应。 */
export function okReply(type: string, requestId: string, payload: unknown): HostResponse {
  return { type, requestId, payload } as HostResponse;
}

/** 构造错误回执。 */
export function errReply(requestId: string | undefined, message: string): HostResponse {
  return { type: HostReply.ERROR, requestId, message };
}

/** 构造初始化引导消息。 */
export function initReply(payload: InitPayload): HostResponse {
  return { type: HostReply.INIT, payload };
}