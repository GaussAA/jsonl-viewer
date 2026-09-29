/**
 * profileLogic.ts — 画像的**纯展示逻辑**（无 DOM / 无 node 依赖，可直接单测）。
 *
 * 为什么单独一层：画像是「一整屏数字」，而数字本身不构成结论。把「怎么把一组统计
 * 说成人话」收敛成纯函数，面板只负责把它们贴到 DOM 上 —— 文案可以被测试，
 * 而不是散落在渲染代码里靠肉眼检查。
 */

import type { FieldProfile, ProfileResult } from '../protocol/rpc.ts';

/** 覆盖率 = 出现次数 / 参与统计的记录数。分母为 0 时返回 0（而不是 NaN 或被 0 除）。 */
export function fieldCoverage(present: number, parsed: number): number {
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return present / parsed;
}

/** 覆盖率 → 百分比文本（整数百分比；0 与 100 不加小数）。 */
export function formatCoverage(present: number, parsed: number): string {
  return `${Math.round(fieldCoverage(present, parsed) * 100)}%`;
}

/**
 * 一条字段的摘要行（面板左侧主文案）。
 *
 * 只放「能据以判断数据质量」的三件事：出现率、空值情况、主要类型。
 */
export function fieldSummaryLine(f: FieldProfile, parsed: number): string {
  const parts = [`${formatCoverage(f.present, parsed)}（${f.present}/${parsed}）`, f.type];
  if (f.nulls > 0) parts.push(`${f.nulls} 个 null`);
  if (f.empties > 0) parts.push(`${f.empties} 个空串`);
  if (f.missing > 0) parts.push(`${f.missing} 条缺失`);
  return parts.join(' · ');
}

/** 字段是否存在数据质量问题（用于视觉强调：稀疏 / 有 null / 有缺失）。 */
export function fieldHasQualityIssue(f: FieldProfile, parsed: number): boolean {
  if (f.missing > 0 || f.nulls > 0) return true;
  return parsed > 0 && f.present < parsed;
}

/** 字段排序维度。 */
export type ProfileSort = 'presence' | 'missing';

/**
 * 按展示需要排序（返回新数组，不改动入参）。
 *
 * `missing` 维度把「最不完整的字段」顶到最前 —— 数据清洗时最先要看的就是它们；
 * `presence` 则是「字段有多常用」，用于摸清结构。
 */
export function sortFieldsForDisplay(
  fields: readonly FieldProfile[],
  mode: ProfileSort = 'presence'
): FieldProfile[] {
  const copy = [...fields];
  if (mode === 'missing') {
    copy.sort((a, b) => b.missing + b.nulls - (a.missing + a.nulls) || b.present - a.present);
  } else {
    copy.sort((a, b) => b.present - a.present || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  return copy;
}

/**
 * 面板抬头的一句话结论。
 *
 * 被中断时**第一句**就得说结果不可信 —— 半份统计看起来与全量毫无区别，
 * 而用户会据此对数据下判断。
 */
export function profileHeadline(res: ProfileResult): string {
  if (res.cancelled) {
    return `已中断：只扫了 ${res.scanned.toLocaleString('en-US')} / ${res.totalRecords.toLocaleString('en-US')} 条，结果不完整，请勿据此判断数据质量。`;
  }
  const parts = [
    `共 ${res.parsed.toLocaleString('en-US')} 条记录，${res.fields.length} 个顶层字段`,
  ];
  const sparse = res.fields.filter((f) => f.missing > 0).length;
  if (sparse > 0) parts.push(`${sparse} 个字段并非每条都有`);
  if (res.bad > 0) parts.push(`${res.bad} 条解析失败（未计入统计）`);
  if (res.fieldsTruncated) parts.push('字段数已达统计上限，仅列出前若干');
  parts.push(`用时 ${res.costMs} ms`);
  return parts.join(' · ');
}

/** 顶部取值 → 一行文本（值 + 次数）；值为空串时显示成「(空串)」以免看起来像没渲染。 */
export function topValueLabel(entry: { value: string; count: number }): string {
  const shown = entry.value === '' ? '(空串)' : entry.value;
  return `${shown} ×${entry.count.toLocaleString('en-US')}`;
}
