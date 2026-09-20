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

/** 一段行的原始字节区间（end 为独占边界，可能含末尾 \r 或 \n）。 */
export interface LineRange {
  line: number;
  start: number;
  /** 独占的末尾偏移：下一行起始，或文件末尾。 */
  end: number;
}

/** `scan` 选项。 */
export interface ScanOpts {
  /** 超长行阈值（字节）。超过即该行 yield error 而非无界拼接。默认 MAX_LINE_BYTES。 */
  maxLineBytes?: number;
}

/** `scan` 产出的一行：区间 + 已剥离行尾的字节 + 可选超长错误。 */
export interface ScannedLine extends LineRange {
  /** 剥离行尾 \r\n/\n 的原始字节（subarray，无拷贝）。 */
  bytes: Buffer;
  /** 超长行（>MAX_LINE_BYTES 无换行）时报错文本；缺省表示正常。 */
  error?: string;
}

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

  constructor(
    checkpoints: Checkpoint[],
    totalBytes: number,
    totalLines: number,
    interval: number,
    stats: { buildMs?: number; eof?: boolean } = {}
  ) {
    this.checkpoints = checkpoints;
    this.totalBytes = totalBytes;
    this.totalLines = totalLines;
    this.interval = interval;
    this.buildMs = stats.buildMs ?? 0;
    this.eof = stats.eof ?? true;
  }

  /** 流式顺序扫描，构建稀疏检查点索引。返回可查询的 LineIndex（含统计）。 */
  static async build(
    handle:
      | NodeJS.ReadableStream
      | AsyncIterable<Buffer | string>
      | Iterable<Buffer | string>,
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

    const started = performance.now();

    for await (const raw of handle) {
      const buf: Buffer = typeof raw === 'string' ? Buffer.from(raw) : (raw as Buffer);
      const n = buf.length;
      const chunkBase = totalBytes; // 本 chunk 起始的绝对偏移
      let cursor = 0;
      let nextLf;
      while ((nextLf = buf.indexOf(10, cursor)) !== -1) {
        // 每隔 interval 行记一个检查点（含第 0 行）。
        if (line % interval === 0) checkpoints.push({ line, offset: startOff });
        startOff = chunkBase + nextLf + 1; // \n 之后即下一行的绝对起始偏移
        line++;
        cursor = nextLf + 1;
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
      line++;
    }
    const buildMs = performance.now() - started;

    if (onProgress) {
      onProgress({ bytesRead: totalBytes, lines: line, done: true });
    }

    return new LineIndex(checkpoints, totalBytes, line, interval, { buildMs, eof });
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
   * `bytes` 为剥离行尾的 subarray（无拷贝）。超长行（无换行且长度 ≥
   * `opts.maxLineBytes`；缺省 MAX_LINE_BYTES）以 `error` 标记 yield（不抛、
   * 不中断遍历），保证调用方内存有界；补读以 totalBytes 为界，兼容内存/边界读取器。
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

    while (cur < to) {
      const nl = buf.indexOf(10);
      if (nl === -1) {
        // 当前累积行（无换行）已超阈值 → 超长行：计 1 行，报错（跳过段不 yield 正文）。
        if (buf.length >= maxLineBytes) {
          if (cur >= from) {
            yield {
              line: cur,
              start: abs,
              end: abs + buf.length,
              bytes: EMPTY,
              error: `line too large: ${buf.length} bytes exceeds maxLineBytes ${maxLineBytes}`,
            };
          }
          cur++;
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

  toStats(): LineIndexStats {
    return {
      totalBytes: this.totalBytes,
      totalLines: this.totalLines,
      buildMs: this.buildMs,
      eof: this.eof,
    };
  }
}
