import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineIndex } from '../lineIndex.ts';

/** 把字符串切成小 chunk 供流式扫描，强制 \n 落在 chunk 边界、跨块定位。 */
function* chunks(s: string, size: number): Generator<Buffer> {
  for (let i = 0; i < s.length; i += size) {
    yield Buffer.from(s.slice(i, i + size), 'utf8');
  }
}

async function buildFromString(s: string, size = 3, opts?: { chunkSize?: number }) {
  return LineIndex.build(chunks(s, size), opts);
}

test('多行正确性：计数与每行起始偏移', async () => {
  // 3 行 + 末尾无换行
  const s = '{"a":1}\n{"a":2}\n{"a":3}';
  const li = await buildFromString(s);
  assert.equal(li.totalLines, 3);
  assert.equal(li.totalBytes, s.length);
  // 逐字节累计的偏移
  assert.equal(li.getOffsetAtLine(0), 0);
  assert.equal(li.getOffsetAtLine(1), 8); // '{"a":1}\n' 8 字节
  assert.equal(li.getOffsetAtLine(2), 16);
});

test('末尾无换行：最后一行仍计入并可定位', async () => {
  const s = 'abc\ndef\nghi';
  const li = await buildFromString(s);
  assert.equal(li.totalLines, 3);
  const r = li.lineRange(2);
  assert.deepEqual([r.start, r.end], [8, s.length]);
});

test('空行计数与定位：连续空行各自成行', async () => {
  const s = 'a\n\n\nb';
  const li = await buildFromString(s);
  assert.equal(li.totalLines, 4);
  assert.deepEqual([...li.offsets], [0, 2, 3, 4]);
  // 空行区间 [start, end) 长度为 1（含换行）
  const r = li.lineRange(1);
  assert.equal(r.start, 2);
  assert.equal(r.end, 3);
});

test('仅空行 + 末尾换行：产量为对应空行数', async () => {
  const li = await buildFromString('\n\n');
  assert.equal(li.totalLines, 2);
  assert.deepEqual([...li.offsets], [0, 1]);
});

test('空文件：0 行', async () => {
  const li = await buildFromString('');
  assert.equal(li.totalLines, 0);
  assert.equal(li.getLineRangeAtOffset(0), null);
});

test('\\r\\n 混排：只按 \\n 切分，\\r 归入上一行', async () => {
  const s = 'a\r\nb\r\nc\n';
  const li = await buildFromString(s);
  assert.equal(li.totalLines, 3);
  assert.deepEqual([...li.offsets], [0, 3, 6]);
});

test('混入坏 JSON 行：单个坏行以 \\n 为单位切分时定位依旧准确', async () => {
  // 行内含逗号、冒号、花括号、制表符等——不改变按 \n 切分的事实
  const s = '{"x":1}\n{"bad":\n}\n{"z":3}\n';
  const li = await buildFromString(s);
  assert.equal(li.totalLines, 4);
  // 逐字节核对：line1 起始于 {@..."bad": 之后}，坏 JSON 内容散落在两行
  assert.deepEqual([...li.offsets], [0, 8, 16, 18]);
  // 第 4 行（0 起 3）短，只有 '{"z":3}'
  const r = li.lineRange(3);
  assert.equal(s.slice(r.start, r.end), '{"z":3}\n');
});

test('跨 chunk 的 \\n 边界在极小 chunk 下正确（强制边界采样）', async () => {
  // chunk=可以保证某个换行位于切片末尾/开头，逐字节切分也验证无遗漏
  const perLine: number[] = [];
  for (let i = 0; i < 30; i++) perLine.push(i * 1);
  const content = Array.from({ length: 30 }, (_, i) => `${'k'.repeat(0)}${i}`).join('\n') + '\n';
  const li = await buildFromString(content, 1); // 每 1 字节一个 chunk
  assert.equal(li.totalLines, 30);
  // 单调递增 + 均匀 1 字符
  for (let i = 1; i < li.totalLines; i++) {
    assert.ok(li.offsets[i] > li.offsets[i - 1]);
  }
});

test('二分定位：随机行的区间与相邻行偏移单调递增', async () => {
  const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ id: i }));
  const s = lines.join('\n');
  const li = await buildFromString(s);

  // 单调递增
  for (let i = 1; i < li.totalLines; i++) {
    assert.ok(li.offsets[i] > li.offsets[i - 1]);
  }
  // 相邻行 end(独占) 恰为下一行 start
  for (let i = 0; i < li.totalLines - 1; i++) {
    assert.equal(li.lineRange(i).end, li.getOffsetAtLine(i + 1));
  }
  // 对每个行起始偏移二分定位应回到该行
  for (let i = 0; i < li.totalLines; i += 7) {
    const at = li.getOffsetAtLine(i);
    const got = li.getLineRangeAtOffset(at);
    assert.ok(got);
    assert.equal(got!.line, i);
    assert.equal(got!.start, at);
  }
  // 偏移落在行中部也回到同一行
  const mid = li.getOffsetAtLine(50) + 2;
  assert.equal(li.getLineRangeAtOffset(mid)!.line, 50);
});

test('偏移越界/空文件定位返回 null', async () => {
  const li = await buildFromString('a\nb\n');
  assert.equal(li.getLineRangeAtOffset(-1), null);
  assert.equal(li.getLineRangeAtOffset(li.totalBytes), null);
});

test('getOffsetAtLine 越界抛 RangeError', async () => {
  const li = await buildFromString('a\n');
  assert.throws(() => li.getOffsetAtLine(-1), RangeError);
  assert.throws(() => li.getOffsetAtLine(1), RangeError);
});

test('构建统计：totalLines/totalBytes/eof/buildMs', async () => {
  const li = await buildFromString('a\nb\n');
  assert.equal(li.eof, true);
  assert.equal(li.totalBytes, 4);
  assert.ok(li.buildMs >= 0);
  assert.deepEqual(li.toStats().totalLines, 2);
});