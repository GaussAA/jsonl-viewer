/**
 * dataService.ts — 主进程侧最小、可跑通的数据宿主服务（无 vscode 依赖）。
 *
 * 职责：把 rpc 协议里的请求与「行偏移索引 + 按需惰性解析」接起来——
 *   - getOverview    ：首见时构建整文件行偏移索引（流式扫描），返回统计；
 *   - readRecords    ：按需读取并解析一批行（虚拟滚动请求可视区）；
 *   - readRecord     ：读取并解析单行（JSON 树详情面板用）。
 *
 * 2b 接管：索引构建 + 全文/字段搜索 + 字段过滤三类重活，统一委托给 `IndexHost`
 * （worker 下沉实现 / 主线程兜底实现，见 indexHost.ts）。未传 `workerScriptPath`
 * 时走主线程，行为与旧实现等价（单测零回归）；运行时走 worker，扫大文件主线程不阻塞。
 * 随机读/单行读/字段推断仍在主线程，基于 worker 回传的稀疏检查点重建的 LineIndex，
 * 轻量且频繁，不值得跨线程。惰性性与内存有界原则不变。
 */

import { stat } from 'node:fs/promises';
import { LineIndex, applyIndexOps, type IndexDeltaOp } from '../indexer/lineIndex.ts';
import type { ByteReader, ReadRecordOpts } from '../parser/jsonParser.ts';
import {
  openFileReader,
  parseJsonLine,
  readLineAt,
  readRecord as readRecordAt,
  scanRecords,
} from '../parser/jsonParser.ts';
import { inferFields } from '../infer/inferFields.ts';
import {
  detectLineEnding,
  lineEndingBytes,
  replaceLine,
  replaceRange,
  rewriteWithEdits,
  WriteCancelledError,
} from './fileWriter.ts';
import type { ByteEdit, LineEnding } from './fileWriter.ts';
import { planLineReplace } from '../core/replaceLogic.ts';
import { jsonValueEquals, locateValue, replaceValueAtPath } from '../core/jsonSpan.ts';
import type { Condition } from '../core/query.ts';
import type { FilterLinesResult, SearchLinesResult } from './searchEngine.ts';
import {
  SAMPLE_SCAN_LINES,
  RECORDS_MAX_COUNT,
  SEARCH_MAX_RESULTS,
  FILTER_MAX_RESULTS,
  MAX_REPLACE_UNDO_LINES,
  MAX_REPLACE_UNDO_BYTES,
  MAX_SELECTION_LINES,
  COPY_MAX_BYTES,
  MAX_BAD_LINES,
  PROGRESS_THROTTLE_MS,
  QUERY_CACHE_MAX,
  MAX_EXPORT_LINES,
} from '../constants.ts';
import {
  discardOrphanBackup,
  inspectOrphanBackup,
  restoreOrphanBackup,
  type OrphanBackup,
} from './backupRecovery.ts';
import { exportLinesToFile, type ExportOpts } from './exporter.ts';
import { buildIndexWithFallback, type IndexHost } from './indexHost.ts';
import { profileRecords, type ProfileResult } from './profileEngine.ts';
import type { BuildResult } from './workerProtocol.ts';
import { EditHistory } from './editHistory.ts';
import { BadLineTracker } from './badLineTracker.ts';
import type { HistoryEntry, HistoryOp, HistoryStepResult } from './editHistory.ts';
import { buildRecordsPayload, PROTOCOL_VERSION } from '../protocol/rpc.ts';
import type {
  BadLinesPayload,
  CopyLinesResultPayload,
  DeleteManyResultPayload,
  DeletedRange,
  EditResultPayload,
  HistoryPayload,
  OverviewPayload,
  RecordsPayload,
  RecordsPayloadItem,
  ReplaceChange,
  ReplaceResultPayload,
  SampleFieldsPayload,
  ExportResultPayload,
} from '../protocol/rpc.ts';
import {
  isOversized,
  jsonCountOf,
  jsonKindOf,
  makeSummary,
  summarizeRawLine,
} from './recordSummary.ts';

/**
 * 探测某行的字节区间与行尾风格。
 *
 * **失败原因必须区分**（越界 / 行过大 / 索引与磁盘不一致）：三者的处置完全不同，
 * 混成一句「无法定位该行」会让排查走弯路 —— 这正是此前踩过的坑。
 */
async function probeLine(
  li: LineIndex,
  reader: ByteReader,
  line: number
): Promise<
  | { ok: true; start: number; end: number; ending: LineEnding }
  | { ok: false; reason: 'out-of-range' | 'too-large' | 'not-found' }
> {
  if (!Number.isInteger(line) || line < 0 || line >= li.totalLines) {
    return { ok: false, reason: 'out-of-range' };
  }
  for await (const r of li.scan(reader, line, line + 1)) {
    if (r.error) return { ok: false, reason: 'too-large' };
    return {
      ok: true,
      start: r.start,
      end: r.end,
      ending: detectLineEnding({ start: r.start, end: r.end }, r.bytes.length),
    };
  }
  // scan 未产出任何行：索引与磁盘不一致（索引说该行存在，却读不出来）。
  return { ok: false, reason: 'not-found' };
}

/** 探测失败原因 → 可操作的中文提示。 */
function describeProbeFailure(
  line: number,
  reason: 'out-of-range' | 'too-large' | 'not-found'
): string {
  switch (reason) {
    case 'out-of-range':
      return `行号越界：${line}`;
    case 'too-large':
      return `该行过大，暂不支持编辑：${line}`;
    case 'not-found':
      return `无法定位该行（索引可能已过期），请重新加载后再试：${line}`;
  }
}

/**
 * 把底层按分块触发的进度**节流**为「≥`PROGRESS_THROTTLE_MS` 一次 + 终态必发」。
 *
 * 终态刻意不节流：否则进度条会永远停在 96% 之类的位置，用户以为卡住了 ——
 * 一个停在 96% 的进度条比没有进度条更糟。
 */
function throttleProgress(
  cb?: (info: { processedBytes: number; totalBytes: number }) => void
): ((info: { processedBytes: number; totalBytes: number }) => void) | undefined {
  if (!cb) return undefined;
  let last = 0;
  return (info) => {
    const now = performance.now();
    const done = info.totalBytes > 0 && info.processedBytes >= info.totalBytes;
    if (!done && now - last < PROGRESS_THROTTLE_MS) return;
    last = now;
    cb(info);
  };
}

/** 二分统计升序数组中小于 `x` 的元素个数（用于批量删除后的行号映射）。 */
/**
 * 复制一份搜索结果再交出去。
 *
 * 缓存里的对象是**共享**的，直接交出去等于把内部状态借给调用方：调用方一旦往
 * `matches` 里 push（或排序），缓存就被污染，下一次同样的查询会拿到错答案。
 * 复制 5 万个数字约 1ms，远比一次全文件扫描便宜。
 */
function cloneSearchResult(r: SearchLinesResult): SearchLinesResult {
  return { ...r, matches: [...r.matches] };
}

/** 同上；过滤结果的 `matches` 可能为 null（=不过滤），须分别处理。 */
function cloneFilterResult(r: FilterLinesResult): FilterLinesResult {
  return { ...r, matches: r.matches === null ? null : [...r.matches] };
}

function countLessThan(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 把宿主侧的编辑选项适配成写入层选项。
 *
 * 顺带做字段名映射：写入层上报的是「已搬移字节」（movedBytes），而协议层统一用
 * 「已处理字节」（processedBytes）—— 三者（替换/扫描/编辑）在前端是同一条进度通道。
 */
function toReplaceOpts(opts: EditRecordOpts): {
  shouldCancel?: () => boolean;
  onProgress?: (info: { movedBytes: number; totalBytes: number }) => void;
} {
  return {
    ...(opts.shouldCancel ? { shouldCancel: opts.shouldCancel } : {}),
    ...(opts.onProgress
      ? {
          onProgress: (info: { movedBytes: number; totalBytes: number }) =>
            opts.onProgress?.({ processedBytes: info.movedBytes, totalBytes: info.totalBytes }),
        }
      : {}),
  };
}

/** 检测文件是否已变更（size/mtime）的最小快照。 */
export interface FileSnapshot {
  size: number;
  mtimeMs: number;
}

/** 文件变更检测结果。null 表示索引尚未构建、无法判断。 */
export type StaleCheckResult =
  { changed: false } | { changed: true; deleted: boolean; message: string } | null;

export interface DataServiceOptions {
  onProgress?: (info: { bytesRead: number; lines: number; done: boolean }) => void;
  readLine?: ReadRecordOpts;
  /** 抽样行数上限（字段推断 / 坏行集合查询用）。默认 200。 */
  sampleLines?: number;
  /**
   * 索引 Worker 脚本的绝对路径（运行时由 extension 传入 dist/indexWorker.js）。
   * 传入则「索引构建 + 搜索 + 过滤」下沉 worker；省略或 spawn 失败则回退主线程。
   */
  workerScriptPath?: string;
  /**
   * 索引宿主工厂（**测试接缝**；生产环境勿传）。
   *
   * 存在理由与 `WorkerIndexHost` 的 `workerFactory` 一致：`DataService` 在内部自行
   * 决定宿主类型，而「重建时是否释放旧宿主」「写后是否回填索引」这类**生命周期正确性**
   * 只有在能注入观测点时才测得出来（否则只能靠泄漏一个真 worker 线程来间接观察）。
   * 省略时走 `buildIndexWithFallback` 的默认选择，行为与既有实现完全一致。
   */
  hostFactory?: IndexHostBuilder;
}

/**
 * 索引宿主构建签名（与 `buildIndexWithFallback` 同形，便于直接替换）。
 */
export type IndexHostBuilder = (
  workerScriptPath: string | undefined,
  path: string,
  onProgress?: (info: { bytesRead: number; lines: number; done: boolean }) => void
) => Promise<{ host: IndexHost; result: BuildResult; fellBack: boolean }>;

/* ---------------------- 会话编辑历史 ---------------------- */

/** 批量改写（查找替换 / 撤销 / 重做）的可选行为。 */
export interface ReplaceOpts {
  /** 是否大小写不敏感（与搜索保持一致；默认 true）。 */
  caseInsensitive?: boolean;
  /** 调用方视图的期望总行数（乐观锁的调用方一侧；详见 detectWriteConflict）。 */
  expectedTotalLines?: number;
  /**
   * 全文件重写阶段的进度回调（已按 `PROGRESS_THROTTLE_MS` 节流，终态必发）。
   * 1GB 文件底层会按 4MB 分块回调 250 次，全量上报只是无意义的 IPC 压力。
   */
  onProgress?: (info: { processedBytes: number; totalBytes: number }) => void;
  /**
   * 取消回调：返回 true 则中止本次改写。
   *
   * 批量重写在 `rename` **之前**中止是**零风险**的 —— 临时文件被清理，目标文件从未被触碰。
   * 这正是选择「全量重写 + 原子 rename」而非逐处搬移换来的额外红利：可取消且不留残迹。
   */
  shouldCancel?: () => boolean;
}

/** 坏行全文件扫描的可选行为。 */
export interface ScanBadLinesOpts {
  /** 进度回调（已按 `PROGRESS_THROTTLE_MS` 节流，终态必发）。 */
  onProgress?: (info: { processedBytes: number; totalBytes: number }) => void;
  /**
   * 取消回调：返回 true 则中止本次扫描。
   *
   * 扫描是**纯读**操作，取消的代价只是白读了一些字节 —— 且取消时**不**替换已发现的
   * 坏行集合（半份扫描结果比没有结果更容易误导）。
   */
  shouldCancel?: () => boolean;
}

/**
 * 单行编辑的可选行为。
 *
 * 只有「需要搬移尾部」的变长编辑才会用到它们：等长替换是单次 IO、末尾行无需搬移，
 * 两者都在毫秒级完成，轮询取消与上报进度都只是噪音。
 */
export interface EditRecordOpts {
  /** 调用方视图的期望总行数（乐观锁的调用方一侧；详见 detectWriteConflict）。 */
  expectedTotalLines?: number;
  /** 搬移进度回调（仅在真有搬移时触发）。 */
  onProgress?: (info: { processedBytes: number; totalBytes: number }) => void;
  /**
   * 取消回调：在分块边界中止搬移。
   *
   * 取消会**自动回滚**（用备份把文件恢复原样），故与批量替换一样是零风险的 ——
   * 上层可放心让用户看到「已取消，文件未被修改」。
   */
  shouldCancel?: () => boolean;
}

export class DataService {
  private index: LineIndex | undefined;
  private reader: ByteReader | undefined;
  private building: Promise<LineIndex> | undefined;
  /** 索引宿主（worker 或主线程兜底），承担 build/search/filter。 */
  private host: IndexHost | undefined;
  /** 构建统计（来自 host.build，供 getOverview/reload）。 */
  private buildStats: { buildMs: number; eof: boolean } | undefined;
  /**
   * 已检查范围中的坏行 lineId 集合（内存只与「已确认的坏行数」成正比）。
   *
   * **它不是全文件坏行集**：只覆盖用户读过/抽样过的行。要拿全量必须显式
   * `scanBadLines()`。二者在前端必须可区分（`BadLinesPayload.partial`）——
   * 把「已发现 3 个坏行」当成「文件只有 3 个坏行」，在数据清洗场景下是危险的误判。
   */
  /**
   * 坏行集合 + 「是否已全量扫过」的标记（细节见 badLineTracker.ts）。
   *
   * **它不是全文件坏行集**：lines 只覆盖读过/抽样过的行；要拿全量必须显式
   * scanBadLines()。二者在前端必须可区分（BadLinesPayload.partial）——
   * 把「已发现 3 个坏行」当成「文件只有 3 个坏行」，在数据清洗场景下是危险的误判。
   */
  private readonly badLines = new BadLineTracker();
  /** 构建索引时的文件快照（用来检测文件是否已变更）。 */
  private snapshot: FileSnapshot | undefined;

  /**
   * 搜索 / 过滤结果缓存（键 = 文件快照 + 查询）。
   *
   * 为何值得缓存：搜索与过滤都要**顺序扫全文件**（1GB 文件数秒），而用户在列表里
   * 反复切换过滤条件、翻页后又回到同一搜索词，是极常见的高频路径 —— 每次都重扫
   * 一遍，既慢又占满 worker。
   *
   * 为何以「快照」为键的一部分：结果只在该版本的文件内容上成立，文件一变（本进程
   * 写入或外部改动）就必须整体失效 —— 缓存一份过期结论比不缓存更危险。
   */
  private readonly queryCache = new Map<string, SearchLinesResult | FilterLinesResult>();
  /**
   * 生命周期代际：dispose/reload 时递增，使在途索引构建失效
   * （构建完成检测到代际变化即丢弃结果，不写回成员，防止 fd 泄漏与索引复活）。
   */
  private generation = 0;
  /**
   * 编辑进行中标志。期间 `checkStale` 不判定 —— 文件正被本进程改写、基线随后同步，
   * 此刻判定只会产生「自己改自己」的误报横幅。
   */
  private editing = false;

  /**
   * 待回填给索引宿主的增量 op —— 与 `this.index` 的每一步增量是**同一事实**。
   *
   * 为何排队而非每次同步：一次「全部替换」可产出成千上万个 op，逐个跨线程回填是纯浪费；
   * 写路径本来就有唯一的成功收口点（`refreshSnapshot`），在那里一次性回传即可。
   */
  private indexOps: IndexDeltaOp[] = [];
  /**
   * 宿主索引是否与 `this.index` 失同步。
   *
   * 正常情况下每次写都会成功回填（为 false）。回填失败（worker 崩 / 句柄异常 / op 被拒）
   * 时置 true，下一次 `search` / `filter` 前**先重建宿主索引** ——
   * 宁可多花一次全文件重扫，也绝不拿一份旧索引给用户出结果。
   */
  private hostDirty = false;

  /**
   * 写操作串行链（互斥锁）—— **一切改动磁盘的动作必须经 `runExclusive` 排队**。
   *
   * 为何必须有它：`DataService` 按 uri 被多个视图共享（默认编辑器 + 独立面板走同一
   * 实例），两个视图可以在同一毫秒各自发起一次编辑。写路径是「读基线 → 冲突检测 →
   * 定位区间 → 写盘 → 平移索引」的多步序列——两步之间若被另一个写操作插入，后写者
   * 的定位区间与索引平移就建立在已被改动的字节之上（典型 TOCTOU）：轻则索引错位，
   * 重则把两段内容写到同一偏移上。
   *
   * 为何不用「标志位 + 直接拒绝」：那会把「两个视图同时编辑」变成随机失败的体验。
   * 排队让两次写入都成功且严格有序，才是用户预期的行为。
   *
   * 死锁纪律：**加锁只发生在对外入口**（editRecord / deleteRecord / insertRecord /
   * replaceText / replaceField / deleteRecords / insertRanges / undo / redo / revert），
   * 内部实现（*Internal 与 applyLineTexts 等）一律不加锁，供锁内调用。
   */
  private writeChain: Promise<unknown> = Promise.resolve();

  /**
   * 把一次写操作排到串行链尾部执行（前一个无论成败都继续，绝不因一次失败卡死全链）。
   */
  private runExclusive<T>(run: () => Promise<T>): Promise<T> {
    const started = this.writeChain.then(run, run);
    // 链上只挂「已吞掉异常」的 Promise：否则前一步 reject 会让链的后续 then 变成
    // unhandledRejection，进而可能击穿扩展宿主。
    this.writeChain = started.then(undefined, () => {});
    return started;
  }

  /** 会话编辑历史（单一光标模型；状态机细节见 editHistory.ts）。 */
  private readonly history = new EditHistory();

  private readonly uri: string;
  private readonly path: string;
  private readonly opts: DataServiceOptions;

  // 注意：不用参数属性语法（Node 类型擦除运行 TS 单测时不支持）。
  constructor(uri: string, path: string, opts: DataServiceOptions = {}) {
    this.uri = uri;
    this.path = path;
    this.opts = opts;
  }

  /** 惰性构建（并发安全：多次同时调用只构建一次；失败后允许重试）。 */
  private ensureIndex(): Promise<LineIndex> {
    if (this.index) return Promise.resolve(this.index);
    if (!this.building) {
      const gen = this.generation;
      this.building = (async () => {
        // 选宿主：优先 worker；**worker 失败时内部自动回退主线程重试**（见 buildIndexWithFallback），
        // 保证「打得开」这条底线不被 worker 加载异常击穿。
        let host: IndexHost | undefined;
        try {
          const buildHost = this.opts.hostFactory ?? buildIndexWithFallback;
          const built = await buildHost(
            this.opts.workerScriptPath,
            this.path,
            this.opts.onProgress
          );
          host = built.host;
          const { index, stats } = built.result;
          if (gen !== this.generation) {
            // 已被 dispose/reload 废弃：释放 worker/reader 后放弃。
            await host.dispose().catch(() => {});
            return index;
          }
          const reader = await openFileReader(this.path);
          if (gen !== this.generation) {
            // 打开读取器期间再次被废弃：关闭自己打开的句柄后放弃。
            if (reader.close) await reader.close().catch(() => {});
            await host.dispose().catch(() => {});
            return index;
          }
          this.host = host;
          this.index = index;
          this.reader = reader;
          this.buildStats = stats;
          // 记下本次索引对应的磁盘快照，供后续「文件变更」检测作基线。
          this.snapshot = await this.currentSnapshot();
          return index;
        } catch (e) {
          // 失败后允许重试：清空 building，否则后续所有请求会永久 reject。
          if (host) await host.dispose().catch(() => {});
          this.building = undefined;
          throw e;
        }
      })();
    }
    return this.building;
  }

  /** 读取当前磁盘快照；文件不存在（被删除）时返回 undefined。 */
  private async currentSnapshot(): Promise<FileSnapshot | undefined> {
    try {
      const s = await stat(this.path);
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch {
      return undefined;
    }
  }

  /**
   * 检测文件是否已变更（size / mtime，或已被删除）。
   * 返回 null 表示索引尚未构建、无从比较（扩展宿主应跳过推送）。
   * 幂等：多次调用返回同一基线下的「当前是否已走样」判断。
   */
  async checkStale(): Promise<StaleCheckResult> {
    // 编辑进行中：不判定（见 editing 字段说明）。
    if (this.editing) return null;
    if (!this.snapshot) return null;
    const cur = await this.currentSnapshot();
    if (!cur) {
      return {
        changed: true,
        deleted: true,
        message: '文件已被删除，索引可能已失效，请重新加载。',
      };
    }
    if (cur.size !== this.snapshot.size || cur.mtimeMs !== this.snapshot.mtimeMs) {
      return { changed: true, deleted: false, message: '文件已更改，行索引可能过期，请重新加载。' };
    }
    return { changed: false };
  }

  async getOverview(): Promise<OverviewPayload> {
    const li = await this.ensureIndex();
    return {
      uri: this.uri,
      protocolVersion: PROTOCOL_VERSION,
      totalLines: li.totalLines,
      totalRecords: li.totalRecords,
      totalBytes: li.totalBytes,
      buildMs: this.buildStats?.buildMs ?? li.buildMs,
      eof: this.buildStats?.eof ?? li.eof,
    };
  }

  async readRecords(
    startLine: number,
    count: number,
    shouldCancel?: () => boolean
  ): Promise<RecordsPayload> {
    const li = await this.ensureIndex();
    const reader = this.reader!;
    // M3：入口整数化校验——脏行号（NaN/小数/负数）不进入读批，也不污染坏行集合。
    if (!Number.isInteger(startLine) || startLine < 0 || !Number.isInteger(count) || count <= 0) {
      return buildRecordsPayload(0, [], li.totalRecords);
    }
    // 协议层硬上限：防御异常输入 / 未来改动一次拉取整个文件（解析 + 序列化双重内存风险）。
    const n = Math.min(count, RECORDS_MAX_COUNT, Math.max(0, li.totalRecords - startLine));
    if (n <= 0) return buildRecordsPayload(startLine, [], li.totalRecords);

    // 阶段三（UI 热路径）：列表态不整条解析、不缓存整条巨物。
    // - 普通记录（≤ 内联阈值，见 constants.ts 的 RECORD_INLINE_MAX_BYTES）：JSON.parse 后附带「有界摘要」；
    // - 超大记录（> 阈值）：跳过整条 parse，浅扫描得类型/顶层条目数/预览并标记 truncated，
    //   完整值仍由 readRecord 按需拉取。如此 list 内存只与「可见窗口 + 有界摘要」成正比。
    // **必须走 scanRecords（记录分组聚合）而非裸 scan**：多行（pretty）文件里一条记录
    // 跨多个物理行，裸 scan 会把每个物理行当记录判定 —— 首行只剩 `{`，全列表皆错
    // （v1.9.0 实机事故：01_basic.jsonl 前 2 条 pretty 记录全显示为 error）。
    const items: RecordsPayloadItem[] = [];
    for await (const rec of scanRecords(startLine, startLine + n, li, reader, { shouldCancel })) {
      const byteLen = rec.buf.length;
      if (isOversized(byteLen)) {
        const raw = summarizeRawLine(rec.buf);
        items.push({
          line: rec.recordNo,
          ok: true,
          value: undefined,
          truncated: true,
          kind: raw.kind,
          count: raw.count,
          summary: [{ key: '', display: raw.preview }],
        });
        continue;
      }
      const parsed = parseJsonLine(rec.text);
      if (!parsed.ok) {
        items.push({ line: rec.recordNo, ok: false, error: parsed.error });
        this.badLines.add(rec.recordNo);
        continue;
      }
      const value = parsed.value;
      items.push({
        line: rec.recordNo,
        ok: true,
        value,
        summary: makeSummary(value),
        kind: jsonKindOf(value),
        count: jsonCountOf(value),
      });
    }
    return buildRecordsPayload(startLine, items, li.totalRecords);
  }

  /**
   * 读取并解析单行。除解析结果外还回**该行原文**（`rawText` / `rawBytes`）——
   * 编辑功能据此把「磁盘上原样」填进编辑框，并作为乐观锁断言（`expectedBytes`）。
   */
  async readRecord(line: number): Promise<{
    value?: unknown;
    error?: string;
    ok: boolean;
    rawText?: string;
    rawBytes?: number;
  }> {
    const li = await this.ensureIndex();
    const reader = this.reader!;
    if (!Number.isInteger(line) || line < 0) {
      return { value: undefined, error: '无效行号', ok: false };
    }
    const r = await readRecordAt(line, li, reader, this.opts.readLine);
    if (!r.ok) this.badLines.add(line);
    return {
      value: r.value,
      error: r.error,
      ok: r.ok,
      rawText: r.rawText,
      rawBytes: r.rawBytes,
    };
  }

  /** 编辑失败的统一回执（避免多处重复填充字段）。 */
  private static editFailure(
    line: number,
    error: string,
    extra?: Partial<EditResultPayload>
  ): EditResultPayload {
    return {
      ok: false,
      line,
      bytesDelta: 0,
      inPlace: false,
      movedBytes: 0,
      costMs: 0,
      error,
      ...extra,
    };
  }

  /**
   * 就地替换第 `recordNo` 条逻辑记录（紧凑文件下即第 `line` 行，行为与旧版一致）。
   *
   * 安全与一致性要点（**顺序即正确性**）：
   *   1. **写前冲突检测**：stat 与索引基线比对（size/mtime）。不一致说明文件已被外部
   *      改动，拒绝写入并返回 conflict —— 避免基于过期视图覆写他人改动；
   *   2. **乐观锁**：`expectedBytes` 非空时须与磁盘上该记录聚合内容字节长度一致；
   *   3. **JSON 校验 + JSONL 单行约束**：多行 pretty 文本会被拒绝（写入后会把一条
   *      记录拆成多行，从那一行起整个文件错位 —— v1.8.0 事故根因）；
   *   4. **写盘**：单行记录走 `replaceLine` 快路径（索引增量平移）；多行记录走
   *      `replaceRange` 整体区间替换 + 索引全量重建（行数变化使增量失效，宁可慢不可错）；
   *   5. **索引与基线同步**：写盘成功后先换上新索引，再立刻刷新基线快照；
   *   6. **写后验证**：用新索引把该记录读回并校验，失败自动回滚（详见内部方法）。
   *
   * 历史回退/重放走 `editRecordInternal`（before/after 可能是多行 —— 曾合法写入文件的
   * 内容），因此单行约束只在本对外入口检查。
   */
  /** 对外入口：串行化后进入带校验的编辑实现（校验同样在锁内，避免校验与写入之间被插队）。 */
  async editRecord(
    line: number,
    text: string,
    expectedBytes?: number,
    opts: EditRecordOpts = {}
  ): Promise<EditResultPayload> {
    return this.runExclusive(() => this.editRecordChecked(line, text, expectedBytes, opts));
  }

  /** 编辑的入参校验（JSONL 单行约束 + JSON 合法性）；校验通过才落盘。 */
  private async editRecordChecked(
    line: number,
    text: string,
    expectedBytes?: number,
    opts: EditRecordOpts = {}
  ): Promise<EditResultPayload> {
    const li = await this.ensureIndex();
    if (!Number.isInteger(line) || line < 0 || line >= li.totalRecords) {
      return DataService.editFailure(line, `无效记录号：${line}`);
    }
    // JSONL 单行约束（对外入口）：物理换行会把一条记录拆成多行，从那一行起整个文件
    // 的行号与内容全部错位。合法 JSONL 行中字符串值的换行必然已转义为 \n 字面量。
    if (/\r|\n/.test(text)) {
      return DataService.editFailure(
        line,
        'JSONL 每条记录必须单行（文本含换行）。请把记录并回一行后再保存。',
        { invalid: true }
      );
    }
    const parsed = parseJsonLine(text);
    if (!parsed.ok) {
      return DataService.editFailure(line, `JSON 校验未通过：${parsed.error}`, { invalid: true });
    }
    return this.editRecordInternal(line, text, expectedBytes, opts);
  }

  /**
   * 编辑内部实现（对外 editRecord 与历史回退/重放共用）。
   *
   * 定位记录区间（多行记录=多行区间）→ 乐观锁 → 写盘 → 索引同步 → 写后验证与回滚 →
   * 历史。**不做单行约束检查** —— 历史重放写回的 before/after 可能是多行（曾合法
   * 存在于文件中的内容），回退必须能够原样恢复。
   */
  private async editRecordInternal(
    line: number,
    text: string,
    expectedBytes?: number,
    opts: EditRecordOpts = {}
  ): Promise<EditResultPayload> {
    const li = await this.ensureIndex();
    const reader = this.reader!;

    if (!Number.isInteger(line) || line < 0 || line >= li.totalRecords) {
      return DataService.editFailure(line, `无效记录号：${line}`);
    }

    // ① 写前冲突检测
    const conflict = await this.detectWriteConflict(line, opts.expectedTotalLines);
    if (conflict) return conflict;

    // ② 定位该记录的字节区间与聚合原文（多行记录=多行区间；顺带探明下一条记录
    //    首行的合法性，供写后验证区分「原本就是坏记录」与「本次写入弄坏了它」）。
    let range: { start: number; end: number } | undefined;
    let oldContentBytes = 0;
    let beforeText = '';
    let isMultiline = false;
    let tailEnding: LineEnding = 'lf'; // 记录尾行尾（保持磁盘原样，不擅自规范化）
    let nextRecordWasValid: boolean | undefined;
    {
      const recRange = li.recordRange(line);
      isMultiline = recRange.endLine > recRange.startLine;
      const parts: string[] = [];
      const scanTo = Math.min(recRange.endLine + 2, li.totalLines);
      for await (const r of li.scan(reader, recRange.startLine, scanTo)) {
        if (r.line === recRange.endLine) {
          // 记录尾行：行尾字节数决定回写时的 ending（保持原样）
          const tailBytes = r.end - r.start - r.bytes.length;
          tailEnding = tailBytes >= 2 ? 'crlf' : 'lf';
        }
        if (r.line <= recRange.endLine) {
          if (r.error) return DataService.editFailure(line, `该记录过大，暂不支持编辑：${r.error}`);
          parts.push(r.bytes.toString('utf8'));
        } else if (r.line === recRange.endLine + 1) {
          // 下一条记录的首行超长（error）时无从判定合法性，跳过写后验证。
          nextRecordWasValid = r.error ? undefined : parseJsonLine(r.bytes.toString('utf8')).ok;
          break;
        }
      }
      if (parts.length === 0) return DataService.editFailure(line, `记录不存在：${line}`);
      beforeText = parts.join('\n');
      oldContentBytes = Buffer.byteLength(beforeText, 'utf8');
      // 字节区间：多行索引直接用分组偏移（含前导空行，一并替换无害）；
      // 紧凑快路径（multiline=false）recordRange 无偏移，用扫描给出的精确行区间。
      range =
        li.multiline || isMultiline
          ? { start: recRange.startOffset, end: recRange.endOffset }
          : undefined;
      if (!range) {
        for await (const r of li.scan(reader, line, line + 1)) {
          if (r.error) return DataService.editFailure(line, `该记录过大，暂不支持编辑：${r.error}`);
          range = { start: r.start, end: r.end };
          break;
        }
        if (!range) return DataService.editFailure(line, `记录不存在：${line}`);
      }
    }

    // ③ 乐观锁
    if (expectedBytes != null && expectedBytes !== oldContentBytes) {
      return DataService.editFailure(line, '该行内容已变化（与编辑前视图不一致），请重新加载。', {
        conflict: true,
      });
    }

    // ④⑤⑥ 写盘 + 同步索引与基线
    this.editing = true;
    try {
      let bytesDelta: number;
      let inPlace: boolean;
      let movedBytes: number;
      let costMs: number;
      let ending: LineEnding = tailEnding;

      if (li.multiline && isMultiline) {
        // —— 多行记录：整体区间替换为单行新文本（记录数 1→1）+ 索引全量重建 ——
        // 行数变化打破增量平移的前提；重建 = 全文件重扫（秒级），低频操作宁可慢不可错。
        const replacement = Buffer.concat([Buffer.from(text, 'utf8'), lineEndingBytes(tailEnding)]);
        const res = await replaceRange(this.path, range, replacement, toReplaceOpts(opts));
        await this.rebuildIndex();
        bytesDelta = res.bytesDelta;
        inPlace = res.inPlace;
        movedBytes = res.movedBytes;
        costMs = res.costMs;
      } else {
        // —— 单行记录：原行替换快路径，索引增量平移 ——
        ending = detectLineEnding(range, oldContentBytes);
        const res = await replaceLine(
          this.path,
          range,
          Buffer.from(text, 'utf8'),
          ending,
          toReplaceOpts(opts)
        );
        await this.commitIndex(li, [{ kind: 'replace', line, delta: res.bytesDelta }]);
        bytesDelta = res.bytesDelta;
        inPlace = res.inPlace;
        movedBytes = res.movedBytes;
        costMs = res.costMs;
      }

      // ⑦ 写后验证（防御性收口）：「写盘成功」的唯一可信依据是**用新索引把字节读回
      //    来仍是合法 JSON**。校验对象 = 被编辑记录（必须合法），外加紧邻下一条记录
      //    （仅在它编辑前就合法时参与）。失败 = 本次写入在某个环节损坏了内容，**立即
      //    用原文写回（回滚）**，并把根因如实带回前端。验证安排在记入历史之前。
      const verifyError = await this.verifyAfterRecordEdit(line, nextRecordWasValid);
      if (verifyError !== '') {
        const rollbackError =
          li.multiline && isMultiline
            ? await this.rollbackRecordEdit(line, beforeText, tailEnding)
            : await this.rollbackLineEdit(line, beforeText, ending, bytesDelta);
        if (rollbackError === '') {
          return DataService.editFailure(
            line,
            `编辑写入后自检未通过（${verifyError}），已自动回滚，文件保持编辑前状态。`
          );
        }
        return DataService.editFailure(
          line,
          `编辑写入后自检未通过（${verifyError}），且自动回滚失败：${rollbackError}。请先检查文件完整性。`
        );
      }

      this.badLines.delete(line);
      this.history.push({ kind: 'edit', line, before: beforeText, after: text }, bytesDelta);
      return {
        ok: true,
        line,
        bytesDelta,
        inPlace,
        movedBytes,
        costMs: Math.round(costMs * 100) / 100,
        beforeText,
      };
    } catch (e) {
      // 取消与失败必须分开报：取消会自动回滚（文件原样），报成「失败」会让用户
      // 以为文件可能损坏 —— 那是与事实相反的恐慌。
      if (e instanceof WriteCancelledError) {
        return DataService.editFailure(line, e.message, { cancelled: true });
      }
      return DataService.editFailure(line, e instanceof Error ? e.message : String(e));
    } finally {
      this.editing = false;
    }
  }

  /** 写前冲突检测：文件被外部改动过则返回失败回执，否则返回 undefined。 */
  private async detectWriteConflict(
    line: number,
    expectedTotalLines?: number
  ): Promise<EditResultPayload | undefined> {
    // ① 调用方视图基线（乐观锁的「调用方一侧」）
    //
    // 拦的是宿主**自己看不见**的那类过期：DataService 按 uri 被多个视图共享，
    // A 视图编辑后宿主基线会刷新，但 B 视图的界面仍是旧行号 ——
    // 此时宿主侧的 size/mtime 检查全都会通过（在宿主看来文件一切正常），
    // B 视图却会拿旧行号去删/插，**改到别的行上**。
    // 期望值由调用方（前端视图）给出，对不上即拒绝：宁可让用户重新加载，也不要错改。
    if (expectedTotalLines != null) {
      const actual = this.index?.totalLines;
      if (actual != null && actual !== expectedTotalLines) {
        return DataService.editFailure(
          line,
          `当前视图已过期（你看到的 ${expectedTotalLines} 行，磁盘上已是 ${actual} 行），` +
            `为避免改错行，已拒绝本次操作；请重新加载后再试。`,
          { conflict: true }
        );
      }
    }

    // ② 宿主基线（拦外部程序改动）
    const before = await this.currentSnapshot();
    if (!before) return DataService.editFailure(line, '文件不存在或无法访问', { conflict: true });
    if (
      this.snapshot &&
      (before.size !== this.snapshot.size || before.mtimeMs !== this.snapshot.mtimeMs)
    ) {
      return DataService.editFailure(line, '文件已被外部修改，请先重新加载再编辑。', {
        conflict: true,
      });
    }
    return undefined;
  }

  /**
   * 索引 update 的**唯一入口**（写路径专用）：同时更新主索引与待回填队列。
   *
   * 为何必须收口：索引现在有两份实例（本类的 `this.index` 与索引宿主内部那份），
   * 任何绕过本方法直接 `this.index = li.applyLineXxx(...)` 的写法，都会让两份索引
   * 悄悄分家 —— 而 `search` / `filter` 只读宿主那一份，于是错误只在「写完再搜」时才
   * 出现，既不报错也难复现。
   *
   * @param ops 严格按发生顺序（op 之间会互相影响行号）；调用方负责算好合法顺序。
   */
  /**
   * 写盘成功后维护索引的**唯一分流点**：多行（pretty）文件全量重建，紧凑文件增量平移。
   *
   * 为何按 `li.multiline` 分流：`LineIndex.applyLine*` 只维护**检查点**，不维护**记录分组**
   * （`recordEndLines/Offsets`）。在 pretty 文件里用增量，索引会静默从「记录语义」塌回
   * 「物理行语义」（`totalRecords` 随之从分组数变成行数），此后 `readRecords` 与历史重放
   * 的行号全部错位 —— 而界面上看不出任何异常。
   *
   * 代价是重建（O(文件大小) 重扫）：多行文件的编辑本就低频，「正确性优先 + 接受一次重扫」
   * 远优于「为省一次重扫引入一套记录分组增量平移」（插入一行是否改变分组需重算深度）。
   */
  private async commitIndex(li: LineIndex, ops: IndexDeltaOp[]): Promise<void> {
    if (li.multiline) {
      await this.rebuildIndex();
      return;
    }
    this.stageIndexOps(ops);
    await this.refreshSnapshot();
  }

  private stageIndexOps(ops: readonly IndexDeltaOp[]): void {
    if (!this.index || ops.length === 0) return;
    this.index = applyIndexOps(this.index, ops);
    this.indexOps.push(...ops);
  }

  /**
   * 把累积的增量 op 一次性回填给索引宿主（worker 则跨线程，主线程则就地应用）。
   *
   * **失败为何不向上抛**：此刻磁盘已经是新内容，让一次「写成功 + 索引回填失败」变成
   * 用户可见的编辑失败，是把内部不一致谎报成数据失败。但它必须**留下痕迹**
   * （`hostDirty`），好让下一条查询前用重建兜底 —— 沉默地丢一次回填，就是沉默地丢一次正确性。
   */
  private async flushIndexOps(): Promise<void> {
    if (this.indexOps.length === 0) return;
    const ops = this.indexOps;
    this.indexOps = []; // 先摘出：即便失败也不重复积压（下一次写会走重建路径）
    try {
      await this.host?.applyIndexOps(ops);
    } catch {
      this.hostDirty = true;
    }
  }

  /**
   * 查询前的前置保障：宿主索引若已失同步，先重建再说。
   *
   * 只在确有必要时触发 —— 正常编辑走的是廉价的增量回填，走到这里的都是异常路径。
   */
  private async ensureFreshHost(): Promise<void> {
    if (!this.hostDirty) return;
    await this.rebuildIndex();
    this.hostDirty = false;
  }

  /** 写后刷新基线快照 —— 不做这一步，5s 轮询会把「自写」误判成外部变更。 */
  private async refreshSnapshot(): Promise<void> {
    const after = await this.currentSnapshot();
    if (after) this.snapshot = after;
    // 文件内容已变 ⇒「坏行已全量扫过」这一结论不再有依据（行号与内容都动了）。
    // 放在这个统一收口点而非 7 个写方法里各写一遍 —— 漏掉任何一处都会让前端
    // 拿一份过期的「全量」结论去说服用户，那比不支持扫描更危险。
    // 注意只降级完整性标记，**不清空**已发现列表（其行号位移已被各处正确维护）。
    this.badLines.invalidate();
    // 快照一变，所有「按旧快照键」缓存的搜索/过滤结果立即作废：
    // 缓存一份过期结论比不缓存更危险（用户会据此以为文件里没有某条记录）。
    if (this.queryCache.size > 0) this.queryCache.clear();
    // 本方法是**所有写路径共同的唯一收口点**（7 个写方法都调它），故索引回填也放这里：
    // 放在此处而非在每个写方法末尾各写一遍 —— 漏一处就是一次静默的行号错位。
    await this.flushIndexOps();
  }

  /**
   * 查询缓存键：文件快照（size + mtime）+ 查询内容。
   *
   * 快照部分不可省：同一查询词在文件被改写前后，正确答案是不同的。
   */
  private queryCacheKey(kind: 's' | 'f', query: string): string {
    const s = this.snapshot;
    const base = s ? `${s.size}:${Math.round(s.mtimeMs)}` : 'nosnap';
    return `${kind}|${base}|${query}`;
  }

  /** 记入查询缓存；超容量按插入顺序淘汰最旧的一条（FIFO，本场景足够）。 */
  private rememberQuery(key: string, res: SearchLinesResult | FilterLinesResult): void {
    if (this.queryCache.size >= QUERY_CACHE_MAX) {
      const oldest = this.queryCache.keys().next().value;
      if (oldest !== undefined) this.queryCache.delete(oldest);
    }
    this.queryCache.set(key, res);
  }

  /**
   * 删除第 `line` 行（含行尾）。行数减一，其后所有行的行号**前移一位**。
   *
   * 前置保护与 `editRecord` 一致（写前冲突检测）；落盘复用写入层同一原语
   * `replaceRange`（空 replacement 即区间删除），随后同步索引与基线快照。
   */
  /** 对外入口：串行化删除。 */
  async deleteRecord(line: number, opts: EditRecordOpts = {}): Promise<EditResultPayload> {
    return this.runExclusive(() => this.deleteRecordInternal(line, opts));
  }

  private async deleteRecordInternal(
    line: number,
    opts: EditRecordOpts = {}
  ): Promise<EditResultPayload> {
    const li = await this.ensureIndex();
    const reader = this.reader!;

    if (!Number.isInteger(line) || line < 0 || line >= li.totalLines) {
      return DataService.editFailure(line, `无效行号：${line}`);
    }
    const conflict = await this.detectWriteConflict(line, opts.expectedTotalLines);
    if (conflict) return conflict;

    const probed = await probeLine(li, reader, line);
    if (!probed.ok) {
      return DataService.editFailure(line, describeProbeFailure(line, probed.reason));
    }
    const removedBytes = probed.end - probed.start;
    // 旧原文用于撤销：删除的逆操作就是把这段文本插回去。
    const removedText = await readLineAt(reader, probed.start, probed.end).catch(() => '');

    this.editing = true;
    try {
      const res = await replaceRange(
        this.path,
        { start: probed.start, end: probed.end },
        Buffer.alloc(0),
        toReplaceOpts(opts)
      );
      await this.commitIndex(li, [{ kind: 'delete', line, bytes: removedBytes }]);
      this.badLines.shiftAfterDelete(line);
      this.history.push({ kind: 'delete', line, before: removedText }, res.bytesDelta);
      return {
        ok: true,
        line,
        bytesDelta: res.bytesDelta,
        inPlace: res.inPlace,
        movedBytes: res.movedBytes,
        costMs: Math.round(res.costMs * 100) / 100,
        beforeText: removedText,
      };
    } catch (e) {
      if (e instanceof WriteCancelledError) {
        return DataService.editFailure(line, e.message, { cancelled: true });
      }
      return DataService.editFailure(line, e instanceof Error ? e.message : String(e));
    } finally {
      this.editing = false;
    }
  }

  /**
   * 在第 `at` 行**之前**插入一行（`at === totalLines` 表示追加到文件末尾）。
   *
   * 新行的行尾风格取「参考行」——优先前一行，其次插入点所在行；二者皆无（空文件）用 LF。
   * 这样在 CRLF 文件里插入的行同样是 CRLF，不会把行尾风格搅乱。
   */
  /** 对外入口：串行化插入。 */
  async insertRecord(
    at: number,
    text: string,
    opts: EditRecordOpts = {}
  ): Promise<EditResultPayload> {
    return this.runExclusive(() => this.insertRecordInternal(at, text, opts));
  }

  private async insertRecordInternal(
    at: number,
    text: string,
    opts: EditRecordOpts = {}
  ): Promise<EditResultPayload> {
    const li = await this.ensureIndex();
    const reader = this.reader!;

    if (!Number.isInteger(at) || at < 0 || at > li.totalRecords) {
      return DataService.editFailure(at, `无效插入位置：${at}`);
    }
    const conflict = await this.detectWriteConflict(at, opts.expectedTotalLines);
    if (conflict) return conflict;

    // 与 editRecord 同一口径的 JSONL 单行约束：插入多行文本会把一条记录拆成多行，
    // 破坏「一行一记录」与索引的行数假设。
    if (/\r|\n/.test(text)) {
      return DataService.editFailure(
        at,
        'JSONL 每条记录必须单行（文本含换行）。请把记录并回一行后再插入。',
        { invalid: true }
      );
    }
    const parsed = parseJsonLine(text);
    if (!parsed.ok) {
      return DataService.editFailure(at, `JSON 校验未通过：${parsed.error}`, { invalid: true });
    }

    // 插入点 = 第 at 行的起始偏移；追加到末尾则用文件末尾。
    let insertAt = li.totalBytes;
    let nextEnding: LineEnding | undefined;
    if (at < li.totalRecords) {
      const p = await probeLine(li, reader, at);
      if (!p.ok) return DataService.editFailure(at, describeProbeFailure(at, p.reason));
      insertAt = p.start;
      nextEnding = p.ending;
    }
    const prev = at > 0 ? await probeLine(li, reader, at - 1) : undefined;
    const refEnding = (prev?.ok ? prev.ending : undefined) ?? nextEnding ?? 'lf';
    // 参考行若位于文件末尾且原本无换行，插入的新行仍须自带行尾（否则会与下一行粘连）。
    const ending: LineEnding = refEnding === 'none' ? 'lf' : refEnding;
    const newLineBytes = Buffer.concat([Buffer.from(text, 'utf8'), lineEndingBytes(ending)]);

    this.editing = true;
    try {
      const res = await replaceRange(
        this.path,
        { start: insertAt, end: insertAt },
        newLineBytes,
        toReplaceOpts(opts)
      );
      await this.commitIndex(li, [{ kind: 'insert', line: at, bytes: newLineBytes.length }]);
      this.badLines.shiftAfterInsert(at);
      this.history.push({ kind: 'insert', line: at, text }, res.bytesDelta);
      return {
        ok: true,
        line: at,
        bytesDelta: res.bytesDelta,
        inPlace: res.inPlace,
        movedBytes: res.movedBytes,
        costMs: Math.round(res.costMs * 100) / 100,
      };
    } catch (e) {
      if (e instanceof WriteCancelledError) {
        return DataService.editFailure(at, e.message, { cancelled: true });
      }
      return DataService.editFailure(at, e instanceof Error ? e.message : String(e));
    } finally {
      this.editing = false;
    }
  }

  /* ------------------------- 查找替换（批量改写） ------------------------- */

  /**
   * 全文查找替换：把每一命中行中的 `query` 字面量替换为 `replacement`，一次性落盘。
   *
   * 流程即正确性：
   *   1. **复用搜索定位命中行** —— 搜索即预览，不另造一套预览机制（用户在工具栏已看到命中数）；
   *   2. **一次顺序扫过命中区间取原文** —— 成本 O(命中区间)，与整体重写同阶，不做逐行随机读；
   *   3. **逐行校验替换后的 JSON** —— 非法则该行跳过（个别行失败不该拖垮整批，但必须如实统计）；
   *   4. **原子重写** —— 写同目录临时文件再 rename，失败时用户拿到的仍是完整旧文件；
   *   5. **索引增量 + 基线快照** —— 行数不变，逐行平移其后检查点即可，无需重建。
   *
   * 查询为空直接拒绝：空串会匹配每一行的每个位置，那不是「替换」而是毁文件。
   * 命中数达到搜索上限（truncated）时同样拒绝 —— 我们无法确认待改行的全集，
   * 在此基础上的「批量替换」是不可控的。
   */
  /** 对外入口：串行化批量文本替换。 */
  async replaceText(
    query: string,
    replacement: string,
    opts: ReplaceOpts = {}
  ): Promise<ReplaceResultPayload> {
    return this.runExclusive(() => this.replaceTextInternal(query, replacement, opts));
  }

  private async replaceTextInternal(
    query: string,
    replacement: string,
    opts: ReplaceOpts = {}
  ): Promise<ReplaceResultPayload> {
    if (!query) return DataService.replaceFailure('查找内容不能为空');

    const li = await this.ensureIndex();
    const reader = this.reader!;

    const conflict = await this.detectWriteConflict(-1, opts.expectedTotalLines);
    if (conflict) {
      return DataService.replaceFailure(conflict.error ?? '文件已被外部修改', { conflict: true });
    }

    // 多行（pretty）文件暂不支持批量文本替换：替换以物理行为单位，会跨记录边界
    // 破坏多行记录的结构。逐条编辑（双击/铅笔）在多行文件下完全可用。
    if (li.multiline) {
      return DataService.replaceFailure(
        '多行（pretty）文件暂不支持批量替换：替换以物理行为单位，会破坏跨行记录的结构。请逐条编辑。'
      );
    }

    // ① 搜索定位（走 host：worker 或主线程兜底）
    const found = await this.search(query, undefined, 'all');
    // 被中断的搜索只知道「扫到哪儿」，此后是否还有命中一无所知 ——
    // 基于它做批量改写就是「漏改一批行却报成功」，宁可拒绝重来。
    if (found.cancelled) {
      return DataService.replaceFailure(
        '查找在扫描完成前被中断，无法确认待改行的全集，已拒绝批量替换；请重试。'
      );
    }
    if (found.truncated) {
      return DataService.replaceFailure(
        `命中行超过 ${SEARCH_MAX_RESULTS} 行，无法确认待改行的全集，已拒绝批量替换；请缩小查找范围。`
      );
    }
    if (found.matches.length === 0) {
      return DataService.replaceOk(0, 0, 0, 0, 0, false);
    }

    // ② 一次顺序扫过命中行区间，取出原文并规划替换
    const hitSet = new Set(found.matches);
    const first = found.matches[0];
    const last = found.matches[found.matches.length - 1];
    const edits: ByteEdit[] = [];
    const deltas: { line: number; delta: number }[] = [];
    const changes: ReplaceChange[] = [];
    let skippedInvalid = 0;
    let unchanged = 0;

    // 替换后含物理换行 = 把一条记录拆成多行，与「JSONL 单行约束」同罪
    //（统计上计入 invalid，与其他非法结果一致，不静默略过）。
    const validate = (t: string): boolean => !/\r|\n/.test(t) && parseJsonLine(t).ok;

    for await (const r of li.scan(reader, first, last + 1)) {
      if (!hitSet.has(r.line)) continue;
      // 超长行（scan 以 error 标记）无法安全取出与改回，计入跳过而非静默略过。
      if (r.error) {
        skippedInvalid++;
        continue;
      }
      const raw = r.bytes.toString('utf8');
      const plan = planLineReplace(raw, query, replacement, {
        caseInsensitive: opts.caseInsensitive,
        validate,
      });
      if (!plan.text) {
        if (plan.skip === 'invalid-json') skippedInvalid++;
        else unchanged++;
        continue;
      }
      // 行尾按磁盘原样保留：替换只动行内容，不擅自把 CRLF 规范化成 LF。
      const ending = detectLineEnding({ start: r.start, end: r.end }, r.bytes.length);
      const next = Buffer.concat([Buffer.from(plan.text, 'utf8'), lineEndingBytes(ending)]);
      edits.push({ start: r.start, end: r.end, replacement: next });
      deltas.push({ line: r.line, delta: next.length - (r.end - r.start) });
      changes.push({ line: r.line, before: raw, after: plan.text });
    }

    const total = found.matches.length;
    if (edits.length === 0) {
      return DataService.replaceOk(0, skippedInvalid, unchanged, total, 0, false);
    }
    return this.applyEdits(li, edits, deltas, changes, total, skippedInvalid, unchanged, opts);
  }

  /**
   * 按行号批量写回指定文本（批量替换的撤销 / 重做走这条路）。
   *
   * 与 `replaceText` 的区别只在「规划」阶段：这里不做查询匹配，直接接受「这些行该是什么」。
   * 撤销必须走批量重写而非逐行 `editRecord` —— 后者是 N 次尾部搬移（成本 Σ(改动点距 EOF)），
   * 撤销一次 5000 行的替换可能要几分钟；批量重写恒为 O(文件大小)。
   */
  async applyLineTexts(
    entries: readonly { line: number; text: string }[],
    opts: ReplaceOpts = {}
  ): Promise<ReplaceResultPayload> {
    const li = await this.ensureIndex();
    const reader = this.reader!;

    // 目标行 → 期望文本（重复行号后者覆盖前者，避免同一区间被规划两次）
    const wanted = new Map<number, string>();
    for (const e of entries) {
      if (Number.isInteger(e.line) && e.line >= 0 && e.line < li.totalRecords) {
        wanted.set(e.line, e.text);
      }
    }
    if (wanted.size === 0) return DataService.replaceFailure('没有可写回的行');

    const conflict = await this.detectWriteConflict(-1, opts.expectedTotalLines);
    if (conflict) {
      return DataService.replaceFailure(conflict.error ?? '文件已被外部修改', { conflict: true });
    }

    const lines = [...wanted.keys()].toSorted((a, b) => a - b);
    const edits: ByteEdit[] = [];
    const deltas: { line: number; delta: number }[] = [];
    const changes: ReplaceChange[] = [];
    let skippedInvalid = 0;
    let unchanged = 0;

    for await (const r of li.scan(reader, lines[0], lines[lines.length - 1] + 1)) {
      const text = wanted.get(r.line);
      if (text === undefined) continue;
      if (r.error) {
        skippedInvalid++;
        continue;
      }
      const raw = r.bytes.toString('utf8');
      if (raw === text) {
        unchanged++;
        continue;
      }
      // 写回的内容同样要过 JSON 校验：撤销的是「曾经合法的内容」，但磁盘可能已被
      // 外部改过，此处不能假设它一定还合法。
      if (!parseJsonLine(text).ok) {
        skippedInvalid++;
        continue;
      }
      const ending = detectLineEnding({ start: r.start, end: r.end }, r.bytes.length);
      const next = Buffer.concat([Buffer.from(text, 'utf8'), lineEndingBytes(ending)]);
      edits.push({ start: r.start, end: r.end, replacement: next });
      deltas.push({ line: r.line, delta: next.length - (r.end - r.start) });
      changes.push({ line: r.line, before: raw, after: text });
    }

    if (edits.length === 0) {
      return DataService.replaceOk(0, skippedInvalid, unchanged, wanted.size, 0, false);
    }
    return this.applyEdits(
      li,
      edits,
      deltas,
      changes,
      wanted.size,
      skippedInvalid,
      unchanged,
      opts
    );
  }

  /**
   * 批量字段级替换（M3 收尾）：把所有行中「指定路径下的值恰好等于 `from`」的字段改成 `to`。
   *
   * 与 `replaceText` 的本质区别：匹配的是**该路径下的值**（结构化语义），而非行内文本。
   * 把每行的 `status: "pending"` 改成 `"done"` 时，正文里恰好含 "pending" 字样的字段
   * 不应被波及 —— 这正是本能力相对整行替换的存在意义。
   *
   * 落盘复用 `applyLineTexts`：冲突检测、批量原子重写、撤销栈都在那里，复制必漂移。
   * 本方法只负责「规划」—— 找出哪些行该变成什么样。规划阶段（全文件逐行定位）是耗时
   * 主体，进度与取消由这里自管；写入阶段的重写进度由 `applyEdits` 继续接管，两种进度
   * 共用同一个 `onProgress` 通道，前端横幅表现为「扫描 → 重写」连续推进。
   */
  /** 对外入口：串行化批量字段级替换。 */
  async replaceField(
    path: readonly (string | number)[],
    from: unknown,
    to: unknown,
    opts: ReplaceOpts = {}
  ): Promise<ReplaceResultPayload> {
    return this.runExclusive(() => this.replaceFieldInternal(path, from, to, opts));
  }

  private async replaceFieldInternal(
    path: readonly (string | number)[],
    from: unknown,
    to: unknown,
    opts: ReplaceOpts = {}
  ): Promise<ReplaceResultPayload> {
    if (!Array.isArray(path) || path.length === 0) {
      return DataService.replaceFailure('字段路径不能为空（改整行请用批量替换）。');
    }
    // from/to 必须是合法 JSON 值。`JSON.stringify(undefined)` 返回 undefined 而**不抛错**，
    // 故 undefined 须显式拒绝 —— 否则一个来自上游 bug 的 undefined 会变成「永远匹配不到」，
    // 用户看到的是一次安静的无操作，而不是一声报错。
    if (from === undefined || to === undefined) {
      return DataService.replaceFailure('匹配值或新值不能为 undefined。');
    }
    try {
      JSON.stringify(from);
      JSON.stringify(to);
    } catch {
      return DataService.replaceFailure('匹配值或新值无法序列化为 JSON。');
    }

    const li = await this.ensureIndex();
    const reader = this.reader!;

    // 多行（pretty）文件暂不支持批量字段替换：按记录聚合替换的写入路径尚未打通。
    // 逐条编辑（双击/铅笔）在多行文件下完全可用。
    if (li.multiline) {
      return DataService.replaceFailure(
        '多行（pretty）文件暂不支持批量字段替换。请逐条编辑（双击字段值或点铅笔）。'
      );
    }

    const conflict = await this.detectWriteConflict(-1, opts.expectedTotalLines);
    if (conflict) {
      return DataService.replaceFailure(conflict.error ?? '文件已被外部修改', { conflict: true });
    }

    const report = throttleProgress(opts.onProgress);
    const entries: { line: number; text: string }[] = [];
    let skippedInvalid = 0;
    let unchanged = 0;
    const total = li.totalRecords;
    const totalBytes = li.totalBytes;

    for await (const r of li.scan(reader, 0, total)) {
      // 进度按字节报（与其它长任务同一分母），节流由 helper 管。
      report?.({ processedBytes: r.end, totalBytes });
      if (opts.shouldCancel?.()) {
        // 扫描是纯读 —— 中止时磁盘未被触碰，与「写入前取消」同等零风险。
        return { ...DataService.replaceFailure('已取消'), cancelled: true };
      }
      // 超长行无法安全取出与改回，计入跳过而非静默略过（与 replaceText 同一口径）。
      if (r.error) {
        skippedInvalid++;
        continue;
      }
      const raw = r.bytes.toString('utf8');
      // scan 本身不做 JSON 校验（r.error 只标记超长行），非法行在这里判定 ——
      // 与 replaceText 的「替换后非法才跳过」不同：本操作的**原文**就必须合法，
      // 否则无法定位字段（也无法保证改完仍是合法 JSONL）。
      if (!parseJsonLine(raw).ok) {
        skippedInvalid++;
        continue;
      }
      const span = locateValue(raw, path);
      if (!span) {
        // 路径在该行不存在：该行本就不在本次改动的目标范围内，计入 unchanged。
        unchanged++;
        continue;
      }
      let current: unknown;
      try {
        current = JSON.parse(raw.slice(span.start, span.end));
      } catch {
        // locateValue 已保证区间是完整合法的 JSON token，此处只是纵深防御。
        skippedInvalid++;
        continue;
      }
      if (!jsonValueEquals(current, from)) {
        unchanged++;
        continue;
      }
      const replaced = replaceValueAtPath(raw, path, to);
      if (!replaced.ok) {
        unchanged++;
        continue;
      }
      entries.push({ line: r.line, text: replaced.text });
    }
    report?.({ processedBytes: totalBytes, totalBytes }); // 终态必发：停在 96% 比没有进度条更糟

    if (entries.length === 0) {
      return DataService.replaceOk(0, skippedInvalid, unchanged, total, 0, false);
    }
    const res = await this.applyLineTexts(entries, opts);
    // 扫描阶段的统计（跳过 / 未匹配）与写入结果合并 —— 缺了任何一半，数字都是错的。
    return res.ok
      ? {
          ...res,
          skippedInvalid: res.skippedInvalid + skippedInvalid,
          unchanged: res.unchanged + unchanged,
          total,
        }
      : res;
  }

  /* ---------------------- 会话编辑历史 ---------------------- */

  /**
   * 写后验证：用**新索引**把被编辑记录（以及紧邻下一条，仅当它编辑前合法）重新读回
   * 并 `parseJsonLine`。返回空串表示通过；否则返回「第 N 行：<原因>」。
   *
   * 之所以要求「读回」而不是相信写入返回值：写入 API 只知道「写了多少字节」，不知道
   * 「落盘的字节是不是我们想写的」—— 磁盘层任何一环（搬移、fsync、并发写）出错，
   * 都只有读回才能发现。
   */
  private async verifyAfterRecordEdit(
    line: number,
    nextRecordWasValid: boolean | undefined
  ): Promise<string> {
    // 调用点在 ensureIndex() 之后，二者必然就绪；类型上仍是可选，故局部断言一次。
    const index = this.index!;
    const reader = this.reader!;
    const targets: number[] = [line];
    if (nextRecordWasValid === true && line + 1 < index.totalRecords) targets.push(line + 1);
    for (const ln of targets) {
      const r = await readRecordAt(ln, index, reader).catch((e: unknown) => ({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      }));
      if (!r.ok) return `第 ${ln + 1} 行：${r.error}`;
    }
    return '';
  }

  /**
   * 结构变更（多行记录编辑等破坏「行数不变」假设的操作）后的索引全量重建。低频重操作。
   *
   * **必须 dispose 旧宿主**：`buildIndexWithFallback` 每次都会新建一个宿主（worker 路径下
   * 就是一根新线程 + 新文件句柄）。此前直接覆写 `this.host`，旧 worker 再也没人 `terminate`
   * —— 多行文件每编辑一条就泄漏一根线程，`activeWorkers` 计数也永不归还，
   * 超过 `MAX_ACTIVE_WORKERS` 后连新文件的宿主都会永久退化到主线程。
   */
  private async rebuildIndex(): Promise<void> {
    await this.releaseFileHandles();
    const prev = this.host;
    this.host = undefined;
    if (prev) await prev.dispose().catch(() => {});
    // 待回填队列随旧宿主一并作废：新宿主的索引本就是按磁盘最新状态构建的，重放只会把它搞坏。
    this.indexOps = [];
    const buildHost = this.opts.hostFactory ?? buildIndexWithFallback;
    const built = await buildHost(this.opts.workerScriptPath, this.path);
    this.host = built.host;
    this.index = built.result.index;
    this.buildStats = built.result.stats;
    this.reader = await openFileReader(this.path);
    this.snapshot = await this.currentSnapshot();
    // 行号已全变：坏行集合与「已全量扫描」结论一并作废。
    this.badLines.reset();
    // 新宿主由本次重建直接产出，索引已是最新；失同步标记随之清零。
    this.hostDirty = false;
  }

  /**
   * 多行记录写坏时的回滚：用当前（重建后）索引重新定位该记录，把 `beforeText`
   * （多行原文）按其尾行尾**原样**写回，再次重建索引。返回空串表示成功。
   */
  private async rollbackRecordEdit(
    line: number,
    beforeText: string,
    tailEnding: LineEnding
  ): Promise<string> {
    try {
      const li = this.index!;
      const rr = li.recordRange(line);
      const replacement = Buffer.concat([
        Buffer.from(beforeText, 'utf8'),
        lineEndingBytes(tailEnding),
      ]);
      await replaceRange(this.path, { start: rr.startOffset, end: rr.endOffset }, replacement, {});
      await this.rebuildIndex();
      return '';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * 编辑写坏时的回滚：用当前（新）索引重新定位该行，把 `beforeText` **原样**写回。
   * 返回空串表示回滚成功；否则返回失败原因。
   *
   * 回滚 delta 恰为本次写入的相反数（`-previousDelta`）—— 行尾在写入与回滚间保持一致，
   * 内容差就是全部差。
   */
  private async rollbackLineEdit(
    line: number,
    beforeText: string,
    ending: LineEnding,
    previousDelta: number
  ): Promise<string> {
    try {
      const index = this.index!;
      const reader = this.reader!;
      let range: { start: number; end: number } | undefined;
      for await (const r of index.scan(reader, line, line + 1)) {
        if (r.error) throw new Error(r.error);
        range = { start: r.start, end: r.end };
        break;
      }
      if (!range) return '定位不到该行';
      await replaceLine(this.path, range, Buffer.from(beforeText, 'utf8'), ending, {});
      await this.commitIndex(index, [{ kind: 'replace', line, delta: -previousDelta }]);
      return '';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /** 历史快照（对外视图，**不含**回退数据 —— 那是宿主内部事务）。 */
  getHistory(): HistoryPayload {
    return this.history.snapshot();
  }

  /** 撤销一步（光标前移）。整体串行：回退本身也是写磁盘。 */
  async undoStep(): Promise<HistoryStepResult> {
    return this.runExclusive(() => this.undoStepInternal());
  }

  private async undoStepInternal(): Promise<HistoryStepResult> {
    if (this.history.cursorPos === 0) {
      return {
        ok: false,
        steps: 0,
        cursor: 0,
        total: this.history.total,
        error: '没有可撤销的操作',
      };
    }
    const entry = this.history.prevEntry();
    // 光标已确认 > 0，理论上必然有条目；仍显式守卫——历史状态一旦被别处改动，
    // 宁可如实报错也不能带着 undefined 去执行回退。
    if (!entry) {
      return {
        ok: false,
        steps: 0,
        cursor: this.history.cursorPos,
        total: this.history.total,
        error: '历史状态已失效，请重新打开后再试',
      };
    }
    const applied = await this.runHistoryOp(entry, false);
    if (!applied.ok) {
      return {
        ok: false,
        steps: 0,
        cursor: this.history.cursorPos,
        total: this.history.total,
        error: applied.error,
      };
    }
    this.history.stepBack();
    return {
      ok: true,
      steps: 1,
      cursor: this.history.cursorPos,
      total: this.history.total,
      label: entry.label,
    };
  }

  /** 重做一步（光标后移）。整体串行。 */
  async redoStep(): Promise<HistoryStepResult> {
    return this.runExclusive(() => this.redoStepInternal());
  }

  private async redoStepInternal(): Promise<HistoryStepResult> {
    if (this.history.cursorPos >= this.history.total) {
      return {
        ok: false,
        steps: 0,
        cursor: this.history.cursorPos,
        total: this.history.total,
        error: '没有可重做的操作',
      };
    }
    const entry = this.history.entryAt(this.history.cursorPos);
    if (!entry) {
      return {
        ok: false,
        steps: 0,
        cursor: this.history.cursorPos,
        total: this.history.total,
        error: '历史状态已失效，请重新打开后再试',
      };
    }
    const applied = await this.runHistoryOp(entry, true);
    if (!applied.ok) {
      return {
        ok: false,
        steps: 0,
        cursor: this.history.cursorPos,
        total: this.history.total,
        error: applied.error,
      };
    }
    this.history.stepForward();
    return {
      ok: true,
      steps: 1,
      cursor: this.history.cursorPos,
      total: this.history.total,
      label: entry.label,
    };
  }

  /**
   * 把光标移到指定位置（历史浮层的「回退到此处」）。
   *
   * **逐条执行**而非「一步到位」：写操作之间有依赖（行号与偏移），跳着回退会让中间
   * 条目的回退数据失效。只能沿着历史一步步走 —— 这正是它们被记成一条链的原因。
   * 中途失败即停，并如实报告已走了几步（不假装全部成功）。
   */
  async setHistoryCursor(target: number): Promise<HistoryStepResult> {
    // 多步回退整体持锁：中途被别的写插入会让「已走到第 k 步」的结论失效。
    return this.runExclusive(() => this.setHistoryCursorInternal(target));
  }

  private async setHistoryCursorInternal(target: number): Promise<HistoryStepResult> {
    const clamped = Math.max(0, Math.min(target, this.history.total));
    const shrinking = clamped < this.history.cursorPos;
    let steps = 0;
    let error: string | undefined;

    // 必须走 Internal：本方法可能已在调用方（revertTo）持有的写锁内，
    // 再取一次锁就是自死锁（表现为请求永不 settle）。
    while (this.history.cursorPos > clamped) {
      const r = await this.undoStepInternal();
      if (!r.ok) {
        error = r.error;
        break;
      }
      steps++;
    }
    while (this.history.cursorPos < clamped) {
      const r = await this.redoStepInternal();
      if (!r.ok) {
        error = r.error;
        break;
      }
      steps++;
    }

    return {
      ok: this.history.cursorPos === clamped,
      steps,
      cursor: this.history.cursorPos,
      total: this.history.total,
      ...(error ? { error: `${error}（已${shrinking ? '撤销' : '重做'} ${steps} 步后中止）` } : {}),
    };
  }

  /**
   * 让某条历史成为**最新已应用**的操作（光标移到它之后）。
   *
   * 语义选「停在这一步」而非「撤销该条本身」：后者会让「点最新那一条」变成一次撤销，
   * 与直觉相反 —— 点最上面那条应该什么都不发生。UI 的文案、按钮禁用态都依赖这个语义，
   * 宿主与前端必须一致（差一步就会「想保留的那步被撤掉」）。
   */
  async revertTo(id: string): Promise<HistoryStepResult> {
    // 跨多步的回退必须整体串行：中途被别的写插入会让「已回退 k 步」的结论失效。
    return this.runExclusive(() => this.revertToInternal(id));
  }

  private async revertToInternal(id: string): Promise<HistoryStepResult> {
    const idx = this.history.indexOfId(id);
    if (idx < 0) {
      return {
        ok: false,
        steps: 0,
        cursor: this.history.cursorPos,
        total: this.history.total,
        error: '该历史记录已不存在（可能因超出上限被丢弃）',
      };
    }
    return this.setHistoryCursorInternal(idx + 1);
  }

  /** 执行一条历史操作的正向或反向；期间 `history.push` 自动失效。 */
  private async runHistoryOp(
    entry: HistoryEntry,
    forward: boolean
  ): Promise<{ ok: boolean; error?: string }> {
    this.history.applying = true;
    try {
      return await this.applyHistoryOp(entry.op, forward);
    } finally {
      this.history.applying = false;
    }
  }

  /** 历史操作的双向执行（正向 = 用户当初的操作，反向 = 回退）。 */
  private async applyHistoryOp(
    op: HistoryOp,
    forward: boolean
  ): Promise<{ ok: boolean; error?: string }> {
    const wrap = (r: { ok: boolean; error?: string }): { ok: boolean; error?: string } =>
      r.ok ? { ok: true } : { ok: false, ...(r.error ? { error: r.error } : {}) };

    switch (op.kind) {
      // 一律调用 **Internal（不加锁）** 版本：本方法已在 undo/redo/revert 持有的写锁内，
      // 再走对外入口会第二次索取同一把锁 —— 那是必然的自死锁。
      case 'edit':
        // 走无单行约束的 internal：op.before/after 是当初磁盘上真实存在过的原文，
        // 多行记录的原样写回必须允许（写后验证与回滚仍在，安全性不受影响）。
        return wrap(await this.editRecordInternal(op.line, forward ? op.after : op.before));
      case 'insert':
        return wrap(
          forward
            ? await this.insertRecordInternal(op.line, op.text)
            : await this.deleteRecordInternal(op.line)
        );
      case 'delete':
        return wrap(
          forward
            ? await this.deleteRecordInternal(op.line)
            : await this.insertRecordInternal(op.line, op.before)
        );
      case 'deleteMany': {
        const lines = op.ranges.flatMap((r) => r.lines);
        return wrap(
          forward
            ? await this.deleteRecordsInternal(lines)
            : await this.insertRangesInternal(op.ranges)
        );
      }
      case 'replaceAll':
        return wrap(
          await this.applyLineTexts(
            op.changes.map((c) => ({ line: c.line, text: forward ? c.after : c.before }))
          )
        );
    }
  }

  /* ------------------------- 多选批量操作（M2） ------------------------- */

  /**
   * 批量删除多行，一次原子落盘。
   *
   * 两个关键设计：
   *   1. **相邻行合并成连续区间** —— 框选一整段连续行是最常见的多选场景，合并后
   *      编辑数从 N 降到 1。这是本功能最有价值的优化（否则「框选 500 行删除」
   *      会变成 500 个区间编辑）。
   *   2. **回传区间（start/end/content）** —— 撤销正是「在同一组 start 处插入 content」。
   *      删除不会改变「删除点之前」的任何偏移，故删除与撤销共用同一组区间，
   *      完全可逆，且撤销同样是**一次原子重写**而非 N 次逐行插入。
   *
   * 索引必须**倒序**应用 `applyLineDelete`：其语义是「在现有索引上删第 line 行」，
   * 倒序才能保证每次的行号都还未被后面的删除影响。
   */
  /** 对外入口：串行化批量删除。 */
  async deleteRecords(
    lines: readonly number[],
    opts: ReplaceOpts = {}
  ): Promise<DeleteManyResultPayload> {
    return this.runExclusive(() => this.deleteRecordsInternal(lines, opts));
  }

  private async deleteRecordsInternal(
    lines: readonly number[],
    opts: ReplaceOpts = {}
  ): Promise<DeleteManyResultPayload> {
    const li = await this.ensureIndex();
    const reader = this.reader!;

    const conflict = await this.detectWriteConflict(-1, opts.expectedTotalLines);
    if (conflict) {
      return DataService.deleteManyFailure(conflict.error ?? '文件已被外部修改', {
        conflict: true,
      });
    }

    const targets = DataService.normalizeLines(lines, li.totalRecords);
    if (targets.length === 0) return DataService.deleteManyFailure('没有可删除的记录');
    if (targets.length > MAX_SELECTION_LINES) {
      return DataService.deleteManyFailure(
        `一次最多删除 ${MAX_SELECTION_LINES} 行，当前选中 ${targets.length} 行。`
      );
    }

    // 记录号 → 物理行集合（多行记录展开为连续行区间；紧凑文件下 == 记录号本身）
    const wantedLines = new Set<number>();
    for (const no of targets) {
      const rr = li.recordRange(no);
      for (let l = rr.startLine; l <= rr.endLine; l++) wantedLines.add(l);
    }
    const firstRecRange = li.recordRange(targets[0]);
    const lastRecRange = li.recordRange(targets[targets.length - 1]);

    // 一次顺序扫过目标区间，取每行的字节范围与原文（含行尾 —— 撤销要原样插回）
    const wanted = wantedLines;
    const rows: { line: number; start: number; end: number; bytes: number; content: string }[] = [];
    let skipped = 0;
    for await (const r of li.scan(reader, firstRecRange.startLine, lastRecRange.endLine + 1)) {
      if (!wanted.has(r.line)) continue;
      // 超长行（scan 以 error 标记）无法安全取出内容：跳过而非删一半。
      if (r.error) {
        skipped++;
        continue;
      }
      const ending = detectLineEnding({ start: r.start, end: r.end }, r.bytes.length);
      const eol = ending === 'crlf' ? '\r\n' : ending === 'lf' ? '\n' : '';
      rows.push({
        line: r.line,
        start: r.start,
        end: r.end,
        bytes: r.end - r.start,
        content: r.bytes.toString('utf8') + eol,
      });
    }
    if (rows.length === 0) return DataService.deleteManyFailure('没有可删除的行（目标行过大）');

    // 合并相邻行为连续区间（每行字节数逐行记录 —— 撤销要精确平移检查点）
    const ranges: DeletedRange[] = [];
    for (const row of rows) {
      const tail = ranges[ranges.length - 1];
      if (tail && tail.lines[tail.lines.length - 1] + 1 === row.line) {
        tail.end = row.end;
        tail.lines.push(row.line);
        tail.lineBytes.push(row.bytes);
        tail.content += row.content;
      } else {
        ranges.push({
          start: row.start,
          end: row.end,
          content: row.content,
          lines: [row.line],
          lineBytes: [row.bytes],
        });
      }
    }

    const edits: ByteEdit[] = ranges.map((r) => ({
      start: r.start,
      end: r.end,
      replacement: Buffer.alloc(0),
    }));

    this.editing = true;
    try {
      const res = await this.rewriteAtomic(edits, opts);
      if (li.multiline) {
        // 多行文件：删除改变行号结构，recordEndLines 无法增量平移 —— 全量重建。
        await this.rebuildIndex();
      } else {
        // 倒序应用索引删除（见方法文档）
        const ops: IndexDeltaOp[] = [];
        for (let i = rows.length - 1; i >= 0; i--) {
          ops.push({ kind: 'delete', line: rows[i].line, bytes: rows[i].end - rows[i].start });
        }
        await this.commitIndex(li, ops);
        this.badLines.remapAfterDeletes(wanted);
      }
      this.history.push({ kind: 'deleteMany', ranges }, res.bytesDelta);

      return {
        ok: true,
        deleted: rows.length,
        ranges: ranges.length,
        bytesDelta: res.bytesDelta,
        costMs: Math.round(res.costMs * 100) / 100,
        skipped,
        changes: ranges,
      };
    } catch (e) {
      if (e instanceof WriteCancelledError) {
        return DataService.deleteManyFailure('已取消', { cancelled: true });
      }
      return DataService.deleteManyFailure(e instanceof Error ? e.message : String(e));
    } finally {
      this.editing = false;
    }
  }

  /**
   * 按字节区间批量插回内容（批量删除的**撤销 / 重做**专用）。
   *
   * 传入的区间来自 `deleteRecords` 回传的 `changes`。之所以能直接复用同一组 `start`：
   * 删除不改变「删除点之前」的任何偏移，故原 `start` 在删除后的文件里仍是有效插入点。
   * 于是撤销与删除完全对称 —— 都是一次原子重写，而不是 N 次逐行插入。
   *
   * 插入行号用 `原首行号 − 在此之前被删的行数` 推出，并**倒序**应用
   * `applyLineInsert`：倒序时后面的插入不会影响前面待处理区间的行号。
   */
  /** 对外入口：串行化区间插回（批量删除的撤销 / 重做）。 */
  async insertRanges(
    ranges: readonly DeletedRange[],
    opts: ReplaceOpts = {}
  ): Promise<DeleteManyResultPayload> {
    return this.runExclusive(() => this.insertRangesInternal(ranges, opts));
  }

  private async insertRangesInternal(
    ranges: readonly DeletedRange[],
    opts: ReplaceOpts = {}
  ): Promise<DeleteManyResultPayload> {
    const li = await this.ensureIndex();

    if (ranges.length === 0) return DataService.deleteManyFailure('没有需要恢复的内容');

    const conflict = await this.detectWriteConflict(-1, opts.expectedTotalLines);
    if (conflict) {
      return DataService.deleteManyFailure(conflict.error ?? '文件已被外部修改', {
        conflict: true,
      });
    }

    const sorted = [...ranges].toSorted((a, b) => a.start - b.start);
    const allLines = sorted.flatMap((r) => r.lines).toSorted((a, b) => a - b);

    const edits: ByteEdit[] = [];
    for (const r of sorted) {
      if (!Number.isInteger(r.start) || r.start < 0 || r.start > li.totalBytes) {
        // 偏移越界说明文件已被别的编辑改动过：宁可拒绝，也不要在错误位置插入。
        return DataService.deleteManyFailure(
          '撤销数据已失效（文件已被其它编辑改动），请重新加载。',
          {
            conflict: true,
          }
        );
      }
      if (r.lines.length === 0 || !r.content) continue;
      edits.push({ start: r.start, end: r.start, replacement: Buffer.from(r.content, 'utf8') });
    }
    if (edits.length === 0) return DataService.deleteManyFailure('没有需要恢复的内容');

    this.editing = true;
    try {
      const res = await this.rewriteAtomic(edits, opts);
      let restored = 0;
      // 恢复的行内容已知合法（原本就在文件里），故从坏行集合中摘除。
      const ops: IndexDeltaOp[] = [];
      // 倒序：先插后面的区间，前面区间的行号推导才不受影响。
      for (let i = sorted.length - 1; i >= 0; i--) {
        const r = sorted[i];
        if (r.lines.length === 0 || !r.content) continue;
        const at = r.lines[0] - countLessThan(allLines, r.lines[0]);
        // 逐行插入并**逐行给出精确字节数** —— 用平均字节平移检查点会错位（见 DeletedRange.lineBytes）。
        for (let k = 0; k < r.lines.length; k++) {
          ops.push({ kind: 'insert', line: at + k, bytes: r.lineBytes[k] ?? 0 });
        }
        restored += r.lines.length;
      }
      await this.commitIndex(li, ops);
      this.badLines.deleteMany(allLines);

      return {
        ok: true,
        deleted: restored,
        ranges: edits.length,
        bytesDelta: res.bytesDelta,
        costMs: Math.round(res.costMs * 100) / 100,
        skipped: 0,
      };
    } catch (e) {
      if (e instanceof WriteCancelledError) {
        return DataService.deleteManyFailure('已取消', { cancelled: true });
      }
      return DataService.deleteManyFailure(e instanceof Error ? e.message : String(e));
    } finally {
      this.editing = false;
    }
  }

  /** 释放句柄 → 原子重写 → 拿回句柄（批量删除与批量重写共用同一时序）。 */
  private async rewriteAtomic(
    edits: ByteEdit[],
    opts: ReplaceOpts
  ): Promise<{ bytesDelta: number; costMs: number }> {
    await this.releaseFileHandles();
    try {
      const res = await rewriteWithEdits(this.path, edits, {
        onProgress: throttleProgress(opts.onProgress),
        ...(opts.shouldCancel ? { shouldCancel: opts.shouldCancel } : {}),
      });
      return { bytesDelta: res.bytesDelta, costMs: res.costMs };
    } finally {
      // 无论成败都必须把句柄拿回来，否则后续所有读取都会失败。
      await this.acquireFileHandles();
    }
  }

  /** 归一化行号：去重、滤越界、升序（宿主对前端的最后一道防线）。 */
  private static normalizeLines(lines: readonly number[], totalLines: number): number[] {
    const seen = new Set<number>();
    for (const l of lines) {
      if (Number.isInteger(l) && l >= 0 && l < totalLines) seen.add(l);
    }
    return [...seen].toSorted((a, b) => a - b);
  }

  private static deleteManyFailure(
    error: string,
    extra?: Partial<DeleteManyResultPayload>
  ): DeleteManyResultPayload {
    return {
      ok: false,
      deleted: 0,
      ranges: 0,
      bytesDelta: 0,
      costMs: 0,
      skipped: 0,
      error,
      ...extra,
    };
  }

  /**
   * 把选定记录**另存为新文件**。
   *
   * 与所有编辑端点的三条硬区别（写进代码而不是只写进文档）：
   *   1. **不进写链**（`runExclusive`）——它不碰源文件，排队毫无意义；
   *   2. **不进撤销历史** —— 用户不该以为 Ctrl+Z 能「撤回导出」；
   *   3. **拒绝目标 = 源路径** —— 那是覆写原数据，属于编辑能力，不该从导出入口进来。
   *
   * @param targetPath 由宿主侧保存对话框选定的绝对路径。
   */
  async exportLines(
    lines: readonly number[],
    targetPath: string,
    opts: ExportOpts = {}
  ): Promise<ExportResultPayload> {
    const fail = (error: string): ExportResultPayload => ({
      ok: false,
      count: 0,
      bytes: 0,
      skipped: 0,
      error,
    });
    if (typeof targetPath !== 'string' || targetPath.trim() === '') {
      return fail('未指定导出目标路径');
    }
    if (DataService.isSamePath(this.path, targetPath)) {
      return fail('导出目标不能是当前文件本身（那会覆盖原数据）；请另选一个文件名。');
    }

    const li = await this.ensureIndex();
    const targets = DataService.normalizeLines(lines, li.totalRecords);
    if (targets.length === 0) return fail('没有可导出的记录');
    if (targets.length > MAX_EXPORT_LINES) {
      return fail(`一次最多导出 ${MAX_EXPORT_LINES} 条记录，当前 ${targets.length} 条。`);
    }

    const onProgress = throttleProgress(opts.onProgress);
    try {
      const res = await exportLinesToFile(li, this.reader!, targets, targetPath, {
        ...(onProgress ? { onProgress } : {}),
        ...(opts.shouldCancel ? { shouldCancel: opts.shouldCancel } : {}),
      });
      if (res.cancelled) {
        // 取消：目标文件**从未被创建**（临时文件已清理）——与失败严格分开报。
        return { ok: false, count: 0, bytes: 0, skipped: 0, cancelled: true };
      }
      if (res.count === 0) {
        return fail(
          res.skipped > 0
            ? `${res.skipped} 条记录过大、无法取出原文，未写出任何内容（目标文件未创建）。`
            : '没有可导出的内容'
        );
      }
      return {
        ok: true,
        count: res.count,
        bytes: res.bytes,
        skipped: res.skipped,
        targetPath,
      };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  /** 两个路径是否指向同一文件（Windows 大小写不敏感；比较前统一分隔符）。 */
  private static isSamePath(a: string, b: string): boolean {
    const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const [x, y] = [norm(a), norm(b)];
    return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
  }

  /**
   * 读取多行的**磁盘原文**并拼接，供批量复制。
   *
   * 与列表摘要不同：这里要的是可直接粘贴的原始文本，故走一次顺序 scan 取原文，
   * 不做 JSON 解析、不重排、不改行尾。超过 `COPY_MAX_BYTES` 时截断并标记 ——
   * 静默截断会让用户以为复制全了，粘出来的东西却不完整。
   *
   * 返回体额外带 `text`（正文很可能是 MB 级，不宜再经 RPC 回传一遍；
   * 调用方取其写剪贴板后，回执里不带正文）。
   */
  async readLinesText(
    lines: readonly number[]
  ): Promise<CopyLinesResultPayload & { text: string }> {
    const li = await this.ensureIndex();
    const reader = this.reader!;
    const empty = (error: string): CopyLinesResultPayload & { text: string } => ({
      ok: false,
      count: 0,
      bytes: 0,
      truncated: false,
      skipped: 0,
      error,
      text: '',
    });

    const targets = DataService.normalizeLines(lines, li.totalRecords);
    if (targets.length === 0) return empty('没有可复制的记录');
    if (targets.length > MAX_SELECTION_LINES) {
      return empty(`一次最多复制 ${MAX_SELECTION_LINES} 行，当前选中 ${targets.length} 行。`);
    }

    // 记录号 → 物理行集合（多行记录展开为连续行区间，复制得到完整的多行原文）
    const wantedLines = new Set<number>();
    for (const no of targets) {
      const rr = li.recordRange(no);
      for (let l = rr.startLine; l <= rr.endLine; l++) wantedLines.add(l);
    }
    const firstCopyRange = li.recordRange(targets[0]);
    const lastCopyRange = li.recordRange(targets[targets.length - 1]);

    const wanted = wantedLines;
    const parts: string[] = [];
    let bytes = 0;
    let skipped = 0;
    let truncated = false;

    for await (const r of li.scan(reader, firstCopyRange.startLine, lastCopyRange.endLine + 1)) {
      if (!wanted.has(r.line)) continue;
      if (r.error) {
        skipped++;
        continue;
      }
      const rawBytes = r.end - r.start;
      if (bytes + rawBytes > COPY_MAX_BYTES) {
        truncated = true;
        break;
      }
      const ending = detectLineEnding({ start: r.start, end: r.end }, r.bytes.length);
      const eol = ending === 'crlf' ? '\r\n' : ending === 'lf' ? '\n' : '';
      parts.push(r.bytes.toString('utf8') + eol);
      bytes += rawBytes;
    }

    return { ok: true, count: parts.length, bytes, truncated, skipped, text: parts.join('') };
  }

  /**
   * 把规划好的编辑一次落盘，并同步索引与基线快照。
   *
   * 这是批量改写的**唯一落盘路径**：查找替换、撤销、重做都走它，避免各写一份
   * 「释放句柄 → 原子重写 → 拿回句柄 → 更新索引 → 刷新基线」的时序（那是最易漏步的地方）。
   */
  private async applyEdits(
    li: LineIndex,
    edits: ByteEdit[],
    deltas: { line: number; delta: number }[],
    changes: ReplaceChange[],
    total: number,
    skippedInvalid: number,
    unchanged: number,
    opts: ReplaceOpts
  ): Promise<ReplaceResultPayload> {
    this.editing = true;
    try {
      const res = await this.rewriteAtomic(edits, opts);
      // 索引增量更新：行数不变，逐行平移其后检查点（op 顺序自身无关，但与多种 op 混合时相关）
      // 一次批量 op 走同一条路 —— 宿主侧会用同一函数、同一顺序应用，两侧不会漂移。
      await this.commitIndex(
        li,
        deltas.map<IndexDeltaOp>((d) => ({ kind: 'replace', line: d.line, delta: d.delta }))
      );
      this.badLines.deleteMany(deltas.map((d) => d.line));

      const undoBytes = changes.reduce((a, c) => a + c.before.length + c.after.length, 0);
      const undoable =
        changes.length <= MAX_REPLACE_UNDO_LINES && undoBytes <= MAX_REPLACE_UNDO_BYTES;

      // 注：本方法也被 applyLineTexts 调用（历史回退的原语），那时的 `history.applying`
      // 为真，history.push 会自动跳过 —— 否则每撤销一次就会生成一条新记录。
      this.history.push({ kind: 'replaceAll', changes }, res.bytesDelta);

      return {
        ok: true,
        replaced: edits.length,
        skippedInvalid,
        unchanged,
        total,
        bytesDelta: res.bytesDelta,
        costMs: Math.round(res.costMs * 100) / 100,
        changes: undoable ? changes : undefined,
        undoable,
      };
    } catch (e) {
      // 取消与失败必须分开报：批量重写在 rename 之前中止是**零风险**的，
      // 把它报成「失败」会让用户以为文件可能损坏 —— 那与事实相反。
      if (e instanceof WriteCancelledError) {
        return { ...DataService.replaceFailure('已取消'), cancelled: true };
      }
      return DataService.replaceFailure(e instanceof Error ? e.message : String(e));
    } finally {
      this.editing = false;
    }
  }

  /**
   * 重写文件前释放**两侧**的文件句柄。
   *
   * 主线程 reader 与索引宿主的 reader 都要松手：Windows 下 rename 覆盖一个仍被打开的
   * 文件会 EPERM（worker 是独立线程但同进程，句柄一样拦人）。
   */
  private async releaseFileHandles(): Promise<void> {
    const r = this.reader;
    this.reader = undefined;
    if (r?.close) await r.close().catch(() => {});
    await this.host?.releaseFile().catch(() => {});
  }

  /** 重新获取文件句柄 —— 与 releaseFileHandles 严格配对（放在 finally 里）。 */
  private async acquireFileHandles(): Promise<void> {
    if (!this.reader) {
      try {
        this.reader = await openFileReader(this.path);
      } catch {
        // 拿不回来就只能让后续读取显式报错，不在此处遮蔽真实原因。
      }
    }
    await this.host?.reacquireFile(this.path).catch(() => {});
  }

  /** 查找替换的失败回执（统一填充字段，避免多处重复）。 */
  private static replaceFailure(
    error: string,
    extra?: Partial<ReplaceResultPayload>
  ): ReplaceResultPayload {
    return {
      ok: false,
      replaced: 0,
      skippedInvalid: 0,
      unchanged: 0,
      total: 0,
      bytesDelta: 0,
      costMs: 0,
      undoable: false,
      error,
      ...extra,
    };
  }

  private static replaceOk(
    replaced: number,
    skippedInvalid: number,
    unchanged: number,
    total: number,
    bytesDelta: number,
    undoable: boolean
  ): ReplaceResultPayload {
    return {
      ok: true,
      replaced,
      skippedInvalid,
      unchanged,
      total,
      bytesDelta,
      costMs: 0,
      undoable,
    };
  }

  /** 抽样前 N 行推断字段（只扫前 sampleLines/count 行，绝不全文件）。 */
  async getSampleFields(count?: number): Promise<SampleFieldsPayload> {
    const li = await this.ensureIndex();
    const reader = this.reader!;
    const n = count ?? this.opts.sampleLines ?? SAMPLE_SCAN_LINES;
    const res = await inferFields(reader, li, { sampleLines: n });
    this.badLines.addMany(res.errorLines);
    return { fields: res.fields, total: res.total, scanned: res.scanned };
  }

  /* ------------------------- 坏行诊断（M3 收尾） ------------------------- */

  /**
   * 读取「已发现」的坏行集合。
   *
   * 该集合只覆盖宿主**已检查过**的范围（用户读过的行 + 抽样行 + 上次扫描结果），
   * 故未完成全量扫描时 `partial` 恒为 true —— 前端据此决定文案，绝不把它说成
   * 「文件共有 N 个坏行」。把它当全量用在数据清洗里会得出相反结论（「文件挺干净」）。
   */
  getBadLines(): BadLinesPayload {
    const all = this.badLines.toSortedArray();
    const truncated = all.length > MAX_BAD_LINES;
    return {
      lines: truncated ? all.slice(0, MAX_BAD_LINES) : all,
      partial: !this.badLines.isComplete,
      // 未做过范围扫描时无「已扫描行数」可言，填 0（与 partial=true 一致）。
      scanned: this.badLines.isComplete ? (this.index?.totalRecords ?? 0) : 0,
      totalLines: this.index?.totalLines ?? 0,
      truncated,
      costMs: 0,
    };
  }

  /**
   * 全文件扫描坏行（流式、可取消、带进度）。
   *
   * 为何需要：已发现的坏行集合只覆盖已检查范围，据它判断「文件干净与否」是危险误判；
   * 而数据清洗的第一步恰恰是「这文件到底有多少坏行、都在哪」。
   *
   * 判定口径**必须与列表红标完全一致**，否则会出现「列表说好、扫描说坏」这种
   * 最难解释的不一致：超长行按 `isOversized` 视作合法（列表同样不解析它），
   * 只有 scan 的 `error`（触到 maxLineBytes）与 JSON 解析失败才算坏行。
   *
   * 位置选择：与 `getSampleFields` 一样在主线程做（只读流式扫描，逐行 await 让出
   * 事件循环，webview 在独立进程不受影响）。未下沉 worker 是因为那要扩 worker
   * 协议，而扫描是低频的显式用户动作；若日后成为瓶颈，可平移至 `IndexHost`
   * （接口形状已与 search/filter 一致）。
   */
  async scanBadLines(opts: ScanBadLinesOpts = {}): Promise<BadLinesPayload> {
    const li = await this.ensureIndex();
    const reader = this.reader!;
    const started = performance.now();
    const totalBytes = li.totalBytes;
    const lines: number[] = [];
    let scanned = 0;
    let truncated = false;
    let processedBytes = 0;
    let lastTick = 0;

    // 记录分组聚合扫描：多行（pretty）文件里一条记录跨多个物理行，
    // 必须整体 parse —— 裸扫物理行会把 pretty 的中间行全部误判为坏行。
    for await (const rec of scanRecords(0, li.totalRecords, li, reader, {
      shouldCancel: opts.shouldCancel,
    })) {
      if (opts.shouldCancel?.()) {
        // 取消即**不**替换已发现集合：半份结果看起来像「文件很干净」，比没有结果更糟。
        return {
          lines: [],
          partial: true,
          scanned,
          totalLines: li.totalLines,
          truncated: false,
          cancelled: true,
          costMs: Math.round(performance.now() - started),
        };
      }
      scanned++;
      processedBytes = rec.endOffset; // 绝对偏移（含行尾），终态恰为 totalBytes

      // 进度按字节节流；**终态必发**（停在 96% 的进度条比没有进度条更糟）。
      const now = performance.now();
      if (scanned >= li.totalRecords || now - lastTick >= PROGRESS_THROTTLE_MS) {
        lastTick = now;
        opts.onProgress?.({ processedBytes, totalBytes });
      }

      const bad = isOversized(rec.buf.length)
        ? false // 与列表口径一致：超大记录不解析，视作合法
        : !parseJsonLine(rec.text).ok;
      if (!bad) continue;

      // 超上限后只标记不记录 —— 载荷与前端 DOM 都不该随坏记录数无界增长。
      if (lines.length >= MAX_BAD_LINES) truncated = true;
      else lines.push(rec.recordNo);
    }

    // 扫描成功即权威全量，**整体替换**而非合并：合并会让「已被改好的行」永远留在列表里。
    this.badLines.replaceAll(lines);

    return {
      lines,
      partial: false,
      scanned,
      totalLines: li.totalLines,
      truncated,
      costMs: Math.round(performance.now() - started),
    };
  }

  /**
   * Task 6 全文/字段搜索：委托 IndexHost（worker 或主线程）流式顺序扫描匹配行。
   * - 全文搜索不做 JSON.parse（纯文本匹配，大文件成本可控）；
   * - 字段限定搜索才对行做单行解析取值。
   * scope 为字符串（'all' 默认；未来可扩展为区间），未识别当作全范围。
   */
  async search(
    query: string,
    field?: string,
    scope?: string,
    shouldCancel?: () => boolean
  ): Promise<SearchLinesResult> {
    await this.ensureIndex();
    // 宿主索引必须与磁盘同源：正常情况下编辑会增量回填，只有回填失败才会走到重建。
    await this.ensureFreshHost();
    const range =
      scope && /^\d+:\d+$/.test(scope)
        ? { startLine: Number(scope.split(':')[0]), endLine: Number(scope.split(':')[1]) }
        : undefined;
    const key = this.queryCacheKey('s', `${query}\u0000${field ?? ''}\u0000${scope ?? ''}`);
    const hit = this.queryCache.get(key);
    if (hit) return cloneSearchResult(hit as SearchLinesResult);
    const res = await this.host!.search(query, field, range, SEARCH_MAX_RESULTS, shouldCancel);
    // 残缺结果不缓存：被取消 / 超限截断的都是半份答案，缓存下来会让用户
    // 「再搜一次」依旧拿到不完整的结论，还以为这就是全部。
    // 注意 `cancelled` 必须与 `truncated` 一样排除在外 —— 前者甚至是「没扫完」，
    // 连「结果是可信子集」都不成立（例如某段区间压根没查）。
    if (!res.truncated && !res.cancelled) this.rememberQuery(key, res);
    return res;
  }

  /** Task 6 字段值过滤：委托 IndexHost 对流解析并评估，返回匹配行号（结果行号数组有上限）。 */
  async filter(cond: Condition | null, shouldCancel?: () => boolean): Promise<FilterLinesResult> {
    await this.ensureIndex();
    await this.ensureFreshHost();
    const key = this.queryCacheKey('f', JSON.stringify(cond ?? null));
    const hit = this.queryCache.get(key);
    if (hit) return cloneFilterResult(hit as FilterLinesResult);
    const res = await this.host!.filter(cond, FILTER_MAX_RESULTS, shouldCancel);
    if (!res.truncated && !res.cancelled) this.rememberQuery(key, res);
    return res;
  }

  /**
   * 全量 Schema / 数据质量画像（F4）。
   *
   * 与 `getSampleFields`（抽样前 200 条）是**互补**关系，不是替代：抽样求快、在打开路径上；
   * 画像求准、由用户显式触发。所以这里不做任何缓存 —— 每次都真扫，
   * 缓存一份「可能已过期」的全量结论比不缓存更危险（用户会据此判断数据质量）。
   */
  async scanProfile(
    opts: {
      onProgress?: (info: { processedBytes: number; totalBytes: number }) => void;
      shouldCancel?: () => boolean;
    } = {}
  ): Promise<ProfileResult> {
    const li = await this.ensureIndex();
    const onProgress = throttleProgress(opts.onProgress);
    return profileRecords(this.reader!, li, {
      ...(onProgress ? { onProgress } : {}),
      ...(opts.shouldCancel ? { shouldCancel: opts.shouldCancel } : {}),
    });
  }

  /**
   * 检测中断编辑遗留的备份（O8）。**只报告，不自动恢复**。
   *
   * 为何不自动恢复：备份可能属于另一个会话，或已被后续的外部写入覆盖 ——
   * 自动拿它盖回文件是拿用户的数据赌一个猜测。这里保持「告知 + 显式授权」，
   * 与本项目对破坏性操作的一贯态度一致。
   */
  async inspectBackup(): Promise<OrphanBackup | null> {
    return inspectOrphanBackup(this.path);
  }

  /**
   * 处理遗留备份：恢复或丢弃。
   *
   * 恢复会**改写源文件**，因此走写链（`runExclusive`）—— 与编辑互斥；
   * 恢复完成后必须重扫索引（磁盘内容已不是当前索引描述的那份），但**不在这里做**：
   * 刷新由调用方（前端拿到结果后触发 reload）驱动，避免「恢复内部又重扫」把
   * 一次用户动作变成两条并行的重建路径。
   */
  async resolveBackup(
    action: 'restore' | 'discard'
  ): Promise<{ ok: boolean; restoredBytes?: number; error?: string }> {
    if (action === 'discard') {
      await discardOrphanBackup(this.path);
      return { ok: true };
    }
    return this.runExclusive(async () => {
      const res = await restoreOrphanBackup(this.path);
      if (res.ok) {
        // 文件已被改回旧内容：基线与索引描述的都作废，标记为需重建，
        // 让下一次查询/读取拿到的是新现状（而不是按旧偏移读到的错行）。
        await this.refreshSnapshot();
        this.hostDirty = true;
      }
      return res;
    });
  }

  /**
   * 重建索引（文件被检测到变更后由 webview 点「重新加载」触发）。
   * 释放旧句柄/索引并重新构建；返回重建后的概览。
   */
  async reload(): Promise<OverviewPayload> {
    await this.dispose();
    const li = await this.ensureIndex();
    return {
      uri: this.uri,
      protocolVersion: PROTOCOL_VERSION,
      totalLines: li.totalLines,
      totalRecords: li.totalRecords,
      totalBytes: li.totalBytes,
      buildMs: this.buildStats?.buildMs ?? li.buildMs,
      eof: this.buildStats?.eof ?? li.eof,
    };
  }

  get totalLines(): number {
    return this.index?.totalLines ?? 0;
  }

  /** 逻辑记录总数（紧凑文件==行数；pretty 文件按记录分组）。 */
  get totalRecords(): number {
    return this.index?.totalRecords ?? 0;
  }

  /** 返回当前索引（尚未构建则 undefined），用于惰性进度/概要栏。 */
  peekIndex(): LineIndex | undefined {
    return this.index;
  }

  async dispose(): Promise<void> {
    // 递增代际，使在途索引构建失效（其检测代际变化后丢弃结果，不写回成员）。
    this.generation++;
    const building = this.building;
    this.building = undefined;
    if (building) {
      // 等待在途构建结束，避免其自开文件句柄在完成后无人关闭。
      await building.catch(() => {});
    }
    if (this.reader && this.reader.close) {
      await this.reader.close().catch(() => {});
    }
    // 释放索引宿主（worker 则终止 worker，主线程则关 reader）。
    if (this.host) await this.host.dispose().catch(() => {});
    this.reader = undefined;
    this.index = undefined;
    this.host = undefined;
    this.buildStats = undefined;
    this.snapshot = undefined;
    this.badLines.reset();
    // 未回填的增量与失同步标记一并清零：宿主已不存在，下次 ensureIndex 会拿到全新索引。
    this.indexOps = [];
    this.hostDirty = false;
    // 会话编辑历史必须一并作废：行号与偏移在重载后已整体失效，用旧历史回退
    // 会**改到错误的行**上 —— 这比「不能撤销」危险得多。
    this.history.clear();
  }
}
