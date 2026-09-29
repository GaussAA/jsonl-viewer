/**
 * core/query.ts — 字段过滤评估的「共享纯逻辑层」（零依赖）。
 *
 * 抽离自 webview/queryLogic.ts。宿主（searchEngine / dataService / indexHost …）
 * 与 webview 两侧都需要对「字段过滤条件」做一致的求值，但宿主此前反向依赖了
 * webview 层（DIP 违反，见 docs/ARCHITECTURE_REVIEW.md 债务 T3）。
 *
 * 本模块刻意不 import 任何 host / node / DOM / webview 模块：既能被宿主安全复用
 * （不把 webview 依赖带进扩展宿主），也能被 webview 打包（IIFE 无 node:fs 泄漏），
 * 且可直接 `node:test` 单测。webview/queryLogic.ts 通过 re-export 保留旧符号，
 * 既有 webview 调用方无需改动。
 */

/* ------------------------------ 常量 ------------------------------ */

/** 数组型记录的伪字段键（与推断字段对齐，但避免宿主依赖 webview）。 */
export const ARRAY_RECORD_KEY = '$array';
/** 标量型记录的伪字段键。 */
export const SCALAR_RECORD_KEY = '$value';

/* --------------------- 类型：字段过滤条件 --------------------- */

export type FilterOp = 'eq' | 'contains' | 'exists' | 'type';

/** 字段值过滤条件（序列化友好，可直接存 workspaceState）。 */
export interface FieldCondition {
  field: string;
  op: FilterOp;
  value: string;
  negate?: boolean;
  /** 字符串比较是否忽略大小写；默认 true。数字/布尔比较也做大小写归一（无副作用）。 */
  caseInsensitive?: boolean;
}

/* ------------------- 值 → 类型（本地轻量实现） ------------------- */

export type LocalFieldType =
  'string' | 'number' | 'boolean' | 'null' | 'object' | 'array' | 'undefined';

export function fieldTypeOf(value: unknown): LocalFieldType {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'object':
      return 'object';
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'undefined';
  }
}

/* --------------------- 过滤评估的纯函数 --------------------- */

/** 任意值 → 参与字符串比较的文本；对象/数组 JSON 化，其余 String。 */
export function stringifyValue(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * 从一条记录中取出指定字段的值用于评估。
 * 顶层伪字段 $array / $value 指向「整条记录」（当记录本身是数组 / 标量时）。
 */
export function recordFieldValue(record: unknown, field: string): unknown {
  if (!field) return undefined;
  if (record === null || record === undefined) return undefined;
  if (Array.isArray(record)) return field === ARRAY_RECORD_KEY ? record : undefined;
  if (typeof record === 'object') {
    if (field === ARRAY_RECORD_KEY || field === SCALAR_RECORD_KEY) return record;
    return (record as Record<string, unknown>)[field];
  }
  return field === SCALAR_RECORD_KEY ? record : undefined;
}

/** 对「单个字段值」求值过滤条件（条件作用于值本身；recordFieldValue 负责取字段）。 */
export function matchesFilter(value: unknown, cond: FieldCondition): boolean {
  const ci = cond.caseInsensitive !== false;
  let ok: boolean;
  switch (cond.op) {
    case 'exists':
      ok = value !== undefined && value !== null;
      break;
    case 'type': {
      const t = fieldTypeOf(value);
      ok = t === cond.value;
      break;
    }
    case 'eq': {
      const s = stringifyValue(value);
      ok = ci ? s.toLowerCase() === cond.value.toLowerCase() : s === cond.value;
      break;
    }
    case 'contains': {
      const s = stringifyValue(value);
      ok =
        cond.value === '' ||
        (ci ? s.toLowerCase().includes(cond.value.toLowerCase()) : s.includes(cond.value));
      break;
    }
    default:
      ok = false;
  }
  return cond.negate ? !ok : ok;
}

/** 空条件（无字段 / 无 op）视为「不过滤」。 */
export function isEmptyCondition(cond: FieldCondition | null | undefined): boolean {
  return !cond || !cond.field || !cond.op;
}

/* --------------------- 命中区间（高亮的单一来源） --------------------- */

/**
 * 在文本中找出 `needle` 的全部**非重叠**出现区间（左到右）。
 *
 * 为何放在 core：宿主侧的搜索语义（字面量、非重叠、大小写不敏感只折 ASCII A–Z）
 * 与前端高亮必须一致 —— 两处各写一份匹配逻辑，早晚会出现「搜索说命中、高亮标不出来」
 * 这类自相矛盾的界面。返回的是 `[start, end)` 区间数组，供调用方自己决定怎么呈现。
 *
 * 边界：needle 为空返回空数组（空串会匹配每个位置，那不是搜索而是灾难）；
 * 大小写不敏感时**只折叠 ASCII A–Z**（与 searchEngine 的 Buffer 折叠口径一致，
 * 避免 `toLowerCase()` 改写多字节序列）。
 */
export function findRanges(
  text: string,
  needle: string,
  caseInsensitive = true
): [number, number][] {
  if (!needle) return [];
  const haystack = caseInsensitive ? foldAsciiLowerStr(text) : text;
  const target = caseInsensitive ? foldAsciiLowerStr(needle) : needle;
  const out: [number, number][] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(target, from);
    if (at < 0) break;
    out.push([at, at + target.length]);
    from = at + target.length; // 非重叠推进（与搜索一致）
  }
  return out;
}

/** 只把 ASCII A–Z 折叠成小写，其余字符原样（长度不变，索引与原文一一对应）。 */
function foldAsciiLowerStr(s: string): string {
  let changed = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      changed = true;
      break;
    }
  }
  if (!changed) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}
