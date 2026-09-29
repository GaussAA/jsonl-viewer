/**
 * profileEngine.ts — 全量 Schema / 数据质量画像（F4）。
 *
 * 与 `inferFields` 的关系是「抽样 vs 全量」，而这正是它存在的理由：
 * 字段推断只看**前 200 条**（`jsonlViewer.sampleLines`），于是「第 30 万行才出现的
 * 可选字段」「某字段 60% 为空」「某状态码 99% 都是同一个值」这类结论，抽样永远看不见 ——
 * 而脏数据体检恰恰是查看器的典型用途（仓库 `samples/` 里放的就是真实业务数据）。
 *
 * 设计取舍（都为了让内存**有界**，因为这是在多 GB 文件上跑全量）：
 *
 *   1. **只统计顶层 key**。深层字段的组合会爆炸（`a.b.c` 与 `a.b.d` 各自计数，
 *      嵌套一深就是无底洞），而真实数据的质量问题绝大多数在顶层就看得见。
 *   2. **值分布用固定容量 + 去重上限**。每字段只保留 top N，且 distinct 值超过上限后
 *      归入「其他」并标记截断 —— 否则一个高基数字段（如 timestamp）能把堆吃光。
 *   3. **值文本截断**（默认 60 字符）。一个 1MB 的字符串字段不该在画像里占 1MB。
 *   4. **不落盘缓存**。容量与隐私双考虑，与「会话历史不持久化」的既有决策同调
 *      （见 EDIT_FEATURE_PLAN 决策 20）。
 *
 * 完整性语义**照抄 `scanBadLines`**：`cancelled`（用户中断，结果不可信）与
 * `fieldsTruncated`（字段数触顶）严格分开 —— 前者是「没扫完」，后者是「扫完了但只留了这些」，
 * 界面文案与可信度完全不同。
 *
 * 仅依赖 `parser/jsonParser` 与 `indexer/lineIndex`，不依赖 `vscode`，可直接单测。
 */

import { ARRAY_RECORD_KEY, SCALAR_RECORD_KEY, fieldTypeOf } from '../core/query.ts';
import { parseJsonLine, scanRecords } from '../parser/jsonParser.ts';
import type { ByteReader } from '../parser/jsonParser.ts';
import type { LineIndex } from '../indexer/lineIndex.ts';

/** 每字段保留的 top 值数量。 */
export const PROFILE_TOP_VALUES = 5;

/** 单个值文本保留的最长字符数（超出截断）。 */
export const PROFILE_VALUE_MAX_LEN = 60;

/** 统计的顶层字段数上限：超过后新字段被忽略并置 `fieldsTruncated`。 */
export const PROFILE_MAX_FIELDS = 200;

/** 每字段去重值的容量上限：超过后新值归入「其他」并置该字段 `topTruncated`。 */
export const PROFILE_MAX_DISTINCT = 200;

/** 主导类型的平手优先序（与 inferFields 保持一致，避免两处给出不同答案）。 */
const TYPE_PRIORITY = ['object', 'array', 'string', 'number', 'boolean', 'null', 'undefined'];

/** 单个字段的画像。 */
export interface FieldProfile {
  key: string;
  /** 该键**存在**的记录数（含显式 null）。 */
  present: number;
  /** 该键缺失的记录数（= 成功解析的记录数 − present）。 */
  missing: number;
  /** 显式 null 的次数。 */
  nulls: number;
  /** 空字符串的次数。 */
  empties: number;
  /** 类型 → 次数。 */
  types: Record<string, number>;
  /** 主导类型（出现最多者；平手按 TYPE_PRIORITY）。 */
  type: string;
  /** top 取值（按次数降序，容量 PROFILE_TOP_VALUES）。 */
  top: Array<{ value: string; count: number }>;
  /** 值分布是否因去重容量而截断 —— true 表示 top 之外还有未计入的取值。 */
  valuesTruncated: boolean;
}

/** 全量画像结果。 */
export interface ProfileResult {
  /** 扫描的记录数（含坏记录）。 */
  scanned: number;
  /** 成功解析并参与统计的记录数。 */
  parsed: number;
  /** 解析失败被跳过的记录数。 */
  bad: number;
  /** 文件中的总记录数。 */
  totalRecords: number;
  totalLines: number;
  /** 各顶层字段的画像（按 present 降序）。 */
  fields: FieldProfile[];
  /** 是否因顶层字段数触顶而丢弃了部分字段。 */
  fieldsTruncated: boolean;
  /** 是否被主动取消（结果只是扫到一半的片段，**不可信**）。 */
  cancelled?: boolean;
  costMs: number;
}

export interface ProfileOpts {
  shouldCancel?: () => boolean;
  onProgress?: (info: { processedBytes: number; totalBytes: number }) => void;
  /** 进度节流间隔（毫秒）；0 表示每条都推。 */
  throttleMs?: number;
}

/** 内部累计器（对外只暴露整理后的 FieldProfile）。 */
interface Accum {
  present: number;
  nulls: number;
  empties: number;
  types: Map<string, number>;
  distinct: Map<string, number>;
  /** 超出 PROFILE_MAX_DISTINCT 的取值次数合计。 */
  overflow: number;
}

/** 值 → 参与分布统计的文本（截断到 PROFILE_VALUE_MAX_LEN）。 */
function valueText(v: unknown): string {
  let t: string;
  if (v === null) t = 'null';
  else if (v === undefined) t = '';
  else if (typeof v === 'string') t = v;
  else if (typeof v === 'object') {
    try {
      t = JSON.stringify(v) ?? String(v);
    } catch {
      t = String(v);
    }
  } else t = String(v);
  return t.length > PROFILE_VALUE_MAX_LEN ? `${t.slice(0, PROFILE_VALUE_MAX_LEN)}…` : t;
}

function pickDominantType(types: Map<string, number>): string {
  let best = '';
  let bestCount = -1;
  for (const t of TYPE_PRIORITY) {
    const c = types.get(t) ?? 0;
    if (c > bestCount) {
      bestCount = c;
      best = t;
    }
  }
  return best;
}

/**
 * 全文件流式扫描并统计画像。
 *
 * 与 `scanBadLines` 共用 `scanRecords` 这条记录分组骨架：多行（pretty）文件里一条记录
 * 跨多个物理行，必须整体 parse —— 按物理行统计会把 pretty 的中间行全部当成垃圾。
 */
export async function profileRecords(
  reader: ByteReader,
  li: LineIndex,
  opts: ProfileOpts = {}
): Promise<ProfileResult> {
  const started = performance.now();
  const totalBytes = li.totalBytes;
  const throttleMs = opts.throttleMs ?? 100;
  const accs = new Map<string, Accum>();
  let scanned = 0;
  let parsed = 0;
  let bad = 0;
  let fieldsTruncated = false;
  let lastTick = 0;
  let cancelled = false;

  const bump = (key: string, value: unknown): void => {
    let a = accs.get(key);
    if (!a) {
      if (accs.size >= PROFILE_MAX_FIELDS) {
        fieldsTruncated = true; // 触顶后不再新建字段，但**如实标记**
        return;
      }
      a = { present: 0, nulls: 0, empties: 0, types: new Map(), distinct: new Map(), overflow: 0 };
      accs.set(key, a);
    }
    a.present++;
    const t = fieldTypeOf(value);
    a.types.set(t, (a.types.get(t) ?? 0) + 1);
    if (value === null) a.nulls++;
    else if (value === '') a.empties++;

    const text = valueText(value);
    const seen = a.distinct.get(text);
    if (seen !== undefined) {
      a.distinct.set(text, seen + 1);
    } else if (a.distinct.size < PROFILE_MAX_DISTINCT) {
      a.distinct.set(text, 1);
    } else {
      // 去重容量触顶：新值只汇总计数，不再占用内存（字典序 ASCII 有序，便于日后加取样）。
      a.overflow++;
    }
  };

  const shouldCancel = (): boolean => {
    if (cancelled) return true;
    if (opts.shouldCancel?.()) cancelled = true;
    return cancelled;
  };

  for await (const rec of scanRecords(0, li.totalRecords, li, reader, { shouldCancel })) {
    if (cancelled) break;
    scanned++;
    // 进度按字节节流；**终态必发**（停在 96% 的进度条比没有进度条更糟）。
    const now = performance.now();
    if (scanned >= li.totalRecords || now - lastTick >= throttleMs) {
      lastTick = now;
      opts.onProgress?.({ processedBytes: rec.endOffset, totalBytes });
    }

    const res = parseJsonLine(rec.text);
    if (!res.ok || res.value === undefined) {
      bad++;
      continue;
    }
    parsed++;
    const v = res.value;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) bump(k, val);
    } else {
      // 数组 / 标量记录：与推断字段同一套伪键，避免「整条记录无处安放」。
      bump(Array.isArray(v) ? ARRAY_RECORD_KEY : SCALAR_RECORD_KEY, v);
    }
  }

  const fields: FieldProfile[] = [];
  for (const [key, a] of accs) {
    const sorted = [...a.distinct.entries()].toSorted((x, y) => y[1] - x[1]);
    const top = sorted.slice(0, PROFILE_TOP_VALUES).map(([value, count]) => ({ value, count }));
    if (a.overflow > 0) top.push({ value: '（其他未计入的取值）', count: a.overflow });
    fields.push({
      key,
      present: a.present,
      missing: parsed - a.present,
      nulls: a.nulls,
      empties: a.empties,
      types: Object.fromEntries(a.types),
      type: pickDominantType(a.types),
      top,
      valuesTruncated: a.overflow > 0 || sorted.length > PROFILE_TOP_VALUES,
    });
  }
  fields.sort((x, y) => y.present - x.present || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));

  return {
    scanned,
    parsed,
    bad,
    totalRecords: li.totalRecords,
    totalLines: li.totalLines,
    fields,
    fieldsTruncated,
    ...(cancelled ? { cancelled: true } : {}),
    costMs: Math.round(performance.now() - started),
  };
}

/**
 * 把画像结果压成一句可读结论（供面板抬头 / 徽章 tooltip）。
 *
 * 不把 JSON 直接甩给用户：画像的价值在于**结论**（有几个字段、多少灰字段、有没有坏行），
 * 而不是一堆数字。
 */
export function describeProfile(res: ProfileResult): string {
  if (res.cancelled) return '画像已中断（结果不完整，不可据以判断）';
  const total = res.parsed;
  const sparse = res.fields.filter((f) => total > 0 && f.present / total < 1).length;
  const parts = [
    `扫描 ${total.toLocaleString('en-US')} 条记录`,
    `${res.fields.length} 个顶层字段`,
    sparse > 0 ? `${sparse} 个并非每条都有` : '所有字段覆盖完整',
  ];
  if (res.bad > 0) parts.push(`${res.bad} 条解析失败`);
  if (res.fieldsTruncated) parts.push('字段数已达上限，仅统计前若干');
  return parts.join(' · ');
}
