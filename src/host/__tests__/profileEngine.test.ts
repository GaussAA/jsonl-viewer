/**
 * profileEngine.test.ts — 全量画像引擎（F4）。
 *
 * 重点在**有界性**：画像要在多 GB 文件上跑全量，所以「字段数触顶」「去重容量触顶」
 * 这些防御行为必须被钉住 —— 它们是「能不能安全地跑全量」的前提，而不是可选优化。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineIndex } from '../../indexer/lineIndex.ts';
import { MemoryReader } from '../../parser/jsonParser.ts';
import {
  describeProfile,
  profileRecords,
  PROFILE_MAX_DISTINCT,
  PROFILE_MAX_FIELDS,
  PROFILE_TOP_VALUES,
  PROFILE_VALUE_MAX_LEN,
} from '../profileEngine.ts';

async function makeCtx(content: string): Promise<{ reader: MemoryReader; li: LineIndex }> {
  const buf = Buffer.from(content, 'utf8');
  const li = await LineIndex.build([buf], {});
  return { reader: new MemoryReader(buf), li };
}

test('F4：统计顶层字段的出现次数、类型分布与主导类型', async () => {
  const { reader, li } = await makeCtx(
    [
      '{"level":"error","n":1,"ok":true}',
      '{"level":"warn","n":2,"ok":false}',
      '{"level":"error","n":3,"ok":true}',
    ].join('\n') + '\n'
  );
  const res = await profileRecords(reader, li, { throttleMs: 0 });

  assert.equal(res.parsed, 3);
  assert.equal(res.bad, 0);
  assert.equal(res.cancelled, undefined, '未取消时不带该字段');

  const level = res.fields.find((f) => f.key === 'level');
  assert.ok(level, 'level 字段被统计');
  assert.equal(level!.present, 3);
  assert.equal(level!.missing, 0);
  assert.equal(level!.type, 'string');
  assert.deepEqual(level!.types, { string: 3 });
  assert.deepEqual(level!.top, [
    { value: 'error', count: 2 },
    { value: 'warn', count: 1 },
  ]);
  assert.equal(level!.valuesTruncated, false, '取值未超容量时不标记截断');
});

test('F4：字段缺失、显式 null、空串分别计数（不混为一谈）', async () => {
  const { reader, li } = await makeCtx(
    ['{"a":1,"b":null}', '{"a":2}', '{"a":3,"b":""}', '{"a":4}'].join('\n') + '\n'
  );
  const res = await profileRecords(reader, li, { throttleMs: 0 });
  const b = res.fields.find((f) => f.key === 'b');
  assert.ok(b);
  assert.equal(b!.present, 2, 'b 出现在两条里');
  assert.equal(b!.missing, 2, '第 2、4 条缺 b');
  assert.equal(b!.nulls, 1, '只有一条是显式 null');
  assert.equal(b!.empties, 1, '只有一条是空串');
  // 三者互不混淆：缺失 = 键不存在；null = 显式空值；空串 = 值为 "" 的字符串。
  assert.deepEqual(b!.types, { null: 1, string: 1 }, 'null 与空串的类型也各自如实记录');
});

test('F4：主导类型按固定优先序判定（与 inferFields 同一口径）', async () => {
  const { reader, li } = await makeCtx(['{"x":{}}', '{"x":[]}', '{"x":"s"}'].join('\n') + '\n');
  const res = await profileRecords(reader, li, { throttleMs: 0 });
  const x = res.fields.find((f) => f.key === 'x');
  assert.ok(x);
  // 三类各 1 次（平手）→ object 优先
  assert.equal(x!.type, 'object');
  assert.deepEqual(x!.types, { object: 1, array: 1, string: 1 });
});

test('F4：坏记录被跳过并计数，不进入字段统计', async () => {
  const { reader, li } = await makeCtx(['{"a":1}', 'not-json', '{"a":2}'].join('\n') + '\n');
  const res = await profileRecords(reader, li, { throttleMs: 0 });
  assert.equal(res.parsed, 2);
  assert.equal(res.bad, 1);
  const a = res.fields.find((f) => f.key === 'a');
  assert.equal(a!.present, 2, '坏行不参与分母');
  assert.equal(a!.missing, 0);
});

test('F4：数组 / 标量记录走伪键（与推断字段同一套约定）', async () => {
  const { reader, li } = await makeCtx(['[1,2]', '"裸标量"', '{"a":1}'].join('\n') + '\n');
  const res = await profileRecords(reader, li, { throttleMs: 0 });
  const keys = new Set(res.fields.map((f) => f.key));
  assert.ok(keys.has('$array'), '数组记录归到 $array');
  assert.ok(keys.has('$value'), '标量记录归到 $value');
  assert.ok(keys.has('a'));
});

test('F4：多行（pretty）记录整体 parse，不按物理行统计', async () => {
  const content = ['{', '  "a": 1,', '  "b": 2', '}', '{"a":3,"b":4}'].join('\n') + '\n';
  const { reader, li } = await makeCtx(content);
  const res = await profileRecords(reader, li, { throttleMs: 0 });
  assert.equal(res.bad, 0, 'pretty 文件的中间行不该被当成坏行');
  assert.equal(res.parsed, 2);
  assert.equal(res.fields.find((f) => f.key === 'a')!.present, 2);
});

test('F4：值分布超出去重容量 → 归入「其他」并标记截断（内存有界）', async () => {
  const lines: string[] = [];
  // 造出远多于容量上限的互异取值。
  const many = PROFILE_MAX_DISTINCT + 40;
  for (let i = 0; i < many; i++) lines.push(JSON.stringify({ id: `v${i}` }));
  const { reader, li } = await makeCtx(lines.join('\n') + '\n');

  const res = await profileRecords(reader, li, { throttleMs: 0 });
  const id = res.fields.find((f) => f.key === 'id');
  assert.ok(id);
  assert.equal(id!.present, many, '出现次数仍是全量（计数不受容量影响）');
  assert.equal(id!.valuesTruncated, true, '必须标记「top 之外还有取值」');
  const overflow = id!.top.find((t) => t.value.includes('其他'));
  assert.ok(overflow, '溢出的取值被汇总为一项');
  assert.equal(overflow!.count, many - PROFILE_MAX_DISTINCT, '溢出计数如实汇总');
  assert.ok(
    id!.top.length <= PROFILE_TOP_VALUES + 1,
    `top 长度有界（含溢出项），实得 ${id!.top.length}`
  );
});

test('F4：顶层字段数触顶 → 停止新建并标记 fieldsTruncated', async () => {
  const many = PROFILE_MAX_FIELDS + 20;
  const obj: Record<string, number> = {};
  for (let i = 0; i < many; i++) obj[`f${i}`] = i;
  const { reader, li } = await makeCtx(JSON.stringify(obj) + '\n');

  const res = await profileRecords(reader, li, { throttleMs: 0 });
  assert.equal(res.fieldsTruncated, true, '触顶必须如实标记，而不是静默丢弃');
  assert.ok(res.fields.length <= PROFILE_MAX_FIELDS, `字段数有界，实得 ${res.fields.length}`);
});

test('F4：超长值被截断（一个巨型字符串不该在画像里占同等内存）', async () => {
  const long = 'x'.repeat(PROFILE_VALUE_MAX_LEN * 3);
  const { reader, li } = await makeCtx(JSON.stringify({ pad: long }) + '\n');
  const res = await profileRecords(reader, li, { throttleMs: 0 });
  const pad = res.fields.find((f) => f.key === 'pad');
  assert.ok(pad);
  assert.equal(pad!.top[0].value.length, PROFILE_VALUE_MAX_LEN + 1, '截断到上限 + 省略号');
  assert.ok(pad!.top[0].value.endsWith('…'));
});

test('F4：取消 → cancelled=true 且结果明确不可信（与「扫完」严格分开）', async () => {
  const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i }));
  const { reader, li } = await makeCtx(lines.join('\n') + '\n');

  let calls = 0;
  const res = await profileRecords(reader, li, {
    throttleMs: 0,
    shouldCancel: () => calls++ >= 5,
  });
  assert.equal(res.cancelled, true);
  assert.ok(res.scanned < res.totalRecords, '确实没扫完');
});

test('F4：未取消时不带 cancelled 字段（不给调用方多余的判断分支）', async () => {
  const { reader, li } = await makeCtx('{"a":1}\n');
  const res = await profileRecords(reader, li, { throttleMs: 0 });
  assert.equal('cancelled' in res, false);
});

test('F4：进度回调在终态必发（停在半路的进度条比没有更糟）', async () => {
  const lines = Array.from({ length: 30 }, (_, i) => JSON.stringify({ i }));
  const { reader, li } = await makeCtx(lines.join('\n') + '\n');
  const seen: Array<{ processedBytes: number; totalBytes: number }> = [];
  const res = await profileRecords(reader, li, {
    throttleMs: 10000, // 节流窗口极大：只有「终态必发」这一条能触发回调
    onProgress: (info) => seen.push(info),
  });
  assert.ok(seen.length >= 1, '终态必须推一次进度');
  assert.equal(seen.at(-1)!.processedBytes, li.totalBytes, '终态进度应为 100%');
  assert.equal(res.scanned, res.totalRecords);
});

test('F4：字段按出现次数降序（常用字段先看到）', async () => {
  const { reader, li } = await makeCtx(
    ['{"common":1,"rare":2}', '{"common":3}', '{"common":4}'].join('\n') + '\n'
  );
  const res = await profileRecords(reader, li, { throttleMs: 0 });
  assert.equal(res.fields[0].key, 'common');
  assert.equal(res.fields.at(-1)!.key, 'rare');
});

test('F4：describeProfile 给结论而不是甩数字', async () => {
  const { reader, li } = await makeCtx('{"a":1,"b":2}\nnot-json\n');
  const res = await profileRecords(reader, li, { throttleMs: 0 });
  const text = describeProfile(res);
  assert.match(text, /扫描 1 条记录/);
  assert.match(text, /2 个顶层字段/);
  assert.match(text, /1 条解析失败/);

  const cancelled = describeProfile({ ...res, cancelled: true });
  assert.match(cancelled, /中断/, '被取消时必须明说结果不可信');
});
