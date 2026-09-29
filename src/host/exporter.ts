/**
 * exporter.ts — 把选定的记录**另存为新文件**（只读源文件，绝不改写它）。
 *
 * 与 `fileWriter` 的分工（本文件刻意不复用它的写入原语）：
 *   - `fileWriter` 解决的是「在**原文件上**就地改一行/重写整个文件」——它的一切复杂度
 *     （尾部搬移、sidecar 备份、原子 rename 覆盖原路径）都来自「源既目标」这一点；
 *   - 导出是「读源、写另一个文件」，没有原地搬移，也不需要动源文件的任何一个字节。
 *     复用 `fileWriter` 反而会把「原位覆盖」的语义带进来 —— 那是两件不同的事。
 *
 * 唯一借用的惯例是**原子性**：先写同名临时文件、成功后再 rename。这样：
 *   - 取消/失败时删掉临时文件，**目标路径从头到尾没有被创建过**（零风险）；
 *   - 用户不会看到一个「导出到一半」的文件，并据此以为导出成功了。
 */

import { createWriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import type { LineIndex } from '../indexer/lineIndex.ts';
import type { ByteReader } from '../parser/jsonParser.ts';

/** 导出临时文件后缀（与目标文件**同目录**，否则 rename 跨分区不具原子性）。 */
export const EXPORT_TEMP_SUFFIX = '.jlv-export-tmp';

export interface ExportOpts {
  /** 取消回调：在每个记录边界与每个写块边界检查，返回 true 即中止。 */
  shouldCancel?: () => boolean;
  /** 进度回调（已处理的源文件字节数 / 总字节数）。 */
  onProgress?: (info: { processedBytes: number; totalBytes: number }) => void;
  /**
   * 单行字节上限（透传给 `scan`）。默认沿用 `MAX_LINE_BYTES`；
   * 暴露出来是为了让「超长行被跳过」这条路径**可测** —— 否则要造一个 16MB 的行。
   */
  maxLineBytes?: number;
}

export interface ExportResult {
  /** 实际写入的记录数。 */
  count: number;
  /** 写入的字节数。 */
  bytes: number;
  /** 因过大等原因跳过的记录数（必须如实回报，否则用户以为全导出了）。 */
  skipped: number;
  /** 是否被主动取消（此时目标文件未被创建）。 */
  cancelled: boolean;
}

/** 导出被取消（与「失败」严格区分：取消后目标文件从未被创建）。 */
export class ExportCancelledError extends Error {
  constructor() {
    super('导出已取消');
    this.name = 'ExportCancelledError';
  }
}

/**
 * 把 `lines`（记录号，已去重升序）的**磁盘原文**写入 `targetPath`。
 *
 * - 逐记录顺序 scan，按记录粒度写出：一条记录的原文（多行记录含内部换行）原样落盘，
 *   与复制到剪贴板的行为一致（不做 JSON 解析、不重排键序、不改行尾）；
 * - 超长记录（scan 报 error）跳过并计数 —— 取不出原文就不能假装导出了；
 * - 取消/失败一律删除临时文件并抛出，调用方据此如实汇报。
 */
export async function exportLinesToFile(
  li: LineIndex,
  reader: ByteReader,
  lines: readonly number[],
  targetPath: string,
  opts: ExportOpts = {}
): Promise<ExportResult> {
  const tmpPath = `${targetPath}${EXPORT_TEMP_SUFFIX}`;
  const totalBytes = li.totalBytes;
  let count = 0;
  let bytes = 0;
  let skipped = 0;
  let processedBytes = 0;
  const stream = createWriteStream(tmpPath, { flags: 'w' });

  const cleanup = async (): Promise<void> => {
    await new Promise<void>((res) => {
      stream.once('close', () => res());
      stream.destroy();
    });
    await unlink(tmpPath).catch(() => {});
  };

  try {
    for (const line of lines) {
      if (opts.shouldCancel?.()) throw new ExportCancelledError();
      const rr = li.recordRange(line);
      for await (const r of li.scan(
        reader,
        rr.startLine,
        rr.endLine + 1,
        opts.maxLineBytes != null ? { maxLineBytes: opts.maxLineBytes } : undefined
      )) {
        // 超长行取不出安全原文 → 跳过整条记录（不是跳过这一行：半条记录更没用）。
        if (r.error) {
          skipped++;
          break;
        }
        processedBytes = r.end;
        const text = r.bytes.toString('utf8');
        if (!(await writeChunk(stream, `${text}\n`))) {
          throw new Error('写入导出文件失败');
        }
        bytes += Buffer.byteLength(text, 'utf8') + 1;
        count++;
      }
      opts.onProgress?.({ processedBytes, totalBytes });
    }

    await closeStream(stream);
    if (count === 0) {
      // 一条都没取出原文（全被跳过）：**不创建目标文件** ——
      // 留一个空文件在那里，用户会以为「导出成功但内容没了」，比明说失败更糟。
      await unlink(tmpPath).catch(() => {});
      return { count: 0, bytes: 0, skipped, cancelled: false };
    }
    // 原子落地：此刻用户选定的路径才第一次出现。
    await rename(tmpPath, targetPath);
    return { count, bytes, skipped, cancelled: false };
  } catch (e) {
    await cleanup();
    if (e instanceof ExportCancelledError) {
      return { count: 0, bytes: 0, skipped: 0, cancelled: true };
    }
    throw e;
  }
}

/** 写一块（背压感知：返回 false 表示写入流出错，调用方应中止）。 */
function writeChunk(stream: ReturnType<typeof createWriteStream>, text: string): Promise<boolean> {
  return new Promise<boolean>((res) => {
    const ok = stream.write(text, (err) => {
      if (err) res(false);
    });
    if (ok) res(true);
    else stream.once('drain', () => res(true));
  });
}

/** 关闭并等待落盘（不等待会在 rename 前丢掉尾部缓冲）。 */
function closeStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise<void>((res, rej) => {
    stream.end(() => res());
    stream.once('error', (e) => rej(e));
  });
}
