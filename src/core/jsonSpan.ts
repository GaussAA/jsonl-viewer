/**
 * jsonSpan.ts — 在 JSON 文本中**定位某个路径的值区间**，并做「外科式」替换（零依赖）。
 *
 * 与 `core/query.ts` / `core/replaceLogic.ts` 同样的定位：纯逻辑、无 host/node/DOM 依赖，
 * 可直接 `node:test` 单测。
 *
 * ## 为什么需要它
 *
 * 字段级编辑（在详情树上改某个字段）若走「解析成值 → 改动 → 重新序列化整行」，会
 * **重排用户的键序与空白**，还会把字节长度整体改写、放大变长搬移的成本。正确做法是
 * 只在原文里替换**那一段字节**，其余逐字节保持原样 —— 而要做到这一点，必须先知道
 * 「那个值在原文里占哪几个字符」。
 *
 * `JSON.parse` 不提供任何位置信息，故此处实现一个**只定位、不构造值**的递归下降扫描器：
 *   · 只对目标路径那一支做键名比较，其余分支照样精确跳过（保证结构解析不失真）；
 *   · 全程不分配中间对象（连键名也只在与当前层级比较时才 decode）。
 *
 * ## 三条不可让步的规则
 *
 *   1. **定位失败一律返回 undefined，绝不返回一个"大概位置"** —— 调用方据此拒绝编辑。
 *      给错区间的后果是写坏文件，比编辑失败严重得多。
 *   2. **键必须在 decode 之后比较** —— 否则 `"a\"b"` 这类含转义的键永远匹配不上
 *      （原文里是 `a\"b`，路径里是 `a"b`）。借用 `JSON.parse` 解单个键 token 以保证正确。
 *   3. **文本必须整体合法**（扫完还有残留字符即判失败）—— 否则对一段不是 JSON 的文本
 *      也可能"定位成功"并改坏它。
 */

/** 路径的一段：对象键为 string，数组下标为 number。 */
export type PathPart = string | number;

/** 值在文本中的区间（半开区间 `[start, end)`，含字符串的引号等字面字符、不含前导空白）。 */
export interface ValueSpan {
  start: number;
  end: number;
}

/** 替换结果：失败时给出可读原因（调用方直接展示给用户）。 */
export type ReplaceValueResult =
  { ok: true; text: string; span: ValueSpan } | { ok: false; error: string };

/** 递归深度上限：病态深层嵌套直接判失败，不冒爆栈的险。 */
const MAX_DEPTH = 1000;

/** 数字 token 的黏性正则（`y` 保证从 lastIndex 精确匹配，不会跳过非法前缀）。 */
const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** JSON 空白（只有这四个字符是合法空白）。 */
function isWs(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * 递归下降扫描器：只定位目标路径，不构造值。
 *
 * `onTarget` 表示「当前值仍在目标路径上」。之所以要它而不只是深度：若只比深度，
 * 目标是 `/a/b` 时，同深度的 `/c/d` 也会被误判为命中。
 */
class JsonScanner {
  private i = 0;
  private depth = 0;
  private span: ValueSpan | undefined;

  constructor(
    private readonly text: string,
    private readonly path: readonly PathPart[]
  ) {}

  /** 扫描整个文本；返回 undefined 表示文本非法或未命中。 */
  locate(): ValueSpan | undefined {
    const end = this.scanValue(0, true);
    if (end === undefined) return undefined;
    this.skipWs();
    // 尾部仍有残留 ⇒ 不是一段完整的 JSON。放宽它会让「半截 JSONL」也被认为可编辑。
    if (this.i !== this.text.length) return undefined;
    return this.span;
  }

  private skipWs(): void {
    while (this.i < this.text.length && isWs(this.text.charCodeAt(this.i))) this.i++;
  }

  /**
   * 扫描一个值，返回其结束位置；文本非法返回 undefined。
   *
   * @param segIndex 当前值在目标路径中的层级；等于 `path.length` 表示**它就是目标**
   * @param onTarget 当前值是否仍在目标路径上（祖先键/下标全部匹配）
   */
  private scanValue(segIndex: number, onTarget: boolean): number | undefined {
    if (this.depth > MAX_DEPTH) return undefined;
    this.skipWs();
    const start = this.i;
    const ch = this.text[this.i];
    if (ch === undefined) return undefined;

    let ok: boolean;
    if (ch === '{') {
      this.depth++;
      ok = this.scanObject(segIndex, onTarget);
      this.depth--;
    } else if (ch === '[') {
      this.depth++;
      ok = this.scanArray(segIndex, onTarget);
      this.depth--;
    } else if (ch === '"') {
      ok = this.scanString();
    } else if (ch === 't') {
      ok = this.expect('true');
    } else if (ch === 'f') {
      ok = this.expect('false');
    } else if (ch === 'n') {
      ok = this.expect('null');
    } else if (ch === '-' || (ch >= '0' && ch <= '9')) {
      ok = this.scanNumber();
    } else {
      return undefined;
    }
    if (!ok) return undefined;

    if (onTarget && segIndex === this.path.length && this.span === undefined) {
      this.span = { start, end: this.i };
    }
    return this.i;
  }

  private scanObject(segIndex: number, onTarget: boolean): boolean {
    this.i++; // 消费 '{'
    this.skipWs();
    if (this.text[this.i] === '}') {
      this.i++;
      return true;
    }
    for (;;) {
      this.skipWs();
      if (this.text[this.i] !== '"') return false;

      const keyStart = this.i;
      if (!this.scanString()) return false;
      const key = this.decodeToken(keyStart, this.i);
      if (key === undefined) return false;

      this.skipWs();
      if (this.text[this.i] !== ':') return false;
      this.i++;

      // 键名匹配才算「仍在目标路径上」；`path[segIndex]` 越界时为 undefined，
      // 与任何 string 键都不相等，故深层不会被误判为命中。
      const childOnTarget = onTarget && key === this.path[segIndex];
      if (this.scanValue(segIndex + 1, childOnTarget) === undefined) return false;

      this.skipWs();
      const c = this.text[this.i];
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === '}') {
        this.i++;
        return true;
      }
      return false;
    }
  }

  private scanArray(segIndex: number, onTarget: boolean): boolean {
    this.i++; // 消费 '['
    this.skipWs();
    if (this.text[this.i] === ']') {
      this.i++;
      return true;
    }
    let index = 0;
    for (;;) {
      const childOnTarget = onTarget && index === this.path[segIndex];
      if (this.scanValue(segIndex + 1, childOnTarget) === undefined) return false;
      index++;

      this.skipWs();
      const c = this.text[this.i];
      if (c === ',') {
        this.i++;
        continue;
      }
      if (c === ']') {
        this.i++;
        return true;
      }
      return false;
    }
  }

  /** 消费一个字符串 token（含两侧引号）。未闭合或含裸控制字符即失败。 */
  private scanString(): boolean {
    this.i++; // 消费开引号
    while (this.i < this.text.length) {
      const c = this.text[this.i];
      if (c === '\\') {
        // 转义：连跳两个字符。此处只求「不把 \" 误判为结束」，不做严格转义校验
        // （结构合法性由后续 JSON.parse 兜底；扫描器的职责是切准 span，不是验错）。
        this.i += 2;
        continue;
      }
      if (c === '"') {
        this.i++;
        return true;
      }
      // U+0000..U+001F 在 JSON 字符串里必须转义。
      if (c < ' ') return false;
      this.i++;
    }
    return false; // 未闭合
  }

  /** 用 JSON.parse 解一个完整的 token（键名或字符串值），失败返回 undefined。 */
  private decodeToken(start: number, end: number): string | undefined {
    try {
      const v: unknown = JSON.parse(this.text.slice(start, end));
      return typeof v === 'string' ? v : undefined;
    } catch {
      return undefined;
    }
  }

  private expect(word: string): boolean {
    if (!this.text.startsWith(word, this.i)) return false;
    this.i += word.length;
    return true;
  }

  private scanNumber(): boolean {
    NUMBER_RE.lastIndex = this.i;
    const m = NUMBER_RE.exec(this.text);
    if (!m || m[0].length === 0) return false;
    this.i += m[0].length;
    return true;
  }
}

/**
 * JSON 值的深度相等比较。
 *
 * 用于批量字段级替换的「旧值匹配」：判断某行指定路径下的当前值是否等于用户给的
 * `from`。对象比较键集合与各键的值（**键序无关**——语义相等不要求书写顺序一致）；
 * 数字按 JS 语义比较（`1` 与 `1.0` 解析后是同一个数，视为相等）。
 */
export function jsonValueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonValueEquals(v, b[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      jsonValueEquals((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  );
}

/**
 * 在 `text` 中定位 `path` 所指的值区间。
 *
 * 返回 `undefined` 表示：文本不是合法 JSON、路径在该值中不存在、或路径类型不符
 * （例如对字符串取字段）。**调用方必须据此拒绝编辑** —— 给一个错的区间会写坏文件。
 */
export function locateValue(text: string, path: readonly PathPart[]): ValueSpan | undefined {
  return new JsonScanner(text, path).locate();
}

/**
 * 用 `next` 替换 `text` 中 `path` 所指的值 —— **只改那一段字节**。
 *
 * 键序、空白、其余字段的转义风格全部逐字节保持原样。这正是字段级编辑相对
 * 「整行重新序列化」的价值：改一个字段不该重排整行。
 */
export function replaceValueAtPath(
  text: string,
  path: readonly PathPart[],
  next: unknown
): ReplaceValueResult {
  const span = locateValue(text, path);
  if (!span) {
    return {
      ok: false,
      error: '未能在原文中定位该字段（原文可能不是标准 JSON，或该路径已不存在）。',
    };
  }
  const literal = JSON.stringify(next);
  if (literal === undefined) {
    return { ok: false, error: '该值无法序列化为 JSON。' };
  }
  return {
    ok: true,
    text: text.slice(0, span.start) + literal + text.slice(span.end),
    span,
  };
}
