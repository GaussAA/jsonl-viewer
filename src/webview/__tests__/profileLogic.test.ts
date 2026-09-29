/**
 * profileLogic.test.ts — 画像的展示层纯函数（F4）。
 *
 * 最要紧的一条是 `profileHeadline` 在**被中断**时的行为：半份统计与全量统计在界面上
 * 长得一模一样，用户会据此判断数据质量 —— 所以「结果不完整」必须出现在第一句。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fieldCoverage,
  fieldHasQualityIssue,
  fieldSummaryLine,
  formatCoverage,
  profileHeadline,
  sortFieldsForDisplay,
  topValueLabel,
} from '../profileLogic.ts';
import type { FieldProfile, ProfileResult } from '../../protocol/rpc.ts';

function field(partial: Partial<FieldProfile> & { key: string }): FieldProfile {
  return {
    present: 10,
    missing: 0,
    nulls: 0,
    empties: 0,
    types: { string: 10 },
    type: 'string',
    top: [],
    valuesTruncated: false,
    ...partial,
  };
}

function result(partial: Partial<ProfileResult> = {}): ProfileResult {
  return {
    scanned: 10,
    parsed: 10,
    bad: 0,
    totalRecords: 10,
    totalLines: 10,
    fields: [],
    fieldsTruncated: false,
    costMs: 12,
    ...partial,
  };
}

test('F4：覆盖率与百分比（分母为 0 时退化为 0，不是 NaN）', () => {
  assert.equal(fieldCoverage(3, 6), 0.5);
  assert.equal(fieldCoverage(5, 0), 0, '空文件不该算出 NaN');
  assert.equal(formatCoverage(3, 6), '50%');
  assert.equal(formatCoverage(0, 0), '0%');
  assert.equal(formatCoverage(1, 1), '100%');
});

test('F4：字段摘要只放能据以判断质量的三件事', () => {
  assert.equal(
    fieldSummaryLine(field({ key: 'a', present: 3, missing: 0 }), 3),
    '100%（3/3） · string'
  );
  const messy = field({ key: 'b', present: 8, missing: 2, nulls: 1, empties: 1, type: 'string' });
  const line = fieldSummaryLine(messy, 10);
  assert.match(line, /80%（8\/10）/);
  assert.match(line, /1 个 null/);
  assert.match(line, /1 个空串/);
  assert.match(line, /2 条缺失/);
});

test('F4：质量问题判定 —— 有缺失或有 null 才算，全覆盖的普通字段不加戏', () => {
  assert.equal(fieldHasQualityIssue(field({ key: 'a', present: 10, missing: 0 }), 10), false);
  assert.equal(fieldHasQualityIssue(field({ key: 'b', present: 9, missing: 1 }), 10), true);
  assert.equal(fieldHasQualityIssue(field({ key: 'c', present: 10, nulls: 2 }), 10), true);
  // 分母为 0 时不应把每个字段都标成「有问题」
  assert.equal(fieldHasQualityIssue(field({ key: 'd' }), 0), false);
});

test('F4：排序 —— 按出现次数与按缺失最多，且不改动入参', () => {
  const fields = [
    field({ key: 'rare', present: 2, missing: 18 }),
    field({ key: 'common', present: 20, missing: 0 }),
    field({ key: 'mid', present: 10, missing: 5, nulls: 3 }),
  ];
  const snapshot = JSON.stringify(fields);

  const byPresence = sortFieldsForDisplay(fields, 'presence').map((f) => f.key);
  assert.deepEqual(byPresence, ['common', 'mid', 'rare']);

  const byMissing = sortFieldsForDisplay(fields, 'missing').map((f) => f.key);
  assert.deepEqual(byMissing, ['rare', 'mid', 'common'], '缺得最多的排最前');

  assert.equal(JSON.stringify(fields), snapshot, '排序不得改动入参');
});

test('F4：抬头 —— 正常时给结论（记录数 / 字段数 / 稀疏字段 / 坏行 / 耗时）', () => {
  const text = profileHeadline(
    result({
      parsed: 100,
      fields: [field({ key: 'a' }), field({ key: 'b', missing: 30 })],
      bad: 2,
      costMs: 88,
    })
  );
  assert.match(text, /100 条记录/);
  assert.match(text, /2 个顶层字段/);
  assert.match(text, /1 个字段并非每条都有/);
  assert.match(text, /2 条解析失败/);
  assert.match(text, /88 ms/);
});

test('F4：抬头 —— 被中断时**第一句**就说结果不可信（半份统计看起来与全量一样）', () => {
  const text = profileHeadline(
    result({ cancelled: true, scanned: 30, totalRecords: 300, parsed: 30 })
  );
  assert.match(text, /^已中断/);
  assert.match(text, /30 \/ 300/, '如实给出扫到多少');
  assert.match(text, /请勿据此判断/, '必须劝阻据此下结论');
});

test('F4：抬头 —— 字段数触顶要说明（只列了一部分）', () => {
  const text = profileHeadline(result({ fieldsTruncated: true, fields: [field({ key: 'a' })] }));
  assert.match(text, /字段数已达统计上限/);
});

test('F4：top 值文案 —— 空串显示成「(空串)」，否则看起来像没渲染出来', () => {
  assert.equal(topValueLabel({ value: '', count: 3 }), '(空串) ×3');
  assert.equal(topValueLabel({ value: 'error', count: 1200 }), 'error ×1,200');
});
