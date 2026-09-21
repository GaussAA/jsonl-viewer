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
 *     全部复用自 `core/query.ts`（评估规则单一来源，原在 webview/queryLogic.ts，已抽离消 DIP 违反），保证前端本地缓存补充过滤与宿主结果一致。
 *   - 范围：默认当前文件全范围（[0, totalLines)），可按 scope 限定，宿主分批/顺序扫描，
 *     支持 maxResults 提前终止（truncated）与可选取消回调。
 */

import type { LineIndex } from '../indexer/lineIndex.ts';
import type { ByteReader } from '../parser/jsonParser.ts';
import { parseJsonLine } from '../parser/jsonParser.ts';
import { matchesFilter, recordFieldValue } from '../core/query.ts';
import type { FieldCondition } from '../core/query.ts';
import { SEARCH_SCAN_EVERY } from '../constants.ts';

/* ------------------------------ Buffer 级全文匹配 ------------------------------ */

/** 仅把 ASCII A-Z(65-90) 折叠为小写，返回新 Buffer（与旧实现的逐字节折叠语义**完全一致**）。 */
function foldAsciiLower(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    out[i] = b >= 65 && b <= 90 ? b + 32 : b;
  }
  return out;
}

/** query 是否含 ASCII 字母（决定大小写折叠是否可能产生差异）。 */
function hasAsciiLetter(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if ((b >= 65 && b <= 90) || (b >= 97 && b <= 122)) return true;
  }
  return false;
}

/**
 * 在原始字节行上做大小写不敏感的子串匹配（只处理 ASCII 范围的 a-z/A-Z）。
 *
 * 性能（P2-4 修正）：旧实现是 JS 双层循环的朴素匹配 O(行字节 × query 长度)，
 * 315MB 文件配长 query 可达数十秒。改为三级策略：
 *   1) 原生 `Buffer.includes` 快速路径 —— 大小写完全一致时直接命中（最常见）；
 *   2) query 不含 ASCII 字母 ⇒ 大小写折叠不可能改变结果，直接否定，省掉昂贵折叠；
 *   3) 折叠后原生 `includes` —— 总体 O(行字节 + query)，比旧实现快一个量级。
 *
 * ⚠️ 这里**只折叠 ASCII A-Z**，绝不对整行做 `toString().toLowerCase()`：
 * 后者会改写 0xC2~0xDE 等 UTF-8 前导字节（如 'Ã'(C3)→'ã'(E3)），破坏多字节序列的字节等价性，
 * 产生误匹配。折叠法与旧实现逐字节语义严格一致。
 */
function bufferIncludesCI(lineBuf: Buffer, queryBuf: Buffer): boolean {
  if (queryBuf.length === 0) return false;
  if (queryBuf.length > lineBuf.length) return false;
  if (lineBuf.includes(queryBuf)) return true;
  if (!hasAsciiLetter(queryBuf)) return false;
  return foldAsciiLower(lineBuf).includes(foldAsciiLower(queryBuf));
}

/** 大小写敏感的 Buffer includes（直接用 Node 原生 Buffer.includes）。 */
const bufferIncludesCS = (lineBuf: Buffer, queryBuf: Buffer): boolean =>
  lineBuf.includes(queryBuf);

/* ------------------------------ 搜索 ------------------------------ */

export interface SearchScope {
  /** 起（含），默认 0。 */
  startLine?: number;
  /** 止（不含），默认全文件最后一行之后。 */
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
  const scanEvery = opts.scanEvery ?? SEARCH_SCAN_EVERY;
  const field = opts.field?.trim();
  const ci = opts.caseInsensitive !== false;

  // 预编译 query：全文搜索路径用 Buffer（避免每轮 UTF-8 解码）；字段路径保持 string。
  const queryBuf = field ? undefined : Buffer.from(ci ? q.toLowerCase() : q, 'utf8');

  const matches: number[] = [];
  let total = 0;
  let truncated = false;

  // 单次顺序 IO：从 start 行顺扫到 end，完全不依赖逐行随机定位（稀疏索引友好）。
  for await (const r of li.scan(reader, start, end)) {
    if (opts.shouldCancel?.()) break;
    if (r.error) continue; // 超长/坏扫描行跳过

    let hit: boolean;
    if (field) {
      const parsed = parseJsonLine(r.bytes.toString('utf8'));
      if (!parsed.ok || parsed.value === undefined) continue;
      hit = matchesFilter(recordFieldValue(parsed.value, field), {
        field,
        op: 'contains',
        value: q,
        caseInsensitive: ci !== false,
      });
    } else {
      hit = ci !== false ? bufferIncludesCI(r.bytes, queryBuf!) : bufferIncludesCS(r.bytes, queryBuf!);
    }

    if (hit) {
      if (matches.length >= maxResults) {
        // 达上限立即终止扫描（M1：此前仅停 push 仍扫完全文件，高频词搜索整文件 O(bytes) 浪费）。
        truncated = true;
        break;
      }
      matches.push(r.line);
      total++;
    }

    if ((r.line - start) % scanEvery === scanEvery - 1) await yieldToLoop();
  }

  if (truncated) total = Number.MAX_SAFE_INTEGER; // 不精确总数，仅表示「未列尽」。
  return { matches, total, truncated };
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
  const scanEvery = opts.scanEvery ?? SEARCH_SCAN_EVERY;
  const maxResults = opts.maxResults ?? FILTER_MAX_RESULTS;

  // 单次顺序 IO：从 start 顺扫到 end，逐行解析求值（稀疏索引友好）。
  const matches: number[] = [];
  let truncated = false;
  for await (const r of li.scan(reader, start, end)) {
    if (opts.shouldCancel?.()) break;
    if (r.error) continue; // 超长/坏扫描行跳过
    const parsed = parseJsonLine(r.bytes.toString('utf8'));
    if (!parsed.ok || parsed.value === undefined) continue;
    const value = recordFieldValue(parsed.value, cond.field);
    if (matchesFilter(value, cond)) {
      if (matches.length >= maxResults) {
        // 达上限立即终止扫描（M1：此前仅停 push 仍扫完全文件）。
        truncated = true;
        break;
      }
      matches.push(r.line);
    }
    if ((r.line - start) % scanEvery === scanEvery - 1) await yieldToLoop();
  }
  return { matches, total: truncated ? maxResults + 1 : matches.length, truncated };
}

/** 让出一次事件循环（setImmediate），防止长扫描阻塞宿主。 */
function yieldToLoop(): Promise<void> {
  return new Promise((res) => setImmediate(res));
}