/**
 * lineIndex.ts — 行偏移索引（性能核心之一）。
 *
 * 用一次流式顺序扫描把「行号 → 字节偏移」建成一个扁平升序数组，之后任意
 * 行(或任意字节偏移)都能用二分在 O(log n) 内定位，从而支持「按需惰性解析」：
 * 对齐索引后，每一行的内容只需一次随机读回到磁盘上精确的 [start, end) 区间，
 * 内存只与可视区所请求的行数成正比，与文件总大小无关。
 *
 * 设计取舍（内存 / 速度）：
 *   - 选用「每行一个偏移」的完整扁平数组（number[]，V8 packed double，约
 *     8 字节/行）。这能保证 getOffsetAtLine / getLineRangeAtOffset 的 O(log n)
 *     二分复杂度且实现最简、无误差。
 *   - 不做「分块间距采样」的原因：采样会引入块内二次顺序查找与更复杂的行号
 *     编解码，收益仅在「海量极短线」场景（每行几字节、行数数千万）时才有意义；
 *     而本项目目标为「数 GB 大文件」，其行通常较大（KB~MB），行数反而适中，
 *     偏移数组内存开销可接受（例：5GB，2KB/行 ≈ 250 万行 ≈ 20MB）。该取舍记录
 *     于 README/任务报告。若未来需要，可在 LineIndex 结构上无损叠加采样层。
 *   - 扫描时只维护一个「当前行起始的绝对偏移」游标，绝不对 chunk 做跨块拼接，
 *     因此即便出现单个超大行（GB 级无换行），构建期内存也保持恒定有界。
 */

export interface LineIndexOpts {
  /** 逐块读取的字节上限，默认 1 MiB。 */
  chunkSize?: number;
  /** 每隔多少字节报告一次进度（供 UI 进度条），默认 4 MiB。 */
  reportInterval?: number;
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
  /** 独占的末尾偏移：下一行起始，或文件末尾。包含行尾换行符。 */
  end: number;
}

/**
 * 完整行偏移索引。既是数据结构（含 LineIndexStats），又提供二分定位方法。
 *
 * offsets[i] = 第 i 行起始的字节偏移（0 起）。offsets 严格递增。
 */
export class LineIndex implements LineIndexStats {
  readonly offsets: readonly number[];
  readonly totalBytes: number;
  readonly totalLines: number;
  readonly buildMs: number;
  readonly eof: boolean;

  constructor(
    offsets: readonly number[],
    totalBytes: number,
    stats: { buildMs?: number; eof?: boolean } = {}
  ) {
    this.offsets = offsets;
    this.totalBytes = totalBytes;
    this.totalLines = offsets.length;
    this.buildMs = stats.buildMs ?? 0;
    this.eof = stats.eof ?? true;
  }

  /** 流式顺序扫描，构建行偏移索引。返回可查询的 LineIndex（含统计）。 */
  static async build(
    handle:
      | NodeJS.ReadableStream
      | AsyncIterable<Buffer | string>
      | Iterable<Buffer | string>,
    opts: LineIndexOpts = {}
  ): Promise<LineIndex> {
    const reportInterval = opts.reportInterval ?? 4 * 1024 * 1024;
    const onProgress = opts.onProgress;

    const offsets: number[] = [];
    let startOff = 0; // 当前（未闭合）行的起始绝对偏移
    let totalBytes = 0;
    let lastReport = 0;

    const started = performance.now();

    for await (const raw of handle) {
      const buf: Buffer = typeof raw === 'string' ? Buffer.from(raw) : (raw as Buffer);
      const n = buf.length;
      // 单字节 \n 切分；\r 归属上一行内容，读取时由 readLineAt 剥离。
      for (let i = 0; i < n; i++) {
        if (buf[i] === 10) {
          offsets.push(startOff);
          startOff = totalBytes + i + 1; // 下一行自 \n 之后开始
        }
      }
      totalBytes += n;

      if (onProgress && totalBytes - lastReport >= reportInterval) {
        lastReport = totalBytes;
        onProgress({ bytesRead: totalBytes, lines: offsets.length, done: false });
      }
    }

    const eof = true;
    // 末尾剩余的一段（无换行结尾）也算一行；正好以 \n 结束则不额外产生空行。
    if (startOff < totalBytes) {
      offsets.push(startOff);
    }
    const buildMs = performance.now() - started;

    if (onProgress) {
      onProgress({ bytesRead: totalBytes, lines: offsets.length, done: true });
    }

    return new LineIndex(offsets, totalBytes, { buildMs, eof });
  }

  /** 由已构好的偏移数组直接构造（便于测试与将来叠加缓存）。 */
  static fromOffsets(offsets: readonly number[], totalBytes: number, stats?: {
    buildMs?: number;
    eof?: boolean;
  }): LineIndex {
    return new LineIndex(offsets, totalBytes, stats);
  }

  /** 二分：第一个满足 arr[i] > value 的下标。arr 严格升序。 */
  private static upperBound(arr: readonly number[], value: number): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid] <= value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** 返回第 line 行（0 起）起始的字节偏移。越界抛 RangeError。 */
  getOffsetAtLine(line: number): number {
    if (line < 0 || line >= this.totalLines) {
      throw new RangeError(`line out of range: ${line} (totalLines=${this.totalLines})`);
    }
    return this.offsets[line];
  }

  /** 返回第 line 行（0 起）的原始字节区间（end 独占，含行尾换行符）。 */
  lineRange(line: number): LineRange {
    const start = this.getOffsetAtLine(line);
    const end = line + 1 < this.totalLines ? this.offsets[line + 1] : this.totalBytes;
    return { line, start, end };
  }

  /**
   * 给定任意字节偏移，定位它所属的行及其原始字节区间。
   * 偏移在 [0, totalBytes) 内返回该行；空文件或越界返回 null。
   */
  getLineRangeAtOffset(offset: number): LineRange | null {
    if (this.totalLines === 0 || offset < 0 || offset >= this.totalBytes) return null;
    const line = LineIndex.upperBound(this.offsets, offset) - 1;
    return this.lineRange(line);
  }

  /** 便捷：第 line 行的内容字节区间（不含换行符前的 \r），供读取前裁剪。 */
  contentLengthAt(line: number): number {
    const { end } = this.lineRange(line);
    return end - this.offsets[line];
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