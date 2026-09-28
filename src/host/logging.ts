/**
 * logging.ts — 宿主侧结构化日志（扩展宿主专用，不引入 vscode 依赖，可直接单测）。
 *
 * 为何要从「拼字符串 appendLine」换成结构化行：
 *   1. 大文件场景的排障靠的是**关联**——某次请求从收包到落盘经历了哪些步骤、耗时多少、
 *      最终什么结局。纯文本日志没有 traceId，跨消息串联只能靠人肉比对时间戳；
 *   2. 结构化行可被外部工具直接聚合（按 endpoint 统计耗时 P95、按 outcome 统计失败率），
 *      无需先写一套正则去解析中文句子；
 *   3. `code` / `outcome` 等字段让「错误分类」从文案匹配变成字段比较。
 *
 * 设计要点：
 *   - 一行一条 JSON，**不美化、不换行**（输出面板里一行即一条，便于复制给他人排障）；
 *   - 所有字段缺失即省略（不是填 null）——稀疏但清晰；
 *   - 写日志本身绝不抛错（磁盘/序列化异常一律吞掉）：日志不应成为新的故障源。
 */

/** 结构化日志字段。仅 `ts`/`level`/`msg` 必填，其余按上下文附加。 */
export interface LogFields {
  /** 追踪 ID：一次请求生命周期内的所有日志共享（无 requestId 时用生成的短 ID）。 */
  traceId?: string;
  /** webview 请求的 requestId（有则与 traceId 同源，便于前端/宿主对照）。 */
  requestId?: string;
  /** 端点名（HostEndpoint 或 HostReply）。 */
  endpoint?: string;
  /** 耗时（毫秒）。 */
  durationMs?: number;
  /** 结局：ok / error / cancelled。 */
  outcome?: 'ok' | 'error' | 'cancelled';
  /** 错误码（与协议 RpcErrorCode 同源的语义）。 */
  code?: string;
  /** 任意附加上下文（数值 / 布尔 / 短字符串）。 */
  [key: string]: unknown;
}

export type LogLevel = 'debug' | 'info' | 'error';

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  /** 把一行格式化后的文本写到目的地（输出面板 / 测试收集器）。 */
  sink: (line: string) => void;
  /** debug 级是否输出（绑定 `jsonlViewer.debug` 配置，可随时开关）。 */
  debugEnabled: () => boolean;
  /** 时间源（可注入，便于单测断言）。默认 Date.now()。 */
  now?: () => number;
}

/** 生成短追踪 ID（无 requestId 的宿主主动动作——如 stale 轮询——用它串联）。 */
export function makeTraceId(prefix = 'tr'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * 创建结构化日志器。
 *
 * 序列化失败（循环引用 / bigint）时降级为「只带 msg 的最小行」——
 * 宁可少记字段，也不能让一次日志把整个消息处理流程打断。
 */
export function createLogger(opts: LoggerOptions): Logger {
  const now = opts.now ?? (() => Date.now());

  function emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (level === 'debug' && !opts.debugEnabled()) return;
    let line: string;
    try {
      line = JSON.stringify({
        ts: new Date(now()).toISOString(),
        level,
        msg,
        ...fields,
      });
    } catch {
      line = JSON.stringify({ ts: new Date(now()).toISOString(), level, msg });
    }
    try {
      opts.sink(line);
    } catch {
      /* 写日志失败不得影响业务 */
    }
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}
