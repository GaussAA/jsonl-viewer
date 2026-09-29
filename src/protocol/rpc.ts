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

import type { Condition } from '../core/query.ts';
import type { FieldInfo } from '../infer/inferFields.ts';
import { MAX_PERSIST_KEY_LEN, MAX_PERSIST_VALUE_BYTES, PERSIST_KEY_PREFIX } from '../constants.ts';

/* ------------------------------ 常量 ------------------------------ */

/**
 * 协议版本号（host 与 webview 的契约版本）。
 *
 * 为何必须有它：webview 以 `retainContextWhenHidden: true` 常驻，扩展更新后 VS Code
 * 可能仍复用**旧版 webview 脚本**与**新版宿主**配对。没有版本号时，两端对消息形状
 * 的理解差异不会报错，只会表现为「点了没反应 / 字段全是 undefined」这类无法归因的
 * 诡异行为。版本号让宿主能立刻识别并给出「请重新打开」的明确指引。
 *
 * 变更纪律：凡**破坏性**改动（删改端点、改载荷字段语义）必须 +1；纯增量（新增可选
 * 字段、新增端点）不改版本。
 */
export const PROTOCOL_VERSION = 1;

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
  /**
   * 批量字段级替换（M3 收尾）：把所有行中「指定路径下的值恰好等于 from」的字段改成 to。
   *
   * 与 REPLACE_TEXT 的本质区别：匹配的是**该路径下的值**（结构化语义），而非行内文本 ——
   * 其他字段里恰好含相同文本的地方不受影响。这正是它存在的意义。
   */
  REPLACE_FIELD: 'replaceField',
  /** 批量删除多行（编辑能力 M2；相邻行会合并成连续区间后一次原子重写）。 */
  DELETE_RECORDS: 'deleteRecords',
  /** 读取多行原文并复制到剪贴板（剪贴板由宿主侧写入，比 webview 的 clipboard 可靠）。 */
  COPY_LINES: 'copyLines',
  /** 读取会话内的编辑历史（不含回退所需的原文，那是宿主内部事务）。 */
  GET_HISTORY: 'getHistory',
  /**
   * 读取「已发现」的坏行集合。
   *
   * **语义警告**：该集合只覆盖宿主已检查过的范围（用户读过/抽样过的行），
   * 不是全文件坏行集。前端必须如实标注，否则用户会误判「文件基本干净」。
   */
  GET_BAD_LINES: 'getBadLines',
  /** 全文件扫描坏行（耗时只读操作，可取消、带进度）。扫描结果是权威全量。 */
  SCAN_BAD_LINES: 'scanBadLines',
  /** 撤销一步（与 VS Code 的 Ctrl+Z 走同一光标，二者不会各说各话）。 */
  UNDO_EDIT: 'undoEdit',
  /** 重做一步。 */
  REDO_EDIT: 'redoEdit',
  /** 把光标移到指定历史条目（历史浮层的「回退到此处」）。 */
  REVERT_TO: 'revertTo',
  /**
   * 把选定记录**另存为新文件**（导出子集）。
   *
   * 与所有编辑端点的根本区别：它**只读源文件**、只创建目标文件 —— 不进写链、
   * 不进撤销历史。用户不会（也不应）以为 Ctrl+Z 能「撤回导出」。
   */
  EXPORT_LINES: 'exportLines',
  /** 查询是否有中断编辑遗留的备份（O8）。只报告，不自动恢复。 */
  BACKUP_STATUS: 'backupStatus',
  /** 处理遗留备份：恢复或丢弃（恢复会改写源文件，走写链）。 */
  RECOVER_BACKUP: 'recoverBackup',
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
  /** 批量字段级替换结果（与 REPLACE_RESULT 同构，复用同一 payload 形状）。 */
  REPLACE_FIELD_RESULT: 'replaceFieldResult',
  /** 批量删除结果（成功与业务失败均走此回执）。 */
  DELETE_MANY_RESULT: 'deleteManyResult',
  /** 批量复制结果（是否截断必须如实回报）。 */
  COPY_RESULT: 'copyResult',
  /** 会话编辑历史快照。 */
  HISTORY: 'history',
  /** 撤销 / 重做 / 回退的结果。 */
  HISTORY_RESULT: 'historyResult',
  /** 坏行查询 / 扫描的结果。 */
  BAD_LINES: 'badLines',
  /** 导出子集的结果（成功与业务失败均走此回执）。 */
  EXPORT_RESULT: 'exportResult',
  /** 遗留备份的检测结果。 */
  BACKUP_STATUS_RESULT: 'backupStatusResult',
  /** 遗留备份的处理结果（恢复 / 丢弃）。 */
  RECOVER_BACKUP_RESULT: 'recoverBackupResult',
  /**
   * host 主动推送：耗时写操作的进度（批量重写的全文件重写阶段）。
   *
   * 为何必须走主动推送：RPC 是请求/响应模型，而重写 1GB 文件要数秒，期间 webview
   * 需要一个可取消的进度条 —— 只能由 host 单向推送。
   */
  EDIT_PROGRESS: 'editProgress',
} as const;

/* ------------------------------ 类型 ------------------------------ */

export interface OverviewPayload {
  uri: string;
  /** 宿主侧的协议版本；webview 据此判断自己是否与宿主匹配。 */
  protocolVersion: number;
  totalLines: number;
  /** 逻辑记录总数（紧凑文件 == totalLines；pretty/多行文件按记录分组计数）。 */
  totalRecords: number;
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
  /**
   * 是否被主动取消（本次只是「扫到一半」的片段，不是命中全集）。
   *
   * 与 `truncated` 严格区分：前者意味着「结果是可信子集，只是没列尽」，
   * 后者意味着「此后是否还有命中一无所知」。前端据此只提示「已中断」，
   * 而宿主侧的批量替换会直接拒绝基于它的改写。
   */
  cancelled?: boolean;
}

/** 字段过滤结果有效载荷。matches 为 null 表示「不过滤 = 全量视图」。 */
export interface FilterResultsPayload {
  /** 升序匹配 lineId；null = 清空过滤恢复全量。 */
  matches: number[] | null;
  total: number;
  /** 是否因达到宿主结果上限而提前终止（仍有更多匹配未列出）。 */
  truncated?: boolean;
  /** 是否被主动取消（结果只是扫描到一半的片段）。语义同 `SearchResultsPayload.cancelled`。 */
  cancelled?: boolean;
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
  /**
   * 是否被主动取消（此时 `ok` 为 false，但**文件未被修改**）。
   *
   * 取消与失败必须分开报：变长编辑的取消会自动回滚（零风险），把它报成「失败」
   * 会让用户以为文件可能损坏 —— 那是与事实相反的恐慌。
   */
  cancelled?: boolean;
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
  /**
   * 是否被用户主动取消。
   *
   * 与「失败」严格区分：批量重写走「写临时文件 + 原子 rename」，取消发生在 rename 之前，
   * 故**目标文件从未被触碰**。把它报成普通失败会让用户以为文件可能损坏，
   * 那是与事实相反的恐慌。
   */
  cancelled?: boolean;
  /** 失败原因（ok=false 时给出，可直接展示给用户）。 */
  error?: string;
  /** 是否为「文件已被外部修改」冲突（需重新加载后再操作）。 */
  conflict?: boolean;
}

/**
 * 一次批量删除中被移除的**连续区间**。
 *
 * 关键：`start` / `end` 与 `content` 一起回传，是因为**撤销 = 在同一组 start 处插入 content**。
 * 删除不会改变「删除点之前」的任何偏移，故删除与撤销共用同一组区间 —— 完全可逆，
 * 且撤销与删除一样是**一次原子重写**（而非 N 次逐行插入）。
 */
export interface DeletedRange {
  /** 被删区间的起始偏移；删除后该偏移即为插入点。 */
  start: number;
  /** 结束偏移（含行尾，独占）。 */
  end: number;
  /** 区间内的原始字节（含行尾），撤销时原样插回。 */
  content: string;
  /** 该区间覆盖的行号（升序）。 */
  lines: number[];
  /**
   * 每行的字节数（含行尾），与 `lines` 一一对应。
   *
   * 必须回传：撤销时要把索引检查点精确平移，而各行的字节长度并不相等 ——
   * 用「总字节 ÷ 行数」的平均值去平移会让检查点错位，`scan` 随即读到错误位置。
   */
  lineBytes: number[];
}

/** 批量删除结果。 */
export interface DeleteManyResultPayload {
  ok: boolean;
  /** 实际删除的行数。 */
  deleted: number;
  /** 合并后的连续区间数（框选一整段时它会是 1，这是本功能的核心优化）。 */
  ranges: number;
  bytesDelta: number;
  costMs: number;
  /** 因过大而跳过的行数（无法安全取出内容）。 */
  skipped: number;
  /** 供撤销的区间清单（与删除共用同一组偏移）。 */
  changes?: DeletedRange[];
  error?: string;
  /** 是否为「文件已被外部修改」冲突。 */
  conflict?: boolean;
  /** 是否被用户主动取消（与失败严格区分：取消时目标文件从未被触碰）。 */
  cancelled?: boolean;
}

/** 批量复制结果。 */
export interface CopyLinesResultPayload {
  ok: boolean;
  /** 实际复制的行数。 */
  count: number;
  /** 复制的字节数。 */
  bytes: number;
  /** 是否因超过上限被截断 —— 必须如实告知，静默截断会让用户以为复制全了。 */
  truncated: boolean;
  /** 因过大而跳过的行数。 */
  skipped: number;
  error?: string;
}

/** 一条历史记录的**对外视图**（供 UI 渲染）。 */
export interface HistoryEntryView {
  id: string;
  /** 操作类型（驱动图标与配色）。 */
  kind: 'edit' | 'insert' | 'delete' | 'deleteMany' | 'replaceAll';
  /** 人类可读描述，如「替换 3 行」。 */
  label: string;
  /** 影响的行数（插入/删除为 1，批量为 N）。 */
  lines: number;
  /** 字节增量（可为负）。 */
  bytesDelta: number;
  /** 时间戳（毫秒）。 */
  at: number;
}

/** 会话编辑历史快照。 */
export interface HistoryPayload {
  /** 按时间升序；「光标」之前的为**已应用**，之后的为**已撤销**。 */
  entries: HistoryEntryView[];
  /** 已应用条数（0 表示全部已撤销）。 */
  cursor: number;
  /**
   * 是否因超出上限丢弃过更早的记录。
   * 必须如实告知 —— 否则用户会以为看到的是完整历史。
   */
  dropped: boolean;
}

/** 撤销 / 重做 / 回退的结果。 */
export interface HistoryResultPayload {
  ok: boolean;
  /** 本次实际执行的步数（回退跨多条时为多步）。 */
  steps: number;
  /** 执行后的光标位置。 */
  cursor: number;
  /** 历史总条数。 */
  total: number;
  /** 被操作条目的描述（单步时给出，便于提示）。 */
  label?: string;
  /** 失败原因（中途失败时 steps 表示已成功回退的步数，便于如实告知）。 */
  error?: string;
}

/** 耗时写操作的进度（host → webview 主动推送）。 */
export interface EditProgressPayload {
  /**
   * 任务类型 —— 决定前端展示什么文案。
   * 之所以复用同一个推送通道：它表达的本就是「长任务的字节级进度」，
   * 与任务语义无关；新增一种长任务时不该再造一条推送链路。
   */
  kind: 'replace' | 'scanBadLines' | 'edit' | 'replaceField' | 'export';
  /** 已处理的原始文件字节数（批量替换时不含被替换区间，它们无需逐字节复制）。 */
  processedBytes: number;
  /** 原始文件总字节数（进度分母）。 */
  totalBytes: number;
}

/**
 * 坏行查询 / 扫描的结果。
 *
 * 两个「完整性」字段必须分开表达，不可合成一个布尔：
 * - `partial`：结果是否只覆盖部分范围（未扫描全文件）。这是**语义**上的不完整。
 * - `truncated`：结果是否因超出 MAX_BAD_LINES 被砍掉。这是**容量**上的不完整。
 * 二者可同时为真，且给用户的提示完全不同（「去扫描」 vs 「坏行太多」）。
 */
export interface BadLinesPayload {
  /** 坏行行号（升序）。 */
  lines: number[];
  /** 是否只覆盖部分范围（查询已发现集合时恒为 true；全文件扫描后为 false）。 */
  partial: boolean;
  /** 已检查/已扫描的行数。 */
  scanned: number;
  /** 文件总行数（partial 为 true 时可据此估出未覆盖比例）。 */
  totalLines: number;
  /** 是否因超出上限被截断（lines 不是范围内的全部坏行）。 */
  truncated: boolean;
  /**
   * 扫描被主动取消（此时 `lines` 为空、`partial` 为 true、`scanned` 为已扫行数）。
   *
   * 取消与失败必须分开报：取消是零风险的（纯读操作），报成「失败」会让用户以为
   * 文件或索引出了问题。
   */
  cancelled?: boolean;
  /** 扫描耗时（毫秒）；查询已发现集合时为 0。 */
  costMs?: number;
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

/** 导出子集的结果。 */
export interface ExportResultPayload {
  ok: boolean;
  /** 实际写入的记录数。 */
  count: number;
  /** 写入的字节数。 */
  bytes: number;
  /** 因过大取不出原文而跳过的记录数（必须如实展示）。 */
  skipped: number;
  /** 目标文件路径（供界面回显「导到哪了」）。 */
  targetPath?: string;
  /** 是否被主动取消（此时目标文件从未被创建，与失败严格区分）。 */
  cancelled?: boolean;
  /** 失败原因（ok=false 时给出，可直接展示）。 */
  error?: string;
}

/** 遗留备份的检测结果（O8）。 */
export interface BackupStatusPayload {
  /** 是否存在孤儿备份。false 时其余字段缺省。 */
  present: boolean;
  /** 备份文件路径（供界面回显「在哪」）。 */
  backupPath?: string;
  /** 备份字节数。 */
  backupBytes?: number;
  /** 能否自动恢复；false 时 reason 说明为什么，界面据此只提供「丢弃」。 */
  recoverable?: boolean;
  /** 不可恢复的原因（可直接展示）。 */
  reason?: string;
}

/** 遗留备份的处理结果。 */
export interface RecoverBackupPayload {
  ok: boolean;
  /** 已写回的字节数（成功时给出）。 */
  restoredBytes?: number;
  /** 失败原因（可直接展示）。 */
  error?: string;
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
      /**
       * 组合过滤条件（F3）：叶子（单字段）或 and / or / not 组。
       *
       * 与下面三个扁平字段**二选一**：新客户端一律走本字段；扁平字段保留为旧客户端的
       * 兼容通道（它们表达的正是「单个叶子条件」，宿主侧归一化后等价）。
       * 形状不可信，宿主会 `normalizeCondition` 净化后再求值。
       */
      condition?: Condition | null;
      /** @deprecated 旧扁平单条件通道（老客户端仍在用）；新客户端请用 `condition`。 */
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
      /** 调用方视图的期望总行数（乐观锁；与磁盘不符即判冲突，宁可拒绝也不错改）。 */
      expectedTotalLines?: number;
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
      /** 调用方视图的期望总行数（乐观锁；详见 EDIT_RECORD 同名参数）。 */
      expectedTotalLines?: number;
      /** 新行的整行文本（不含行尾；行尾风格由宿主参考相邻行决定）。 */
      text: string;
    }
  | {
      type: typeof HostEndpoint.DELETE_RECORD;
      requestId: string;
      /** 要删除的行号（0 基）。 */
      line: number;
      /** 调用方视图的期望总行数（乐观锁；详见 EDIT_RECORD 同名参数）。 */
      expectedTotalLines?: number;
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
      /** 调用方视图的期望总行数（乐观锁；详见 EDIT_RECORD 同名参数）。 */
      expectedTotalLines?: number;
    }
  | {
      type: typeof HostEndpoint.REPLACE_FIELD;
      requestId: string;
      /** 字段路径（对象键为 string、数组下标为 number；不得为空 —— 空路径即整行替换，应走 REPLACE_TEXT）。 */
      path: (string | number)[];
      /** 匹配的旧值（与该路径下的当前值做**深度相等**比较；1 与 1.0 相等）。 */
      from: unknown;
      /** 替换为的新值（任意 JSON 值，可换类型）。 */
      to: unknown;
      /** 调用方视图的期望总行数（乐观锁；详见 EDIT_RECORD 同名参数）。 */
      expectedTotalLines?: number;
    }
  | {
      type: typeof HostEndpoint.DELETE_RECORDS;
      requestId: string;
      /** 要删除的行号（0 基；可乱序、可含重复，宿主负责归一化与合并）。 */
      lines: number[];
      /** 调用方视图的期望总行数（乐观锁；详见 EDIT_RECORD 同名参数）。 */
      expectedTotalLines?: number;
    }
  | {
      type: typeof HostEndpoint.COPY_LINES;
      requestId: string;
      /** 要复制的行号（0 基）。 */
      lines: number[];
    }
  | { type: typeof HostEndpoint.GET_HISTORY; requestId: string }
  | { type: typeof HostEndpoint.GET_BAD_LINES; requestId: string }
  | { type: typeof HostEndpoint.SCAN_BAD_LINES; requestId: string }
  | {
      type: typeof HostEndpoint.EXPORT_LINES;
      requestId: string;
      /**
       * 要导出的记录号（0 基；可乱序、可含重复，宿主负责归一化）。
       *
       * 注意**没有** targetPath：目标路径由宿主侧的保存对话框决定 ——
       * webview 既拿不到文件系统，也不该有权决定往哪里写文件。
       */
      lines: number[];
    }
  | { type: typeof HostEndpoint.BACKUP_STATUS; requestId: string }
  | {
      type: typeof HostEndpoint.RECOVER_BACKUP;
      requestId: string;
      /** 恢复（把备份写回源文件）或丢弃（删除备份与元数据）。 */
      action: 'restore' | 'discard';
    }
  | { type: typeof HostEndpoint.UNDO_EDIT; requestId: string }
  | { type: typeof HostEndpoint.REDO_EDIT; requestId: string }
  | {
      type: typeof HostEndpoint.REVERT_TO;
      requestId: string;
      /** 目标条目 id：光标将移到它**之前**（即回退掉该条及其后的操作）。 */
      id: string;
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
  | { type: typeof HostReply.ERROR; requestId?: string; message: string; code?: RpcErrorCode }
  | { type: typeof HostReply.JUMP_TO_SOURCE; payload: JumpToSourcePayload }
  | { type: typeof HostReply.FILE_STALE; payload: StaleFilePayload }
  | { type: typeof HostReply.EDIT_RESULT; requestId: string; payload: EditResultPayload }
  | { type: typeof HostReply.DOCUMENT_RESET; payload: DocumentResetPayload }
  | { type: typeof HostReply.REPLACE_RESULT; requestId: string; payload: ReplaceResultPayload }
  | {
      type: typeof HostReply.REPLACE_FIELD_RESULT;
      requestId: string;
      payload: ReplaceResultPayload;
    }
  | { type: typeof HostReply.EDIT_PROGRESS; payload: EditProgressPayload }
  | {
      type: typeof HostReply.DELETE_MANY_RESULT;
      requestId: string;
      payload: DeleteManyResultPayload;
    }
  | { type: typeof HostReply.COPY_RESULT; requestId: string; payload: CopyLinesResultPayload }
  | { type: typeof HostReply.HISTORY; requestId: string; payload: HistoryPayload }
  | { type: typeof HostReply.HISTORY_RESULT; requestId: string; payload: HistoryResultPayload }
  | { type: typeof HostReply.BAD_LINES; requestId: string; payload: BadLinesPayload }
  | { type: typeof HostReply.EXPORT_RESULT; requestId: string; payload: ExportResultPayload }
  | { type: typeof HostReply.BACKUP_STATUS_RESULT; requestId: string; payload: BackupStatusPayload }
  | {
      type: typeof HostReply.RECOVER_BACKUP_RESULT;
      requestId: string;
      payload: RecoverBackupPayload;
    };

/**
 * 错误回执的机器可读分类。
 *
 * 为何不能只有 `message` 字符串：前端对错误的处理需要**分支**（冲突要提示「重新加载」、
 * 取消要静默收场、参数非法要提示改输入、超时要可重试），靠匹配中文文案分支既脆弱又
 * 无法本地化。错误码是给程序的，文案是给人看的，两者缺一不可。
 */
export type RpcErrorCode =
  /** 入参不合法（类型/范围/长度）；前端应提示用户改正输入。 */
  | 'INVALID_ARG'
  /** 请求体过大被拒绝；前端应缩小范围后重试。 */
  | 'TOO_LARGE'
  /** 目标不存在（文件被删 / 记录不存在）。 */
  | 'NOT_FOUND'
  /** 文件已被外部修改，基于过期视图的写入被拒绝；前端应提示重新加载。 */
  | 'CONFLICT'
  /** 用户主动取消（零风险，文件未被触碰）；前端应静默收场，不可报成失败。 */
  | 'CANCELLED'
  /** 请求超时（可重试）。 */
  | 'TIMEOUT'
  /** 端点未实现（两端版本不匹配的典型症状）。 */
  | 'NOT_IMPLEMENTED'
  /** 宿主内部异常（未分类兜底）。 */
  | 'INTERNAL';

export type RpcMessage = HostRequest | HostResponse;

/* ---------------------------- 工具函数 ---------------------------- */

let reqSeq = 0;
export function makeRequestId(prefix = 'req'): string {
  reqSeq = (reqSeq + 1) | 0;
  return `${prefix}-${Date.now().toString(36)}-${reqSeq.toString(36)}`;
}

/**
 * 偏好键是否合法。
 *
 * 键由 **webview 给出**（不可信输入），直接拿去写 `workspaceState` 等于让前端决定
 * 宿主存储的结构。故限定：本扩展命名空间前缀 + 长度上限 + 仅允许安全字符
 * （不含路径分隔符与控制字符，杜绝任何形式的键注入）。
 */
export function isAllowedPersistKey(key: string): boolean {
  if (typeof key !== 'string') return false;
  if (key.length === 0 || key.length > MAX_PERSIST_KEY_LEN) return false;
  if (!key.startsWith(PERSIST_KEY_PREFIX)) return false;
  // 允许 `/ :` 是因为键里带文件 URI（`jsonlViewer.state.file:///a.jsonl`）；
  // 拒绝其余一切——空白、控制字符、反斜杠、引号——杜绝任何形式的键注入与路径穿越。
  return /^[A-Za-z0-9._:/-]+$/.test(key);
}

/**
 * 偏好值的体积是否在预算内。
 *
 * `JSON.stringify` 对循环引用抛错、对 bigint 抛错——故整体包在 try 里：
 * 序列化失败一律视为「不可持久化」并拒绝，而不是让异常逃逸到消息循环。
 */
export function isWithinPersistBudget(value: unknown): boolean {
  try {
    const json = JSON.stringify(value ?? null);
    if (typeof json !== 'string') return false; // undefined / 函数等不可序列化值
    // 用 TextEncoder 而非 Buffer：本模块被 **webview 端** 一同引用，
    // 任何 node:* 专属 API 都会让浏览器侧 bundle 需要 polyfill 甚至直接崩。
    return byteLength(json) <= MAX_PERSIST_VALUE_BYTES;
  } catch {
    return false;
  }
}

/** 文本类入参是否在长度预算内（搜索词 / 替换词 / 编辑文本）。 */
export function isWithinTextBudget(text: string, maxBytes: number): boolean {
  return typeof text === 'string' && byteLength(text) <= maxBytes;
}

/** UTF-8 字节长度（两端通用的实现，避免依赖 node:Buffer）。 */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
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
  [HostEndpoint.REPLACE_FIELD]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.REPLACE_FIELD }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.DELETE_RECORDS]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.DELETE_RECORDS }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.COPY_LINES]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.COPY_LINES }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.GET_HISTORY]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.GET_HISTORY }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.GET_BAD_LINES]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.GET_BAD_LINES }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.SCAN_BAD_LINES]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.SCAN_BAD_LINES }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.BACKUP_STATUS]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.BACKUP_STATUS }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.RECOVER_BACKUP]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.RECOVER_BACKUP }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.EXPORT_LINES]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.EXPORT_LINES }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.UNDO_EDIT]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.UNDO_EDIT }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.REDO_EDIT]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.REDO_EDIT }>
  ) => Promise<HostResponse> | HostResponse;
  [HostEndpoint.REVERT_TO]: (
    req: Extract<HostRequest, { type: typeof HostEndpoint.REVERT_TO }>
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
    // NOT_IMPLEMENTED 是「两端版本不匹配」的典型症状，必须可区分于普通内部错误。
    return {
      response: errReply(requestId, `endpoint not implemented yet: ${msg.type}`, 'NOT_IMPLEMENTED'),
    };
  }
  try {
    const response = await handler(msg);
    return { response: response ?? undefined };
  } catch (e) {
    // 异常兜底统一归类为 INTERNAL：前端可据此只提示「宿主内部错误」而不去猜文案。
    return {
      response: errReply(requestId, e instanceof Error ? e.message : String(e), 'INTERNAL'),
    };
  }
}

/** 构造一条带 requestId 的通行成功响应。 */
export function okReply(type: string, requestId: string, payload: unknown): HostResponse {
  return { type, requestId, payload } as HostResponse;
}

/** 构造错误回执（带机器可读的错误码，便于前端分支处理）。 */
export function errReply(
  requestId: string | undefined,
  message: string,
  code?: RpcErrorCode
): HostResponse {
  return { type: HostReply.ERROR, requestId, message, ...(code ? { code } : {}) };
}

/** 构造初始化引导消息。 */
export function initReply(payload: InitPayload): HostResponse {
  return { type: HostReply.INIT, payload };
}
