/**
 * queryLogic.ts — 前端纯逻辑层（无 DOM / 无 node 依赖）。
 *
 * 它把「字段显示定制对摘要卡片的映射、偏好持久化的状态合并/校验、搜索导航」收敛成
 * 可被 node:test 直接测试的纯函数。webview 与宿主共用过滤评估规则：
 *   - webview 直接用本模块做「本地缓存补充过滤」与「字段定制渲染」；
 *   - 宿主 `host/searchEngine.ts` 复用 core/query.ts 的纯评估函数
 *     （matchesFilter / recordFieldValue）做全文件流式扫描，不重复实现评估逻辑。
 *
 * ⚠️ 评估规则单一来源已迁至 src/core/query.ts（消 DIP 违反，见
 * docs/ARCHITECTURE_REVIEW.md 债务 T3）。本文件 re-export 之，保证既有 webview
 * 调用方与历史 import 路径不变。新增/修改过滤规则请改 core/query.ts，勿在此重复实现。
 *
 * 本文件除 re-export core 外不 import 任何 host / node 模块：保证 webview 打包
 * 不引入 node:fs 等内置模块。
 */

import { formatValue, MAX_TOP_LEVEL_KEYS } from './logic.ts';
import {
  ARRAY_RECORD_KEY,
  SCALAR_RECORD_KEY,
  fieldTypeOf,
  stringifyValue,
  recordFieldValue,
  matchesFilter,
  isEmptyCondition,
  isConditionGroup,
  matchesCondition,
  hasAnyRealCondition,
  normalizeCondition,
  conditionSummary,
} from '../core/query.ts';
import type {
  FilterOp,
  FieldCondition,
  LocalFieldType,
  Condition,
  ConditionGroup,
  GroupKind,
} from '../core/query.ts';

/* 评估规则单一来源在 core/query.ts，此处 re-export 兼容既有调用方。 */
export {
  ARRAY_RECORD_KEY,
  SCALAR_RECORD_KEY,
  fieldTypeOf,
  stringifyValue,
  recordFieldValue,
  matchesFilter,
  isEmptyCondition,
  isConditionGroup,
  matchesCondition,
  hasAnyRealCondition,
  normalizeCondition,
  conditionSummary,
};
export type { FilterOp, FieldCondition, LocalFieldType, Condition, ConditionGroup, GroupKind };

/**
 * 持久化偏好的**版本信封**（F3 引入）。
 *
 * 为什么需要：过滤条件从「单个扁平 `{field, op, value}`」扩成「叶子或 and/or/not 组」。
 * 历史数据是叶子形状，天然仍是合法 `Condition`（叶子的形状一字未改），所以**不需要
 * 迁移逻辑**；写 version 是为了让**下一个**形状变更时有据可依 —— 读到 `version` 缺失
 * 即知这是 v1 写入的，读到更高的版本号则知道是更新的版本写的、本版本可能读不懂。
 */
export const PERSIST_STATE_VERSION = 2;

/* ------------------------------ 常量（webview 专属） ------------------------------ */

/** 字段定制摘要卡片的默认字段数上限。 */
export const DEFAULT_MAX_KEYS = MAX_TOP_LEVEL_KEYS;

/* ------------------- 类型：字段显示定制布局 ------------------- */

/**
 * 字段显示定制布局（影响摘要卡片），纯数据、可序列化：
 *   - pinned：固定在卡片最前展示的字段（去重后按此顺序优先）。
 *   - order ：其余可见字段的展示顺序。
 *   - hidden：被隐藏的字段（不出现在卡片）。hidden 与 pinned/order 互斥。
 *   - maxKeys：卡片最多展示的字段数上限（默认 DEFAULT_MAX_KEYS）。
 */
export interface FieldLayout {
  pinned: string[];
  order: string[];
  hidden: string[];
  maxKeys: number;
}

/** 持久化偏好（对应宿主 workspaceState 中 jsonlViewer.state.<uri> 的值）。 */
export interface PersistedState {
  fieldLayout?: FieldLayout;
  /** 过滤条件树；null = 当前未启用过滤。 */
  filter?: Condition | null;
  searchQuery?: string;
  /** 版本信封（见 PERSIST_STATE_VERSION）；v1 数据无此字段。 */
  version?: number;
}

/* --------------------- 搜索的纯评估函数（webview 侧） --------------------- */

/** 原始行文本的字符串匹配（明文，不做 JSON.parse）。大小写不敏感默认开。 */
export function rawLineMatches(text: string, query: string, caseInsensitive = true): boolean {
  if (!query) return false;
  return caseInsensitive ? text.toLowerCase().includes(query.toLowerCase()) : text.includes(query);
}

/* ---------------- 字段定制：布局构造 / 校验 / 对摘要映射 ---------------- */

/** 依据推断字段生成默认布局（全部可见、按推断顺序、无固定）。 */
export function defaultFieldLayout(fields: readonly { key: string }[] | null): FieldLayout {
  return {
    pinned: [],
    order: (fields ?? []).map((f) => f.key),
    hidden: [],
    maxKeys: DEFAULT_MAX_KEYS,
  };
}

function cleanKeys(raw: unknown, known: Set<string> | null): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of raw) {
    if (typeof k !== 'string' || k === '') continue;
    if (known && !known.has(k)) continue; // 净化掉当前并不存在的字段
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * 把从 workspaceState 读回的未知形状裁剪成合法 FieldLayout（防御脏数据 / 旧版本字段）。
 * knownKeys 为当前推断字段名集合；传 null 表示不做字段白名单过滤（仅在构造时）。
 */
export function normalizeFieldLayout(raw: unknown, knownKeys?: Set<string> | null): FieldLayout {
  const known = knownKeys ?? null;
  const base = defaultFieldLayout(null);
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const layout: FieldLayout = {
    pinned: cleanKeys(r.pinned, known),
    order: cleanKeys(r.order, known),
    hidden: cleanKeys(r.hidden, known),
    maxKeys:
      typeof r.maxKeys === 'number' && Number.isFinite(r.maxKeys)
        ? Math.max(1, Math.min(20, Math.floor(r.maxKeys)))
        : DEFAULT_MAX_KEYS,
  };
  // 去重并保证 pinned/order 与 hidden 不重叠（hidden 优先）。
  const hiddenSet = new Set(layout.hidden);
  layout.pinned = layout.pinned.filter((k) => !hiddenSet.has(k));
  layout.order = layout.order.filter((k) => !hiddenSet.has(k) && !layout.pinned.includes(k));
  return layout;
}

/** 计算「应展示的字段键」：pinned（先）> order，跳过 hidden，截断到 maxKeys。 */
export function visibleFieldKeys(
  fields: readonly { key: string }[] | null,
  layout: FieldLayout
): string[] {
  const known = new Set((fields ?? []).map((f) => f.key));
  const hidden = new Set(layout.hidden);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of [...layout.pinned, ...layout.order]) {
    if (seen.has(k) || hidden.has(k)) continue;
    if (known.size > 0 && !known.has(k)) continue; // 仅展示真实存在的字段
    seen.add(k);
    out.push(k);
    if (out.length >= layout.maxKeys) break;
  }
  return out;
}

/**
 * 按字段定制布局输出摘要卡片条目。只返回「键确实存在于记录中」的字段；
 * 无可用字段时退化为顶层 key（复用 summarizeRecord 的回退能力，但走布局顺序）。
 */
export function summarizeWithLayout(
  value: unknown,
  fields: readonly { key: string }[] | null,
  layout: FieldLayout
): { key: string; display: string }[] {
  if (value === null || value === undefined) return [{ key: '', display: formatValue(value) }];
  const t = typeof value;
  if (t !== 'object' || Array.isArray(value)) {
    return [{ key: '', display: formatValue(value) }];
  }
  const rec = value as Record<string, unknown>;
  const keys = visibleFieldKeys(fields, layout).filter((k) => k in rec);
  if (keys.length === 0) {
    for (const k of Object.keys(rec)) {
      keys.push(k);
      if (keys.length >= layout.maxKeys) break;
    }
  }
  if (keys.length === 0) return [{ key: '', display: '{}' }];
  return keys.map((k) => ({ key: k, display: formatValue(rec[k]) }));
}

/* --------------------- 搜索导航（上一条 / 下一条） --------------------- */

/** 返回 matches 中 current 的下一个索引（循环到开头）。 */
export function nextMatchIndex(matches: readonly number[], current: number): number {
  if (matches.length === 0) return -1;
  const i = matches.indexOf(current);
  return (i + 1) % matches.length;
}

/** 返回 matches 中 current 的上一个索引（循环到末位）。 */
export function prevMatchIndex(matches: readonly number[], current: number): number {
  if (matches.length === 0) return -1;
  const i = matches.indexOf(current);
  return i <= 0 ? matches.length - 1 : i - 1;
}

/* ------------------- 偏好持久化：状态构建 / 合并 ------------------- */

/**
 * 把「当前 UI 偏好」打包成可序列化对象（供宿主存 workspaceState）。
 */
export function toPersistedState(p: {
  fieldLayout: FieldLayout;
  filter: Condition | null;
  searchQuery?: string;
}): PersistedState {
  return {
    version: PERSIST_STATE_VERSION,
    ...(p.fieldLayout ? { fieldLayout: p.fieldLayout } : {}),
    ...(p.filter ? { filter: p.filter } : { filter: null }),
    ...(p.searchQuery ? { searchQuery: p.searchQuery } : {}),
  };
}

/**
 * 从宿主读回的未知状态合并到当前偏好：仅接受合法字段布局与合法过滤条件，
 * 其它一律丢弃，避免脏数据覆盖正确配置。返回合并后的新状态。
 */
export function mergePersistedState(
  saved: unknown,
  current: { fieldLayout: FieldLayout; filter: Condition | null; searchQuery?: string },
  knownKeys?: Set<string>
): { fieldLayout: FieldLayout; filter: Condition | null; searchQuery?: string } {
  if (!saved || typeof saved !== 'object') return { ...current };
  const s = saved as Record<string, unknown>;
  const merged = { ...current };

  if (s.fieldLayout && typeof s.fieldLayout === 'object') {
    // M13：仅接受合法对象——脏数据（非对象）不覆盖当前布局。
    merged.fieldLayout = normalizeFieldLayout(s.fieldLayout, knownKeys ?? null);
  }
  if (s.filter === null) {
    merged.filter = null;
  } else if (s.filter && typeof s.filter === 'object') {
    // v1 的扁平叶子与 v2 的条件树走**同一条**净化路径：叶子的形状一字未改，
    // 故历史偏好无需迁移即可读回（这正是把叶子保留为联合成员的价值）。
    const norm = normalizeCondition(s.filter);
    if (norm) merged.filter = norm;
  }
  if (typeof s.searchQuery === 'string') merged.searchQuery = s.searchQuery;

  return merged;
}
