/**
 * replaceLogic.ts — 查找替换的「共享纯逻辑层」（零依赖）。
 *
 * 与 `core/query.ts` 同样的定位：宿主与 webview 两侧都需要判断「这一行按给定条件
 * 替换后是什么、能不能接受」，判定规则必须**单一来源**，否则会出现「前端预览说改 3 处、
 * 宿主实际只改 2 处」这种最难查的分歧。
 *
 * 本模块刻意不 import 任何 host / node / DOM / webview 模块：
 *   · JSON 合法性校验以**注入函数**方式提供（宿主注入 `parseJsonLine`，webview 注入
 *     `JSON.parse` 试解析）——避免 core 层为一次校验反向依赖解析器与 node 内建；
 *   · 于是它既能被宿主复用，也能被 webview 打包，且可直接 `node:test` 单测。
 *
 * 三条不可让步的规则：
 *   1. **字面量匹配，绝不是正则** —— 用户输入 `.*` `[` `(` 是常见的事，当正则会变成
 *      意外的大面积改写（甚至抛异常）。查找替换只做纯文本。
 *   2. **大小写折叠只折 ASCII A-Z，且长度严格不变** —— `String.prototype.toLowerCase()`
 *      对 'İ'(U+0130) 等字符会改变长度，一旦长度变了，用折叠后字符串算出的索引去
 *      原串上切片就会整体错位、切出乱码。此处逐 UTF-16 码元判断，长度恒等。
 *      同时必须与 `searchEngine.foldAsciiLower` 语义一致，否则用户会看到
 *      「搜索说有 5 处命中，替换却说不匹配」。
 *   3. **替换后 JSON 非法即跳过该行**（而非整批拒绝）—— 批量替换里个别行失败不该
 *      拖垮整体，但必须被如实统计并醒目地告诉用户，不能让人以为全改完了。
 */

/** 单行替换的跳过原因。 */
export type ReplaceSkipReason = 'unchanged' | 'invalid-json';

export interface LineReplacePlan {
  /** 替换后的新文本；未发生实际变化时为 undefined。 */
  text?: string;
  /** 该行内被替换的处数（即使最终跳过也会给出，便于前端如实提示）。 */
  count: number;
  /** 未产生写入的原因。 */
  skip?: ReplaceSkipReason;
}

export interface ReplacePlanOptions {
  /** 是否大小写不敏感（与搜索保持一致，默认 true）。 */
  caseInsensitive?: boolean;
  /**
   * 替换结果的接受性校验（返回 false 则该行跳过）。
   * 宿主注入 `(t) => parseJsonLine(t).ok`；webview 注入 JSON 试解析。
   */
  validate?: (text: string) => boolean;
}

/** 只折叠 ASCII A-Z → a-z。**长度严格不变**（见文件头规则 2）。 */
export function foldAscii(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

/** 该行会出现多少处匹配（不重叠，语义与「全部替换」一致）。 */
export function countLiteralMatches(hay: string, needle: string, caseInsensitive = true): number {
  if (!needle) return 0;
  const h = caseInsensitive ? foldAscii(hay) : hay;
  const n = caseInsensitive ? foldAscii(needle) : needle;
  let from = 0;
  let count = 0;
  while (true) {
    const at = h.indexOf(n, from);
    if (at < 0) return count;
    count++;
    from = at + n.length;
  }
}

/**
 * 规划一行的替换：返回新文本 / 处数 / 跳过原因。
 *
 * 不重叠匹配（`from = at + needle.length`）：与 `countLiteralMatches`、与 `String.replaceAll`
 * 的默认语义一致，避免「计数说 3 处、替换后只剩 2 处」。
 */
export function planLineReplace(
  rawText: string,
  query: string,
  replacement: string,
  opts: ReplacePlanOptions = {}
): LineReplacePlan {
  if (!query) return { count: 0, skip: 'unchanged' };
  const ci = opts.caseInsensitive !== false;
  const hay = ci ? foldAscii(rawText) : rawText;
  const needle = ci ? foldAscii(query) : query;
  if (hay.length < needle.length) return { count: 0, skip: 'unchanged' };

  let from = 0;
  let count = 0;
  let out = '';
  while (true) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    // 用**原串**切片（而非折叠串）——折叠串只用于定位。
    out += rawText.slice(from, at) + replacement;
    from = at + needle.length;
    count++;
  }
  if (count === 0) return { count: 0, skip: 'unchanged' };
  out += rawText.slice(from);

  // 替换成与原文相同的内容（如将 'a' 换成 'a'）：不是变化，不该计入写入。
  if (out === rawText) return { count, skip: 'unchanged' };

  if (opts.validate && !opts.validate(out)) return { count, skip: 'invalid-json' };
  return { text: out, count };
}

/* ------------------------------ 结果汇总 ------------------------------ */

export interface ReplaceOutcome {
  /** 实际改写的行数。 */
  replaced: number;
  /** 因替换后 JSON 非法而跳过的行数。 */
  skippedInvalid: number;
  /** 命中查询但内容无变化的行数（替换文本与原文相同）。 */
  unchanged: number;
  /** 扫描过的命中行总数。 */
  total: number;
}

/**
 * 生成面向用户的结果文案。
 *
 * 刻意把「跳过」放在显眼位置：用户点了「全部替换」后最危险的误解就是「以为全改完了」。
 * 只报「已替换 N 行」而隐瞒跳过数，等于让用户在不知情下继续基于错误认知操作。
 */
export function describeReplaceOutcome(o: ReplaceOutcome): string {
  if (o.total === 0) return '没有匹配的内容';
  const parts = [`已替换 ${o.replaced} 行`];
  if (o.skippedInvalid > 0) {
    parts.push(`${o.skippedInvalid} 行因替换后 JSON 非法已跳过`);
  }
  if (o.unchanged > 0) parts.push(`${o.unchanged} 行内容无变化`);
  return parts.join('；');
}
