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

/* --------------- 类型：组合条件树（AND / OR / NOT） --------------- */

/**
 * 组合算子。语义刻意按「数组 + 量词」定义（与 Elasticsearch 的 must / should / must_not
 * 同一套直觉），而非「任意嵌套的表达式树」—— 前者无歧义、无需符号推理，UI 也只需要
 * 一层就够用：
 *   - `and`：**全部**子条件为真（空数组 = 真，等同不约束）；
 *   - `or` ：**至少一个**为真（空数组 = 假）；
 *   - `not`：**全部**子条件都不为真（即 NOT(OR(items))）。
 * 「空 and = 真 / 空 or = 假」是量词的数学定义，不是随手约定：这样 `every` / `some` /
 * `!some` 三条实现都是同一形状，不必为「空集」写特例分支。
 */
export type GroupKind = 'and' | 'or' | 'not';

/** 条件组：把若干子条件按 `kind` 组合。 */
export interface ConditionGroup {
  kind: GroupKind;
  items: Condition[];
}

/**
 * 过滤条件：叶子（单字段条件）或组。
 *
 * 为何做成联合而不是「一个带 children 的结构」：既有 `FieldCondition` 的序列化形状
 * （`{field, op, value, negate?, caseInsensitive?}`）已经在 workspaceState 里落了盘、
 * 也在协议上用着，让它继续作为**叶子**存在，历史数据无需迁移就是合法的 `Condition`。
 */
export type Condition = FieldCondition | ConditionGroup;

/** 判别组 / 叶子：`kind` 只在组上出现（叶子用 `field` + `op`）。 */
export function isConditionGroup(cond: Condition): cond is ConditionGroup {
  return typeof (cond as { kind?: unknown }).kind === 'string';
}

/** 组合条件的嵌套深度上限：正常 UI 只生成两层，设界只为拦住损坏 / 恶意数据。 */
export const MAX_CONDITION_DEPTH = 8;

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

/**
 * 对**整条记录**求值一个（可能是组合的）过滤条件。
 *
 * 单一来源的理由与本文件开头的说明一致：宿主侧的 `filterLines` 与 webview 侧的
 * 「本地缓存补充过滤」必须给出同一答案 —— 两处各写一份必然漂移。
 *
 * 叶子为**空条件**（用户加了一行但没填完）时返回 `true`：视为「不施加约束」。
 * 若按「空条件求值为假」处理，界面上会出现「刚点 + 条件、结果集瞬间清空」——
 * 那看起来就是「文件里没有数据」，与本库「如实告知」的原则相悖。
 */
export function matchesCondition(record: unknown, cond: Condition | null | undefined): boolean {
  if (!cond) return true;
  if (isConditionGroup(cond)) {
    switch (cond.kind) {
      case 'and':
        return cond.items.every((it) => matchesCondition(record, it));
      case 'or':
        return cond.items.some((it) => matchesCondition(record, it));
      case 'not':
        return !cond.items.some((it) => matchesCondition(record, it));
      default:
        // 组类型非法（脏数据）→ 不约束，不把整视图清空。
        return true;
    }
  }
  if (isEmptyCondition(cond)) return true;
  return matchesFilter(recordFieldValue(record, cond.field), cond);
}

/**
 * 条件树里是否存在**至少一个真正填过的叶子条件**。
 *
 * 用作「本次是否启用了过滤」的判据（替代原先只看顶层 `cond.field` 的判断）：
 * 只按结构判定的好处是不必做符号推理（例如「or 里有一个恒真分支」这类），
 * 且行为直观 —— 用户没填任何字段就是没过滤。
 */
export function hasAnyRealCondition(cond: Condition | null | undefined): boolean {
  if (!cond) return false;
  if (isConditionGroup(cond)) return cond.items.some((it) => hasAnyRealCondition(it));
  return !isEmptyCondition(cond);
}

/**
 * 把未知形状（协议入参 / workspaceState 里读回的历史偏好）净化成合法条件树。
 *
 * 为什么不做「迁移」而是「净化」：叶子的序列化形状与历史完全一致，旧数据天然合法；
 * 真正需要防的是**脏数据与损坏的组**（例如 items 非数组、kind 拼错、深度异常）。
 * 非法分支一律丢弃而不是整个条件作废 —— 局部可用胜过全盘回退到「无过滤」。
 */
export function normalizeCondition(raw: unknown, depth = 0): Condition | null {
  if (depth > MAX_CONDITION_DEPTH) return null;
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind === 'string') {
    if (r.kind !== 'and' && r.kind !== 'or' && r.kind !== 'not') return null;
    const items: Condition[] = [];
    if (Array.isArray(r.items)) {
      for (const it of r.items) {
        const n = normalizeCondition(it, depth + 1);
        if (n) items.push(n);
      }
    }
    return { kind: r.kind, items };
  }
  const op = r.op;
  if (typeof r.field !== 'string' || r.field === '') return null;
  if (op !== 'eq' && op !== 'contains' && op !== 'exists' && op !== 'type') return null;
  return {
    field: r.field,
    op,
    value: typeof r.value === 'string' ? r.value : '',
    negate: !!r.negate,
    caseInsensitive: r.caseInsensitive !== false,
  };
}

/**
 * 条件树的单行摘要（给徽章 / 只读回显）。
 *
 * 用户在关闭面板后只能看到一枚「已过滤」徽章，看不到自己设的到底是什么 ——
 * 摘要让「我刚才筛的哪几个条件」有据可查，且沿用中文连接词而非内部算子名。
 */
export function conditionSummary(cond: Condition | null | undefined): string {
  if (!cond) return '';
  if (isConditionGroup(cond)) {
    const parts = cond.items.map((it) => conditionSummary(it)).filter((t) => t !== '');
    if (parts.length === 0) return '';
    if (cond.kind === 'not') return `非(${parts.join(' 或 ')})`;
    const sep = cond.kind === 'and' ? ' 且 ' : ' 或 ';
    return parts.length === 1 ? parts[0] : `(${parts.join(sep)})`;
  }
  const neg = cond.negate ? '非 ' : '';
  switch (cond.op) {
    case 'exists':
      return `${neg}存在 ${cond.field}`;
    case 'type':
      return `${neg}${cond.field} 为 ${cond.value}`;
    case 'eq':
      return `${neg}${cond.field} 等于 ${cond.value}`;
    default:
      return `${neg}${cond.field} 含 ${cond.value}`;
  }
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
