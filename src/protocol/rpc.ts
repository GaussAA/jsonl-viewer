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
  /** 就地替换某一行（编辑能力；行数不变，行尾按原样保留）。 */
  EDIT_RECORD: 'editRecord',
  /** 在第 at 行之前插入一行（编辑能力 M2；at === 总行数表示追加到末尾）。 */
  INSERT_RECORD: 'insertRecord',
  /** 删除第 line 行（编辑能力 M2；行数减一，其后行号前移）。 */
  DELETE_RECORD: 'deleteRecord',
  /** 全文查找替换（编辑能力 M2；批量改写命中行，走「重写 + 原子替换」）。 */
  REPLACE_TEXT: 'replaceText',
} as const;

/** O(1) 查找表：把 HostEndpoint 所有值预编译成 Set，isHostEndpoint 每次调用不再 O(n) 遍历。 */
const HOST_ENDPOINT_SET: ReadonlySet<string> = new Set(Object.values(HostEndpoint));

/** host -> webview 响应端点。 */
export const HostReply = {
  INIT: 'init',
  OVERVIEW: 'overview',
  SAMPLE_FIELDS: 'sampleFields',
  RECORDS: 'records',
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
  /** 行替换结果（成功与业务失败均走此回执，便于携带冲突等结构化原因）。 */
  EDIT_RESULT: 'editResult',
  /** host 主动推送：文档已从磁盘整体复位（放弃改动 / revert），webview 应清缓存并重拉。 */
  DOCUMENT_RESET: 'documentReset',
  /** 查找替换结果（成功与业务失败均走此回执）。 */
  REPLACE_RESULT: 'replaceResult',
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

/**
 * 列表中的单条记录载荷（阶段三：列表态只回有界摘要，完整值按需走 READ_RECORD）。
 * - value    ：完整值。仅当未超阈值（或坏行）时提供；超大对象截断为 undefined。
 * - summary  ：有界摘要（列表卡片渲染用），ok 记录始终提供，不持有整条 JSON。
 * - truncated：超大对象被截断标记——value 为 undefined，完整值须经 READ_RECORD 按需获取。
 * - kind/count：值类型与顶层条目数（徽章用），截断态下仍能渲染徽章，无需回退解析 value。
 */
export interface RecordsPayloadItem {
  line: number;
  ok: boolean;
  /** 完整值。超大对象截断为 undefined（经 READ_RECORD 按需拉取）。 */
  value?: unknown;
  error?: string;
  /** 有界摘要（列表卡片渲染用），ok 记录始终提供。 */
  summary?: { key: string; display: string }[];
  /** 超大对象被截断：value 为 undefined，完整值须经 READ_RECORD 按需获取。 */
  truncated?: boolean;
  /** 值类型（徽章用），截断态下仍能渲染徽章。 */
  kind?: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  /** 顶层 key 数(object)/元素数(array)，徽章用。 */
  count?: number;
}

export interface RecordsPayload {
  startLine: number;
  items: RecordsPayloadItem[];
  hasMore: boolean;
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

/** 行替换结果。业务失败（冲突 / 校验不过 / 权限不足）也走此载荷，便于前端结构化处理。 */
export interface EditResultPayload {
  /** 被编辑的行号（0 基）。 */
  line: number;
  /** 是否写入成功。 */
  ok: boolean;
  /** 字节增量（新行含行尾 − 旧行含行尾）。 */
  bytesDelta: number;
  /** 是否走原位覆写（等长替换，零搬移）。 */
  inPlace: boolean;
  /** 实际搬移的尾部字节数（成本度量）。 */
  movedBytes: number;
  /** 磁盘动作耗时（毫秒）。 */
  costMs: number;
  /** 失败原因（ok=false 时给出，可直接展示给用户）。 */
  error?: string;
  /** 是否为「文件已被外部修改」冲突（需重新加载后再编辑）。 */
  conflict?: boolean;
  /** 是否因 JSON 校验未通过而拒绝（前端可据此提示语法错误）。 */
  invalid?: boolean;
  /** 被替换掉的旧行文本（ok=true 时提供，供撤销/重做使用）。 */
  beforeText?: string;
}

/** 查找替换的结果。业务失败（冲突 / 命中过多 / 空间不足）也走此载荷。 */
export interface ReplaceResultPayload {
  ok: boolean;
  /** 实际改写的行数。 */
  replaced: number;
  /** 因替换后 JSON 非法而跳过的行数（必须如实展示，否则用户会以为全改完了）。 */
  skippedInvalid: number;
  /** 命中查询但内容无变化的行数。 */
  unchanged: number;
  /** 本次扫描到的命中行总数（含跳过）。 */
  total: number;
  /** 新文件相对旧文件的字节增量。 */
  bytesDelta: number;
  /** 磁盘动作耗时（毫秒）。 */
  costMs: number;
  /**
   * 被改写行的前后文本，供**一次性撤销**整批替换。
   * 仅当规模在上限内时提供；未提供时 `undoable` 为 false，调用方须如实告知用户。
   */
  changes?: ReplaceChange[];
  /** 本批替换是否已具备撤销能力。 */
  undoable: boolean;
  /** 失败原因（ok=false 时给出，可直接展示给用户）。 */
  error?: string;
  /** 是否为「文件已被外部修改」冲突（需重新加载后再操作）。 */
  conflict?: boolean;
}

/** 一次被改写的行：行号 + 前后文本（撤销时按行号升序写回 before）。 */
export interface ReplaceChange {
  line: number;
  before: string;
  after: string;
}

/** 文档复位通告：宿主已从磁盘重新加载，webview 应清空缓存/搜索/过滤并重拉概览与字段。 */
export interface DocumentResetPayload {
  /** 人类可读的原因（如「已放弃更改并从磁盘重新加载」）。 */
  message: string;
}

/* webview -> host 的具体请求消息。 */
export type HostRequest =
  | { type: typeof HostEndpoint.READY }
  | { type: typeof HostEndpoint.GET_OVERVIEW; requestId: string }
  | { type: typeof HostEndpoint.GET_SAMPLE_FIELDS; requestId: string; count?: number }
  | { type: typeof HostEndpoint.READ_RECORDS; requestId: string; startLine: number; count: number }
  | { type: typeof HostEndpoint.READ_RECORD; requestId: string; line: number }
  | {
      type: typeof HostEndpoint.SEARCH;
      requestId: string;
      query: string;
      field?: string;
      scope?: string;
    }
  | {
      type: typeof HostEndpoint.FILTER;
      requestId: string;
      field?: string;
      op?: string;
      value?: string;
    }
  | { type: typeof HostEndpoint.JUMP_TO_SOURCE; requestId: string; line: number }
  | { type: typeof HostEndpoint.CANCEL; requestId: string }
  | { type: typeof HostEndpoint.PERSIST_STATE; requestId: string; key: string; value: unknown }
  | { type: typeof HostEndpoint.LOAD_STATE; requestId: string; key: string }
  | { type: typeof HostEndpoint.RELOAD; requestId: string }
  | {
      type: typeof HostEndpoint.EDIT_RECORD;
      requestId: string;
      line: number;
      /** 替换后的整行文本（不含行尾；行尾由宿主按原样保留）。 */
      text: string;
      /**
       * 乐观锁：断言旧行的内容字节长度。与磁盘实际不符即判冲突 ——
       * 用于发现「会话期间文件被外部程序改过」，避免基于过期视图覆写。
       */
      expectedBytes?: number;
    }
  | {
      type: typeof HostEndpoint.INSERT_RECORD;
      requestId: string;
      /** 插入位置：新行将成为第 at 行（at === 总行数即追加到末尾）。 */
      at: number;
      /** 新行的整行文本（不含行尾；行尾风格由宿主参考相邻行决定）。 */
      text: string;
    }
  | {
      type: typeof HostEndpoint.DELETE_RECORD;
      requestId: string;
      /** 要删除的行号（0 基）。 */
      line: number;
    }
  | {
      type: typeof HostEndpoint.REPLACE_TEXT;
      requestId: string;
      /** 要查找的文本（**字面量**，绝不当正则对待）。 */
      query: string;
      /** 替换为的文本（可为空串，即删除匹配片段）。 */
      replacement: string;
      /** 是否大小写不敏感；默认与搜索一致（true）。 */
      caseInsensitive?: boolean;
    };

/* host -> webview 的具体响应消息。 */
export type HostResponse =
  | { type: typeof HostReply.INIT; payload: InitPayload }
  | { type: typeof HostReply.OVERVIEW; requestId: string; payload: OverviewPayload }
  | { type: typeof HostReply.SAMPLE_FIELDS; requestId: string; payload: SampleFieldsPayload }
  | { type: typeof HostReply.RECORDS; requestId: string; payload: RecordsPayload }
  | { type: typeof HostReply.SEARCH_RESULTS; requestId: string; payload: SearchResultsPayload }
  | { type: typeof HostReply.FILTER_RESULTS; requestId: string; payload: FilterResultsPayload }
  | { type: typeof HostReply.RESULT; requestId: string; payload: unknown }
  | { type: typeof HostReply.ERROR; requestId?: string; message: string }
  | { type: typeof HostReply.JUMP_TO_SOURCE; payload: JumpToSourcePayload }
  | { type: typeof HostReply.FILE_STALE; payload: StaleFilePayload }
  | { type: typeof HostReply.EDIT_RESULT; requestId: string; payload: EditResultPayload }
  | { type: typeof HostReply.DOCUMENT_RESET; payload: DocumentResetPayload }
  | { type: typeof HostReply.REPLACE_RESULT; requestId: string; payload: ReplaceResultPayload };

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
  return isRpcMessage(msg) && isHostEndpoint((msg as { type: string }).type);
}

/** 判断某 type 是否为 HostEndpoint 的某个端点值（枚举键大写、值是端点名）。O(1) Set 查找。 */
function isHostEndpoint(type: string): boolean {
  return HOST_ENDPOINT_SET.has(type);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * 从任意消息中安全取 requestId（无该字段 / 非字符串 → undefined）。
 *
 * 用途（T7）：异常回执须保留请求关联——带 requestId 的 ERROR 会被 webview 精确 reject 到
 * 对应请求（`webview/rpc.ts` 命中 pending 即早返回），而非升级为全局 error 横幅、
 * 也不留下永不 settle 的在途请求。READY 之类无 requestId 的端点自然得到 undefined。
 */
export function requestIdOf(msg: unknown): string | undefined {
  if (!isObject(msg)) return undefined;
  const rid = (msg as { requestId?: unknown }).requestId;
  return typeof rid === 'string' ? rid : undefined;
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
/**
 * 宿主侧处理器注册表：每个端点对应一个 handler，handler **自行构造并返回完整
 * HostResponse**（含 requestId 与 reply 类型）。新增端点 = 加 HostEndpoint 常量 +
 * HostRequest/HostResponse 联合成员 + 此处一个字段 + 调用处注册一个 handler；
 * **dispatchMessage 本体无需改动**（OCP）。
 */
export type HostHandlerMap = {
  [HostEndpoint.READY]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.READY }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.GET_OVERVIEW]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.GET_OVERVIEW }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.GET_SAMPLE_FIELDS]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.GET_SAMPLE_FIELDS }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.READ_RECORDS]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.READ_RECORDS }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.READ_RECORD]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.READ_RECORD }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.JUMP_TO_SOURCE]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.JUMP_TO_SOURCE }>
  ) => Promise<HostResponse | undefined> | HostResponse | undefined;
  [HostEndpoint.SEARCH]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.SEARCH }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.FILTER]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.FILTER }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.PERSIST_STATE]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.PERSIST_STATE }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.LOAD_STATE]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.LOAD_STATE }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.RELOAD]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.RELOAD }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.EDIT_RECORD]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.EDIT_RECORD }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.INSERT_RECORD]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.INSERT_RECORD }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.DELETE_RECORD]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.DELETE_RECORD }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.REPLACE_TEXT]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.REPLACE_TEXT }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.CANCEL]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.CANCEL }>
  ) => HostResponse | undefined;
};

export interface DispatchResult {
  /** 需要回给 webview 的消息；undefined 表示无需回执（如 ready 外的空响应）。 */
  response: HostResponse | undefined;
}

/**
 * 按端点查表分发一条 webview 消息。handler 已在 HostHandlerMap 中自带 reply 构造逻辑，
 * 本函数只做「类型校验 → 查表 → 调用 → 异常兜底」，不含任何端点专属分支。
 * 未知端点（非 HostEndpoint）直接被 isHostRequest 过滤，无回执。
 */
export async function dispatchMessage(
  msg: unknown,
  handlers: HostHandlerMap
): Promise<DispatchResult> {
  if (!isHostRequest(msg)) return { response: undefined };
  // READY 端点无 requestId 字段，故安全取值（可能 undefined）；errReply 已兼容 undefined 入参。
  const requestId = requestIdOf(msg);
  const registry = handlers as unknown as Record<
    string,
    (req: HostRequest) => Promise<HostResponse | undefined>
  >;
  const handler = registry[msg.type];
  if (!handler) {
    return { response: errReply(requestId, `endpoint not implemented yet: ${msg.type}`) };
  }
  try {
    const response = await handler(msg);
    return { response: response ?? undefined };
  } catch (e) {
    return { response: errReply(requestId, e instanceof Error ? e.message : String(e)) };
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
