/**
 * recordSummary.ts — 列表态「有界摘要」生成 + 超大行浅扫描。
 *
 * 阶段三（UI 热路径）核心：readRecords 不再对每一屏可见行整条 JSON.parse 并回传整条
 * 值——仅对未超阈值的普通行解析并附带「有界摘要」；对超过 RECORD_INLINE_MAX_BYTES 的
 * 超大行，跳过整条 parse，改用单次线性浅扫描得到类型/顶层条目数/预览文本，标记
 * truncated=true 且不内联 value。完整值仍由 readRecord 按详情需求拉取。如此列表内存
 * 只与「可见窗口 + 有界摘要」成正比，单条 MB 级巨物不再撑爆 webview 缓存。
 *
 * 全部为纯函数，无 DOM / vscode / fs 依赖，可在 node:test 下直接单测。
 */

import { RECORD_INLINE_MAX_BYTES } from '../constants.ts';

export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

/** 列表卡片摘要字段：键名 + 展示文本（有界）。 */
export interface SummaryField {
  key: string;
  display: string;
}

/** 列表卡片最多展示的顶层字段数（与 webview logic.MAX_TOP_LEVEL_KEYS 对齐）。 */
export const SUMMARY_MAX_KEYS = 4;
/** 预览/截断文本最多展示的字符数。 */
export const SUMMARY_MAX_PREVIEW_CHARS = 160;
/** 单字段展示字符串最大长度（超长省略）。 */
export const SUMMARY_MAX_STRING_LEN = 120;

/** 单字段字符串值超长省略。 */
function truncateStr(s: string, max = SUMMARY_MAX_STRING_LEN): string {
  return s.length <= max ? s : s.slice(0, max) + '…';
}

/** 任意 JSON 标量 -> 有界展示文本。 */
function formatScalar(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string') return truncateStr(v);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (Array.isArray(v)) return `[…] (${v.length} item${v.length === 1 ? '' : 's'})`;
  if (typeof v === 'object') {
    const n = Object.keys(v as object).length;
    return `{…} (${n} field${n === 1 ? '' : 's'})`;
  }
  return String(v);
}

/** 推断值的 JSON 类型（详情徽章用）。 */
export function jsonKindOf(value: unknown): JsonKind {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return 'string';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  return Array.isArray(value) ? 'array' : 'object';
}

/** 顶层条目数：object=key 数，array=元素数，标量=0。 */
export function jsonCountOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value !== null && typeof value === 'object') return Object.keys(value as object).length;
  return 0;
}

/**
 * 从已解析值生成有界摘要（最多前 N 个顶层 key；标量/数组直接折叠展示）。
 * 不持有整条 JSON 的深拷贝——仅引用顶层 key 与其值的轻量展示串。
 */
export function makeSummary(value: unknown, maxKeys = SUMMARY_MAX_KEYS): SummaryField[] {
  if (value === null || value === undefined) {
    return [{ key: '', display: value === null ? 'null' : 'undefined' }];
  }
  const t = typeof value;
  if (t !== 'object' || Array.isArray(value)) {
    return [{ key: '', display: formatScalar(value) }];
  }
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length === 0) return [{ key: '', display: '{}' }];
  return keys.slice(0, maxKeys).map((k) => ({ key: k, display: formatScalar(rec[k]) }));
}

/** 超大行浅扫描结果。 */
export interface RawLineSummary {
  /** 值类型（徽章用）。 */
  kind: JsonKind;
  /** 顶层条目数（object=key 数, array=元素数）；非容器为 0。 */
  count: number;
  /** 预览文本（前 SUMMARY_MAX_PREVIEW_CHARS 字符，超长省略）。 */
  preview: string;
}

/**
 * 单次线性浅扫描（不 JSON.parse、不物化嵌套结构）得到超大行的类型 / 顶层条目数 / 预览。
 *
 * 算法：跳过前导空白后取首非空白字节判定类型；对象/数组再做一次单层深度扫描——
 * 仅追踪「容器深度 + 字符串态」，遇 depth===1 的逗号计顶层条目，遇任意值起始字符
 * 标记非空；空容器（无任何值起始字符）计 0，否则逗号数 + 1。全程 O(n) 单遍、零分配
 * （除预览解码），故即便对 16MB 单行也仅一次轻量遍历，远优于整条 JSON.parse。
 *
 * @param bytes 单行原始 UTF-8 字节（不含行尾 `\n`/`\r\n`）。
 * @param previewChars 预览最多展示字符数。
 */
export function summarizeRawLine(bytes: Buffer, previewChars = SUMMARY_MAX_PREVIEW_CHARS): RawLineSummary {
  const n = bytes.length;
  let i = 0;
  // 跳过前导空白（空格/Tab/LF/CR）。
  while (i < n && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) {
    i++;
  }
  if (i >= n) return { kind: 'null', count: 0, preview: '' };

  const first = bytes[i];
  let kind: JsonKind;
  if (first === 0x7b) kind = 'object'; // {
  else if (first === 0x5b) kind = 'array'; // [
  else if (first === 0x22) kind = 'string'; // "
  else if (first === 0x74 || first === 0x66) kind = 'boolean'; // t / f
  else if (first === 0x6e) kind = 'null'; // n
  else kind = 'number'; // 数字或 '-'

  let count = 0;
  if (kind === 'object' || kind === 'array') {
    let depth = 0;
    let inStr = false;
    let esc = false;
    let hasContent = false;
    for (let j = i; j < n; j++) {
      const c = bytes[j];
      if (inStr) {
        hasContent = true; // 字符串内必有内容
        if (esc) esc = false;
        else if (c === 0x5c) esc = true; // backslash
        else if (c === 0x22) inStr = false; // 关闭字符串
        continue;
      }
      if (c === 0x22) {
        inStr = true;
        hasContent = true;
        continue;
      }
      if (c === 0x7b || c === 0x5b) {
        if (j === i) depth = 1; // 顶层容器起始
        else depth++;
      } else if (c === 0x7d || c === 0x5d) {
        if (depth === 1) depth = 0; // 顶层容器闭合
        else if (depth > 0) depth--;
      } else if (c === 0x2c && depth === 1) {
        count++; // 顶层逗号 = 顶层条目分隔
      } else if (
        (c >= 0x30 && c <= 0x39) || // 数字
        c === 0x2d || // 负号
        c === 0x74 ||
        c === 0x66 ||
        c === 0x6e // true / false / null 首字
      ) {
        hasContent = true;
      }
      if (count > 100000) break; // 防御：极端巨物只数到上限
    }
    // 顶层条目数：有逗号则逗号+1；无逗号时看是否非空（空容器计 0）。
    count = count > 0 ? count + 1 : hasContent ? 1 : 0;
  }

  // 预览：解码首段字节后按字符截断（UTF-8 最多 3 字节/常见字符，留余量 *3）。
  const decodedLen = Math.min(n, i + previewChars * 3);
  let preview = bytes.toString('utf8', i, decodedLen);
  if (n > decodedLen || preview.length > previewChars) {
    preview = preview.slice(0, previewChars) + '…';
  }
  return { kind, count, preview };
}

/** 供宿主判定某行原始字节是否超过「列表内联阈值」。 */
export function isOversized(byteLength: number): boolean {
  return byteLength > RECORD_INLINE_MAX_BYTES;
}
