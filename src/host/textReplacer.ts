/**
 * textReplacer.ts — 批量改写：全文查找替换 / 按行号写回 / 字段级替换。
 *
 * 从 dataService.ts 拆出的写路径之一。三者共用同一条落盘路径 `applyEdits`
 * （释放句柄 → 原子重写 → 拿回句柄 → 更新索引 → 刷新基线 → 记历史），
 * 避免各写一份时序（那是最易漏步的地方）。
 *
 * 与 recordWriter.ts 一样全部是**锁内实现**：加锁只发生在 DataService 对外入口。
 */

import { parseJsonLine } from '../parser/jsonParser.ts';
import { planLineReplace } from '../core/replaceLogic.ts';
import { jsonValueEquals, locateValue, replaceValueAtPath } from '../core/jsonSpan.ts';
import {
  MAX_REPLACE_UNDO_BYTES,
  MAX_REPLACE_UNDO_LINES,
  SEARCH_MAX_RESULTS,
} from '../constants.ts';
import type { IndexDeltaOp, LineIndex } from '../indexer/lineIndex.ts';
import type { ReplaceResultPayload } from '../protocol/rpc.ts';
import { throttleProgress } from './dataServiceHelpers.ts';
import {
  guardedWrite,
  newReplacePlan,
  pushLineEdit,
  recordHistory,
  replaceErrorResult,
  replaceFailure,
  replaceOk,
  roundMs,
  type ReplaceOpts,
  type ReplacePlan,
  type WriteContext,
} from './writeSupport.ts';

/**
 * 写前冲突检测的「批量」口径：没有单一行号，失败回执换成 ReplaceResultPayload 形状。
 * 返回 undefined 表示无冲突。
 */
async function batchConflict(
  ctx: WriteContext,
  opts: ReplaceOpts
): Promise<ReplaceResultPayload | undefined> {
  const conflict = await ctx.detectWriteConflict(-1, opts.expectedTotalLines);
  if (!conflict) return undefined;
  return replaceFailure(conflict.error ?? '文件已被外部修改', { conflict: true });
}

/**
 * 全文查找替换：把每一命中行中的 `query` 字面量替换为 `replacement`，一次性落盘。
 *
 * 流程即正确性：
 *   1. **复用搜索定位命中行** —— 搜索即预览，不另造一套预览机制（用户在工具栏已看到命中数）；
 *   2. **一次顺序扫过命中区间取原文** —— 成本 O(命中区间)，与整体重写同阶，不做逐行随机读；
 *   3. **逐行校验替换后的 JSON** —— 非法则该行跳过（个别行失败不该拖垮整批，但必须如实统计）；
 *   4. **原子重写** —— 写同目录临时文件再 rename，失败时用户拿到的仍是完整旧文件；
 *   5. **索引增量 + 基线快照** —— 行数不变，逐行平移其后检查点即可，无需重建。
 *
 * 查询为空直接拒绝：空串会匹配每一行的每个位置，那不是「替换」而是毁文件。
 * 命中数达到搜索上限（truncated）时同样拒绝 —— 我们无法确认待改行的全集，
 * 在此基础上的「批量替换」是不可控的。
 */
export async function replaceTextInternal(
  ctx: WriteContext,
  query: string,
  replacement: string,
  opts: ReplaceOpts = {}
): Promise<ReplaceResultPayload> {
  if (!query) return replaceFailure('查找内容不能为空');

  const li = await ctx.ensureIndex();
  const reader = ctx.reader();

  const conflict = await batchConflict(ctx, opts);
  if (conflict) return conflict;

  // 多行（pretty）文件暂不支持批量文本替换：替换以物理行为单位，会跨记录边界
  // 破坏多行记录的结构。逐条编辑（双击/铅笔）在多行文件下完全可用。
  if (li.multiline) {
    return replaceFailure(
      '多行（pretty）文件暂不支持批量替换：替换以物理行为单位，会破坏跨行记录的结构。请逐条编辑。'
    );
  }

  // ① 搜索定位（走 host：worker 或主线程兜底）
  const found = await ctx.search(query, undefined, 'all');
  // 被中断的搜索只知道「扫到哪儿」，此后是否还有命中一无所知 ——
  // 基于它做批量改写就是「漏改一批行却报成功」，宁可拒绝重来。
  if (found.cancelled) {
    return replaceFailure('查找在扫描完成前被中断，无法确认待改行的全集，已拒绝批量替换；请重试。');
  }
  if (found.truncated) {
    return replaceFailure(
      `命中行超过 ${SEARCH_MAX_RESULTS} 行，无法确认待改行的全集，已拒绝批量替换；请缩小查找范围。`
    );
  }
  if (found.matches.length === 0) {
    return replaceOk(0, 0, 0, 0, 0, false);
  }

  // ② 一次顺序扫过命中行区间，取出原文并规划替换
  const hitSet = new Set(found.matches);
  const first = found.matches[0];
  const last = found.matches[found.matches.length - 1];
  const plan = newReplacePlan();

  // 替换后含物理换行 = 把一条记录拆成多行，与「JSONL 单行约束」同罪
  //（统计上计入 invalid，与其他非法结果一致，不静默略过）。
  const validate = (t: string): boolean => !/\r|\n/.test(t) && parseJsonLine(t).ok;

  for await (const r of li.scan(reader, first, last + 1)) {
    if (!hitSet.has(r.line)) continue;
    // 超长行（scan 以 error 标记）无法安全取出与改回，计入跳过而非静默略过。
    if (r.error) {
      plan.skippedInvalid++;
      continue;
    }
    const raw = r.bytes.toString('utf8');
    const planned = planLineReplace(raw, query, replacement, {
      caseInsensitive: opts.caseInsensitive,
      validate,
    });
    if (!planned.text) {
      if (planned.skip === 'invalid-json') plan.skippedInvalid++;
      else plan.unchanged++;
      continue;
    }
    pushLineEdit(plan, r, raw, planned.text);
  }

  const total = found.matches.length;
  if (plan.edits.length === 0) {
    return replaceOk(0, plan.skippedInvalid, plan.unchanged, total, 0, false);
  }
  return applyEdits(ctx, li, plan, total, opts);
}

/**
 * 按行号批量写回指定文本（批量替换的撤销 / 重做走这条路）。
 *
 * 与 `replaceTextInternal` 的区别只在「规划」阶段：这里不做查询匹配，直接接受
 * 「这些行该是什么」。撤销必须走批量重写而非逐行 `editRecord` —— 后者是 N 次尾部搬移
 * （成本 Σ(改动点距 EOF)），撤销一次 5000 行的替换可能要几分钟；批量重写恒为 O(文件大小)。
 */
export async function applyLineTexts(
  ctx: WriteContext,
  entries: readonly { line: number; text: string }[],
  opts: ReplaceOpts = {}
): Promise<ReplaceResultPayload> {
  const li = await ctx.ensureIndex();
  const reader = ctx.reader();

  // 目标行 → 期望文本（重复行号后者覆盖前者，避免同一区间被规划两次）
  const wanted = new Map<number, string>();
  for (const e of entries) {
    if (Number.isInteger(e.line) && e.line >= 0 && e.line < li.totalRecords) {
      wanted.set(e.line, e.text);
    }
  }
  if (wanted.size === 0) return replaceFailure('没有可写回的行');

  const conflict = await batchConflict(ctx, opts);
  if (conflict) return conflict;

  const lines = [...wanted.keys()].toSorted((a, b) => a - b);
  const plan = newReplacePlan();

  for await (const r of li.scan(reader, lines[0], lines[lines.length - 1] + 1)) {
    const text = wanted.get(r.line);
    if (text === undefined) continue;
    if (r.error) {
      plan.skippedInvalid++;
      continue;
    }
    const raw = r.bytes.toString('utf8');
    if (raw === text) {
      plan.unchanged++;
      continue;
    }
    // 写回的内容同样要过 JSON 校验：撤销的是「曾经合法的内容」，但磁盘可能已被
    // 外部改过，此处不能假设它一定还合法。
    if (!parseJsonLine(text).ok) {
      plan.skippedInvalid++;
      continue;
    }
    pushLineEdit(plan, r, raw, text);
  }

  if (plan.edits.length === 0) {
    return replaceOk(0, plan.skippedInvalid, plan.unchanged, wanted.size, 0, false);
  }
  return applyEdits(ctx, li, plan, wanted.size, opts);
}

/**
 * 批量字段级替换：把所有行中「指定路径下的值恰好等于 `from`」的字段改成 `to`。
 *
 * 与 `replaceTextInternal` 的本质区别：匹配的是**该路径下的值**（结构化语义），而非行内文本。
 * 把每行的 `status: "pending"` 改成 `"done"` 时，正文里恰好含 "pending" 字样的字段
 * 不应被波及 —— 这正是本能力相对整行替换的存在意义。
 *
 * 落盘复用 `applyLineTexts`：冲突检测、批量原子重写、撤销栈都在那里，复制必漂移。
 * 本方法只负责「规划」—— 找出哪些行该变成什么样。规划阶段（全文件逐行定位）是耗时
 * 主体，进度与取消由这里自管；写入阶段的重写进度由 `applyEdits` 继续接管，两种进度
 * 共用同一个 `onProgress` 通道，前端横幅表现为「扫描 → 重写」连续推进。
 */
export async function replaceFieldInternal(
  ctx: WriteContext,
  path: readonly (string | number)[],
  from: unknown,
  to: unknown,
  opts: ReplaceOpts = {}
): Promise<ReplaceResultPayload> {
  if (!Array.isArray(path) || path.length === 0) {
    return replaceFailure('字段路径不能为空（改整行请用批量替换）。');
  }
  // from/to 必须是合法 JSON 值。`JSON.stringify(undefined)` 返回 undefined 而**不抛错**，
  // 故 undefined 须显式拒绝 —— 否则一个来自上游 bug 的 undefined 会变成「永远匹配不到」，
  // 用户看到的是一次安静的无操作，而不是一声报错。
  if (from === undefined || to === undefined) {
    return replaceFailure('匹配值或新值不能为 undefined。');
  }
  try {
    JSON.stringify(from);
    JSON.stringify(to);
  } catch {
    // from 或 to 包含循环引用等无法序列化的值
    return replaceFailure('匹配值或新值无法序列化为 JSON。');
  }

  const li = await ctx.ensureIndex();
  const reader = ctx.reader();

  // 多行（pretty）文件暂不支持批量字段替换：按记录聚合替换的写入路径尚未打通。
  // 逐条编辑（双击/铅笔）在多行文件下完全可用。
  if (li.multiline) {
    return replaceFailure(
      '多行（pretty）文件暂不支持批量字段替换。请逐条编辑（双击字段值或点铅笔）。'
    );
  }

  const conflict = await batchConflict(ctx, opts);
  if (conflict) return conflict;

  const report = throttleProgress(opts.onProgress);
  const entries: { line: number; text: string }[] = [];
  let skippedInvalid = 0;
  let unchanged = 0;
  const total = li.totalRecords;
  const totalBytes = li.totalBytes;

  for await (const r of li.scan(reader, 0, total)) {
    // 进度按字节报（与其它长任务同一分母），节流由 helper 管。
    report?.({ processedBytes: r.end, totalBytes });
    if (opts.shouldCancel?.()) {
      // 扫描是纯读 —— 中止时磁盘未被触碰，与「写入前取消」同等零风险。
      return { ...replaceFailure('已取消'), cancelled: true };
    }
    // 超长行无法安全取出与改回，计入跳过而非静默略过（与 replaceText 同一口径）。
    if (r.error) {
      skippedInvalid++;
      continue;
    }
    const raw = r.bytes.toString('utf8');
    // scan 本身不做 JSON 校验（r.error 只标记超长行），非法行在这里判定 ——
    // 与 replaceText 的「替换后非法才跳过」不同：本操作的**原文**就必须合法，
    // 否则无法定位字段（也无法保证改完仍是合法 JSONL）。
    if (!parseJsonLine(raw).ok) {
      skippedInvalid++;
      continue;
    }
    const span = locateValue(raw, path);
    if (!span) {
      // 路径在该行不存在：该行本就不在本次改动的目标范围内，计入 unchanged。
      unchanged++;
      continue;
    }
    let current: unknown;
    try {
      current = JSON.parse(raw.slice(span.start, span.end));
    } catch {
      // locateValue 已保证区间是完整合法的 JSON token，此处只是纵深防御。
      skippedInvalid++;
      continue;
    }
    if (!jsonValueEquals(current, from)) {
      unchanged++;
      continue;
    }
    const replaced = replaceValueAtPath(raw, path, to);
    if (!replaced.ok) {
      unchanged++;
      continue;
    }
    entries.push({ line: r.line, text: replaced.text });
  }
  report?.({ processedBytes: totalBytes, totalBytes }); // 终态必发：停在 96% 比没有进度条更糟

  if (entries.length === 0) {
    return replaceOk(0, skippedInvalid, unchanged, total, 0, false);
  }
  const res = await applyLineTexts(ctx, entries, opts);
  // 扫描阶段的统计（跳过 / 未匹配）与写入结果合并 —— 缺了任何一半，数字都是错的。
  return res.ok
    ? {
        ...res,
        skippedInvalid: res.skippedInvalid + skippedInvalid,
        unchanged: res.unchanged + unchanged,
        total,
      }
    : res;
}

/**
 * 把规划好的编辑一次落盘，并同步索引与基线快照。
 *
 * 这是批量改写的**唯一落盘路径**：查找替换、撤销、重做都走它，避免各写一份
 * 「释放句柄 → 原子重写 → 拿回句柄 → 更新索引 → 刷新基线」的时序（那是最易漏步的地方）。
 */
async function applyEdits(
  ctx: WriteContext,
  li: LineIndex,
  plan: ReplacePlan,
  total: number,
  opts: ReplaceOpts
): Promise<ReplaceResultPayload> {
  const { edits, deltas, changes, skippedInvalid, unchanged } = plan;
  return guardedWrite(ctx, replaceErrorResult, async () => {
    const res = await ctx.rewriteAtomic(edits, opts);
    // 索引增量更新：行数不变，逐行平移其后检查点（op 顺序自身无关，但与多种 op 混合时相关）
    // 一次批量 op 走同一条路 —— 宿主侧会用同一函数、同一顺序应用，两侧不会漂移。
    await ctx.commitIndex(
      li,
      deltas.map<IndexDeltaOp>((d) => ({ kind: 'replace', line: d.line, delta: d.delta }))
    );
    ctx.badLines.deleteMany(deltas.map((d) => d.line));

    const undoBytes = changes.reduce((a, c) => a + c.before.length + c.after.length, 0);
    const undoable =
      changes.length <= MAX_REPLACE_UNDO_LINES && undoBytes <= MAX_REPLACE_UNDO_BYTES;

    // 注：本函数也被 applyLineTexts 调用（历史回退的原语），那时的 `history.applying`
    // 为真，recordHistory 会自动跳过 —— 否则每撤销一次就会生成一条新记录。
    recordHistory(ctx, { kind: 'replaceAll', changes }, res.bytesDelta);

    return {
      ok: true,
      replaced: edits.length,
      skippedInvalid,
      unchanged,
      total,
      bytesDelta: res.bytesDelta,
      costMs: roundMs(res.costMs),
      changes: undoable ? changes : undefined,
      undoable,
    };
  });
}
