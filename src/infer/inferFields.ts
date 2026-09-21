/**
 * inferFields.ts — 字段推断抽样（性能友好的「前 N 行」方案）。
 *
 * 只扫描前 sampleLines 行（默认 200，见 package.json `jsonlViewer.sampleLines`），
 * 绝不对全文件做任何工作：
 *   - 每行仅在需要时从磁盘随机读回其 [start, end) 区间并做单行 JSON 校验 & 解析
 *     （复用近乎相同的逻辑：`readRecord`），坏行/空行直接跳过不计入。
 *   - 记录顶层字段的类型 / 出现频率 / 示例值（截断）/ 覆盖率 / 是否恒为对象或数组。
 *
 * 关于「何时把一行视为一个对象记录」：
 *   - 顶层是纯对象 `{...}` ：抽其键位作为字段，值类型即字段类型。
 *   - 顶层是数组 `[...]`  ：视为“数组型记录”，产出一个 $array 伪字段（整体作为示例），
 *     让摘要卡片至少能展示“这可能不是对象型 JSONL”。
 *   - 顶层是标量（string/number/boolean/null）：视为“标量型记录”，产出 $value 伪字段。
 *   这样 coverage（除以抽样有效记录数 total）对非对象型记录也有稳定语义。
 *
 * 内存：不驻留整文件，Map 只保存“字段名 → 汇总计数 + 首个示例”，大小与字段数成正比。
 */

import type { LineIndex } from '../indexer/lineIndex.ts';
import type { ByteReader } from '../parser/jsonParser.ts';
import { SAMPLE_SCAN_LINES } from '../constants.ts';
import { readRecord } from '../parser/jsonParser.ts';

export type FieldType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array' | 'undefined';

/** 数组型记录的伪字段键。 */
export const ARRAY_RECORD_KEY = '$array';
/** 标量型记录的伪字段键。 */
export const SCALAR_RECORD_KEY = '$value';

/** 单一字段的推断结果（webview / ui 复用）。 */
export interface FieldInfo {
  /** 字段名（顶层键；数组/标量记录见 ARRAY_RECORD_KEY / SCALAR_RECORD_KEY）。 */
  key: string;
  /** 主导类型（出现次数最高者；平手按固定优先序 object > array > string > number > boolean > null > undefined）。 */
  type: FieldType;
  /** 在抽样有效记录中的出现次数。 */
  freq: number;
  /** 示例值（已按 sampleMaxLen 截断；对象/数组过大时退化为截断串）。 */
  sample: unknown;
  /** 覆盖率 = freq / total（0..1，total 为抽样有效记录数）。 */
  coverage: number;
  /** 该字段是否在每一次出现中都恒为 object。 */
  alwaysObject: boolean;
  /** 该字段是否在每一次出现中都恒为 array。 */
  alwaysArray: boolean;
  /** 各类别出现次数（未出现为 0）。 */
  types: Record<FieldType, number>;
}

export interface InferFieldsOpts {
  /** 抽样行数上限（前 N 行），默认 200。 */
  sampleLines?: number;
  /** 示例值序列化后的最大长度（字符），默认 120。 */
  sampleMaxLen?: number;
}

export interface InferFieldsResult {
  fields: FieldInfo[];
  /** 抽样有效记录数（合法、非空记录数）。 */
  total: number;
  /** 本次实际扫描的行数上限（min(sampleLines, totalLines)）。 */
  scanned: number;
  /** 抽样范围内坏行（含空行）的 lineId 集合（升序，供红标）。 */
  errorLines: number[];
}

interface Entry {
  key: string;
  types: Record<FieldType, number>;
  freq: number;
  sample?: unknown;
  allObject: boolean;
  allArray: boolean;
}

/** 值 → FieldType（含 null/undefined 的区分）。 */
export function fieldTypeOf(value: unknown): FieldType {
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

/** 主导类型优先序（前者优先用于平手）。 */
const TYPE_PRIORITY: FieldType[] = [
  'object',
  'array',
  'string',
  'number',
  'boolean',
  'null',
  'undefined',
];

function dominantType(types: Record<FieldType, number>): FieldType {
  let best: FieldType = 'undefined';
  let bestCount = -1;
  for (const t of TYPE_PRIORITY) {
    const c = types[t];
    if (c > bestCount) {
      best = t;
      bestCount = c;
    }
  }
  return best;
}

/** 捕获示例值：字符串/对象/数组过大时退化为截断串（保证可序列化、内存有界）。 */
export function captureSample(value: unknown, maxLen: number): unknown {
  if (typeof value === 'string') {
    return value.length <= maxLen ? value : `${value.slice(0, maxLen)}…`;
  }
  if (value === null || typeof value !== 'object') return value;
  const s = JSON.stringify(value);
  if (s.length <= maxLen) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  return `${s.slice(0, maxLen)}…`;
}

function ensure(map: Map<string, Entry>, key: string): Entry {
  let e = map.get(key);
  if (!e) {
    e = {
      key,
      types: { string: 0, number: 0, boolean: 0, null: 0, object: 0, array: 0, undefined: 0 },
      freq: 0,
      allObject: true,
      allArray: true,
    };
    map.set(key, e);
  }
  return e;
}

function track(entry: Entry, value: unknown, sampleMaxLen: number): void {
  const t = fieldTypeOf(value);
  entry.types[t]++;
  entry.freq++;
  if (t !== 'object') entry.allObject = false;
  if (t !== 'array') entry.allArray = false;
  if (entry.sample === undefined && value !== undefined) {
    entry.sample = captureSample(value, sampleMaxLen);
  }
}

/**
 * 抽样前 N 行推断字段。result.fields 按出现频率降序（平手按字段名升序）。
 */
export async function inferFields(
  reader: ByteReader,
  li: LineIndex,
  opts: InferFieldsOpts = {}
): Promise<InferFieldsResult> {
  const sampleLines = opts.sampleLines ?? SAMPLE_SCAN_LINES;
  const sampleMaxLen = opts.sampleMaxLen ?? 120;
  const scanned = Math.min(sampleLines, li.totalLines);

  const map = new Map<string, Entry>();
  const errorLines: number[] = [];
  let total = 0;

  for (let line = 0; line < scanned; line++) {
    const r = await readRecord(line, li, reader);
    if (!r.ok) {
      errorLines.push(line);
      continue;
    }
    total++;
    const v = r.value;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        track(ensure(map, key), obj[key], sampleMaxLen);
      }
    } else if (Array.isArray(v)) {
      track(ensure(map, ARRAY_RECORD_KEY), v, sampleMaxLen);
    } else {
      track(ensure(map, SCALAR_RECORD_KEY), v, sampleMaxLen);
    }
  }

  const fields: FieldInfo[] = [...map.values()]
    .map((e) => ({
      key: e.key,
      type: dominantType(e.types),
      freq: e.freq,
      sample: e.sample,
      coverage: total === 0 ? 0 : e.freq / total,
      alwaysObject: e.allObject,
      alwaysArray: e.allArray,
      types: e.types,
    }))
    .toSorted((a, b) => b.freq - a.freq || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return { fields, total, scanned, errorLines };
}
