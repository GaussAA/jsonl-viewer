import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineIndex } from '../../indexer/lineIndex.ts';
import { MemoryReader } from '../../parser/jsonParser.ts';
import { inferFields, fieldTypeOf, ARRAY_RECORD_KEY, SCALAR_RECORD_KEY } from '../inferFields.ts';

async function inferFromString(
  s: string,
  opts: { sampleLines?: number; sampleMaxLen?: number } = {}
) {
  const buf = Buffer.from(s, 'utf8');
  const li = await LineIndex.build([buf]);
  const reader = new MemoryReader(buf);
  return inferFields(reader, li, opts);
}

test('fieldTypeOf：各类型映射正确', () => {
  assert.equal(fieldTypeOf('x'), 'string');
  assert.equal(fieldTypeOf(42), 'number');
  assert.equal(fieldTypeOf(true), 'boolean');
  assert.equal(fieldTypeOf(null), 'null');
  assert.equal(fieldTypeOf(undefined), 'undefined');
  assert.equal(fieldTypeOf({}), 'object');
  assert.equal(fieldTypeOf([]), 'array');
});

test('前 N 行抽样正确性：只扫前 sampleLines 行', async () => {
  // 前 100 行有 id+name；第 300 行之后才有 lateOnly。
  const lines: string[] = [];
  for (let i = 0; i < 300; i++) {
    lines.push(JSON.stringify({ id: i, name: `n${i}` }));
  }
  lines[299] = JSON.stringify({ id: 299, lateOnly: true }); // 不会进入前 N 抽样
  const res = await inferFromString(lines.join('\n') + '\n', { sampleLines: 100 });

  assert.equal(res.scanned, 100);
  assert.equal(res.total, 100);
  const keys = res.fields.map((f) => f.key);
  assert.ok(keys.includes('id'));
  assert.ok(keys.includes('name'));
  assert.ok(!keys.includes('lateOnly'), 'lateOnly 不应出现在前 100 行抽样中');
  // 前 100 行每行都有 id/name → freq 应为 100, coverage 1
  const id = res.fields.find((f) => f.key === 'id')!;
  assert.equal(id.freq, 100);
  assert.equal(id.coverage, 1);
});

test('坏行与空行跳过：不计入字段，且出现在 errorLines', async () => {
  const s = '{"a":1}\nnot-valid\n\n{"a":2,"b":3}\n{"a":3,"b":4}\n';
  const res = await inferFromString(s, { sampleLines: 100 });
  // 有效记录 = 行0,3,4 → total 3
  assert.equal(res.total, 3);
  assert.deepEqual(res.errorLines, [1, 2]); // 坏行 + 空行
  const a = res.fields.find((f) => f.key === 'a')!;
  const b = res.fields.find((f) => f.key === 'b')!;
  assert.equal(a.freq, 3);
  assert.equal(a.coverage, 1); // 3/3
  assert.equal(b.freq, 2);
  assert.equal(Number(b.coverage.toFixed(4)), Number((2 / 3).toFixed(4)));
});

test('类型推断：混合类型得到计数、主导类型与恒定型标记', async () => {
  const s = ['{"m":1}', '{"m":"str"}', '{"m":2}'].join('\n');
  const res = await inferFromString(s);
  const m = res.fields.find((f) => f.key === 'm')!;
  assert.equal(m.types.number, 2);
  assert.equal(m.types.string, 1);
  assert.equal(m.types.object, 0);
  assert.equal(m.type, 'number'); // 主导类型
  assert.equal(m.alwaysObject, false);
  assert.equal(m.alwaysArray, false);
});

test('恒为对象 / 恒为数组', async () => {
  const s = ['{"o":{"x":1}}', '{"o":{"x":2}}'].join('\n');
  const res = await inferFromString(s);
  const o = res.fields.find((f) => f.key === 'o')!;
  assert.equal(o.type, 'object');
  assert.equal(o.alwaysObject, true);
  assert.equal(o.alwaysArray, false);
  assert.equal(Number(o.coverage), 1);
});

test('字段按出现频率降序排列（平手按字段名）', async () => {
  const s = ['{"a":1,"b":2}', '{"a":2}', '{"a":3,"c":4}'].join('\n');
  const res = await inferFromString(s);
  assert.deepEqual(
    res.fields.map((f) => f.key),
    ['a', 'b', 'c'] // a freq3, b/c freq1 平手按字母
  );
  assert.equal(res.fields[0].freq, 3);
});

test('数组型记录与标量型记录：伪字段', async () => {
  const s = ['[1,2,3]', '42', '{"k":1}'].join('\n');
  const res = await inferFromString(s);
  const arr = res.fields.find((f) => f.key === ARRAY_RECORD_KEY)!;
  const scalar = res.fields.find((f) => f.key === SCALAR_RECORD_KEY)!;
  assert.ok(arr);
  assert.equal(arr.type, 'array');
  assert.equal(arr.freq, 1);
  assert.ok(scalar);
  assert.equal(scalar.type, 'number');
  // 对象记录 k 存在
  assert.ok(res.fields.some((f) => f.key === 'k'));
  assert.equal(res.total, 3);
});

test('空文件：无字段、0 有效记录', async () => {
  const res = await inferFromString('');
  assert.equal(res.total, 0);
  assert.equal(res.scanned, 0);
  assert.deepEqual(res.fields, []);
  assert.deepEqual(res.errorLines, []);
});

test('示例值：对象过大时被截断', async () => {
  const big = 'x'.repeat(500);
  const s = JSON.stringify({ v: big });
  const res = await inferFromString(s, { sampleLines: 1, sampleMaxLen: 100 });
  const v = res.fields.find((f) => f.key === 'v')!;
  assert.equal(typeof v.sample, 'string');
  assert.ok((v.sample as string).length <= 101); // 截断串长度有界
});

test('示例值：小对象保留为结构化对象', async () => {
  const s = '{"o":{"a":1}}';
  const res = await inferFromString(s, { sampleLines: 1 });
  const o = res.fields.find((f) => f.key === 'o')!;
  assert.deepEqual(o.sample, { a: 1 });
});
