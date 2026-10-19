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
import { LineIndex, applyIndexOps, tailAppendOp, type IndexDeltaOp } from '../indexer/lineIndex.ts';
import type { ByteReader } from '../parser/types.ts';
import type { ReadRecordOpts } from '../parser/jsonParser.ts';
import {
  openFileReader,
  parseJsonLine,
  readRecord as readRecordAt,
  scanRecords,
} from '../parser/jsonParser.ts';
import { inferFields } from '../infer/inferFields.ts';
import { detectLineEnding, rewriteWithEdits } from './fileWriter.ts';
import type { ByteEdit } from './fileWriter.ts';
import type { Condition } from '../core/query.ts';
import type { FilterLinesResult, SearchLinesResult } from './searchEngine.ts';
import {
  SAMPLE_SCAN_LINES,
  RECORDS_MAX_COUNT,
  SEARCH_MAX_RESULTS,
  FILTER_MAX_RESULTS,
  MAX_SELECTION_LINES,
  COPY_MAX_BYTES,
  MAX_BAD_LINES,
  PROGRESS_THROTTLE_MS,
  QUERY_CACHE_MAX,
  MAX_EXPORT_LINES,
  TAIL_APPEND_MAX_BYTES,
  TAIL_ANCHOR_BYTES,
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
import type { HistoryStepResult } from './editHistory.ts';
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

import {
  throttleProgress,
  cloneSearchResult,
  cloneFilterResult,
  eolText,
  expandRecordLines,
  normalizeLines,
  type EditRecordOpts,
} from './dataServiceHelpers.ts';
import { BadLineTracker } from './badLineTracker.ts';
import {
  deleteRecordInternal,
  editRecordChecked,
  insertRecordInternal,
  validateInsertText,
} from './recordWriter.ts';
import { applyLineTexts, replaceFieldInternal, replaceTextInternal } from './textReplacer.ts';
import { deleteRecordsInternal, insertRangesInternal } from './rangeWriter.ts';
import {
  redoStepInternal,
  revertToInternal,
  setHistoryCursorInternal,
  undoStepInternal,
} from './historyReplay.ts';
import { editFailure } from './writeSupport.ts';
import type { ReplaceOpts, WriteContext } from './writeSupport.ts';

// ReplaceOpts 的定义随写路径拆分移到 writeSupport.ts；此处重新导出以保持对外 API 不变。
export type { ReplaceOpts } from './writeSupport.ts';

/** 检测文件是否已变更（size/mtime）的最小快照。 */
export interface FileSnapshot {
  size: number;
  mtimeMs: number;
}

/** 文件变更检测结果。null 表示索引尚未构建、无法判断。 */
export type StaleCheckResult =
  { changed: false } | { changed: true; deleted: boolean; message: string } | null;

/** 一次成功追尾的结果（供扩展层推给 webview 刷新总行数）。 */
export interface TailAppendedInfo {
  totalLines: number;
  totalRecords: number;
  totalBytes: number;
}

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
   * 追尾指纹：吸收点之前 `TAIL_ANCHOR_BYTES` 字节的副本（连同追尾点 offset 一起保存）。
   *
   * 下一轮追尾前先读当前文件的同区间与之比对 —— 文件若被整体替换（日志轮转 / 截断后
   * 重写），size 同样会变大，只看 size/mtime 分不出来；内容不一致即拒绝追尾。
   */
  private tailAnchor: { offset: number; bytes: Buffer } | undefined;

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

  /**
   * 写路径（recordWriter / textReplacer / rangeWriter / historyReplay）看到的受控视图。
   *
   * 写路径只能经它访问索引与句柄、提交索引变更 —— 不能直接碰 `this.index`，
   * 「索引只能经 `commitIndex` 变更」这条不变量因此仍由本类独家守护。
   * 每个访问器都是**现取**（`rebuildIndex` / `rewriteAtomic` 会替换索引与句柄）。
   */
  private readonly write: WriteContext;

  // 注意：不用参数属性语法（Node 类型擦除运行 TS 单测时不支持）。
  constructor(uri: string, path: string, opts: DataServiceOptions = {}) {
    this.uri = uri;
    this.path = path;
    this.opts = opts;
    this.write = {
      path,
      history: this.history,
      badLines: this.badLines,
      ensureIndex: () => this.ensureIndex(),
      index: () => this.index!,
      reader: () => this.reader!,
      commitIndex: (li, ops) => this.commitIndex(li, ops),
      rebuildIndex: () => this.rebuildIndex(),
      detectWriteConflict: (line, expected) => this.detectWriteConflict(line, expected),
      rewriteAtomic: (edits, replaceOpts) => this.rewriteAtomic(edits, replaceOpts),
      withEditing: async (body) => {
        this.editing = true;
        try {
          return await body();
        } finally {
          this.editing = false;
        }
      },
      search: (query, field, scope) => this.search(query, field, scope),
    };
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
          // 追尾指纹同步建立：否则首次追尾必然空转一个轮询周期。
          await this.refreshTailAnchor(index);
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
      // 文件不存在或无权限访问时返回 undefined（预期行为）
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

  /**
   * 追尾增量（F6 最小版）：文件**只在尾部增长**时，把新增的完整行并入索引，
   * 免去 GB 级文件的整量重扫。返回 null 表示本次没有跟进 —— 调用方应继续走
   * 既有的走样判定（横幅提示重新加载），而不是自行重试。
   *
   * 为何拒绝时不自动重建：重建是 O(文件大小) 的重 IO（GB 级数十秒），放在 5s 轮询
   * 回调里会把后台轮询变成周期性卡顿；横幅让用户自己决定时机。
   *
   * 各道闸门（任一不满足即静默放弃，交给横幅）：
   * - 编辑进行中 / 有未回填的写增量：文件正被本进程改写，尾部读到的是半成品；
   * - size 未增长：无追尾可言（缩小 / 持平交给走样判定）；
   * - 索引前提：`eof`、紧凑（`!multiline`）、吸收点落在换行上（`endsWithNewline`）；
   * - 指纹一致：吸收点之前 256 字节与上次记录相同（防「size 变大但其实被整体替换」）；
   * - 新增量有界（≤ `TAIL_APPEND_MAX_BYTES`，超限说明不是「缓缓追加」的场景）；
   * - `appendTail` 接受：新增字节里没有空行 / 跨行结构 / 未闭合记录（详见该方法）。
   */
  async tryTailAppend(): Promise<TailAppendedInfo | null> {
    if (this.editing) return null;
    if (this.indexOps.length > 0) return null;
    const li = await this.ensureIndex();
    const cur = await this.currentSnapshot();
    if (!cur || cur.size <= li.totalBytes) return null;
    if (!li.eof || li.multiline || !li.endsWithNewline) return null;
    if (cur.size - li.totalBytes > TAIL_APPEND_MAX_BYTES) return null;

    // 指纹：锚点缺失（不该发生 —— 构建索引时已建立）或与当前吸收点不齐时重建、本次放弃。
    if (this.tailAnchor?.offset !== li.totalBytes) {
      await this.refreshTailAnchor(li);
      return null;
    }
    // 指纹：读当前文件吸收点之前的同区间，与锚点比对 —— 不一致说明文件被整体改写过。
    const anchorStart = Math.max(0, li.totalBytes - TAIL_ANCHOR_BYTES);
    const probe = await this.reader!.readBytes(anchorStart, li.totalBytes - anchorStart);
    if (!probe.equals(this.tailAnchor.bytes)) return null;

    const tail = await this.reader!.readBytes(li.totalBytes, cur.size - li.totalBytes);
    const res = li.appendTail(tail);
    if (!res.ok || res.consumedBytes === 0) return null;

    const next = res.index;
    this.index = next;
    // 与 O1 同一通道：把这次追尾描述成 op 回填给索引宿主（worker 与主线程共用同一解释）。
    this.indexOps.push(tailAppendOp(li, next));
    // 与写路径同一收口点：刷新基线快照（否则下一轮会弹「文件已更改」）、
    // 作废坏行结论与查询缓存、回填宿主索引 —— 一个都不能少。
    await this.refreshSnapshot();
    // 新吸收点之前的内容刚核对过，就地刷新指纹供下一轮比对。
    await this.refreshTailAnchor(next);
    return {
      totalLines: next.totalLines,
      totalRecords: next.totalRecords,
      totalBytes: next.totalBytes,
    };
  }

  /**
   * 刷新追尾指纹：记录「吸收点之前 `TAIL_ANCHOR_BYTES` 字节」的副本。
   *
   * 建索引 / 重建 / 追尾后都必须调用 —— 追尾首轮即可用，取决于构建时就有了锚点；
   * 拖到追尾流程里才建，等于让用户白等一个轮询周期（实测踩过）。
   */
  private async refreshTailAnchor(li: LineIndex): Promise<void> {
    if (!this.reader || li.totalBytes === 0) {
      this.tailAnchor = undefined;
      return;
    }
    const from = Math.max(0, li.totalBytes - TAIL_ANCHOR_BYTES);
    this.tailAnchor = {
      offset: li.totalBytes,
      bytes: await this.reader.readBytes(from, li.totalBytes - from),
    };
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

  /**
   * 就地替换第 `line` 条逻辑记录（紧凑文件下即第 `line` 行）。
   *
   * 对外入口：串行化后进入带校验的实现（校验同样在锁内，避免校验与写入之间被插队）。
   * 冲突检测、乐观锁、写盘、写后验证与回滚的完整流程见 recordWriter.ts。
   */
  async editRecord(
    line: number,
    text: string,
    expectedBytes?: number,
    opts: EditRecordOpts = {}
  ): Promise<EditResultPayload> {
    return this.runExclusive(() => editRecordChecked(this.write, line, text, expectedBytes, opts));
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
        return editFailure(
          line,
          `当前视图已过期（你看到的 ${expectedTotalLines} 行，磁盘上已是 ${actual} 行），` +
            `为避免改错行，已拒绝本次操作；请重新加载后再试。`,
          { conflict: true }
        );
      }
    }

    // ② 宿主基线（拦外部程序改动）
    const before = await this.currentSnapshot();
    if (!before) return editFailure(line, '文件不存在或无法访问', { conflict: true });
    if (
      this.snapshot &&
      (before.size !== this.snapshot.size || before.mtimeMs !== this.snapshot.mtimeMs)
    ) {
      return editFailure(line, '文件已被外部修改，请先重新加载再编辑。', {
        conflict: true,
      });
    }
    return undefined;
  }

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
      // 索引更新失败时标记为 dirty，下次查询会触发重建
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

  /** 删除第 `line` 条记录（对外入口：串行化；实现见 recordWriter.ts）。 */
  async deleteRecord(line: number, opts: EditRecordOpts = {}): Promise<EditResultPayload> {
    return this.runExclusive(() => deleteRecordInternal(this.write, line, opts));
  }

  /**
   * 在第 `at` 条记录之前插入一行（`at === totalRecords` 表示追加）。
   *
   * 对外入口：单行与 JSON 约束只在这一层、且在取锁**之前**校验；历史重放（撤销「删除」）
   * 走无校验的内部实现，才能把多行 / 当年就是坏记录的原文原样插回。
   */
  async insertRecord(
    at: number,
    text: string,
    opts: EditRecordOpts = {}
  ): Promise<EditResultPayload> {
    const invalid = validateInsertText(at, text);
    if (invalid) return invalid;
    return this.runExclusive(() => insertRecordInternal(this.write, at, text, opts));
  }

  /** 全文查找替换（对外入口：串行化；流程与取舍见 textReplacer.ts）。 */
  async replaceText(
    query: string,
    replacement: string,
    opts: ReplaceOpts = {}
  ): Promise<ReplaceResultPayload> {
    return this.runExclusive(() => replaceTextInternal(this.write, query, replacement, opts));
  }

  /**
   * 按行号批量写回指定文本（批量替换的撤销 / 重做走这条路）。
   *
   * 与其它写入口不同，这里**不**自带写锁：它是历史回放与 `replaceField` 在锁内复用的原语，
   * 再取一次锁会自死锁。需要独立调用的外部使用者须自行保证串行。
   */
  async applyLineTexts(
    entries: readonly { line: number; text: string }[],
    opts: ReplaceOpts = {}
  ): Promise<ReplaceResultPayload> {
    return applyLineTexts(this.write, entries, opts);
  }

  /** 批量字段级替换（对外入口：串行化；结构化匹配语义见 textReplacer.ts）。 */
  async replaceField(
    path: readonly (string | number)[],
    from: unknown,
    to: unknown,
    opts: ReplaceOpts = {}
  ): Promise<ReplaceResultPayload> {
    return this.runExclusive(() => replaceFieldInternal(this.write, path, from, to, opts));
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
    // 追尾指纹随重建一并刷新（索引的吸收点变了，旧指纹不再对应）。
    await this.refreshTailAnchor(this.index!);
    // 行号已全变：坏行集合与「已全量扫描」结论一并作废。
    this.badLines.reset();
    // 新宿主由本次重建直接产出，索引已是最新；失同步标记随之清零。
    this.hostDirty = false;
  }

  /** 历史快照（对外视图，**不含**回退数据 —— 那是宿主内部事务）。 */
  getHistory(): HistoryPayload {
    return this.history.snapshot();
  }

  /** 撤销一步（光标前移）。整体串行：回退本身也是写磁盘。 */
  async undoStep(): Promise<HistoryStepResult> {
    return this.runExclusive(() => undoStepInternal(this.write));
  }

  /** 重做一步（光标后移）。整体串行。 */
  async redoStep(): Promise<HistoryStepResult> {
    return this.runExclusive(() => redoStepInternal(this.write));
  }

  /**
   * 把光标移到指定位置（历史浮层的「回退到此处」）。
   * 多步回退整体持锁：中途被别的写插入会让「已走到第 k 步」的结论失效。
   */
  async setHistoryCursor(target: number): Promise<HistoryStepResult> {
    return this.runExclusive(() => setHistoryCursorInternal(this.write, target));
  }

  /** 让某条历史成为最新已应用的操作（语义见 historyReplay.ts）。整体串行。 */
  async revertTo(id: string): Promise<HistoryStepResult> {
    return this.runExclusive(() => revertToInternal(this.write, id));
  }

  /* ------------------------- 多选批量操作（M2） ------------------------- */

  /** 批量删除多行，一次原子落盘（对外入口：串行化；区间合并与索引倒序见 rangeWriter.ts）。 */
  async deleteRecords(
    lines: readonly number[],
    opts: ReplaceOpts = {}
  ): Promise<DeleteManyResultPayload> {
    return this.runExclusive(() => deleteRecordsInternal(this.write, lines, opts));
  }

  /** 按字节区间批量插回内容（批量删除的撤销 / 重做；对外入口：串行化）。 */
  async insertRanges(
    ranges: readonly DeletedRange[],
    opts: ReplaceOpts = {}
  ): Promise<DeleteManyResultPayload> {
    return this.runExclusive(() => insertRangesInternal(this.write, ranges, opts));
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
    const targets = normalizeLines(lines, li.totalRecords);
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

    const targets = normalizeLines(lines, li.totalRecords);
    if (targets.length === 0) return empty('没有可复制的记录');
    if (targets.length > MAX_SELECTION_LINES) {
      return empty(`一次最多复制 ${MAX_SELECTION_LINES} 行，当前选中 ${targets.length} 行。`);
    }

    // 记录号 → 物理行集合（多行记录展开为连续行区间，复制得到完整的多行原文）
    const { wanted, firstLine, lastLine } = expandRecordLines(li, targets);
    const parts: string[] = [];
    let bytes = 0;
    let skipped = 0;
    let truncated = false;

    for await (const r of li.scan(reader, firstLine, lastLine + 1)) {
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
      parts.push(r.bytes.toString('utf8') + eolText(ending));
      bytes += rawBytes;
    }

    return { ok: true, count: parts.length, bytes, truncated, skipped, text: parts.join('') };
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
