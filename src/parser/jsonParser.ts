/**
 * jsonParser.ts — 按需惰性解析。
 *
 * 依赖 lineIndex 对齐索引：给定行号，先从索引得到 [start, end) 字节区间，
 * 再从文件按偏移读回这一段，最后做单行 JSON 校验 & 解析。因此绝不对整行之外
 * 的数据做任何工作，内存与解析代价只与当前请求的行数成正比（虚拟滚动按可视区
 * 批次请求）。
 */

import type { FileHandle } from 'node:fs/promises';
import { LineIndex } from '../indexer/lineIndex.ts';
import { MAX_LINE_BYTES } from '../constants.ts';

/** 解析单行的结果。合法行返回 value；非法行返回 error（含定位）。 */
export type JsonParseResult =
  { ok: true; value: unknown } | { ok: false; error: string; line: number; column: number };

/** 一条记录的读取/解析结果（供列表渲染与错误行红标定位）。 */
export interface RecordResult {
  line: number;
  ok: boolean;
  value?: unknown;
  error?: string;
  /**
   * 该行的**原始文本**（已剥离行尾）。仅 `readRecord` 单行路径提供 —— 编辑功能需要
   * 「磁盘上原样是什么」而非「重新序列化后的样子」，否则一保存就会把用户原有的
   * 键序与空白重排掉。
   */
  rawText?: string;
  /** 原始文本的 UTF-8 字节长度（编辑乐观锁的断言依据）。 */
  rawBytes?: number;
}

export interface ReadRecordOpts {
  /** 超长行阈值。读取区间超过该长度时拒绝并报错（防吞内存）。默认 16 MiB。 */
  maxLineBytes?: number;
}

/** 批量读取选项（比单行多一个可中断回调）。 */
export interface ReadBatchOpts extends ReadRecordOpts {
  /** 中断回调：返回 true 则提前终止剩余行（配合宿主 CancelToken 做真正的可中断）。 */
  shouldCancel?: () => boolean;
}

/** 对一行的任意字节区间做随机读的抽象（底层可为文件句柄或内存缓冲区）。 */
export interface ByteReader {
  readBytes(start: number, length: number): Promise<Buffer>;
  close?(): Promise<void>;
}

const LF = 10;
const CR = 13;

/** 解析并校验一条（已被 trim 的）JSON 文本，返回结果或错误 + 定位。 */
export function parseJsonLine(text: string): JsonParseResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: '空行（无 JSON 值）', line: 1, column: 1 };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // V8 错误形如：
    //   - "Expected ... after property value in JSON at position 8 (line 1 column 9)"
    //   - "Unexpected token 'N', ...\"5\", \"num\": NaN, ... is not valid JSON"
    // 提取列号，并生成精简、可读的错误文案（去掉整行原文的回显，避免窄栏里一串乱码）。
    const column = extractColumn(msg);
    return { ok: false, error: friendlyJsonError(msg, column), line: 1, column };
  }
}

/** 从 V8 错误信息里抽取字符位置；取不到则返回 1。 */
function extractColumn(msg: string): number {
  const m = /position (\d+)/.exec(msg);
  return m ? Number(m[1]) + 1 : 1;
}

/** 把 V8 的 JSON 解析错误整理成一句话：保留原因 + 位置，去掉整行原文回显。 */
function friendlyJsonError(msg: string, column: number): string {
  const loc = column > 1 ? `（第 ${column} 个字符处）` : '';
  // 截断点：要么在 " at position"，要么在 V8 的原文回显标记 ", ..."，
  // 要么在尾部 " is not valid JSON"。取最早出现处。
  const cut = (needle: string): number => {
    const i = msg.indexOf(needle);
    return i === -1 ? Number.POSITIVE_INFINITY : i;
  };
  const stop = Math.min(cut(' at position'), cut(', ...'), cut(' is not valid JSON'));
  let head = (stop === Number.POSITIVE_INFINITY ? msg : msg.slice(0, stop)).trim();
  head = head.replace(/^Unexpected token /, '非法字符 ').replace(/,*$/, '');
  return `${head || 'JSON 语法错误'}${loc}`;
}

/** 去掉原始行尾的 \n 或 \r\n（始终按多字节安全裁剪，不做额外拷贝）。 */
function trimLineEnding(buf: Buffer, len: number): number {
  if (len > 0 && buf[len - 1] === LF) {
    len--;
    if (len > 0 && buf[len - 1] === CR) len--;
  }
  return len;
}

/** 将 [start, end) 原始字节区间读成一行文本，剥离行尾 `\r\n`/`\n`。 */
export async function readLineAt(
  reader: ByteReader,
  start: number,
  end: number,
  opts: ReadRecordOpts = {}
): Promise<string> {
  const buf = await readLineBuffer(reader, start, end, opts);
  return buf.toString('utf8');
}

/**
 * 轻量级只读 Buffer 版本：宿主全文搜索路径专用，避免 UTF-8 解码开销。
 * 返回剥离了行尾 \r\n/\n 的原始字节切片（subarray，无拷贝）。
 */
export async function readLineBuffer(
  reader: ByteReader,
  start: number,
  end: number,
  opts: ReadRecordOpts = {}
): Promise<Buffer> {
  if (end < start) throw new RangeError(`readLineBuffer: end(${end}) < start(${start})`);
  const max = opts.maxLineBytes ?? MAX_LINE_BYTES;
  const len = end - start;
  if (len > max) {
    throw new Error(
      `line too large: ${len} bytes exceeds maxLineBytes ${max} (start=${start}, end=${end})`
    );
  }
  const buf = await reader.readBytes(start, len);
  const trimmedLen = trimLineEnding(buf, buf.length);
  return buf.subarray(0, trimmedLen);
}

/** 基于稀疏索引 scan，按需读取并解析第 line 行（单次顺序 IO，从最近检查点扫到该行）。 */
/**
 * 读取一条逻辑记录并解析。
 *
 * 「记录」是 JSONL 的逻辑单位：紧凑文件里一条记录占一个物理行（`recordNo == line`，
 * 行为与旧版完全一致）；pretty/多行文件里一条记录可跨多物理行，此时把记录区间内的
 * 物理行按序聚合（内部行的换行是内容的组成部分），整体交给 JSON 解析。
 *
 * `rawBytes` 是聚合文本的字节数（CRLF 行尾的 \r 被扫描层剥离，与旧口径一致）——
 * 与 `editRecord` 内部的聚合口径相同，保证乐观锁比对一致。
 */
export async function readRecord(
  recordNo: number,
  lineIndex: LineIndex,
  reader: ByteReader,
  opts: ReadRecordOpts = {}
): Promise<RecordResult> {
  if (recordNo < 0 || recordNo >= lineIndex.totalRecords) {
    return { line: recordNo, ok: false, error: '无效记录号' };
  }
  const scanOpts = opts.maxLineBytes != null ? { maxLineBytes: opts.maxLineBytes } : undefined;
  const range = lineIndex.recordRange(recordNo);
  const lines: string[] = [];
  for await (const r of lineIndex.scan(reader, range.startLine, range.endLine + 1, scanOpts)) {
    if (r.error) return { line: recordNo, ok: false, error: r.error };
    lines.push(r.bytes.toString('utf8'));
  }
  // 多行记录：物理行按序以 \n 连接（内部行的换行是记录内容的组成部分）。
  const rawText = lines.join('\n');
  const rawBytes = Buffer.byteLength(rawText, 'utf8');
  const parsed = parseJsonLine(rawText);
  if (parsed.ok) {
    return { line: recordNo, ok: true, value: parsed.value, rawText, rawBytes };
  }
  // 坏记录同样回原文：编辑要支持「把坏记录改好」这一最常见的修复动作。
  return { line: recordNo, ok: false, error: parsed.error, rawText, rawBytes };
}

/** 读取并解析 [startLine, startLine+count) 的一批行（虚拟滚动请求可视区用，连续顺序扫）。 */
/**
 * 批量读取记录（虚拟滚动可视区用）：[startRecord, startRecord+count) 单遍扫描聚合。
 *
 * 紧凑文件下与逐行读取完全等价；多行文件下把记录区间内的物理行聚合后再解析，
 * 单遍顺序 IO 完成（边界来自 recordRange，行 → 记录的归组用 recordEndLines 推进）。
 */
/**
 * 记录流式扫描生成器：把 [from, to) 内的每条逻辑记录聚合为 {recordNo, text, buf}。
 *
 * readBatch / 搜索 / 过滤 / 坏记录扫描共用这一分组骨架 —— 行→记录的归组逻辑只有
 * 这一份，任何一处改错都只改这里。多行记录的内部换行是内容组成部分（join('\n')）。
 */
export async function* scanRecords(
  from: number,
  to: number,
  lineIndex: LineIndex,
  reader: ByteReader,
  scanOpts?: { maxLineBytes?: number; shouldCancel?: () => boolean }
): AsyncGenerator<{ recordNo: number; text: string; buf: Buffer; endOffset: number }> {
  if (from >= to || from < 0) return;
  const firstRange = lineIndex.recordRange(from);
  const lastRange = lineIndex.recordRange(to - 1);
  const endLines = lineIndex.multiline
    ? (lineIndex.recordEndLines as ReadonlyArray<number>)
    : undefined;

  let recordNo = from;
  let lines: string[] = [];
  let bytes: Buffer[] = [];
  let total = 0;
  let lastEnd = 0; // 最近一次 scan 行的独占结束偏移（含行尾）

  for await (const r of lineIndex.scan(
    reader,
    firstRange.startLine,
    lastRange.endLine + 1,
    scanOpts?.maxLineBytes != null ? { maxLineBytes: scanOpts.maxLineBytes } : undefined
  )) {
    if (scanOpts?.shouldCancel?.()) return;
    lastEnd = r.end;
    if (!r.error) {
      lines.push(r.bytes.toString('utf8'));
      bytes.push(r.bytes);
      total += r.bytes.length;
    }
    // 行 → 记录归组：到达当前记录的结束行即产出，推进到下一条。
    const groupEnd =
      endLines !== undefined
        ? recordNo < endLines.length
          ? endLines[recordNo]
          : r.line
        : recordNo;
    if (r.line >= groupEnd) {
      yield {
        recordNo,
        text: lines.join('\n'),
        buf: Buffer.concat(bytes, total),
        endOffset: lastEnd,
      };
      recordNo++;
      lines = [];
      bytes = [];
      total = 0;
    }
  }
  if (lines.length > 0) {
    yield {
      recordNo,
      text: lines.join('\n'),
      buf: Buffer.concat(bytes, total),
      endOffset: lastEnd,
    };
  }
}

export async function readBatch(
  startRecord: number,
  count: number,
  lineIndex: LineIndex,
  reader: ByteReader,
  opts: ReadBatchOpts = {}
): Promise<RecordResult[]> {
  if (count <= 0 || startRecord < 0) return [];
  const lastRecord = Math.min(startRecord + count, lineIndex.totalRecords) - 1;
  if (startRecord > lastRecord) return [];
  const out: RecordResult[] = [];
  for await (const rec of scanRecords(startRecord, lastRecord + 1, lineIndex, reader, {
    maxLineBytes: opts.maxLineBytes,
    shouldCancel: opts.shouldCancel,
  })) {
    const parsed = parseJsonLine(rec.text);
    const rawBytes = Buffer.byteLength(rec.text, 'utf8');
    out.push(
      parsed.ok
        ? { line: rec.recordNo, ok: true, value: parsed.value, rawText: rec.text, rawBytes }
        : { line: rec.recordNo, ok: false, error: parsed.error, rawText: rec.text, rawBytes }
    );
  }
  return out;
}

/** 惰性索引外观：封装「索引 + 读取器」，暴露 read 单条/批次。 */
export interface LazyIndex {
  readonly lineIndex: LineIndex;
  readonly reader: ByteReader;
  readRecord(line: number, opts?: ReadRecordOpts): Promise<RecordResult>;
  readBatch(startLine: number, count: number, opts?: ReadRecordOpts): Promise<RecordResult[]>;
}

export function createLazyIndex(lineIndex: LineIndex, reader: ByteReader): LazyIndex {
  return {
    lineIndex,
    reader,
    readRecord: (line, opts) => readRecord(line, lineIndex, reader, opts),
    readBatch: (startLine, count, opts) => readBatch(startLine, count, lineIndex, reader, opts),
  };
}

/* ------------------------------------------------------------------ *
 * 读取器实现
 * ------------------------------------------------------------------ */

/** 基于内存缓冲区的读取器（测试 / 小程序号文件复用）。 */
export class MemoryReader implements ByteReader {
  readonly buffer: Buffer;
  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }
  async readBytes(start: number, length: number): Promise<Buffer> {
    if (start < 0 || length < 0 || start + length > this.buffer.length) {
      throw new RangeError(
        `MemoryReader.readBytes out of range: start=${start} length=${length} size=${this.buffer.length}`
      );
    }
    return this.buffer.subarray(start, start + length);
  }
}

/** 基于 fs.open + fd.read 的按偏移随机读读取器（大文件场景）。 */
export class FileByteReader implements ByteReader {
  private readonly path: string;
  private readonly fh: FileHandle;

  private constructor(path: string, fh: FileHandle) {
    this.path = path;
    this.fh = fh;
  }

  static async open(path: string): Promise<FileByteReader> {
    const { open } = await import('node:fs/promises');
    const fh = await open(path, 'r');
    return new FileByteReader(path, fh);
  }

  async readBytes(start: number, length: number): Promise<Buffer> {
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const r = await this.fh.read(buffer, read, length - read, start + read);
      if (r.bytesRead === 0) break; // EOF
      read += r.bytesRead;
    }
    return read === length ? buffer : buffer.subarray(0, read);
  }

  async close(): Promise<void> {
    await this.fh.close();
  }

  get pathName(): string {
    return this.path;
  }
}

export async function openFileReader(path: string): Promise<ByteReader> {
  return FileByteReader.open(path);
}
