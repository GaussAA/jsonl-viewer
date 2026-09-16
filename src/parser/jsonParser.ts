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

/** 解析单行的结果。合法行返回 value；非法行返回 error（含定位）。 */
export type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string; line: number; column: number };

/** 一条记录的读取/解析结果（供列表渲染与错误行红标定位）。 */
export interface RecordResult {
  line: number;
  ok: boolean;
  value?: unknown;
  error?: string;
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

const decodeBuffer = (buf: Buffer, len: number): string => buf.subarray(0, len).toString('utf8');

/** 将 [start, end) 原始字节区间读成一行文本，剥离行尾 `\r\n`/`\n`。 */
export async function readLineAt(
  reader: ByteReader,
  start: number,
  end: number,
  opts: ReadRecordOpts = {}
): Promise<string> {
  if (end < start) throw new RangeError(`readLineAt: end(${end}) < start(${start})`);
  const max = opts.maxLineBytes ?? 16 * 1024 * 1024;
  const len = end - start;
  if (len > max) {
    throw new Error(
      `line too large: ${len} bytes exceeds maxLineBytes ${max} (start=${start}, end=${end})`
    );
  }
  const buf = await reader.readBytes(start, len);
  return decodeBuffer(buf, trimLineEnding(buf, buf.length));
}

/** 基于索引 + 读取器，按需读取并解析第 line 行。 */
export async function readRecord(
  line: number,
  lineIndex: LineIndex,
  reader: ByteReader,
  opts: ReadRecordOpts = {}
): Promise<RecordResult> {
  const { start, end } = lineIndex.lineRange(line);
  let text: string;
  try {
    text = await readLineAt(reader, start, end, opts);
  } catch (e) {
    return {
      line,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const parsed = parseJsonLine(text);
  if (parsed.ok) return { line, ok: true, value: parsed.value };
  return { line, ok: false, error: parsed.error };
}

/** 读取并解析 [startLine, startLine+count) 的一批行（虚拟滚动请求可视区用）。 */
export async function readBatch(
  startLine: number,
  count: number,
  lineIndex: LineIndex,
  reader: ByteReader,
  opts: ReadBatchOpts = {}
): Promise<RecordResult[]> {
  if (count <= 0) return [];
  const out: RecordResult[] = [];
  const n = Math.min(count, Math.max(0, lineIndex.totalLines - startLine));
  for (let i = 0; i < n; i++) {
    // 真正的可中断：宿主 CancelToken 置位 → 立即停（不再扫剩余行、立即让出事件循环）。
    if (opts.shouldCancel?.()) return out;
    out.push(await readRecord(startLine + i, lineIndex, reader, opts));
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