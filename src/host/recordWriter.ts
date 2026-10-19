/**
 * recordWriter.ts — 单条记录的写操作：编辑 / 删除 / 插入（含写后验证与回滚）。
 *
 * 从 dataService.ts 拆出的写路径之一。这里的函数全部是**锁内实现**：
 * 加锁（`runExclusive`）只发生在 DataService 的对外入口，本文件一律不加锁，
 * 供对外入口与历史回放（historyReplay.ts）共同调用 —— 在锁内再取一次锁就是自死锁。
 *
 * 所有索引 / 句柄访问都经 `WriteContext` 现取（见 writeSupport.ts），不缓存跨 await 的旧引用。
 */

import type { LineIndex } from '../indexer/lineIndex.ts';
import type { ByteReader } from '../parser/types.ts';
import { parseJsonLine, readLineAt, readRecord as readRecordAt } from '../parser/jsonParser.ts';
import { MAX_LINE_BYTES } from '../constants.ts';
import { detectLineEnding, lineEndingBytes, replaceLine, replaceRange } from './fileWriter.ts';
import type { LineEnding } from './fileWriter.ts';
import { describeProbeFailure, probeLine, toReplaceOpts } from './dataServiceHelpers.ts';
import type { EditRecordOpts } from './dataServiceHelpers.ts';
import type { EditResultPayload } from '../protocol/rpc.ts';
import {
  editErrorResult,
  editFailure,
  guardedWrite,
  recordHistory,
  roundMs,
  type WriteContext,
} from './writeSupport.ts';

/**
 * JSONL 单行约束 + JSON 合法性校验（仅对外入口使用）。
 *
 * 物理换行会把一条记录拆成多行，从那一行起整个文件的行号与内容全部错位。合法 JSONL 行中
 * 字符串值的换行必然已转义为 `\n` 字面量。历史回放写回的 before/after 可能是多行 ——
 * 曾合法写入文件的内容，因此内部实现不做这项检查。
 *
 * @param action 失败提示里的动词（「保存」/「插入」）。
 */
function checkSingleLineJson(
  line: number,
  text: string,
  action: '保存' | '插入'
): EditResultPayload | undefined {
  if (/\r|\n/.test(text)) {
    return editFailure(
      line,
      `JSONL 每条记录必须单行（文本含换行）。请把记录并回一行后再${action}。`,
      { invalid: true }
    );
  }
  const parsed = parseJsonLine(text);
  if (!parsed.ok) {
    return editFailure(line, `JSON 校验未通过：${parsed.error}`, { invalid: true });
  }
  return undefined;
}

/**
 * 记录号是否有效（编辑 / 删除共用）。
 *
 * 口径必须是**记录号**而非物理行号：多行（pretty）文件里二者不等，按 totalLines 判上界、
 * 按物理行操作，会把一条 pretty 记录撕成碎片。
 */
function checkRecordNo(li: LineIndex, line: number): EditResultPayload | undefined {
  if (!Number.isInteger(line) || line < 0 || line >= li.totalRecords) {
    return editFailure(line, `无效记录号：${line}`);
  }
  return undefined;
}

/* ------------------------------ 编辑 ------------------------------ */

/** 编辑的入参校验（JSONL 单行约束 + JSON 合法性）；校验通过才落盘。 */
export async function editRecordChecked(
  ctx: WriteContext,
  line: number,
  text: string,
  expectedBytes?: number,
  opts: EditRecordOpts = {}
): Promise<EditResultPayload> {
  const li = await ctx.ensureIndex();
  const invalid = checkRecordNo(li, line) ?? checkSingleLineJson(line, text, '保存');
  if (invalid) return invalid;
  return editRecordInternal(ctx, line, text, expectedBytes, opts);
}

/** 被编辑记录在编辑前的定位结果。 */
interface LocatedRecord {
  /** 记录的字节区间（含行尾）。 */
  range: { start: number; end: number };
  /** 聚合原文（多行记录以 `\n` 连接）。 */
  beforeText: string;
  /** 聚合原文的 UTF-8 字节数（乐观锁比对口径）。 */
  oldContentBytes: number;
  isMultiline: boolean;
  /** 记录尾行的行尾（保持磁盘原样，不擅自规范化）。 */
  tailEnding: LineEnding;
  /** 紧邻下一条记录首行在编辑前是否合法；超长无从判定时为 undefined（跳过其写后验证）。 */
  nextRecordWasValid: boolean | undefined;
}

/**
 * 定位该记录的字节区间与聚合原文（多行记录=多行区间）。
 *
 * 顺带探明下一条记录首行的合法性，供写后验证区分「原本就是坏记录」与「本次写入弄坏了它」。
 */
async function locateRecord(
  li: LineIndex,
  reader: ByteReader,
  line: number
): Promise<{ rec: LocatedRecord } | { failure: EditResultPayload }> {
  const recRange = li.recordRange(line);
  const isMultiline = recRange.endLine > recRange.startLine;
  let tailEnding: LineEnding = 'lf';
  let nextRecordWasValid: boolean | undefined;
  const parts: string[] = [];
  const scanTo = Math.min(recRange.endLine + 2, li.totalLines);
  for await (const r of li.scan(reader, recRange.startLine, scanTo)) {
    if (r.line === recRange.endLine) {
      // 记录尾行：行尾字节数决定回写时的 ending（保持原样）
      const tailBytes = r.end - r.start - r.bytes.length;
      tailEnding = tailBytes >= 2 ? 'crlf' : 'lf';
    }
    if (r.line <= recRange.endLine) {
      if (r.error) return { failure: editFailure(line, `该记录过大，暂不支持编辑：${r.error}`) };
      parts.push(r.bytes.toString('utf8'));
    } else if (r.line === recRange.endLine + 1) {
      // 下一条记录的首行超长（error）时无从判定合法性，跳过写后验证。
      nextRecordWasValid = r.error ? undefined : parseJsonLine(r.bytes.toString('utf8')).ok;
      break;
    }
  }
  if (parts.length === 0) return { failure: editFailure(line, `记录不存在：${line}`) };
  const beforeText = parts.join('\n');

  // 字节区间：多行索引直接用分组偏移（含前导空行，一并替换无害）；
  // 紧凑快路径（multiline=false）recordRange 无偏移，用扫描给出的精确行区间。
  let range: { start: number; end: number } | undefined =
    li.multiline || isMultiline
      ? { start: recRange.startOffset, end: recRange.endOffset }
      : undefined;
  if (!range) {
    for await (const r of li.scan(reader, line, line + 1)) {
      if (r.error) return { failure: editFailure(line, `该记录过大，暂不支持编辑：${r.error}`) };
      range = { start: r.start, end: r.end };
      break;
    }
    if (!range) return { failure: editFailure(line, `记录不存在：${line}`) };
  }
  return {
    rec: {
      range,
      beforeText,
      oldContentBytes: Buffer.byteLength(beforeText, 'utf8'),
      isMultiline,
      tailEnding,
      nextRecordWasValid,
    },
  };
}

/**
 * 编辑内部实现（对外 editRecord 与历史回退/重放共用）。
 *
 * 安全与一致性要点（**顺序即正确性**）：
 *   1. **写前冲突检测**：stat 与索引基线比对（size/mtime）。不一致说明文件已被外部
 *      改动，拒绝写入并返回 conflict —— 避免基于过期视图覆写他人改动；
 *   2. **乐观锁**：`expectedBytes` 非空时须与磁盘上该记录聚合内容字节长度一致；
 *   3. **写盘**：单行记录走 `replaceLine` 快路径（索引增量平移）；多行记录走
 *      `replaceRange` 整体区间替换 + 索引全量重建（行数变化使增量失效，宁可慢不可错）；
 *   4. **索引与基线同步**：写盘成功后先换上新索引，再立刻刷新基线快照；
 *   5. **写后验证**：用新索引把该记录读回并校验，失败自动回滚；
 *   6. **历史**：验证通过才记入历史。
 *
 * **不做单行约束检查** —— 历史重放写回的 before/after 可能是多行（曾合法存在于文件中的
 * 内容），回退必须能够原样恢复。JSON / 单行校验只在对外入口（`editRecordChecked`）做。
 */
export async function editRecordInternal(
  ctx: WriteContext,
  line: number,
  text: string,
  expectedBytes?: number,
  opts: EditRecordOpts = {}
): Promise<EditResultPayload> {
  const li = await ctx.ensureIndex();

  const badNo = checkRecordNo(li, line);
  if (badNo) return badNo;

  // ① 写前冲突检测
  const conflict = await ctx.detectWriteConflict(line, opts.expectedTotalLines);
  if (conflict) return conflict;

  // ② 定位记录
  const located = await locateRecord(li, ctx.reader(), line);
  if ('failure' in located) return located.failure;
  const { range, beforeText, oldContentBytes, isMultiline, tailEnding, nextRecordWasValid } =
    located.rec;

  // ③ 乐观锁
  if (expectedBytes != null && expectedBytes !== oldContentBytes) {
    return editFailure(line, '该行内容已变化（与编辑前视图不一致），请重新加载。', {
      conflict: true,
    });
  }

  // ④⑤ 写盘 + 同步索引与基线
  return guardedWrite(
    ctx,
    (e) => editErrorResult(line, e),
    async () => {
      const rebuild = li.multiline && isMultiline;
      let ending: LineEnding = tailEnding;
      let res: Awaited<ReturnType<typeof replaceRange>>;
      if (rebuild) {
        // —— 多行记录：整体区间替换为单行新文本（记录数 1→1）+ 索引全量重建 ——
        // 行数变化打破增量平移的前提；重建 = 全文件重扫（秒级），低频操作宁可慢不可错。
        const replacement = Buffer.concat([Buffer.from(text, 'utf8'), lineEndingBytes(tailEnding)]);
        res = await replaceRange(ctx.path, range, replacement, toReplaceOpts(opts));
        await ctx.rebuildIndex();
      } else {
        // —— 单行记录：原行替换快路径，索引增量平移 ——
        ending = detectLineEnding(range, oldContentBytes);
        res = await replaceLine(
          ctx.path,
          range,
          Buffer.from(text, 'utf8'),
          ending,
          toReplaceOpts(opts)
        );
        await ctx.commitIndex(li, [{ kind: 'replace', line, delta: res.bytesDelta }]);
      }

      // ⑥ 写后验证（防御性收口）：「写盘成功」的唯一可信依据是**用新索引把字节读回
      //    来仍是合法 JSON**。校验对象 = 被编辑记录（必须合法），外加紧邻下一条记录
      //    （仅在它编辑前就合法时参与）。失败 = 本次写入在某个环节损坏了内容，**立即
      //    用原文写回（回滚）**，并把根因如实带回前端。验证安排在记入历史之前。
      const verifyError = await verifyAfterRecordEdit(ctx, line, nextRecordWasValid);
      if (verifyError !== '') {
        const rollbackError = rebuild
          ? await rollbackRecordEdit(ctx, line, beforeText, tailEnding)
          : await rollbackLineEdit(ctx, line, beforeText, ending, res.bytesDelta);
        return editFailure(
          line,
          rollbackError === ''
            ? `编辑写入后自检未通过（${verifyError}），已自动回滚，文件保持编辑前状态。`
            : `编辑写入后自检未通过（${verifyError}），且自动回滚失败：${rollbackError}。请先检查文件完整性。`
        );
      }

      ctx.badLines.delete(line);
      recordHistory(ctx, { kind: 'edit', line, before: beforeText, after: text }, res.bytesDelta);
      return {
        ok: true,
        line,
        bytesDelta: res.bytesDelta,
        inPlace: res.inPlace,
        movedBytes: res.movedBytes,
        costMs: roundMs(res.costMs),
        beforeText,
      };
    }
  );
}

/**
 * 写后验证：用**新索引**把被编辑记录（以及紧邻下一条，仅当它编辑前合法）重新读回
 * 并 `parseJsonLine`。返回空串表示通过；否则返回「第 N 行：<原因>」。
 *
 * 之所以要求「读回」而不是相信写入返回值：写入 API 只知道「写了多少字节」，不知道
 * 「落盘的字节是不是我们想写的」—— 磁盘层任何一环（搬移、fsync、并发写）出错，
 * 都只有读回才能发现。
 */
async function verifyAfterRecordEdit(
  ctx: WriteContext,
  line: number,
  nextRecordWasValid: boolean | undefined
): Promise<string> {
  const index = ctx.index();
  const reader = ctx.reader();
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
 * 多行记录写坏时的回滚：用当前（重建后）索引重新定位该记录，把 `beforeText`
 * （多行原文）按其尾行尾**原样**写回，再次重建索引。返回空串表示成功。
 */
async function rollbackRecordEdit(
  ctx: WriteContext,
  line: number,
  beforeText: string,
  tailEnding: LineEnding
): Promise<string> {
  try {
    const rr = ctx.index().recordRange(line);
    const replacement = Buffer.concat([
      Buffer.from(beforeText, 'utf8'),
      lineEndingBytes(tailEnding),
    ]);
    await replaceRange(ctx.path, { start: rr.startOffset, end: rr.endOffset }, replacement, {});
    await ctx.rebuildIndex();
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
async function rollbackLineEdit(
  ctx: WriteContext,
  line: number,
  beforeText: string,
  ending: LineEnding,
  previousDelta: number
): Promise<string> {
  try {
    const index = ctx.index();
    const reader = ctx.reader();
    let range: { start: number; end: number } | undefined;
    for await (const r of index.scan(reader, line, line + 1)) {
      if (r.error) throw new Error(r.error);
      range = { start: r.start, end: r.end };
      break;
    }
    if (!range) return '定位不到该行';
    await replaceLine(ctx.path, range, Buffer.from(beforeText, 'utf8'), ending, {});
    await ctx.commitIndex(index, [{ kind: 'replace', line, delta: -previousDelta }]);
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/* ------------------------------ 删除 ------------------------------ */

/**
 * 删除第 `line` 条记录（含行尾）。行数减一，其后所有行的行号**前移一位**。
 *
 * 前置保护与编辑一致（写前冲突检测）；落盘复用写入层同一原语 `replaceRange`
 * （空 replacement 即区间删除），随后同步索引与基线快照。
 */
export async function deleteRecordInternal(
  ctx: WriteContext,
  line: number,
  opts: EditRecordOpts = {}
): Promise<EditResultPayload> {
  const li = await ctx.ensureIndex();
  const reader = ctx.reader();

  // 口径是记录号（见 checkRecordNo）：此前按 totalLines 判上界、按物理行删除 ——
  // 用户选中的是一条 pretty 记录，落盘却只删了它的首行，把整条记录撕成碎片。
  const badNo = checkRecordNo(li, line);
  if (badNo) return badNo;
  const conflict = await ctx.detectWriteConflict(line, opts.expectedTotalLines);
  if (conflict) return conflict;

  // 定位**整条记录**：紧凑文件 = 单个物理行（沿用探测路径）；多行文件 = 记录区间
  // （recordRange 直接给出字节偏移；紧凑文件的该值为 -1，不可用）。
  let start: number;
  let end: number;
  if (li.multiline) {
    const rr = li.recordRange(line);
    if (rr.endOffset - rr.startOffset > MAX_LINE_BYTES) {
      return editFailure(line, `该记录过大，暂不支持删除：超过 ${MAX_LINE_BYTES} 字节`);
    }
    start = rr.startOffset;
    end = rr.endOffset;
  } else {
    const probed = await probeLine(li, reader, line);
    if (!probed.ok) {
      return editFailure(line, describeProbeFailure(line, probed.reason));
    }
    start = probed.start;
    end = probed.end;
  }
  const removedBytes = end - start;
  // 旧原文用于撤销：删除的逆操作就是把这段文本插回去（多行记录 = 聚合原文，
  // 撤销路径不做单行 / JSON 校验 —— 见 insertRecord 对外入口的说明）。
  const removedText = await readLineAt(reader, start, end).catch(() => '');

  return guardedWrite(
    ctx,
    (e) => editErrorResult(line, e),
    async () => {
      const res = await replaceRange(
        ctx.path,
        { start, end },
        Buffer.alloc(0),
        toReplaceOpts(opts)
      );
      await ctx.commitIndex(li, [{ kind: 'delete', line, bytes: removedBytes }]);
      ctx.badLines.shiftAfterDelete(line);
      recordHistory(ctx, { kind: 'delete', line, before: removedText }, res.bytesDelta);
      return {
        ok: true,
        line,
        bytesDelta: res.bytesDelta,
        inPlace: res.inPlace,
        movedBytes: res.movedBytes,
        costMs: roundMs(res.costMs),
        beforeText: removedText,
      };
    }
  );
}

/* ------------------------------ 插入 ------------------------------ */

/**
 * 插入的入参校验（对外入口，在取锁**之前**调用）。
 *
 * 单行与 JSON 约束只放这一层 —— 历史重放（撤销「删除」）必须能把**多行 / 当年就是坏记录**
 * 的原文原样插回，故 `insertRecordInternal` 不做这两项检查
 * （与编辑「对外校验、内部放行」的分层完全一致）。
 */
export function validateInsertText(at: number, text: string): EditResultPayload | undefined {
  return checkSingleLineJson(at, text, '插入');
}

/**
 * 在第 `at` 条记录**之前**插入一行（`at === totalRecords` 表示追加到文件末尾）。
 *
 * 新行的行尾风格取「参考行」——优先前一行，其次插入点所在行；二者皆无（空文件）用 LF。
 * 这样在 CRLF 文件里插入的行同样是 CRLF，不会把行尾风格搅乱。
 */
export async function insertRecordInternal(
  ctx: WriteContext,
  at: number,
  text: string,
  opts: EditRecordOpts = {}
): Promise<EditResultPayload> {
  const li = await ctx.ensureIndex();
  const reader = ctx.reader();

  if (!Number.isInteger(at) || at < 0 || at > li.totalRecords) {
    return editFailure(at, `无效插入位置：${at}`);
  }
  const conflict = await ctx.detectWriteConflict(at, opts.expectedTotalLines);
  if (conflict) return conflict;

  // 插入点 = 第 at 条**记录**的起始偏移（多行文件里记录号 ≠ 物理行号，此前按物理行
  // 探测会把新行插进前面的 pretty 记录中间）；at === totalRecords 表示追加到文件末尾。
  // 行尾参考：优先前一条记录的尾行（保持 CRLF 文件的风格），at === 0 则取首条记录首行。
  let insertAt = li.totalBytes;
  let refEnding: LineEnding | undefined;
  if (at < li.totalRecords) {
    if (li.multiline) {
      insertAt = li.recordRange(at).startOffset;
      const refLine = at > 0 ? li.recordRange(at - 1).endLine : li.recordRange(0).startLine;
      const probed = await probeLine(li, reader, refLine);
      refEnding = probed.ok ? probed.ending : undefined;
    } else {
      const probed = await probeLine(li, reader, at);
      if (!probed.ok) return editFailure(at, describeProbeFailure(at, probed.reason));
      insertAt = probed.start;
      if (at > 0) {
        const prev = await probeLine(li, reader, at - 1);
        refEnding = (prev.ok ? prev.ending : undefined) ?? probed.ending;
      } else {
        refEnding = probed.ending;
      }
    }
  }
  // 参考行若位于文件末尾且原本无换行，插入的新行仍须自带行尾（否则会与下一行粘连）。
  const ending: LineEnding = !refEnding || refEnding === 'none' ? 'lf' : refEnding;
  const newLineBytes = Buffer.concat([Buffer.from(text, 'utf8'), lineEndingBytes(ending)]);

  return guardedWrite(
    ctx,
    (e) => editErrorResult(at, e),
    async () => {
      const res = await replaceRange(
        ctx.path,
        { start: insertAt, end: insertAt },
        newLineBytes,
        toReplaceOpts(opts)
      );
      await ctx.commitIndex(li, [{ kind: 'insert', line: at, bytes: newLineBytes.length }]);
      ctx.badLines.shiftAfterInsert(at);
      recordHistory(ctx, { kind: 'insert', line: at, text }, res.bytesDelta);
      return {
        ok: true,
        line: at,
        bytesDelta: res.bytesDelta,
        inPlace: res.inPlace,
        movedBytes: res.movedBytes,
        costMs: roundMs(res.costMs),
      };
    }
  );
}
