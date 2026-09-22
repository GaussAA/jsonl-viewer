import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateEditCost,
  validateEditText,
  formatJsonText,
  formatBytes,
  editCostWarning,
  describeEditFailure,
  EDIT_COST_WARN_BYTES,
} from '../editLogic.ts';

/* ---------------------------- 成本预估 ---------------------------- */

test('estimateEditCost：末行为 0，首行接近全量，中间按剩余行数占比', () => {
  const bytes = 1000;
  const lines = 10;
  assert.equal(estimateEditCost(bytes, lines, 9), 0, '末行之后无数据 → 零搬移');
  assert.equal(estimateEditCost(bytes, lines, 0), 900, '首行 → 剩余 9/10');
  assert.equal(estimateEditCost(bytes, lines, 4), 500, '中间 → 剩余 5/10');
});

test('estimateEditCost：脏输入与非正数一律回 0（不抛错）', () => {
  assert.equal(estimateEditCost(0, 10, 0), 0);
  assert.equal(estimateEditCost(100, 0, 0), 0);
  assert.equal(estimateEditCost(100, 10, -1), 0);
  assert.equal(estimateEditCost(Number.NaN, 10, 0), 0);
  assert.equal(estimateEditCost(100, Number.NaN, 0), 0);
  // 越界的行号也不应产出负数
  assert.equal(estimateEditCost(100, 10, 99), 0);
});

/* ---------------------------- 提交校验 ---------------------------- */

test('validateEditText：合法 JSON 通过且原文不被改动', () => {
  const raw = ' {"b":2,  "a":1} ';
  const r = validateEditText(raw);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.text, raw, '必须原样保留（不 trim、不重排）');
  assert.equal(validateEditText('[1,2,3]').ok, true);
  assert.equal(validateEditText('42').ok, true);
  assert.equal(validateEditText('null').ok, true);
});

test('validateEditText：空行 / 纯空白 / 非法 JSON 一律拒绝', () => {
  assert.equal(validateEditText('').ok, false);
  assert.equal(validateEditText('   ').ok, false);
  assert.equal(validateEditText('\n\t').ok, false);

  const bad = validateEditText('{"a":1,,}');
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.error.length > 0, '应带可读错误原因');
});

/* ---------------------------- 格式化 ---------------------------- */

test('formatJsonText：合法则重排为 2 空格缩进，非法返回 undefined', () => {
  assert.equal(formatJsonText('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(formatJsonText('[1,2]'), '[\n  1,\n  2\n]');
  assert.equal(formatJsonText('{"a":1,,}'), undefined);
  assert.equal(formatJsonText(''), undefined);
});

/* ---------------------------- 文案 ---------------------------- */

test('formatBytes：小数只在「小于 10 且非整数」时保留（避免 32.0 MB 这类噪音）', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(32 * 1024 * 1024), '32 MB');
  assert.equal(formatBytes(32 * 1024 * 1024 + 1), '32 MB', '大数值不做无意义的小数展开');
  assert.equal(formatBytes(3 * 1024 ** 3), '3 GB');
});

test('editCostWarning：未超阈值不打扰，超阈值说明「为什么慢」', () => {
  assert.equal(editCostWarning(0), undefined);
  assert.equal(editCostWarning(EDIT_COST_WARN_BYTES), undefined, '等于阈值不算超');
  const warn = editCostWarning(EDIT_COST_WARN_BYTES + 1);
  assert.ok(warn);
  assert.match(warn, /搬移/);
  assert.match(warn, /64 MB|32 MB/);
});

test('describeEditFailure：冲突 / 校验 / 通用三类文案可区分', () => {
  assert.match(describeEditFailure({ conflict: true, error: '文件已被外部修改' }), /重新加载/);
  assert.match(describeEditFailure({ invalid: true, error: 'JSON 校验未通过：xxx' }), /JSON/);
  assert.equal(describeEditFailure({}), '保存失败');
  assert.equal(
    describeEditFailure({ error: '无写入权限：/tmp/a.jsonl' }),
    '无写入权限：/tmp/a.jsonl'
  );
});
