/**
 * fileWriter.ts — JSONL 文件的「按字节区间就地改写」层（编辑能力的磁盘动作底座）。
 *
 * 与 `parser/jsonParser.ts` 的「按偏移随机读」对称：那边负责把某一行读回来，本模块
 * 负责把某一行就地写回去。它只做一件事 —— 安全、可控、可诊断地改写一个字节区间。
 *
 * 两种写入形态（成本差异巨大，是本模块的核心设计）：
 *
 *   1. **等长替换**（新行字节数 == 旧行字节数）
 *      直接 `fd.write` 原位覆写，**零搬移**，单次 IO、无中间态 —— 最廉价路径。
 *
 *   2. **变长替换**（Δ = 新长 − 旧长 ≠ 0）
 *      必须把 `[end, EOF)` 的尾部数据整体平移 Δ 字节。成本为**尾部字节数**（不是文件
 *      总大小）：改末行近乎免费，改首行代价等同文件大小。搬移分块进行（内存有界）：
 *        · Δ > 0（变长）→ **倒序**搬移：目标位置在源之后，倒序可避免覆盖尚未读出的数据；
 *        · Δ < 0（变短）→ **正序**搬移：目标位置在源之前，正序同理安全。
 *      最后 `ftruncate` 到新长度。
 *
 * 为何不「写临时文件 + rename」：那必然 O(文件大小) 全量复制，对 GB 级文件不可接受。
 * 原地搬移虽非原子，但配合尾部 sidecar 备份，可把损坏窗口收敛到可恢复范围。
 *
 * 崩溃安全：
 *   · 等长替换无中间态，不需备份；
 *   · 变长替换在搬移前把尾部数据备份到 `${path}${TAIL_BACKUP_SUFFIX}`，成功后删除；
 *     若搬移或写入失败，sidecar **保留**并在异常信息中给出路径（其内容即尾部原始字节，
 *     自 `tailStart` 起可原样拼回）；尾部超过 `MAX_TAIL_BACKUP_BYTES` 时直接拒绝执行。
 *
 * 约束：仅依赖 `node:fs/promises`，不依赖 `vscode`，可直接用临时文件单测。
 */

import { open, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { WRITE_BLOCK_SIZE, MAX_TAIL_BACKUP_BYTES, TAIL_BACKUP_SUFFIX } from '../constants.ts';

/* ------------------------------ 类型 ------------------------------ */

/** 行尾序列形态。`none` 表示该行位于文件末尾且原本无换行符。 */
export type LineEnding = 'lf' | 'crlf' | 'none';

/** 目标行在文件中的字节区间（`end` 为独占边界，包含行尾符）。 */
export interface ByteRange {
  start: number;
  end: number;
}

/** 一次行替换的磁盘动作结果。 */
export interface LineReplaceResult {
  /** 新行（含行尾）相对旧行的字节增量，可为负。 */
  bytesDelta: number;
  /** 是否走原位覆写（等长替换，零搬移）。 */
  inPlace: boolean;
  /** 实际搬移的尾部字节数（成本度量；等长替换为 0）。 */
  movedBytes: number;
  /** 磁盘动作耗时（毫秒）。 */
  costMs: number;
  /** 是否完成了 fsync。 */
  synced: boolean;
}

/** `replaceLine` 的可选行为。 */
export interface ReplaceLineOpts {
  /** 搬移与备份的分块字节数，默认 `WRITE_BLOCK_SIZE`（4MB）。 */
  blockSize?: number;
  /** 变长替换允许备份的尾部上限，默认 `MAX_TAIL_BACKUP_BYTES`（64MB）。 */
  maxTailBackupBytes?: number;
  /** 完成后是否 fsync 落盘。默认 true —— 编辑是低频操作，值得用一次 fsync 换数据安全。 */
  fsync?: boolean;
  /** 取消回调：在分块边界中止搬移（抛 `WriteCancelledError`，sidecar 保留）。 */
  shouldCancel?: () => boolean;
  /** 搬移进度回调（仅在需要搬移时触发）。 */
  onProgress?: (info: { movedBytes: number; totalBytes: number }) => void;
}

/** 写入被主动取消。文件可能处于半搬移状态，尾部 sidecar 备份仍保留。 */
export class WriteCancelledError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WriteCancelledError';
  }
}

/* ---------------------------- 行尾工具 ---------------------------- */

const LF = Buffer.from('\n');
const CRLF = Buffer.from('\r\n');

/** 行尾形态对应的字节序列。 */
export function lineEndingBytes(ending: LineEnding): Buffer {
  if (ending === 'crlf') return CRLF;
  if (ending === 'lf') return LF;
  return Buffer.alloc(0);
}

/**
 * 由「含行尾的原始区间」与「剥离行尾后的内容长度」推断行尾形态。
 *
 * `LineIndex.scan` 产出的 `start`/`end` 是含行尾的原始区间，`bytes` 是剥离行尾后的
 * 内容（单字节 `\n` 或双字节 `\r\n` 均已去掉），故尾部差值只可能为 0 / 1 / 2。
 */
export function detectLineEnding(range: ByteRange, contentLength: number): LineEnding {
  const tail = range.end - range.start - contentLength;
  if (tail <= 0) return 'none';
  if (tail === 1) return 'lf';
  return 'crlf';
}

/** 把内容与行尾拼成待写入的完整行字节。 */
function composeLine(content: Buffer, ending: LineEnding): Buffer {
  if (ending === 'none') return content;
  return Buffer.concat([content, lineEndingBytes(ending)]);
}

/* ---------------------------- 主入口 ---------------------------- */

/**
 * 用 `replacement` 替换文件中的 `range` 区间（`start === end` 即纯插入）。
 *
 * 这是写入层的**唯一原语** —— 行替换 / 行插入 / 行删除都归结到它：
 *   · 行替换：replacement = 新行 + 行尾
 *   · 行插入：range 为**空区间**（start === end）
 *   · 行删除：replacement 为**空**
 * 三者共享同一套「等长原位覆写 / 变长尾部搬移 / sidecar 崩溃备份 / errno 翻译」，
 * 避免为每种操作各写一份搬移逻辑（那是 bug 的温床）。
 */
export async function replaceRange(
  path: string,
  range: ByteRange,
  replacement: Buffer,
  opts: ReplaceLineOpts = {}
): Promise<LineReplaceResult> {
  let fh: FileHandle;
  try {
    // 'r+' 需要写权限：读写共用一个句柄，避免与读取器之间的偏移竞争。
    fh = await open(path, 'r+');
  } catch (e) {
    throw friendlyWriteError(e, path);
  }
  try {
    return await writeRangeWithHandle(fh, path, range, replacement, opts);
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * 把文件中 `range` 指定的字节区间（一条完整行，含其行尾）替换为 `newLineBytes`。
 * 行尾按 `lineEnding` 重建；等长走原位覆写，变长走尾部搬移（先备份）。
 */
export async function replaceLine(
  path: string,
  range: ByteRange,
  newLineBytes: Buffer,
  lineEnding: LineEnding,
  opts: ReplaceLineOpts = {}
): Promise<LineReplaceResult> {
  return replaceRange(path, range, composeLine(newLineBytes, lineEnding), opts);
}

/** 持有已打开句柄的实现体（便于入口处统一收口 close）。 */
async function writeRangeWithHandle(
  fh: FileHandle,
  path: string,
  range: ByteRange,
  replacement: Buffer,
  opts: ReplaceLineOpts
): Promise<LineReplaceResult> {
  const started = performance.now();
  const fileSize = (await fh.stat()).size;
  assertRange(range, fileSize);

  const delta = replacement.length - (range.end - range.start);

  // ── 等长替换：原位覆写，零搬移、无中间态（空 replacement 时无需写入）
  if (delta === 0) {
    if (replacement.length > 0) await writeAll(fh, replacement, range.start);
    return {
      bytesDelta: 0,
      inPlace: true,
      movedBytes: 0,
      costMs: performance.now() - started,
      synced: await trySync(fh, opts.fsync ?? true),
    };
  }

  // ── 变长替换（含插入 / 删除）：尾部搬移（先备份尾部）
  const result = await applyVariableLength(fh, path, range, replacement, fileSize, delta, opts);
  return { ...result, costMs: performance.now() - started };
}

/** 变长替换：备份尾部 → 搬移 → 写入新行 → 截断；成功才删除 sidecar。 */
async function applyVariableLength(
  fh: FileHandle,
  path: string,
  range: ByteRange,
  replacement: Buffer,
  fileSize: number,
  delta: number,
  opts: ReplaceLineOpts
): Promise<Omit<LineReplaceResult, 'costMs'>> {
  const blockSize = opts.blockSize ?? WRITE_BLOCK_SIZE;
  const maxTail = opts.maxTailBackupBytes ?? MAX_TAIL_BACKUP_BYTES;
  const tailStart = range.end;
  const tailLen = fileSize - tailStart;

  if (tailLen > maxTail) {
    throw new Error(
      `变长编辑需搬移 ${tailLen} 字节尾部，超过备份上限 ${maxTail}；` +
        `请确认代价后调高 maxTailBackupBytes，或改用外部编辑器。`
    );
  }

  let backupPath: string | undefined;
  if (tailLen > 0) {
    backupPath = path + TAIL_BACKUP_SUFFIX;
    await copyRangeToFile(fh, tailStart, tailLen, backupPath, blockSize);
  }

  try {
    await shiftTail(fh, tailStart, tailLen, delta, blockSize, opts);
    await writeAll(fh, replacement, range.start);
    await fh.truncate(fileSize + delta);
  } catch (e) {
    const hint = backupPath
      ? `尾部原始字节已保留在 ${backupPath}（自偏移 ${tailStart} 起可原样拼回）`
      : '该行位于文件末尾，尾部为空、无需备份';
    // 取消是「预期内的中止」而非失败：保持可识别的错误类型，供上层区分处理。
    if (e instanceof WriteCancelledError) {
      throw new WriteCancelledError(`${e.message}；${hint}`, { cause: e });
    }
    throw new Error(`变长替换失败：${describe(e)}；${hint}`, { cause: e });
  }

  const synced = await trySync(fh, opts.fsync ?? true);
  if (backupPath) await rm(backupPath, { force: true }).catch(() => {});
  return { bytesDelta: delta, inPlace: false, movedBytes: tailLen, synced };
}

/**
 * 把 `[tailStart, tailStart+tailLen)` 的尾部整体平移 `delta` 字节。
 *
 * 方向选择是正确性关键：Δ > 0 时目标在源之后，必须**倒序**（先搬最后一块）才不会覆盖
 * 尚未读出的数据；Δ < 0 时目标在源之前，必须**正序**。分块保证内存恒定有界。
 */
async function shiftTail(
  fh: FileHandle,
  tailStart: number,
  tailLen: number,
  delta: number,
  blockSize: number,
  opts: ReplaceLineOpts
): Promise<void> {
  if (tailLen === 0) return;
  const buf = Buffer.allocUnsafe(Math.min(blockSize, tailLen));
  let moved = 0;

  if (delta > 0) {
    let offset = tailLen; // 倒序：从尾部向头部
    while (offset > 0) {
      assertNotCancelled(opts);
      const chunk = Math.min(buf.length, offset);
      offset -= chunk;
      await readExact(fh, buf, chunk, tailStart + offset);
      await writeAll(fh, buf.subarray(0, chunk), tailStart + offset + delta);
      moved += chunk;
      opts.onProgress?.({ movedBytes: moved, totalBytes: tailLen });
    }
  } else {
    let offset = 0; // 正序：从头部向尾部
    while (offset < tailLen) {
      assertNotCancelled(opts);
      const chunk = Math.min(buf.length, tailLen - offset);
      await readExact(fh, buf, chunk, tailStart + offset);
      await writeAll(fh, buf.subarray(0, chunk), tailStart + offset + delta);
      offset += chunk;
      moved += chunk;
      opts.onProgress?.({ movedBytes: moved, totalBytes: tailLen });
    }
  }
}

/* ---------------------------- IO 原语 ---------------------------- */

/** 全量写入：循环处理部分写，写满或抛错为止。 */
async function writeAll(fh: FileHandle, buf: Buffer, position: number): Promise<void> {
  let written = 0;
  while (written < buf.length) {
    const r = await fh.write(buf, written, buf.length - written, position + written);
    if (r.bytesWritten === 0) throw new Error(`写入返回 0 字节（position=${position + written}）`);
    written += r.bytesWritten;
  }
}

/** 全量读入：循环处理部分读，读满或遇意外 EOF 抛错。 */
async function readExact(
  fh: FileHandle,
  buf: Buffer,
  length: number,
  position: number
): Promise<void> {
  let read = 0;
  while (read < length) {
    const r = await fh.read(buf, read, length - read, position + read);
    if (r.bytesRead === 0) throw new Error(`意外 EOF（position=${position + read}）`);
    read += r.bytesRead;
  }
}

/** 把源文件的 `[start, start+length)` 区间分块复制到独立文件（尾部备份用）。 */
async function copyRangeToFile(
  fh: FileHandle,
  start: number,
  length: number,
  dest: string,
  blockSize: number
): Promise<void> {
  const out = await open(dest, 'w');
  try {
    const buf = Buffer.allocUnsafe(Math.min(blockSize, length));
    let done = 0;
    while (done < length) {
      const chunk = Math.min(buf.length, length - done);
      await readExact(fh, buf, chunk, start + done);
      await writeAll(out, buf.subarray(0, chunk), done);
      done += chunk;
    }
  } finally {
    await out.close().catch(() => {});
  }
}

/* ---------------------------- 辅助 ---------------------------- */

/** 字节区间合法性校验（防御脏输入，避免越界写坏文件）。 */
function assertRange(range: ByteRange, fileSize: number): void {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) {
    throw new RangeError('字节区间必须为整数');
  }
  if (range.start < 0 || range.end < range.start || range.end > fileSize) {
    throw new RangeError(`字节区间 [${range.start}, ${range.end}) 越界（文件大小 ${fileSize}）`);
  }
}

function assertNotCancelled(opts: ReplaceLineOpts): void {
  if (opts.shouldCancel?.()) {
    throw new WriteCancelledError('写入已在分块边界被取消');
  }
}

/** fsync 落盘；少数文件系统不支持时降级为「未同步」，不影响正确性。 */
async function trySync(fh: FileHandle, want: boolean): Promise<boolean> {
  if (!want) return false;
  try {
    await fh.sync();
    return true;
  } catch {
    return false;
  }
}

/** 把底层 errno 翻译成可操作的中文提示。 */
function friendlyWriteError(e: unknown, path: string): Error {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') return new Error(`无写入权限：${path}`, { cause: e });
  if (code === 'EROFS') return new Error(`文件系统只读：${path}`, { cause: e });
  if (code === 'ENOSPC') return new Error(`磁盘空间不足：${path}`, { cause: e });
  if (code === 'EBUSY') return new Error(`文件被其它程序占用：${path}`, { cause: e });
  if (code === 'ENOENT') return new Error(`文件不存在：${path}`, { cause: e });
  return e instanceof Error ? e : new Error(String(e));
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
