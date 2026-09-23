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

import { chmod, open, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import {
  WRITE_BLOCK_SIZE,
  MAX_TAIL_BACKUP_BYTES,
  TAIL_BACKUP_SUFFIX,
  MAX_BATCH_REWRITE_BYTES,
  REWRITE_TEMP_SUFFIX,
} from '../constants.ts';

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
  /**
   * 取消回调：在分块边界中止搬移（抛 `WriteCancelledError`）。
   *
   * 取消会**自动回滚**（用 sidecar 把文件恢复原样后删除备份），故与批量替换一样是
   * 零风险的 —— 上层可放心让用户看到「已取消，文件未被修改」。
   */
  shouldCancel?: () => boolean;
  /** 搬移进度回调（仅在需要搬移时触发）。 */
  onProgress?: (info: { movedBytes: number; totalBytes: number }) => void;
}

/**
 * 写入被主动取消。
 *
 * 正常路径下文件已被**自动回滚**为原样（sidecar 随之清理）；仅当回滚本身失败时，
 * 异常消息会指明备份仍在何处、可如何手动恢复 —— 那时绝不宣称「文件未被修改」。
 */
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
    // 取消是「预期内的中止」而非失败：**先把文件恢复原样**，再抛可识别的错误。
    // 于是单行编辑的取消与批量替换（在 rename 之前中止）一样是**零风险**的 ——
    // 上层可以让用户看到「已取消，文件未被修改」，而不是「处于半搬移状态、请手动拼接」。
    if (e instanceof WriteCancelledError) {
      const restored = await rollbackToBackup(
        fh,
        backupPath,
        tailStart,
        tailLen,
        fileSize,
        blockSize,
        opts.fsync ?? true
      );
      if (restored) {
        throw new WriteCancelledError('已取消，文件已按备份恢复原样。', { cause: e });
      }
      const hint = backupPath
        ? `取消后的回滚未完成，尾部原始字节仍保留在 ${backupPath}（自偏移 ${tailStart} 起可原样拼回）`
        : '该行位于文件末尾（无尾部需搬移），文件未被修改';
      throw new WriteCancelledError(`已取消；${hint}`, { cause: e });
    }
    const hint = backupPath
      ? `尾部原始字节已保留在 ${backupPath}（自偏移 ${tailStart} 起可原样拼回）`
      : '该行位于文件末尾，尾部为空、无需备份';
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

/* ---------------------------- 批量原子重写 ---------------------------- */

/** 一次区间编辑：用 `replacement` 替换文件中的 `[start, end)`；`start === end` 即纯插入。 */
export interface ByteEdit {
  start: number;
  end: number;
  replacement: Buffer;
}

export interface RewriteResult {
  /** 实际应用的编辑处数。 */
  edits: number;
  /** 新文件相对旧文件的字节增量，可为负。 */
  bytesDelta: number;
  /** 顺序复制的原文件字节数（不含被替换区间——那部分无需逐字节复制）。 */
  copiedBytes: number;
  costMs: number;
  synced: boolean;
}

export interface RewriteOpts {
  /** 复制分块字节数，默认 `WRITE_BLOCK_SIZE`（4MB），保证内存恒定有界。 */
  blockSize?: number;
  /** 完成后是否 fsync 落盘，默认 true。 */
  fsync?: boolean;
  /** 取消回调：在分块边界中止（抛 `WriteCancelledError`，临时文件被清理）。 */
  shouldCancel?: () => boolean;
  /** 复制进度回调（按分块触发；processedBytes 最终等于文件大小）。 */
  onProgress?: (info: { processedBytes: number; totalBytes: number }) => void;
  /** 文件大小上限，默认 `MAX_BATCH_REWRITE_BYTES`。 */
  maxBytes?: number;
}

/**
 * 一次性应用多处区间编辑：读原文件 → 写同目录临时文件 → fsync → 原子 rename。
 *
 * 为什么是它而不是「逐处倒序 replaceRange」（批量编辑的关键取舍）：
 *   · **原子性** —— rename 之前目标文件始终原封不动。失败或取消时用户拿到的还是完整旧文件，
 *     绝不会出现「改了一半」的半成品。批量改写最怕的就是这个，逐处搬移无法给出该保证。
 *   · **成本可预测** —— O(文件大小)，与编辑处数无关。逐处倒序搬移的成本是
 *     Σ(每处改动点距 EOF 的字节数)，命中行散落全文件时可达数十倍文件大小。
 *   · 代价是需要等量临时空间，故以 `maxBytes` 设限，超限直接拒绝（不做无原子性的降级）。
 *
 * ⚠️ **调用方须先释放该文件的读取句柄**：Windows 下会拒绝 rename 覆盖一个仍被
 * 其它句柄打开的文件（EPERM/EBUSY）。`DataService.replaceText` 为此在重写前后
 * 关闭并重新打开 reader。
 *
 * @throws RangeError 编辑区间越界或重叠（在任何写入之前校验）
 * @throws Error 超过 `maxBytes`、无写权限、空间不足、rename 被占用
 */
export async function rewriteWithEdits(
  path: string,
  edits: readonly ByteEdit[],
  opts: RewriteOpts = {}
): Promise<RewriteResult> {
  const started = performance.now();
  const blockSize = opts.blockSize ?? WRITE_BLOCK_SIZE;
  const maxBytes = opts.maxBytes ?? MAX_BATCH_REWRITE_BYTES;

  let src: FileHandle | undefined;
  let dst: FileHandle | undefined;
  let tmpPath: string | undefined;
  let srcClosed = false;

  try {
    try {
      src = await open(path, 'r');
    } catch (e) {
      throw friendlyWriteError(e, path);
    }
    const st = await src.stat();
    const fileSize = st.size;

    if (fileSize > maxBytes) {
      throw new Error(
        `文件 ${fileSize} 字节超过批量替换上限 ${maxBytes} 字节：` +
          `批量替换需要等量临时空间。请改用单行编辑，或在外部工具中处理。`
      );
    }
    const ordered = normalizeEdits(edits, fileSize);
    if (ordered.length === 0) throw new Error('没有需要应用的编辑');

    tmpPath = tempPathFor(path);
    try {
      // 'wx' 独占创建：撞名即失败，绝不覆盖他人文件。
      dst = await open(tmpPath, 'wx', 0o600);
    } catch (e) {
      throw friendlyWriteError(e, tmpPath);
    }

    const srcFh: FileHandle = src;
    const dstFh: FileHandle = dst;
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(blockSize, fileSize || 1)));
    let copied = 0;
    let processed = 0;
    let delta = 0;
    let srcPos = 0;
    let dstPos = 0;

    // 进度以「已处理到的原文件偏移」为准 —— 被替换区间本身无需逐字节复制，
    // 若只按复制量上报则永远到不了 100%。
    const report = (): void =>
      opts.onProgress?.({ processedBytes: processed, totalBytes: fileSize });

    const copyInto = async (from: number, length: number, to: number): Promise<void> => {
      let done = 0;
      while (done < length) {
        assertNotCancelled(opts);
        const chunk = Math.min(buf.length, length - done);
        await readExact(srcFh, buf, chunk, from + done);
        await writeAll(dstFh, buf.subarray(0, chunk), to + done);
        done += chunk;
        copied += chunk;
        processed = from + done;
        report();
      }
    };

    for (const e of ordered) {
      const gap = e.start - srcPos;
      await copyInto(srcPos, gap, dstPos);
      srcPos += gap;
      dstPos += gap;

      if (e.replacement.length > 0) await writeAll(dstFh, e.replacement, dstPos);
      dstPos += e.replacement.length;
      delta += e.replacement.length - (e.end - e.start);
      srcPos = e.end;
      processed = srcPos;
      report();
    }
    await copyInto(srcPos, fileSize - srcPos, dstPos);

    const synced = await trySync(dstFh, opts.fsync ?? true);

    await dst.close();
    dst = undefined;
    await src.close();
    srcClosed = true;

    // 权限先落到临时文件上再替换，最终文件即继承原权限。
    await chmod(tmpPath, st.mode).catch(() => {});
    try {
      await rename(tmpPath, path);
    } catch (e) {
      throw friendlyReplaceError(e, path);
    }
    tmpPath = undefined;

    return {
      edits: ordered.length,
      bytesDelta: delta,
      copiedBytes: copied,
      costMs: performance.now() - started,
      synced,
    };
  } finally {
    if (dst) await dst.close().catch(() => {});
    if (src && !srcClosed) await src.close().catch(() => {});
    // 任何未走到 rename 的路径都必须清掉临时文件，不留垃圾。
    if (tmpPath) await rm(tmpPath, { force: true }).catch(() => {});
  }
}

/** 升序排序并校验编辑列表：越界 / 重叠必须在**任何写入之前**发现。 */
function normalizeEdits(edits: readonly ByteEdit[], fileSize: number): ByteEdit[] {
  // 不改动调用方传入的数组（toSorted 返回新数组），并强制按位置升序。
  const sorted = edits.toSorted((a, b) => a.start - b.start || a.end - b.end);
  let prevEnd = 0;
  for (const e of sorted) {
    if (!Number.isInteger(e.start) || !Number.isInteger(e.end)) {
      throw new RangeError('编辑区间必须为整数');
    }
    if (e.start < 0 || e.end < e.start || e.end > fileSize) {
      throw new RangeError(`编辑区间 [${e.start}, ${e.end}) 越界（文件大小 ${fileSize}）`);
    }
    if (e.start < prevEnd) {
      throw new RangeError(`编辑区间重叠：[${e.start}, ${e.end}) 与前一区间相交`);
    }
    prevEnd = e.end;
  }
  return sorted;
}

/** 临时文件路径：必须与原文件**同目录**，跨分区的 rename 不具备原子性。 */
function tempPathFor(path: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${path}${REWRITE_TEMP_SUFFIX}-${process.pid}-${rand}`;
}

/** rename 阶段的 errno 翻译（与写入阶段的成因不同，需分别给出可操作提示）。 */
function friendlyReplaceError(e: unknown, path: string): Error {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EPERM' || code === 'EBUSY') {
    return new Error(
      `无法替换目标文件（可能仍被其它程序占用，Windows 下需先关闭读取句柄）：${path}`,
      { cause: e }
    );
  }
  if (code === 'EACCES') return new Error(`无权限替换目标文件：${path}`, { cause: e });
  if (code === 'EXDEV') {
    return new Error(`临时文件与目标不在同一分区，无法原子替换：${path}`, { cause: e });
  }
  return e instanceof Error ? e : new Error(String(e));
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

/**
 * 把备份文件的内容原样写回 `fh` 的指定偏移（与 `copyRangeToFile` 对称）。
 *
 * 供回滚使用 —— 见 `rollbackToBackup` 关于「为何整体恢复而非反向搬移」的说明。
 */
async function copyRangeFromFile(
  src: string,
  fh: FileHandle,
  destOffset: number,
  length: number,
  blockSize: number
): Promise<void> {
  const inFh = await open(src, 'r');
  try {
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(blockSize, length)));
    let done = 0;
    while (done < length) {
      const chunk = Math.min(buf.length, length - done);
      await readExact(inFh, buf, chunk, done);
      await writeAll(fh, buf.subarray(0, chunk), destOffset + done);
      done += chunk;
    }
  } finally {
    await inFh.close().catch(() => {});
  }
}

/**
 * 取消后的回滚：用 sidecar 把文件**整体**恢复原样。
 *
 * 为何不做「把已搬移的部分按相反方向搬回去」：那要重新推导搬移方向
 * （Δ>0 倒序 / Δ<0 正序，回滚又各自是它们的逆），而**方向选错会直接写坏文件** ——
 * `shiftTail` 已把这条列为本模块的最高风险点。用备份整体恢复完全不必推导方向，
 * 且复用了崩溃恢复的同一套机制：**一条已经验证过的正确路径**，而不是两条各对一半的。
 *
 * @returns true = 已恢复；false = 无需恢复（无尾部）或恢复失败（sidecar 因此保留）
 */
async function rollbackToBackup(
  fh: FileHandle,
  backupPath: string | undefined,
  tailStart: number,
  tailLen: number,
  fileSize: number,
  blockSize: number,
  fsync: boolean
): Promise<boolean> {
  if (!backupPath || tailLen <= 0) return false;
  try {
    await copyRangeFromFile(backupPath, fh, tailStart, tailLen, blockSize);
    // 搬移中途文件可能已被撑大（写入超出 EOF 会自动扩展），必须截回原大小。
    await fh.truncate(fileSize);
    await trySync(fh, fsync);
  } catch {
    // 回滚失败：**保留** sidecar（用户仍可手动恢复），并如实告知 —— 绝不假装已恢复。
    return false;
  }
  await rm(backupPath, { force: true }).catch(() => {});
  return true;
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

function assertNotCancelled(opts: { shouldCancel?: () => boolean }): void {
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
