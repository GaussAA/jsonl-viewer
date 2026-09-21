import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LineIndex } from '../../indexer/lineIndex.ts';
import {
  parseJsonLine,
  readLineAt,
  readRecord,
  readBatch,
  MemoryReader,
  openFileReader,
  createLazyIndex,
} from '../jsonParser.ts';

/* ------- parseJsonLine：合法/非法输入 ------- */

test('parseJsonLine：合法对象/数组/标量/空串语义', () => {
  assert.deepEqual(parseJsonLine('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseJsonLine('[1,2,3]'), { ok: true, value: [1, 2, 3] });
  assert.deepEqual(parseJsonLine('42'), { ok: true, value: 42 });
  assert.deepEqual(parseJsonLine('"hi"'), { ok: true, value: 'hi' });
  assert.deepEqual(parseJsonLine('null'), { ok: true, value: null });
  // 容忍首尾空白
  assert.deepEqual(parseJsonLine('  {"a":1}  '), { ok: true, value: { a: 1 } });
});

test('parseJsonLine：非法输入返回 error + 定位', () => {
  const bad = parseJsonLine('{"a":1,,}');
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.ok(bad.error.length > 0);
    assert.ok(bad.column >= 1);
    assert.equal(bad.line, 1);
  }
});

test('parseJsonLine：错误文案精简且不再回显整行原文', () => {
  // V8 的原文回显形态（如非标准 JSON 值 NaN），应被裁剪为一句干净提示。
  const r = parseJsonLine('{"id":5,"num":NaN,"regex":/\\d+/}');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(!r.error.includes('NaN'), `不应回显原文: ${r.error}`);
    assert.ok(!r.error.includes('...'), `不应带省略号回显: ${r.error}`);
    assert.ok(r.error.length < 60);
  }
  // 结构化错误带位置（in JSON at position N），应保留原因与位置。
  const s = parseJsonLine('{"a":1,,}');
  if (!s.ok) assert.match(s.error, /字符处|at position/i);
});

test('parseJsonLine：空行拒绝', () => {
  const r = parseJsonLine('   ');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /空行|empty/i);
});

/* ------- readLineAt / 索引 + 读取器联动 ------- */

test('readLineAt：剥离 \\n 与 \\r\\n，多行正确', async () => {
  const buf = Buffer.from('aa\r\nbbb\nc\n', 'utf8');
  const li = await LineIndex.build([buf]);
  const reader = new MemoryReader(buf);
  const r0 = await li.resolveRange(0, reader);
  const r1 = await li.resolveRange(1, reader);
  const r2 = await li.resolveRange(2, reader);
  assert.ok(r0 && r1 && r2);
  assert.equal(await readLineAt(reader, r0.start, r0.end), 'aa');
  assert.equal(await readLineAt(reader, r1.start, r1.end), 'bbb');
  assert.equal(await readLineAt(reader, r2.start, r2.end), 'c');
});

test('readLineAt：超长行被 maxLineBytes 拒绝', async () => {
  const buf = Buffer.from('x'.repeat(100), 'utf8');
  const reader = new MemoryReader(buf);
  await assert.rejects(readLineAt(reader, 0, buf.length, { maxLineBytes: 10 }), /too large/);
});

test('createLazyIndex / readRecord：按需读取并解析单条', async () => {
  const buf = Buffer.from('{"a":1}\nbad-json\n{"c":3}\n', 'utf8');
  const index = await LineIndex.build([buf]);
  const lazy = createLazyIndex(index, new MemoryReader(buf));
  const r0 = await lazy.readRecord(0);
  assert.equal(r0.ok, true);
  assert.deepEqual(r0.value, { a: 1 });
  const r1 = await lazy.readRecord(1);
  assert.equal(r1.ok, false);
  assert.ok(r1.error && r1.error.length > 0);
  const r2 = await lazy.readRecord(2);
  assert.deepEqual(r2.value, { c: 3 });
});

test('readBatch：批次读取并给出可见批量结果', async () => {
  const buf = Buffer.from('{"a":1}\n{"a":2}\n{"a":3}\n{"a":4}\n', 'utf8');
  const index = await LineIndex.build([buf]);
  const lazy = createLazyIndex(index, new MemoryReader(buf));
  const batch = await lazy.readBatch(1, 2);
  assert.equal(batch.length, 2);
  assert.equal(batch[0].line, 1);
  assert.deepEqual(batch[0].value, { a: 2 });
  // startLine 超界返回空
  const empty = await lazy.readBatch(99, 5);
  assert.equal(empty.length, 0);
});

/* ------- 基于真实文件句柄的读取器（fs + fd.read） ------- */

test('FileByteReader：按偏移读取真实文件（含 \\r\\n）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-'));
  const fp = join(dir, 'a.jsonl');
  await writeFile(fp, 'alpha\r\nbeta\ngamma', 'utf8');
  const reader = await openFileReader(fp);
  try {
    const index = await LineIndex.build([Buffer.from('alpha\r\nbeta\ngamma', 'utf8')]);
    const r0 = await index.resolveRange(0, reader);
    const r2 = await index.resolveRange(2, reader);
    assert.ok(r0 && r2);
    assert.equal(await readLineAt(reader, r0.start, r0.end), 'alpha');
    assert.equal(await readLineAt(reader, r2.start, r2.end), 'gamma'); // 最后一行无换行
  } finally {
    await reader.close?.();
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------- 守卫与边界（覆盖率补强） ------- */

test('readRecord：无效行号（负数 / 越界）返回 ok=false 而非抛错', async () => {
  const buf = Buffer.from('{"a":1}\n{"a":2}\n', 'utf8');
  const index = await LineIndex.build([buf]);
  const reader = new MemoryReader(buf);

  const neg = await readRecord(-1, index, reader);
  assert.equal(neg.ok, false);
  assert.equal(neg.line, -1);
  assert.match(String(neg.error), /无效|invalid/i);

  const beyond = await readRecord(99, index, reader);
  assert.equal(beyond.ok, false);
  assert.equal(beyond.line, 99);
  assert.match(String(beyond.error), /无效|invalid/i);

  // 边界：最后一行可读
  const last = await readRecord(1, index, reader);
  assert.equal(last.ok, true);
  assert.deepEqual(last.value, { a: 2 });
});

test('readBatch：count<=0 或 startLine<0 直接返回空数组', async () => {
  const buf = Buffer.from('{"a":1}\n{"a":2}\n', 'utf8');
  const index = await LineIndex.build([buf]);
  const reader = new MemoryReader(buf);

  assert.deepEqual(await readBatch(0, 0, index, reader), [], 'count=0');
  assert.deepEqual(await readBatch(0, -3, index, reader), [], 'count<0');
  assert.deepEqual(await readBatch(-1, 2, index, reader), [], 'startLine<0');
});

test('readBatch：shouldCancel 置位即提前停止（含「扫一段后取消」的局部结果）', async () => {
  const buf = Buffer.from('{"a":1}\n{"a":2}\n{"a":3}\n', 'utf8');
  const index = await LineIndex.build([buf]);
  const reader = new MemoryReader(buf);

  // 立即取消 → 一行都不产出
  assert.deepEqual(await readBatch(0, 3, index, reader, { shouldCancel: () => true }), []);

  // 放过第一行后取消 → 只产出首行（真正的可中断，且已产出结果保留）
  let seen = 0;
  const partial = await readBatch(0, 3, index, reader, { shouldCancel: () => seen++ >= 1 });
  assert.equal(partial.length, 1, `expected 1 item, got ${partial.length}`);
  assert.deepEqual(partial[0].value, { a: 1 });
});

test('MemoryReader：越界 / 负参数抛 RangeError（防御性边界）', async () => {
  const r = new MemoryReader(Buffer.from('abc'));
  assert.equal((await r.readBytes(0, 3)).toString(), 'abc', '边界内可读');

  await assert.rejects(() => r.readBytes(0, 4), RangeError, '超长');
  await assert.rejects(() => r.readBytes(-1, 1), RangeError, '负偏移');
  await assert.rejects(() => r.readBytes(2, -1), RangeError, '负长度');
  await assert.rejects(() => r.readBytes(10, 1), RangeError, '偏移越界');
});
