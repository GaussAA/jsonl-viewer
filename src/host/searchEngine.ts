/**
 * searchEngine.ts — 宿主侧「全文/字段搜索 + 字段过滤」的流式执行层（无 vscode 依赖）。
 *
 * 设计取舍（性能优先）：
 *   - 全文搜索（不限定字段）：对每一行做「按偏移随机读回其原始字节区间」→ 剥离行尾 →
 *     直接做大小写不敏感的字符串包含匹配，**不 JSON.parse**。因为绝大多数场景用户找的是
 *     明文片段，纯文本匹配开销远低于逐行解析，可支撑大文件全量扫。
 *   - 字段限定搜索 / 字段过滤：必须真正取值，才用 readRecord 对命中行做单行解析（成本
 *     可控，因为限定字段/过滤天然受众收窄；过滤在超大纵深时由前端「Dispatch 暂停」配合，
 *     见 webviewEntry 说明）。评估规则（matchesFilter / rawLineMatches / recordFieldValue）
 *     全部复用自 `webview/queryLogic.ts`，保证前端本地缓存补充过滤与宿主结果一致。
 *   - 范围：默认当前文件全范围（[0, totalLines)），可按 scope 限定，宿主分批/顺序扫描，
 *     支持 maxResults 提前终止（truncated）与可选取消回调。
 */

import type { LineIndex } from '../indexer/lineIndex.ts';
import type { ByteReader } from '../parser/jsonParser.ts';
import { readLineAt, readRecord } from '../parser/jsonParser.ts';
import { rawLineMatches, matchesFilter, recordFieldValue } from '../webview/queryLogic.ts';
import type { FieldCondition } from '../webview/queryLogic.ts';

/* ------------------------------ 搜索 ------------------------------ */

export interface SearchScope {
  /** 起（含），默认 0。 */
  startLine?: number;
  /** 止（含），默认全文件最后一行。 */
  endLine?: number;
}

export interface SearchLinesOpts {
  query: string;
  /** 限定字段名；省略则不限定（全文纯文本匹配）。 */
  field?: string;
  scope?: SearchScope;
  caseInsensitive?: boolean;
  /** 最多返回的匹配数；达到后停止并标记 truncated。默认不限。 */
  maxResults?: number;
  /** 每 scanEvery 行让出一次事件循环（避免长时间阻塞宿主）。 */
  scanEvery?: number;
  /** 中断回调：返回 true 则中止本次搜索。 */
  shouldCancel?: () => boolean;
}

export interface SearchLinesResult {
  /** 升序匹配 lineId。 */
  matches: number[];
  /** 命中总数（>= matches.length；仅当 truncated 时大于）。 */
  total: number;
  /** 是否因 maxResults 提前终止。 */
  truncated: boolean;
}

export async function searchLines(
  reader: ByteReader,
  li: LineIndex,
  opts: SearchLinesOpts
): Promise<SearchLinesResult> {
  const q = opts.query;
  if (!q) return { matches: [], total: 0, truncated: false };

  const start = Math.max(0, opts.scope?.startLine ?? 0);
  const end = Math.min(opts.scope?.endLine ?? li.totalLines, li.totalLines);
  const maxResults = opts.maxResults ?? Number.MAX_SAFE_INTEGER;
  const scanEvery = opts.scanEvery ?? 256;
  const field = opts.field?.trim();

  const matches: number[] = [];
  let total = 0;
  let truncated = false;

  for (let line = start; line < end; line++) {
    if (opts.shouldCancel?.()) break;

    const hit = field
      ? await fieldSearchHit(line, reader, li, field, q, opts.caseInsensitive)
      : await fullTextHit(line, reader, li, q, opts.caseInsensitive);

    if (hit) {
      total++;
      if (matches.length < maxResults) matches.push(line);
      else truncated = true;
    }

    if ((line - start) % scanEvery === scanEvery - 1) await yieldToLoop();
  }

  if (truncated) total = Number.MAX_SAFE_INTEGER; // 不精确总数，仅表示「未列尽」。
  return { matches, total, truncated };
}

async function fullTextHit(
  line: number,
  reader: ByteReader,
  li: LineIndex,
  q: string,
  ci: boolean | undefined
): Promise<boolean> {
  const { start, end } = li.lineRange(line);
  let text: string;
  try {
    text = await readLineAt(reader, start, end);
  } catch {
    return false;
  }
  return rawLineMatches(text, q, ci !== false);
}

async function fieldSearchHit(
  line: number,
  reader: ByteReader,
  li: LineIndex,
  field: string,
  q: string,
  ci: boolean | undefined
): Promise<boolean> {
  const r = await readRecord(line, li, reader);
  if (!r.ok || r.value === undefined) return false;
  const value = recordFieldValue(r.value, field);
  return matchesFilter(value, { field, op: 'contains', value: q, caseInsensitive: ci !== false });
}

/* ------------------------------ 过滤 ------------------------------ */

export interface FilterLinesOpts {
  scope?: SearchScope;
  scanEvery?: number;
  shouldCancel?: () => boolean;
  /** 最多返回的匹配行号数；达到后停止并入 matches[capped]，truncated=true。 */
  maxResults?: number;
}

export interface FilterLinesResult {
  /** 升序匹配 lineId；null 表示「未启用过滤 = 全量视图」。 */
  matches: number[] | null;
  total: number;
  /** 是否因 maxResults 提前终止（仍有更多匹配未列出）。 */
  truncated?: boolean;
}

/** 过滤结果默认上限：防御「全行命中」把整文件行号载入 webview 造成内存失控。 */
const FILTER_MAX_RESULTS = 50_000;

/**
 * 字段值过滤：解析范围内每行取值后求值 matchesFilter。条件是空条件时返回全量（matches=null）。
 * 坏行直接跳过（过滤视图不展示非法行）。
 */
export async function filterLines(
  reader: ByteReader,
  li: LineIndex,
  cond: FieldCondition | null,
  opts: FilterLinesOpts = {}
): Promise<FilterLinesResult> {
  if (!cond || !cond.field || !cond.op) return { matches: null, total: li.totalLines };

  const start = Math.max(0, opts.scope?.startLine ?? 0);
  const end = Math.min(opts.scope?.endLine ?? li.totalLines, li.totalLines);
  const scanEvery = opts.scanEvery ?? 256;
  const maxResults = opts.maxResults ?? FILTER_MAX_RESULTS;

  const matches: number[] = [];
  let truncated = false;
  for (let line = start; line < end; line++) {
    if (opts.shouldCancel?.()) break;
    const r = await readRecord(line, li, reader);
    if (!r.ok || r.value === undefined) continue;
    const value = recordFieldValue(r.value, cond.field);
    if (matchesFilter(value, cond)) {
      if (matches.length < maxResults) matches.push(line);
      else truncated = true;
    }
    if ((line - start) % scanEvery === scanEvery - 1) await yieldToLoop();
  }
  return { matches, total: truncated ? maxResults + 1 : matches.length, truncated };
}

/** 让出一次事件循环（setImmediate），防止长扫描阻塞宿主。 */
function yieldToLoop(): Promise<void> {
  return new Promise((res) => setImmediate(res));
}