import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateEditCost,
  validateEditText,
  formatJsonText,
  formatBytes,
  editCostWarning,
  describeEditFailure,
  estimateBatchCost,
  formatDuration,
  clipLabel,
  replaceConfirmText,
  replaceProgressText,
  editProgressText,
  isFieldEditableKind,
  initialFieldText,
  parseFieldInput,
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

test('editProgressText：措辞区别于批量替换，且百分比不越界', () => {
  assert.equal(editProgressText(0, 0), '正在写入…', '无总长时不显示荒谬的 NaN%');
  assert.equal(editProgressText(0, 100), '正在写入… 0%（0 B / 100 B）');
  assert.match(editProgressText(200, 100), /100%/);
  // 与批量替换分开措辞：用户据此判断「等多久才算不正常」
  assert.match(editProgressText(50, 100), /正在写入/);
  assert.ok(!/正在替换/.test(editProgressText(50, 100)));
});

test('describeEditFailure：取消优先于其余判定，措辞要让人放心', () => {
  const cancelled = describeEditFailure({
    cancelled: true,
    error: '已取消，文件已按备份恢复原样。',
  });
  assert.match(cancelled, /已取消/);
  assert.ok(!/失败/.test(cancelled), '取消绝不能说成失败');

  // 即便同时带着别的标记，取消也优先 —— 它是「用户主动中止」
  assert.equal(describeEditFailure({ cancelled: true, conflict: true }), '已取消，文件未被修改。');
  assert.equal(describeEditFailure({ cancelled: true }), '已取消，文件未被修改。');
});

test('describeEditFailure：失败的三类文案仍互不混淆', () => {
  assert.match(describeEditFailure({ conflict: true, error: '文件已被外部修改' }), /重新加载/);
  assert.match(describeEditFailure({ invalid: true, error: 'JSON 校验未通过：xxx' }), /JSON/);
  assert.equal(describeEditFailure({}), '保存失败');
  assert.equal(
    describeEditFailure({ error: '无写入权限：/tmp/a.jsonl' }),
    '无写入权限：/tmp/a.jsonl'
  );
});

/* ---------------------- 批量替换：成本与文案 ---------------------- */

test('estimateBatchCost：按文件大小估算，阈值上分级', () => {
  assert.deepEqual(estimateBatchCost(0), { bytes: 0, etaMs: 0, notable: false });
  // 脏输入不得产生 NaN 耗时（否则文案会出现「预计 NaN 秒」）
  assert.equal(estimateBatchCost(Number.NaN).bytes, 0);
  assert.equal(estimateBatchCost(-100).bytes, 0);

  const small = estimateBatchCost(1024);
  assert.equal(small.notable, false, '1KB 不值得提示');

  const big = estimateBatchCost(EDIT_COST_WARN_BYTES + 1);
  assert.equal(big.notable, true, '超过阈值即提示');
  assert.ok(big.etaMs > 0, '大文件必须有正的预估耗时');
});

test('formatDuration：不足 1 秒不给数字，秒/分按量级切换', () => {
  assert.equal(formatDuration(0), '不到 1 秒');
  assert.equal(formatDuration(999), '不到 1 秒');
  assert.equal(formatDuration(1000), '约 1 秒');
  assert.equal(formatDuration(5500), '约 6 秒');
  assert.equal(formatDuration(60000), '约 1 分钟');
  assert.equal(formatDuration(90000), '约 1 分 30 秒');
  assert.equal(formatDuration(Number.NaN), '不到 1 秒');
});

test('clipLabel：折叠空白并按长度截断', () => {
  assert.equal(clipLabel('bob'), 'bob');
  assert.equal(clipLabel('a\nb\tc'), 'a b c', '换行与制表折叠为空格');
  assert.equal(clipLabel('x'.repeat(50)).length, 33, '32 字符 + 省略号');
  assert.match(clipLabel('x'.repeat(50)), /…$/);
});

test('replaceConfirmText：小文件不啰嗦，大文件说明「为什么慢」并可取消', () => {
  const small = replaceConfirmText('bob', 'alice', 1024);
  assert.match(small, /确定把全部「bob」替换为「alice」/);
  assert.match(small, /立即写入磁盘/);
  assert.ok(!/重写整个/.test(small), '小文件不该出现重写成本说明');

  const big = replaceConfirmText('bob', 'alice', EDIT_COST_WARN_BYTES + 1);
  assert.match(big, /重写整个/);
  assert.match(big, /与命中行数无关/, '必须说明代价来自文件大小而非命中数');
  assert.match(big, /可取消/, '有取消入口就要说');
  assert.match(big, /取消后文件保持原样/, '取消的安全性要说清楚');
});

test('replaceConfirmText：超长查找/替换文本被截断，不撑爆横幅', () => {
  const text = replaceConfirmText('q'.repeat(200), 'r'.repeat(200), 1024);
  assert.ok(text.length < 160, `文案应保持简短，实际 ${text.length} 字`);
  assert.match(text, /…/);
});

test('replaceProgressText：百分比与字节数，且不越界', () => {
  assert.equal(replaceProgressText(0, 0), '正在替换…', '无总长时不显示荒谬的 NaN%');
  assert.equal(replaceProgressText(0, 100), '正在替换… 0%（0 B / 100 B）');
  assert.equal(replaceProgressText(50, 100), '正在替换… 50%（50 B / 100 B）');
  assert.match(replaceProgressText(200, 100), /100%/, '超过总长也封顶 100%');
});

/* ---------------------------- 字段级编辑 ---------------------------- */

test('isFieldEditableKind：仅 string/number/boolean —— null 刻意不支持', () => {
  assert.equal(isFieldEditableKind('string'), true);
  assert.equal(isFieldEditableKind('number'), true);
  assert.equal(isFieldEditableKind('boolean'), true);
  // null 没有「同类型的新值」可言；为它引入第二套输入语义只会让浮层的规则随类型漂移。
  assert.equal(isFieldEditableKind('null'), false);
  assert.equal(isFieldEditableKind('object'), false);
  assert.equal(isFieldEditableKind('array'), false);
});

test('initialFieldText：字符串不带引号（所见即所得）', () => {
  assert.equal(initialFieldText('abc'), 'abc');
  assert.equal(initialFieldText('he said "hi"'), 'he said "hi"', '不预先加转义');
  assert.equal(initialFieldText(''), '');
  assert.equal(initialFieldText(42), '42');
  assert.equal(initialFieldText(-1.5e3), '-1500');
  assert.equal(initialFieldText(true), 'true');
});

test('parseFieldInput：按原类型解析', () => {
  assert.deepEqual(parseFieldInput('abc', 'string'), { ok: true, value: 'abc' });
  assert.deepEqual(parseFieldInput('', 'string'), { ok: true, value: '' }, '空字符串是合法值');
  assert.deepEqual(parseFieldInput('42', 'number'), { ok: true, value: 42 });
  assert.deepEqual(parseFieldInput('-1.5e3', 'number'), { ok: true, value: -1500 });
  assert.deepEqual(parseFieldInput('  7  ', 'number'), { ok: true, value: 7 }, '容忍首尾空白');
  assert.deepEqual(parseFieldInput('true', 'boolean'), { ok: true, value: true });
  assert.deepEqual(parseFieldInput(' false ', 'boolean'), { ok: true, value: false });
});

test('parseFieldInput：拒绝所有「不是 JSON 数字」的写法', () => {
  // 裸 Number() 会接受其中多数（0x10→16、1_000→1000），于是用户输入的东西与最终
  // 落盘的东西不是一回事 —— 这种「我明明写的不是这个」的困惑最难排查。
  for (const bad of [
    '',
    '   ',
    '0x10',
    '1_000',
    'Infinity',
    '-Infinity',
    'NaN',
    '1.',
    '.5',
    '+1',
    '01',
    '1e',
    '1e+',
    '1.2.3',
    'abc',
    '12px',
  ]) {
    const r = parseFieldInput(bad, 'number');
    assert.equal(r.ok, false, `「${bad}」应被拒绝`);
    if (r.ok === false) assert.ok(r.error.length > 0, '拒绝时必须给出原因');
  }
});

test('parseFieldInput：布尔与数字的错误原因可读，且不含未处理的占位', () => {
  const bool = parseFieldInput('yes', 'boolean');
  assert.equal(bool.ok, false);
  if (bool.ok === false) assert.match(bool.error, /true 或 false/);

  const empty = parseFieldInput('', 'number');
  assert.equal(empty.ok, false);
  if (empty.ok === false) assert.match(empty.error, /不能为空/);
});
