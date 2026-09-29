/**
 * lineIndex.ts — 稀疏检查点行索引（性能核心之一）。
 *
 * 用一次流式顺序扫描把「行号 → 字节偏移」建成**稀疏检查点**数组：每隔
 * `INDEX_CHECKPOINT_INTERVAL`(默认 1024) 行记录一个 `{line, offset}`。之后读取
 * 某一行时，从「≤该行的最近检查点」顺读、按 `\n` 推进到目标行（最坏扫一个区间）。
 *
 * 设计取舍（内存 / 速度）：
 *   - 全量 `number[]` 偏移（旧实现，8B/行）在「极短行、数千万行」场景索引自身就会
 *     吃掉上百 MB；稀疏检查点把索引内存降到约 16B/检查点（例：3GB/100B 行 ≈ 3000 万行
 *     → 全量 240MB，稀疏后 ≈ 480KB），超大文件扩展性大幅改善。
 *   - 随机读（详情/坏行/虚拟滚动批读）从检查点顺扫，最坏一个区间（默认 1024 行），
 *     单次顺序 IO，代价可控。
 *   - 搜索/过滤天然改成「单次顺序扫全文件」（`scan` 生成器），反而比旧「逐行随机读」
 *     更优：一次顺序 IO 完成，无随机寻道。
 *   - 扫描期内存恒定有界：即便出现 GB 级无换行的超长行，也由 `MAX_LINE_BYTES`(16MB)
 *     上限保护（超出该行 yield `error`，绝不无界拼接 → 不 OOM）。
 */

import type { ByteReader } from '../parser/jsonParser.ts';
import { INDEX_CHECKPOINT_INTERVAL, SCAN_CHUNK_SIZE, MAX_LINE_BYTES } from '../constants.ts';

export interface LineIndexOpts {
  /** 逐块读取的字节上限，默认 1 MiB。 */
  chunkSize?: number;
  /** 每隔多少字节报告一次进度（供 UI 进度条），默认 4 MiB。 */
  reportInterval?: number;
  /** 检查点间隔（每多少行记一个 {line,offset}）。默认 INDEX_CHECKPOINT_INTERVAL。 */
  checkpointInterval?: number;
  /** 构建进度回调。done 为 true 表示已消费到 EOF。 */
  onProgress?: (info: { bytesRead: number; lines: number; done: boolean }) => void;
}

/** 索引统计 / 概要（后续 webview 概要栏与 getOverview 复用）。 */
export interface LineIndexStats {
  /** 文件字节总数。 */
  totalBytes: number;
  /** 行数（含空行；末尾无换行的最后一行计为一行）。 */
  totalLines: number;
  /** 构建耗时（毫秒）。 */
  buildMs: number;
  /** 是否遍历到 EOF 完成全部索引。 */
  eof: boolean;
}

/**
 * 一条逻辑记录的字节/行区间（end 为独占边界）。
 *
 * 「记录」是 JSONL 的逻辑单位：紧凑文件里一条记录占一行；pretty/多行文件里一条
 * 记录可跨多行（由括号感知的分组扫描确定边界）。
 */
export interface RecordRange {
  /** 起始物理行（0 基）。 */
  startLine: number;
  /** 结束物理行（含；多行记录时 > startLine）。 */
  endLine: number;
  /** 起始字节偏移（含前导空行 —— 空行不属于任何记录，但夹在区间内无害）。 */
  startOffset: number;
  /** 独占结束偏移（含记录尾行尾）。 */
  endOffset: number;
}

/** 一段行的原始字节区间（end 为独占边界，可能含末尾 \r 或 \n）。 */
export interface LineRange {
  line: number;
  start: number;
  /** 独占的末尾偏移：下一行起始，或文件末尾。 */
  end: number;
}

/** `scan` 选项。 */
export interface ScanOpts {
  /**
   * 超长行阈值（字节）。超过即该行 yield error 而非无界拼接；**该行仍只占一个行号**
   * （须读到真正的换行才闭合）。默认 MAX_LINE_BYTES。
   */
  maxLineBytes?: number;
}

/** `scan` 产出的一行：区间 + 已剥离行尾的字节 + 可选超长错误。 */
export interface ScannedLine extends LineRange {
  /** 剥离行尾 \r\n/\n 的原始字节（subarray，无拷贝）。 */
  bytes: Buffer;
  /** 超长行（>MAX_LINE_BYTES 无换行）时报错文本；缺省表示正常。 */
  error?: string;
}

/** 追尾增量被拒绝的原因（调用方据此退回整量重建，而不是硬凑）。 */
export type TailRejectReason =
  /** 索引本身没扫到 EOF（eof=false）——「文件末尾」无从谈起。 */
  | 'incomplete-index'
  /** 多行 / 含空行文件：记录分组需从头维护，尾部续算不可靠。 */
  | 'multiline'
  /** 旧内容末尾不是干净换行（末行未闭合）—— 新字节在续写那一行，不是新行。 */
  | 'open-tail'
  /** 新增字节里出现空行或结构未闭合的记录：文件已不再是「每行一条」的紧凑形态。 */
  | 'not-compact';

/** `appendTail` 的结果。 */
export type TailAppendResult =
  /** 已吸收：`index` 为新实例，`consumedBytes` 为本次并入的字节数（**可为 0**：尾部还没有完整行）。 */
  | { ok: true; index: LineIndex; consumedBytes: number }
  /** 拒绝：调用方必须退回整量重建。 */
  | { ok: false; reason: TailRejectReason };

interface Checkpoint {
  line: number;
  offset: number;
}

/**
 * 稀疏检查点行索引。既是数据结构（含 LineIndexStats），又提供顺序扫描方法 `scan`。
 *
 * `checkpoints[i]` = 第 `checkpoints[i].line` 行起始的字节偏移（含第 0 行）。
 */
export class LineIndex implements LineIndexStats {
  readonly checkpoints: readonly Checkpoint[];
  readonly interval: number;
  readonly totalBytes: number;
  readonly totalLines: number;
  readonly buildMs: number;
  readonly eof: boolean;
  /**
   * 记录分组（仅多行/含空行文件存在）。
   *
   * `recordEndLines[i]` / `recordEndOffsets[i]` = 第 i 条记录的结束物理行 / 独占结束
   * 字节偏移；记录 i 的起始由上一条推导（第 0 条从行 0 / 偏移 0 起）。
   * **紧凑文件（每行一条记录、无空行）为 `undefined`** —— 此时记录号==行号，
   * 走零内存快路径（`multiline` 为 false）。
   */
  readonly recordEndLines: ReadonlyArray<number> | undefined;
  readonly recordEndOffsets: ReadonlyArray<number> | undefined;
  /** 是否存在跨行记录或空行（决定记录号是否等于行号）。 */
  readonly multiline: boolean;
  /**
   * **索引的吸收点**是否落在换行符之后（即 `totalBytes` 处恰好是一行的边界）。
   *
   * 追尾增量（`appendTail`）的前提之一：末行未闭合时，新字节是在**续写**那一行，
   * 而不是开启新行 —— 此时以「追加行」的方式并入会凭空多算一行。
   *
   * 派生实例（编辑增量）沿用父实例的值：编辑以「行」为单位、行含行尾，故这一点
   * 不变（唯一例外是改动最后一行且原末尾无换行 —— 那之后的 `appendTail` 会被
   * 紧凑性校验再挡一次，见该方法说明）。
   */
  readonly endsWithNewline: boolean;

  constructor(
    checkpoints: Checkpoint[],
    totalBytes: number,
    totalLines: number,
    interval: number,
    stats: { buildMs?: number; eof?: boolean } = {},
    records:
      | { endLines: ReadonlyArray<number>; endOffsets: ReadonlyArray<number> }
      | undefined = undefined,
    endsWithNewline = true
  ) {
    this.checkpoints = checkpoints;
    this.totalBytes = totalBytes;
    this.totalLines = totalLines;
    this.interval = interval;
    this.buildMs = stats.buildMs ?? 0;
    this.eof = stats.eof ?? true;
    this.recordEndLines = records?.endLines;
    this.recordEndOffsets = records?.endOffsets;
    this.multiline = records !== undefined;
    this.endsWithNewline = endsWithNewline;
  }

  /** 记录总数：紧凑文件等于行数，多行文件等于分组数。 */
  get totalRecords(): number {
    return this.multiline ? (this.recordEndLines as ReadonlyArray<number>).length : this.totalLines;
  }

  /**
   * 第 `no` 条记录（0 基）的区间。
   *
   * 紧凑文件直接给行号（内容偏移由调用方经 scan 取）；多行文件由 endLines/endOffsets
   * 推导：起始 = 上一条的结束（第 0 条从行 0 / 偏移 0 起）。
   */
  recordRange(no: number): RecordRange {
    if (!Number.isInteger(no) || no < 0 || no >= this.totalRecords) {
      throw new RangeError(`record out of range: ${no} (totalRecords=${this.totalRecords})`);
    }
    if (!this.multiline) {
      return { startLine: no, endLine: no, startOffset: -1, endOffset: -1 };
    }
    const endLines = this.recordEndLines as ReadonlyArray<number>;
    const endOffsets = this.recordEndOffsets as ReadonlyArray<number>;
    return {
      startLine: no === 0 ? 0 : endLines[no - 1] + 1,
      endLine: endLines[no],
      startOffset: no === 0 ? 0 : endOffsets[no - 1],
      endOffset: endOffsets[no],
    };
  }

  /**
   * 由「记录起始物理行」反查记录号（多行文件用；历史回退按当时起始行重放）。
   * 找不到（该行不是任何记录的起始）返回 -1。
   */
  recordNoByStartLine(startLine: number): number {
    if (!this.multiline) return startLine >= 0 && startLine < this.totalLines ? startLine : -1;
    const endLines = this.recordEndLines as ReadonlyArray<number>;
    // startLine 必须恰好等于某条记录的起始（= 上一条结束行 + 1，或 0）
    let prevEnd = -1;
    for (let i = 0; i < endLines.length; i++) {
      if (prevEnd + 1 === startLine) return i;
      prevEnd = endLines[i];
    }
    return prevEnd + 1 === startLine ? endLines.length : -1;
  }

  /** 流式顺序扫描，构建稀疏检查点索引。返回可查询的 LineIndex（含统计）。 */
  static async build(
    handle: NodeJS.ReadableStream | AsyncIterable<Buffer | string> | Iterable<Buffer | string>,
    opts: LineIndexOpts = {}
  ): Promise<LineIndex> {
    const interval = opts.checkpointInterval ?? INDEX_CHECKPOINT_INTERVAL;
    const reportInterval = opts.reportInterval ?? 4 * 1024 * 1024;
    const onProgress = opts.onProgress;

    const checkpoints: Checkpoint[] = [];
    let line = 0; // 已闭合行数
    let startOff = 0; // 当前（未闭合）行的起始绝对偏移
    let totalBytes = 0;
    let lastReport = 0;

    // —— 记录分组状态（括号感知，跨 chunk 保持）——
    // 「记录」= 一个完整 JSON 值（可跨多行）；空行不属于任何记录。
    let depth = 0; // 结构嵌套深度（字符串外：{[ ++、}] --）
    let inString = false; // 是否在 JSON 字符串内
    let escaped = false; // 字符串内下一字节是否被转义
    let lineHasContent = false; // 当前行是否含非空白字节（空行不构成记录）
    let sawMultiline = false; // 出现过跨行记录或空行 → 记录号≠行号
    const recordEndLines: number[] = [];
    const recordEndOffsets: number[] = [];

    const started = performance.now();

    for await (const raw of handle) {
      const buf: Buffer = typeof raw === 'string' ? Buffer.from(raw) : (raw as Buffer);
      const n = buf.length;
      const chunkBase = totalBytes; // 本 chunk 起始的绝对偏移
      for (let i = 0; i < n; i++) {
        const b = buf[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (b === 0x5c /* \ */) escaped = true;
          else if (b === 0x22 /* " */) inString = false;
          continue;
        }
        switch (b) {
          case 0x22: // "
            inString = true;
            lineHasContent = true;
            break;
          case 0x7b: // {
          case 0x5b: // [
            depth++;
            lineHasContent = true;
            break;
          case 0x7d: // }
          case 0x5d: // ]
            if (depth > 0) depth--;
            lineHasContent = true;
            break;
          case 0x0a: // \n —— 行结束
            {
              // 每隔 interval 行记一个检查点（含第 0 行）。
              if (line % interval === 0) checkpoints.push({ line, offset: startOff });
              if (depth === 0 && !inString) {
                if (lineHasContent) {
                  // 结构闭合且本行非空 → 当前记录在此行收尾
                  recordEndLines.push(line);
                  recordEndOffsets.push(chunkBase + i + 1);
                } else {
                  // 空行：不属于任何记录，但打破「记录号==行号」
                  sawMultiline = true;
                }
              } else {
                // 结构未闭合跨行：多行记录的中间行
                sawMultiline = true;
              }
              line++;
              startOff = chunkBase + i + 1;
              lineHasContent = false;
            }
            break;
          default:
            if (b !== 0x20 && b !== 0x09 && b !== 0x0d) lineHasContent = true;
            break;
        }
      }
      totalBytes += n;

      if (onProgress && totalBytes - lastReport >= reportInterval) {
        lastReport = totalBytes;
        onProgress({ bytesRead: totalBytes, lines: line, done: false });
      }
    }

    const eof = true;
    // 末尾剩余的一段（无换行结尾）也算一行；正好以 \n 结束则不额外产生空行。
    if (startOff < totalBytes) {
      if (line % interval === 0) checkpoints.push({ line, offset: startOff });
      if (depth > 0 || inString) sawMultiline = true; // 悬空到 EOF：坏记录，以 EOF 收尾
      if (lineHasContent || depth > 0 || inString) {
        recordEndLines.push(line);
        recordEndOffsets.push(totalBytes);
      }
      line++;
    } else if (depth > 0 || inString) {
      // 悬空记录恰以 \n 结束于 EOF：该行已在上方收行，但记录尚未收尾 ——
      // 若不在此补收尾，这条记录会凭空消失（v1.9.0 自测抓到的边界）。
      sawMultiline = true;
      recordEndLines.push(line - 1);
      recordEndOffsets.push(totalBytes);
    }
    const buildMs = performance.now() - started;

    if (onProgress) {
      onProgress({ bytesRead: totalBytes, lines: line, done: true });
    }

    // 紧凑文件（每行一条记录、无空行）不存分组数组：记录号==行号，走零内存快路径。
    const multiline = sawMultiline || recordEndLines.length !== line;
    const records = multiline
      ? { endLines: recordEndLines, endOffsets: recordEndOffsets }
      : undefined;
    // 吸收点是否落在换行之后：`startOff` 停在最后一个已闭合行的末尾，故它与 EOF 重合
    // 即表示最后一个字节就是换行（`startOff < totalBytes` 则末尾有一段未闭合的内容）。
    const endsWithNewline = startOff === totalBytes;
    return new LineIndex(
      checkpoints,
      totalBytes,
      line,
      interval,
      { buildMs, eof },
      records,
      endsWithNewline
    );
  }

  /** 二分：≤ line 的最大检查点下标；检查点数组按 line 升序。 */
  private checkpointIndexForLine(line: number): number {
    let lo = 0;
    let hi = this.checkpoints.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.checkpoints[mid].line <= line) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - 1);
  }

  /**
   * 同步：返回 ≤ line 的检查点绝对偏移（顺序扫描的锚点，**非**精确行偏移）。
   * 越界抛 RangeError。读取某精确行区间请走 `scan` / `resolveRange`。
   */
  offsetAtLine(line: number): number {
    if (this.totalLines === 0 || line < 0 || line >= this.totalLines) {
      throw new RangeError(`line out of range: ${line} (totalLines=${this.totalLines})`);
    }
    return this.checkpoints[this.checkpointIndexForLine(line)].offset;
  }

  /**
   * 顺序扫描 [fromLine, toLineExclusive) 的行，从最近检查点顺读、按 `\n` 推进。
   * 单次顺序 IO，供 readRecord / readBatch / search / filter 复用；yield 的
   * `bytes` 为剥离行尾的 subarray（无拷贝）。补读以 totalBytes 为界，兼容内存/边界读取器。
   *
   * **超长行**（已读满一块仍无换行，且累计 ≥ `opts.maxLineBytes`；缺省 MAX_LINE_BYTES）：
   * 不把正文交给调用方（`bytes` 为空、带 `error` 标记），**但仍要读到真正的换行才算闭合**
   * —— 整行只占**一个**行号。这一点是硬约束：构建阶段（`build`）按真实换行计数，
   * 若这里把一条超长行按「读取块」切成 N 段各计一行，扫描给出的行号就会多于索引的，
   * 其后每次读取都整体前移 —— 读到的是超长行的尾巴，**且不报错**。
   */
  async *scan(
    reader: ByteReader,
    fromLine: number,
    toLineExclusive: number,
    opts?: ScanOpts
  ): AsyncGenerator<ScannedLine> {
    if (this.totalLines === 0) return;
    const from = Math.max(0, fromLine);
    const to = Math.min(toLineExclusive, this.totalLines);
    if (from >= to) return;

    // per-call 超长行阈值；缺省回落常量 MAX_LINE_BYTES。
    const maxLineBytes = opts?.maxLineBytes ?? MAX_LINE_BYTES;
    const ci = this.checkpointIndexForLine(from);
    const cp = this.checkpoints[ci];
    const EMPTY = Buffer.alloc(0);
    let cur = cp.line;
    let abs = cp.offset; // 当前 buf 起始的绝对偏移
    let buf: Buffer = EMPTY;

    const trimCR = (b: Buffer): Buffer =>
      b.length > 0 && b[b.length - 1] === 13 ? b.subarray(0, b.length - 1) : b;

    // 超长行的**跳过态**：已确认这一行超阈值，但还没读到它的换行符。
    // 期间只累计长度、不保留正文（内存有界），闭合成**一行**后才 cur++。
    let skipping = false;
    let skipStart = 0; // 该超长行的起始绝对偏移
    const tooLarge = (len: number): string =>
      `line too large: ${len} bytes exceeds maxLineBytes ${maxLineBytes}`;

    while (cur < to) {
      const nl = buf.indexOf(10);

      if (skipping) {
        // 继续消费本行的剩余字节，直到了解它到底有多长。
        const have = abs;
        const remaining = this.totalBytes - have;
        if (remaining <= 0) {
          // 该超长行一直延伸到文件末尾：就此闭合为一行。
          if (cur >= from) {
            yield {
              line: cur,
              start: skipStart,
              end: abs,
              bytes: EMPTY,
              error: tooLarge(abs - skipStart),
            };
          }
          cur++;
          skipping = false;
          break;
        }
        const more = await reader.readBytes(have, Math.min(SCAN_CHUNK_SIZE, remaining));
        if (more.length === 0) {
          // 读取器兜底 EOF（同 remaining<=0）。
          if (cur >= from) {
            yield {
              line: cur,
              start: skipStart,
              end: abs,
              bytes: EMPTY,
              error: tooLarge(abs - skipStart),
            };
          }
          cur++;
          skipping = false;
          break;
        }
        const at = more.indexOf(10);
        if (at === -1) {
          abs += more.length; // 整块丢弃（不拼接正文）
          continue;
        }
        const lineEnd = abs + at + 1; // 含换行符
        if (cur >= from) {
          yield {
            line: cur,
            start: skipStart,
            end: lineEnd,
            bytes: EMPTY,
            error: tooLarge(lineEnd - skipStart - 1),
          };
        }
        cur++;
        abs = lineEnd;
        buf = more.subarray(at + 1); // 换行之后的残留属于下一行
        skipping = false;
        continue;
      }

      if (nl === -1) {
        // 已读满一块仍无换行，且累计超阈值 → 进入跳过态（整行仍只占一个行号）。
        if (buf.length >= maxLineBytes) {
          skipping = true;
          skipStart = abs;
          abs += buf.length;
          buf = EMPTY;
          continue;
        }
        // 补读下一块：以 totalBytes 为界，避免对内存/边界读取器越界抛错（EOF 时剩余 ≤ 0 即止）。
        const have = abs + buf.length;
        const remaining = this.totalBytes - have;
        if (remaining <= 0) {
          // EOF：剩余无换行的字节算最后一行。
          if (buf.length > 0) {
            const bytes = trimCR(buf);
            if (cur >= from) yield { line: cur, start: abs, end: abs + buf.length, bytes };
            cur++;
          }
          break;
        }
        const want = Math.min(SCAN_CHUNK_SIZE, remaining);
        const more = await reader.readBytes(have, want);
        if (more.length === 0) {
          // 读取器返回空（EOF 兜底）：同 remaining<=0 处理。
          if (buf.length > 0) {
            const bytes = trimCR(buf);
            if (cur >= from) yield { line: cur, start: abs, end: abs + buf.length, bytes };
            cur++;
          }
          break;
        }
        buf = buf.length ? Buffer.concat([buf, more]) : more;
        continue;
      }

      const lineEnd = abs + nl + 1;
      const bytes = trimCR(buf.subarray(0, nl));
      if (cur >= from) yield { line: cur, start: abs, end: lineEnd, bytes };
      cur++;
      abs = lineEnd;
      buf = buf.subarray(nl + 1);
    }
  }

  /** 便捷：解析单行区间（基于 scan）。越界返回 null，不触发全文件扫描。 */
  async resolveRange(line: number, reader: ByteReader): Promise<LineRange | null> {
    if (line < 0 || line >= this.totalLines) return null;
    for await (const r of this.scan(reader, line, line + 1)) {
      return { line: r.line, start: r.start, end: r.end };
    }
    return null;
  }

  /**
   * 编辑替换后的**增量**索引更新：第 `line` 行长度变化 `deltaBytes`（可负），行数不变。
   *
   * 只有起始偏移位于目标行**之后**的检查点需要平移；目标行自身的检查点偏移不变
   * （仍指向该行起始）。复杂度 O(检查点数) = O(总行数 / interval) —— 千万行文件仅约
   * 一万次加法，远优于重建索引的 O(文件大小) 全量重扫。
   *
   * 返回**新实例**（保持本类不可变语义），未受影响的检查点按引用复用。
   */
  applyLineReplace(line: number, deltaBytes: number): LineIndex {
    if (!Number.isInteger(line) || line < 0 || line >= this.totalLines) {
      throw new RangeError(`line out of range: ${line} (totalLines=${this.totalLines})`);
    }
    if (!Number.isInteger(deltaBytes)) {
      throw new TypeError(`deltaBytes must be an integer, got ${deltaBytes}`);
    }
    if (deltaBytes === 0) return this;

    // map 返回同长新数组；未受影响的检查点按引用复用（不额外分配）。
    const next = this.checkpoints.map((cp) =>
      cp.line > line ? { line: cp.line, offset: cp.offset + deltaBytes } : cp
    );
    return new LineIndex(
      next,
      this.totalBytes + deltaBytes,
      this.totalLines,
      this.interval,
      { buildMs: this.buildMs, eof: this.eof },
      undefined,
      this.endsWithNewline
    );
  }

  /**
   * 在第 `line` 行**之前**插入一行（该行连同行尾共 `insertedBytes` 字节）。
   *
   * 与替换不同，插入会**改变行号**：插入点及其之后的检查点，`line` 与 `offset` 双双平移。
   * 边界：`line === totalLines` 表示追加到文件末尾（此时无检查点需要平移）。
   */
  applyLineInsert(line: number, insertedBytes: number): LineIndex {
    if (!Number.isInteger(line) || line < 0 || line > this.totalLines) {
      throw new RangeError(`insert position out of range: ${line} (totalLines=${this.totalLines})`);
    }
    if (!Number.isInteger(insertedBytes) || insertedBytes < 0) {
      throw new TypeError(`insertedBytes must be a non-negative integer, got ${insertedBytes}`);
    }

    // 空文件首次插入：原本没有任何检查点可平移，必须补上第 0 行的锚点，
    // 否则 scan 找不到顺读起点（会访问 checkpoints[0] === undefined）。
    if (this.totalLines === 0) {
      return new LineIndex(
        [{ line: 0, offset: 0 }],
        insertedBytes,
        1,
        this.interval,
        { buildMs: this.buildMs, eof: this.eof },
        undefined,
        this.endsWithNewline
      );
    }

    const next = this.checkpoints.map((cp) =>
      cp.line >= line ? { line: cp.line + 1, offset: cp.offset + insertedBytes } : cp
    );
    // 在**文件最开头**插入时（line === 0），原 {line:0} 锚点会被上面的平移变成 {line:1}，
    // 索引随即失去「≤ 目标行的最近起点」—— scan 找不到顺读起点，表现为**什么都读不到**
    // （不是报错，而是静默返回空，极难排查）。必须在最前面补回 {line:0, offset:0}：
    // 插入点在最开头，故第 0 行的起始偏移必然是 0。
    if (line === 0 && next[0]?.line !== 0) {
      next.unshift({ line: 0, offset: 0 });
    }
    return new LineIndex(
      next,
      this.totalBytes + insertedBytes,
      this.totalLines + 1,
      this.interval,
      { buildMs: this.buildMs, eof: this.eof },
      undefined,
      this.endsWithNewline
    );
  }

  /**
   * 删除第 `line` 行（该行连同行尾共 `removedBytes` 字节）。
   *
   * 检查点处理有两处不显眼但关键的地方：
   *   1. `cp.line === line` 的检查点，其 `offset` 恰好就是「删后接替该行的下一行」的起始
   *      偏移 —— 故**无需改动**（仅当删的是最后一行、无人接替时才丢弃）；
   *   2. `cp.line > line` 的检查点需 `line-1` 且 `offset-removedBytes`。
   */
  applyLineDelete(line: number, removedBytes: number): LineIndex {
    if (!Number.isInteger(line) || line < 0 || line >= this.totalLines) {
      throw new RangeError(`line out of range: ${line} (totalLines=${this.totalLines})`);
    }
    if (!Number.isInteger(removedBytes) || removedBytes < 0) {
      throw new TypeError(`removedBytes must be a non-negative integer, got ${removedBytes}`);
    }

    const next: Checkpoint[] = [];
    const hasSuccessor = line < this.totalLines - 1;
    for (const cp of this.checkpoints) {
      if (cp.line === line) {
        if (hasSuccessor) next.push(cp); // 接替行的起始偏移与原行相同
        continue; // 删的是最后一行 → 该锚点指向已不存在的内容，丢弃
      }
      if (cp.line > line) {
        next.push({ line: cp.line - 1, offset: cp.offset - removedBytes });
        continue;
      }
      next.push(cp);
    }
    return new LineIndex(
      next,
      Math.max(0, this.totalBytes - removedBytes),
      this.totalLines - 1,
      this.interval,
      { buildMs: this.buildMs, eof: this.eof },
      undefined,
      this.endsWithNewline
    );
  }

  /**
   * 批量「行数不变」的增量平移：**一次遍历**替代 N 次 `applyLineReplace`。
   *
   * 为何需要它：一次「全部替换」可能命中数万行，而每次 `applyLineReplace` 都要把
   * 整份检查点数组 `map` 一遍并重建实例 —— 5 万命中 × 1 万检查点 ≈ 5×10⁸ 次操作，
   * 宿主在这之后会明显卡顿。本方法把「每个检查点要加多少偏移」先累加成前缀，
   * 再单次生成新数组：O(检查点 + 命中 log 命中)。
   *
   * 语义与逐个调用完全等价（含调用顺序无关：同一行的多次 delta 会累加），
   * 未受影响的检查点按引用复用。
   */
  applyLineDeltas(deltas: readonly { line: number; delta: number }[]): LineIndex {
    if (deltas.length === 0) return this;
    // 行号 → 总偏移（同一行可能被多次命中）。
    const byLine = new Map<number, number>();
    let total = 0;
    for (const d of deltas) {
      if (!Number.isInteger(d.line) || d.line < 0 || d.line >= this.totalLines) {
        throw new RangeError(`line out of range: ${d.line} (totalLines=${this.totalLines})`);
      }
      if (!Number.isInteger(d.delta)) {
        throw new TypeError(`delta must be an integer, got ${d.delta}`);
      }
      if (d.delta === 0) continue;
      byLine.set(d.line, (byLine.get(d.line) ?? 0) + d.delta);
      total += d.delta;
    }
    if (byLine.size === 0) return this;

    // 升序行号 + 前缀和：遍历检查点时只需推进游标，无需对每个检查点回看整张表。
    const lines = [...byLine.keys()].toSorted((a, b) => a - b);
    let cursor = 0;
    let shift = 0;
    const next = this.checkpoints.map((cp) => {
      while (cursor < lines.length && lines[cursor] < cp.line) {
        shift += byLine.get(lines[cursor]) ?? 0;
        cursor++;
      }
      return shift === 0 ? cp : { line: cp.line, offset: cp.offset + shift };
    });
    return new LineIndex(
      next,
      this.totalBytes + total,
      this.totalLines,
      this.interval,
      { buildMs: this.buildMs, eof: this.eof },
      undefined,
      this.endsWithNewline
    );
  }

  /**
   * 追尾增量：把「已知 EOF 之后新增的字节」并入索引，返回**新实例**（不可变语义）。
   *
   * 存在的理由：JSONL 里有很大一部分是**正在增长的日志**。整文件重扫在 GB 级要数秒到
   * 数十秒，而用户往往只想看最新的几十条 —— 只扫新增的那几 KB 才是相称的代价。
   *
   * ## 前提（任一不成立即拒绝，由调用方退回整量重建）
   * - `eof`：索引本身扫到了 EOF，否则「末尾」无从谈起；
   * - `!multiline`：多行 / 含空行（含跨行 pretty 记录）的记录分组需从头维护，尾部续算不可靠；
   * - `endsWithNewline`：旧内容末尾是干净的换行。末行未闭合时，新字节是在**续写**那一行，
   *   以「追加新行」并入会凭空多算一行。
   *
   * ## 只吸收到最后一个换行符
   * 尾部若残留「写了一半的行」（没有 `\n`），**不吸收**它：消费位置就记在 `totalBytes` 里，
   * 下一次调用仍会从那里重新读到它 —— 既不需要额外状态，也不会把半行 JSON 当成一条坏记录。
   * 由此得到一条必须写明的语义：`appendTail` 之后 `totalLines` 可能**小于**对同一时刻的
   * 文件做整量构建的结果（差末尾那条未闭合的行）。两者在各自前提下都对 —— 增量给出
   * 「已确定的完整行」，重建给出「眼下看到的全部」。
   *
   * ## 新增字节的紧凑性校验
   * 新增区间内每条记录都必须**结构闭合且非空**；一旦出现空行或跨行结构，说明文件已不是
   * 「每行一条记录」的形态（那会让记录号 ≠ 行号），整批拒绝。这是「只服务紧凑文件」这一
   * 前提的最后一道闸门。
   *
   * 复杂度 O(新增字节)；`tail` 的大小由调用方把握（它决定一次读多少）。
   */
  appendTail(tail: Buffer): TailAppendResult {
    if (!this.eof) return { ok: false, reason: 'incomplete-index' };
    if (this.multiline) return { ok: false, reason: 'multiline' };
    if (!this.endsWithNewline) return { ok: false, reason: 'open-tail' };

    const cut = tail.lastIndexOf(0x0a);
    if (cut < 0) return { ok: true, index: this, consumedBytes: 0 };

    const checkpoints: Checkpoint[] = [...this.checkpoints];
    const base = this.totalBytes;
    let line = this.totalLines;
    let startOff = base;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let hasContent = false;

    for (let i = 0; i <= cut; i++) {
      const b = tail[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (b === 0x5c /* \ */) escaped = true;
        else if (b === 0x22 /* " */) inString = false;
        continue;
      }
      if (b === 0x0a) {
        // 空行 / 结构未闭合：文件已不是紧凑形态 → 整批拒绝（见方法说明）。
        if (!hasContent || depth !== 0) return { ok: false, reason: 'not-compact' };
        if (line % this.interval === 0) checkpoints.push({ line, offset: startOff });
        line++;
        startOff = base + i + 1;
        hasContent = false;
        continue;
      }
      if (b === 0x22) inString = true;
      else if (b === 0x7b /* { */ || b === 0x5b /* [ */) depth++;
      else if (b === 0x7d /* } */ || b === 0x5d /* ] */) {
        if (depth > 0) depth--;
      }
      if (b !== 0x20 && b !== 0x09 && b !== 0x0d) hasContent = true;
    }

    return {
      ok: true,
      index: new LineIndex(
        checkpoints,
        base + cut + 1,
        line,
        this.interval,
        { buildMs: this.buildMs, eof: true },
        undefined,
        true // 吸收点必定落在换行之后
      ),
      consumedBytes: cut + 1,
    };
  }

  toStats(): LineIndexStats {
    return {
      totalBytes: this.totalBytes,
      totalLines: this.totalLines,
      buildMs: this.buildMs,
      eof: this.eof,
    };
  }
}

/**
 * 一次行编辑对应的**索引增量描述**（行数不变者为 replace；增删行者为 insert / delete）。
 *
 * 存在的意义：行索引现在有两份实例 —— 主线程 `DataService.index`（随机读 / 编辑定位用）
 * 与索引宿主内部的实例（worker 线程内那份，或主线程兜底宿主那份）。一次写必须让两份实例
 * 停在**同一组检查点**上，否则宿主侧的 `search` / `filter` 会拿着搬迁前的旧偏移去读
 * 搬迁后的文件：不是报错，而是**静默给出错行号**。
 *
 * 传 op 而非传整份索引：检查点可达数万条（GB 级文件），每次编辑跨线程序列化整份索引
 * 是纯浪费；而一次编辑的实际信息量只有「哪一行 + 多少字节」。
 */
export type IndexDeltaOp =
  /** 行数不变的第 line 行长度变化 delta 字节（可负）。 */
  | { kind: 'replace'; line: number; delta: number }
  /** 在第 line 行之前插入一行，该行连同行尾共 bytes 字节。 */
  | { kind: 'insert'; line: number; bytes: number }
  /** 删除第 line 行，该行连同行尾共 bytes 字节。 */
  | { kind: 'delete'; line: number; bytes: number }
  /**
   * 追尾：在已知 EOF 之后并入若干完整行（`appendTail` 的产物）。
   *
   * `checkpoints` 是这些新行里落在检查点间隔上的锚点，按行号升序、且**严格大于**
   * 既有最大锚点行号 —— 故接收侧只需拼接，无需重排或平移。
   */
  | {
      kind: 'append';
      /** 新增的完整行数（吸收区间内的换行数）。 */
      lines: number;
      /** 新增的字节数（吸收区间长度）。 */
      bytes: number;
      checkpoints: ReadonlyArray<{ line: number; offset: number }>;
    };

/**
 * 按序应用一批增量 op，返回新实例（不可变语义）。
 *
 * **为何必须收敛成一个共用函数**：两侧（主线程宿主、worker 宿主）各自写循环的话，
 * 同一份 op 列表早晚会长出两种解释；收敛后两侧只能同步演化，不存在悄悄漂移的可能。
 *
 * **顺序敏感**：调用方（批量删除的倒序、区间插回的倒序）已算好合法顺序，
 * 本函数严格按数组顺序应用 —— **重排序会改变结果**（增删会让后续行号漂移）。
 */
export function applyIndexOps(li: LineIndex, ops: readonly IndexDeltaOp[]): LineIndex {
  // 快速路径：整批都是「行数不变」的替换（批量替换 / 撤销 / 重做的典型形态）→ 单次遍历。
  // 混合 op（含插入删除）不能走它：那类 op 会改变后续行号，必须逐条按序应用。
  if (ops.length > 0 && ops.every((op) => op.kind === 'replace')) {
    const replaces: { line: number; delta: number }[] = [];
    for (const op of ops) {
      if (op.kind === 'replace') replaces.push({ line: op.line, delta: op.delta });
    }
    return li.applyLineDeltas(replaces);
  }
  let cur = li;
  for (const op of ops) {
    switch (op.kind) {
      case 'replace':
        cur = cur.applyLineReplace(op.line, op.delta);
        break;
      case 'insert':
        cur = cur.applyLineInsert(op.line, op.bytes);
        break;
      case 'delete':
        cur = cur.applyLineDelete(op.line, op.bytes);
        break;
      case 'append': {
        // 追尾：新锚点本就升序且大于既有最大锚点 → 直接拼接（紧凑文件无记录分组）。
        const merged: Checkpoint[] = [...cur.checkpoints, ...op.checkpoints];
        cur = new LineIndex(
          merged,
          cur.totalBytes + op.bytes,
          cur.totalLines + op.lines,
          cur.interval,
          { buildMs: cur.buildMs, eof: true },
          undefined,
          true // appendTail 的吸收点必定落在换行之后
        );
        break;
      }
    }
  }
  return cur;
}

/**
 * 把一次成功的 `appendTail` 结果描述成可下发给索引宿主的增量 op。
 *
 * 与 `applyIndexOps` 同源：**如何描述一次追尾**只有这一处 —— 否则宿主与 worker 侧
 * 早晚会长出两种解释（O1 已就同类问题定过规矩）。
 */
export function tailAppendOp(prev: LineIndex, next: LineIndex): IndexDeltaOp {
  return {
    kind: 'append',
    lines: next.totalLines - prev.totalLines,
    bytes: next.totalBytes - prev.totalBytes,
    checkpoints: next.checkpoints.slice(prev.checkpoints.length).map((c) => ({
      line: c.line,
      offset: c.offset,
    })),
  };
}
