/**
 * editLogic.ts — 编辑能力的**纯逻辑层**（无 DOM / 无 node 依赖，可直接单测）。
 *
 * 承担四件事：
 *   1. **成本预估**：变长编辑必须搬移该行之后的全部字节，代价 = 尾部字节数。前端拿不到
 *      精确行偏移，故按「剩余行数占比」保守估算 —— 宁可高估（提醒用户），不可低估；
 *   2. **提交前校验**：文本非空且可被 `JSON.parse` 解析（宿主侧还会再校验一次，
 *      这里是即时反馈，省一次往返）；
 *   3. **文案整理**：把字节数 / 行号 / 校验错误整理成给用户看的一句话；
 *   4. **批量替换的成本与文案**：批量重写的代价恒为文件大小（与命中数无关），
 *      故按其估算耗时并在确认文案里说明「为什么慢」。
 */

import { REWRITE_THROUGHPUT_BYTES_PER_MS } from '../constants.ts';

/** 成本提示阈值：估值超过该值即提示「可能需要搬移较多数据」。32MB。 */
export const EDIT_COST_WARN_BYTES = 32 * 1024 * 1024;

/**
 * 估算「编辑第 line 行」需要搬移的尾部字节数。
 *
 * 真实成本 = `totalBytes - 该行末尾偏移`，前端没有精确偏移，故用剩余行数占比近似。
 * 对位于文件前部的行会略高估（安全方向），对末行返回 0（确实无需搬移）。
 */
export function estimateEditCost(totalBytes: number, totalLines: number, line: number): number {
  if (!Number.isFinite(totalBytes) || !Number.isFinite(totalLines)) return 0;
  if (totalBytes <= 0 || totalLines <= 0 || line < 0) return 0;
  const remaining = Math.max(0, totalLines - line - 1);
  return Math.floor((totalBytes * remaining) / totalLines);
}

/** 提交前校验结果。 */
export type EditValidation = { ok: true; text: string } | { ok: false; error: string };

/**
 * 校验待提交的整行文本。
 *
 * - **保留原始内容**（不 trim、不重排）：用户输入的空白与键序都可能是有意为之；
 * - 但 `trim()` 后为空的视为空行 → 拒绝（JSONL 的空行是坏行，不该被写出来）；
 * - **含物理换行（\n / \r）→ 拒绝**：JSONL 每条记录必须单行。合法的 JSONL 行里，
 *   字符串值内的换行必然已转义为 `\n` 字面量 —— 文本里出现物理换行只有一种解释：
 *   被格式化/粘贴成了多行。多行文本整体是合法 JSON，所以**只靠 JSON.parse 拦不住
 *   它**，必须显式检查（v1.8.0 实机事故的另一半根因：多行文本被写入后，从那一行起
 *   整个文件的行号与内容全部错位）。
 */
export function validateEditText(raw: string): EditValidation {
  if (raw.trim().length === 0) {
    return { ok: false, error: '内容为空：JSONL 不接受空行' };
  }
  if (/\r|\n/.test(raw)) {
    return {
      ok: false,
      error:
        'JSONL 每条记录必须单行：文本含换行（可能被格式化或粘贴成了多行）。' +
        '请点「格式化」做单行规范化，或把记录并回一行后再保存。',
    };
  }
  try {
    JSON.parse(raw);
    return { ok: true, text: raw };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 格式化：**单行规范化**（JSONL 语义下的「格式化」）。
 *
 * `JSON.stringify(value)`（无缩进参数）：去掉多余空白、规范转义风格，**保持键序与值
 * 原样**，且产出恒为单行。
 *
 * **刻意不做 pretty-print**（多行缩进）：JSONL 的每条记录占一行，把一条记录展开成
 * 多行再写回，物理行数就变了 —— 解析按物理行切，首行只剩 `{`，从那一行起整个文件
 * 的行号与内容全部错位（v1.8.0 实机事故的根因）。pretty 输出属于「整份 JSON 文档」
 * 的编辑器习惯，在「一行一记录」的文件里是错误语义。
 *
 * 仅在用户显式点击「格式化」时调用 —— 即便单行规范化也会改变字节长度（多余空白被
 * 移除），放大变长编辑的搬移成本，同样违背「保持原样」的默认原则。解析失败返回
 * undefined。
 */
export function formatJsonText(raw: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * 字节数的人类可读表示：仅在「小于 10 且非整数」时保留 1 位小数。
 *
 * 例：`512 B` / `1 KB` / `1.5 KB` / `32 MB`（32MB+1B 也显示 32 MB —— 提示文案里
 * 无意义的 `.0` 只会增加噪音）。
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const digits = i === 0 || Number.isInteger(value) || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[i]}`;
}

/**
 * 成本提示文案：估值超过阈值才返回，否则 undefined（不打扰用户）。
 *
 * 措辞刻意说明「为什么慢」而不仅是「慢」—— 用户知道代价来自尾部搬移，才理解这是
 * 文件结构的物理约束，而非实现缺陷。
 */
export function editCostWarning(
  costBytes: number,
  threshold: number = EDIT_COST_WARN_BYTES
): string | undefined {
  if (costBytes <= threshold) return undefined;
  return (
    `此行之后约有 ${formatBytes(costBytes)} 数据需要搬移（修改行长度会平移其后的全部字节），` +
    `保存可能需要数秒。`
  );
}

/** 把宿主返回的失败结果整理成给用户看的错误文案。 */
export function describeEditFailure(res: {
  error?: string;
  conflict?: boolean;
  invalid?: boolean;
  cancelled?: boolean;
}): string {
  // 取消优先于其余判定：它是「用户主动中止」而非失败。写入层已自动回滚，
  // 故措辞必须让人放心（文件原样未动），而不是混在「保存失败」里吓人一跳。
  if (res.cancelled) return res.error ?? '已取消，文件未被修改。';
  if (res.conflict) {
    return `${res.error ?? '文件已变化'}\n可点击「重新加载」获取磁盘最新内容后再编辑。`;
  }
  if (res.invalid) return res.error ?? 'JSON 校验未通过';
  return res.error ?? '保存失败';
}

/* ------------------------- 批量替换：成本与文案 ------------------------- */

/** 批量重写的耗时估算。 */
export interface BatchCostEstimate {
  /** 需要重写的文件字节数。 */
  bytes: number;
  /** 预估耗时（毫秒）。 */
  etaMs: number;
  /** 是否值得提示用户（超过 `EDIT_COST_WARN_BYTES`）。 */
  notable: boolean;
}

/**
 * 估算批量替换的代价。
 *
 * 关键：成本**恒为 O(文件大小)，与命中行数无关** —— 这正是选「全量重写 + 原子 rename」
 * 而非「逐处搬移」换来的性质（后者是 Σ(每处改动点距 EOF)，命中散落全文件时可达数十倍
 * 文件大小）。故这里只需文件大小，不需要知道命中了多少行。
 */
export function estimateBatchCost(totalBytes: number): BatchCostEstimate {
  const bytes = Number.isFinite(totalBytes) && totalBytes > 0 ? Math.floor(totalBytes) : 0;
  // 有效吞吐含读 + 写 + fsync，取保守值：宁可高估等待，也不低估后让用户以为卡死。
  const etaMs = Math.round(bytes / REWRITE_THROUGHPUT_BYTES_PER_MS);
  return { bytes, etaMs, notable: bytes > EDIT_COST_WARN_BYTES };
}

/** 耗时的人类可读表示；不足 1 秒不给数字（「预计 0 秒」是荒谬的提示）。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '不到 1 秒';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `约 ${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return rest === 0 ? `约 ${min} 分钟` : `约 ${min} 分 ${rest} 秒`;
}

/** 提示文案里的长文本截断（否则一次替换能把横幅撑成一行巨物）。 */
export function clipLabel(s: string, max = 32): string {
  const oneLine = s.replace(/\s+/g, ' ');
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}

/**
 * 批量替换的二次确认文案。
 *
 * 小文件不啰嗦；大文件必须说明**为什么慢** —— 用户知道代价来自「整个文件需要重写」，
 * 才理解这是批量改写的物理约束，而非实现缺陷。
 */
export function replaceConfirmText(
  query: string,
  replacement: string,
  totalBytes: number,
  threshold: number = EDIT_COST_WARN_BYTES
): string {
  const head = `确定把全部「${clipLabel(query)}」替换为「${clipLabel(replacement)}」？`;
  const cost = estimateBatchCost(totalBytes);
  if (cost.bytes <= threshold) return `${head}该操作会立即写入磁盘。`;
  return (
    `${head}这需要重写整个 ${formatBytes(cost.bytes)} 文件` +
    `（批量替换的代价与命中行数无关，恒为文件大小），预计${formatDuration(cost.etaMs)}，` +
    `过程中可取消，取消后文件保持原样。`
  );
}

/** 批量替换执行中的进度文案。 */
export function replaceProgressText(processedBytes: number, totalBytes: number): string {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return '正在替换…';
  const pct = Math.min(100, Math.max(0, Math.floor((processedBytes / totalBytes) * 100)));
  return `正在替换… ${pct}%（${formatBytes(processedBytes)} / ${formatBytes(totalBytes)}）`;
}

/**
 * 单行编辑（搬移尾部）的进度文案。
 *
 * 与批量替换分开措辞：一个是「改写这一行」，一个是「重写整个文件」—— 用户据此判断
 * 等多久才算不正常，混着说会让人误以为自己在做整文件操作。
 */
export function editProgressText(processedBytes: number, totalBytes: number): string {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return '正在写入…';
  const pct = Math.min(100, Math.max(0, Math.floor((processedBytes / totalBytes) * 100)));
  return `正在写入… ${pct}%（${formatBytes(processedBytes)} / ${formatBytes(totalBytes)}）`;
}

/* ---------------------------- 字段级编辑（详情树） ---------------------------- */

/**
 * 支持字段级编辑的值类型。
 *
 * **刻意不含 `null`**：null 字段没有「同类型的新值」可言，要给它填值就必须换类型；
 * 而一旦为了 null 引入「按 JSON 字面量输入」的第二套规则，同一个浮层的输入语义就会
 * 随类型漂移（改字符串是裸文本、改 null 要带引号）—— 那是很难不被误解的 UX 陷阱。
 * 填值请走整行编辑（那是填入任意值的通用入口）。这是**有意的能力边界**，不是缺口。
 */
export type FieldEditKind = 'string' | 'number' | 'boolean';

/** 该值是否可做字段级编辑（与 detailTree 的入口判定必须一致）。 */
export function isFieldEditableKind(kind: string): kind is FieldEditKind {
  return kind === 'string' || kind === 'number' || kind === 'boolean';
}

/**
 * 输入框的初始文本。
 *
 * 字符串**不带引号**：用户改的是值本身，不是 JSON token（所见即所得）。
 * 保存时再按原类型序列化并转义。
 */
export function initialFieldText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * JSON 数字的严格语法（与 core/jsonSpan 的扫描规则一致）。
 *
 * 不用裸 `Number()`：它会接受 `0x10`（→16）、`1_000`、`  12  ` 这些**不是 JSON 数字**
 * 的写法，于是用户输入的东西与最终落盘的东西不是一回事 —— 那种「我明明写的不是这个」
 * 的困惑最难排查。
 */
const JSON_NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * 把输入文本按**原类型**解析为新值。
 *
 * 类型恒为原类型：用户点的是「编辑这个字段的值」，不是「改字段类型」。若确实要换类型，
 * 整行编辑才是那个入口 —— 让两种入口各司其职，比让一个输入框猜用户意图可靠得多。
 */
export function parseFieldInput(
  text: string,
  kind: FieldEditKind
): { ok: true; value: string | number | boolean } | { ok: false; error: string } {
  if (kind === 'string') return { ok: true, value: text };
  if (kind === 'boolean') {
    const t = text.trim();
    if (t === 'true') return { ok: true, value: true };
    if (t === 'false') return { ok: true, value: false };
    return { ok: false, error: '布尔值只能是 true 或 false。' };
  }
  const t = text.trim();
  if (t === '') return { ok: false, error: '数字不能为空。' };
  if (!JSON_NUMBER_RE.test(t)) return { ok: false, error: `「${t}」不是合法的 JSON 数字。` };
  return { ok: true, value: Number(t) };
}

/**
 * 「应用到全部」的二次确认文案（批量字段级替换）。
 *
 * 与整行替换共用同一成本模型：字段级批量同样要**重写整个文件**，代价与命中行数无关。
 * 文案里必须说明这一点 —— 用户知道代价来自「整个文件重写」，才不会以为是实现缺陷。
 */
export function fieldReplaceConfirmText(
  pathText: string,
  totalBytes: number,
  threshold: number = EDIT_COST_WARN_BYTES
): string {
  const head = `确定把所有行中「${pathText}」下与当前值相同的字段替换为新值？`;
  const cost = estimateBatchCost(totalBytes);
  if (cost.bytes <= threshold) return `${head}该操作会立即写入磁盘。`;
  return (
    `${head}这需要重写整个 ${formatBytes(cost.bytes)} 文件` +
    `（批量替换的代价与命中行数无关，恒为文件大小），预计${formatDuration(cost.etaMs)}，` +
    `过程中可取消，取消后文件保持原样。`
  );
}
