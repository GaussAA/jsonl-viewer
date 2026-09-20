/**
 * lineIndex.test.ts — 稀疏检查点索引 + `scan` 生成器（阶段二·2a）。
 *
 * 旧实现（全量 `offsets: number[]` + `getOffsetAtLine`/`lineRange`/`getLineRangeAtOffset`）
 * 已移除，本测试覆盖新模型的不变式：
 *   - 行计数 / 字节总数 / EOF 处理；
 *   - 检查点稀疏（每 interval 行一个 {line,offset}），首检查点为 {0,0}；
 *   - `scan` 顺序扫：跨块边界、\r\n 剥离、空行、坏行、末尾无换行；
 *   - `offsetAtLine` 返回「≤该行的检查点锚点」（顺序扫起点，非精确行偏移）；
 *   - `resolveRange` 经 scan 还原精确 [start,end)；
 *   - 超长行（per-call maxLineBytes）以 error 标记 yield，且默认阈值下正常返回。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineIndex } from '../lineIndex.ts';
import { MemoryReader, readLineBuffer, type ByteReader } from '../../parser/jsonParser.ts';

/** 把字符串切成极小 chunk，强制 \n 落在块边界、跨块定位。 */
function* chunks(s: string, size: number): Generator<Buffer> {
  for (let i = 0; i < s.length; i += size) {
    yield Buffer.from(s.slice(i, i + size), 'utf8');
  }
}
async function buildFromString(s: string, size = 3, buildOpts?: { checkpointInterval?: number }) {
  return LineIndex.build(chunks(s, size), buildOpts);
}

/** 用 scan 把 [0, totalLines) 全部读成字符串数组。 */
async function scanAll(li: LineIndex, reader: ByteReader): Promise<string[]> {
  const out: string[] = [];
  for await (const r of li.scan(reader, 0, li.totalLines)) {
    if (r.error) {
      out.push(`__ERR__:${r.error}`);
      continue;
    }
    out.push(r.bytes.toString('utf8'));
  }
  return out;
}

/** 由索引器的切分语义推导期望行集合（末尾 \n 不额外产生空行）。 */
function expectedLines(s: string): string[] {
  const parts = s.split('\n');
  return s.endsWith('\n') ? parts.slice(0, -1) : parts;
}

test('多行正确性：计数 + 逐行字节与 scan 还原一致', async () => {
  const s = '{"a":1}\n{"a":2}\n{"a":3}';
  const li = await buildFromString(s);
  assert.equal(li.totalLines, 3);
  assert.equal(li.totalBytes, s.length);
  assert.equal(li.checkpoints[0].line, 0);
  assert.equal(li.checkpoints[0].offset, 0);
  const reader = new MemoryReader(Buffer.from(s));
  assert.deepEqual(await scanAll(li, reader), expectedLines(s));
});

test('末尾无换行：最后一行仍计入并可定位', async () => {
  const s = 'abc\ndef\nghi';
  const li = await buildFromString(s);
  assert.equal(li.totalLines, 3);
  const reader = new MemoryReader(Buffer.from(s));
  assert.deepEqual(await scanAll(li, reader), ['abc', 'def', 'ghi']);
});

test('空行计数与定位：连续空行各自成行', async () => {
  const s = 'a\n\n\nb';
  const li = await buildFromString(s);
  assert.equal(li.totalLines, 4);
  const reader = new MemoryReader(Buffer.from(s));
  const got = await scanAll(li, reader);
  assert.deepEqual(got, ['a', '', '', 'b']);
  // 空行区间长度为 1（含换行）。
  const r = await li.resolveRange(1, reader);
  assert.ok(r);
  assert.equal(r.end - r.start, 1);
});

test('仅空行 + 末尾换行：产量为对应空行数', async () => {
  const li = await buildFromString('\n\n');
  assert.equal(li.totalLines, 2);
  const reader = new MemoryReader(Buffer.from('\n\n'));
  assert.deepEqual(await scanAll(li, reader), ['', '']);
});

test('空文件：0 行，scan 无产出，offsetAtLine 越界', async () => {
  const li = await buildFromString('');
  assert.equal(li.totalLines, 0);
  const reader = new MemoryReader(Buffer.from(''));
  assert.deepEqual(await scanAll(li, reader), []);
  assert.throws(() => li.offsetAtLine(0), RangeError);
});

test('\\r\\n 混排：只按 \\n 切分，\\r 归入上一行', async () => {
  const s = 'a\r\nb\r\nc\n';
  const li = await buildFromString(s);
  assert.equal(li.totalLines, 3);
  const reader = new MemoryReader(Buffer.from(s));
  assert.deepEqual(await scanAll(li, reader), ['a', 'b', 'c']);
});

test('混入坏 JSON 行：按 \\n 切分仍准确（坏行内容散布两行）', async () => {
  const s = '{"x":1}\n{"bad":\n}\n{"z":3}\n';
  const li = await buildFromString(s);
  assert.equal(li.totalLines, 4);
  const reader = new MemoryReader(Buffer.from(s));
  const got = await scanAll(li, reader);
  // 第 1、2 行拼起来才是坏 JSON；行切分以 \n 为准，不关心 JSON。
  assert.equal(got[1], '{"bad":');
  assert.equal(got[2], '}');
  assert.equal(got[3], '{"z":3}');
});

test('跨 chunk 的 \\n 边界在极小 chunk 下正确（强制边界采样）', async () => {
  const content = Array.from({ length: 30 }, (_, i) => `${i}`).join('\n') + '\n';
  const li = await buildFromString(content, 1); // 每 1 字节一个 chunk
  assert.equal(li.totalLines, 30);
  const reader = new MemoryReader(Buffer.from(content));
  const got = await scanAll(li, reader);
  assert.deepEqual(
    got,
    Array.from({ length: 30 }, (_, i) => `${i}`)
  );
});

test('检查点稀疏性：len ≈ ceil(totalLines/interval) + 1，首点 {0,0}', async () => {
  const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ id: i }));
  const s = lines.join('\n'); // 无末尾换行 → 200 行
  const li = await buildFromString(s, 64, { checkpointInterval: 4 });
  assert.equal(li.totalLines, 200);
  assert.equal(li.interval, 4);
  assert.equal(li.checkpoints[0].line, 0);
  assert.equal(li.checkpoints[0].offset, 0);
  // 200/4 = 50 个检查点（line 0,4,...,196）；EOF 处 startOff==totalBytes 不额外增加。
  assert.equal(li.checkpoints.length, Math.ceil(li.totalLines / li.interval));
  // 每个检查点的 offset 单调递增。
  for (let i = 1; i < li.checkpoints.length; i++) {
    assert.ok(li.checkpoints[i].offset > li.checkpoints[i - 1].offset);
  }
});

test('offsetAtLine 返回 ≤ line 的检查点锚点（非精确行偏移）', async () => {
  const s = 'aa\r\nbbb\nc\n';
  const li = await buildFromString(s, 2); // 触发检查点稀疏
  // 检查点间隔默认 1024，故所有行共享 {0,0} 锚点；offsetAtLine 仅保证 ≤ 精确起始。
  for (let line = 0; line < li.totalLines; line++) {
    const anchor = li.offsetAtLine(line);
    const r = await li.resolveRange(line, new MemoryReader(Buffer.from(s)));
    assert.ok(r);
    assert.ok(anchor <= r.start, `检查点锚点应 ≤ 精确行起始 (line=${line})`);
  }
});

test('resolveRange 经 scan 还原精确 [start,end)，且与原文切片一致', async () => {
  const s = '{"x":1}\n{"bad":\n}\n{"z":3}\n';
  const li = await buildFromString(s);
  const reader = new MemoryReader(Buffer.from(s));
  const expected = expectedLines(s);
  for (let line = 0; line < li.totalLines; line++) {
    const r = await li.resolveRange(line, reader);
    assert.ok(r, `line ${line} 应可定位`);
    const got = (await readLineBuffer(reader, r.start, r.end)).toString('utf8');
    assert.equal(got, expected[line]);
  }
});

test('scan 与朴素按 \\n 切分结果一致（含坏行场景）', async () => {
  const s = '{"a":1}\n{"a":2}\nnot-json\n{"a":3}\n';
  const li = await buildFromString(s);
  const reader = new MemoryReader(Buffer.from(s));
  assert.deepEqual(await scanAll(li, reader), expectedLines(s));
});

test('超长行（per-call maxLineBytes）：scan 以 error 标记 yield，不崩溃', async () => {
  const big = 'x'.repeat(5000);
  const li = await buildFromString(big); // 单行、无换行
  assert.equal(li.totalLines, 1);
  const reader = new MemoryReader(Buffer.from(big));
  const got = await scanAll(li, reader); // 默认 16MiB 阈值 → 正常返回
  assert.equal(got[0], big);
  // 收紧阈值 → 该行成为 error 而非无界拼接。
  const errs: string[] = [];
  for await (const r of li.scan(reader, 0, li.totalLines, { maxLineBytes: 1024 })) {
    assert.ok(r.error);
    errs.push(r.error);
  }
  assert.equal(errs.length, 1);
  assert.match(errs[0], /too large|exceeds/);
});

test('构建统计：totalLines/totalBytes/eof/buildMs', async () => {
  const li = await buildFromString('a\nb\n');
  assert.equal(li.eof, true);
  assert.equal(li.totalBytes, 4);
  assert.ok(li.buildMs >= 0);
  assert.deepEqual(li.toStats().totalLines, 2);
});
