/**
 * editLogic.ts — 编辑能力的**纯逻辑层**（无 DOM / 无 node 依赖，可直接单测）。
 *
 * 承担三件事：
 *   1. **成本预估**：变长编辑必须搬移该行之后的全部字节，代价 = 尾部字节数。前端拿不到
 *      精确行偏移，故按「剩余行数占比」保守估算 —— 宁可高估（提醒用户），不可低估；
 *   2. **提交前校验**：文本非空且可被 `JSON.parse` 解析（宿主侧还会再校验一次，
 *      这里是即时反馈，省一次往返）；
 *   3. **文案整理**：把字节数 / 行号 / 校验错误整理成给用户看的一句话。
 */

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
 * - 但 `trim()` 后为空的视为空行 → 拒绝（JSONL 的空行是坏行，不该被写出来）。
 */
export function validateEditText(raw: string): EditValidation {
  if (raw.trim().length === 0) {
    return { ok: false, error: '内容为空：JSONL 不接受空行' };
  }
  try {
    JSON.parse(raw);
    return { ok: true, text: raw };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 格式化：`JSON.stringify` 重排为 2 空格缩进。
 *
 * **仅在用户显式点击「格式化」时调用** —— 默认绝不擅自重排，因为重排会改变字节长度、
 * 放大变长编辑的搬移成本，也违背「保持原样」的编辑原则。解析失败返回 undefined。
 */
export function formatJsonText(raw: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
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
}): string {
  if (res.conflict) {
    return `${res.error ?? '文件已变化'}\n可点击「重新加载」获取磁盘最新内容后再编辑。`;
  }
  if (res.invalid) return res.error ?? 'JSON 校验未通过';
  return res.error ?? '保存失败';
}
