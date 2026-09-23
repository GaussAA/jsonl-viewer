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

/* ------------- applyLineReplace：编辑后的增量索引 ------------- */

/** 造 n 行文本（行号嵌入内容，便于逐行核对）。 */
function makeLines(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `line-${i}-${'a'.repeat(i)}`);
}

test('applyLineReplace：仅目标行之后的检查点平移，行号与行数不变', async () => {
  const li = await buildFromString(makeLines(10).join('\n') + '\n', 3, { checkpointInterval: 4 });
  assert.deepEqual(
    li.checkpoints.map((c) => c.line),
    [0, 4, 8],
    '前置：10 行 / interval=4 → 检查点落在 0,4,8'
  );

  const next = li.applyLineReplace(1, 100);

  assert.deepEqual(
    next.checkpoints.map((c) => c.line),
    [0, 4, 8],
    '替换不改变行号'
  );
  assert.equal(next.checkpoints[0].offset, li.checkpoints[0].offset, '目标行之前的检查点不动');
  assert.equal(next.checkpoints[1].offset, li.checkpoints[1].offset + 100);
  assert.equal(next.checkpoints[2].offset, li.checkpoints[2].offset + 100);
  assert.equal(next.totalBytes, li.totalBytes + 100);
  assert.equal(next.totalLines, li.totalLines);
});

test('applyLineReplace：目标行本身恰为检查点行时，其偏移不变、其后仍平移', async () => {
  const li = await buildFromString(makeLines(10).join('\n') + '\n', 3, { checkpointInterval: 4 });
  const next = li.applyLineReplace(4, 50); // 第 4 行是检查点行

  assert.equal(next.checkpoints[0].offset, li.checkpoints[0].offset);
  assert.equal(
    next.checkpoints[1].offset,
    li.checkpoints[1].offset,
    '该行起始偏移未变（变的是行内长度）'
  );
  assert.equal(next.checkpoints[2].offset, li.checkpoints[2].offset + 50);
});

test('applyLineReplace：Δ=0 复用同一实例（等长替换无需触碰索引）', async () => {
  const li = await buildFromString('a\nb\nc\n');
  assert.equal(li.applyLineReplace(1, 0), li);
});

test('applyLineReplace：越界行号与非整数 Δ 抛错', async () => {
  const li = await buildFromString('a\nb\nc\n');
  assert.throws(() => li.applyLineReplace(3, 5), RangeError);
  assert.throws(() => li.applyLineReplace(-1, 5), RangeError);
  assert.throws(() => li.applyLineReplace(1.5, 5), RangeError);
  assert.throws(() => li.applyLineReplace(0, 1.5), TypeError);
});

test('applyLineReplace：变长/变短/首行/末行四类编辑的扫描结果均与「重建索引」完全一致', async () => {
  const base = makeLines(30);
  const cases = [
    { line: 0, text: `HEAD-${'z'.repeat(200)}`, desc: '首行变长' },
    { line: 29, text: 'TAIL', desc: '末行变短' },
    { line: 15, text: `MID-${'q'.repeat(120)}`, desc: '中间变长' },
    { line: 7, text: 's', desc: '中间大幅变短' },
  ];

  for (const c of cases) {
    const before = base.join('\n') + '\n';
    const li = await buildFromString(before, 7, { checkpointInterval: 4 });

    const afterLines = [...base.slice(0, c.line), c.text, ...base.slice(c.line + 1)];
    const after = afterLines.join('\n') + '\n';
    const delta = Buffer.byteLength(c.text) - Buffer.byteLength(base[c.line]);

    const incremental = li.applyLineReplace(c.line, delta);
    const rebuilt = await buildFromString(after, 7, { checkpointInterval: 4 });
    const reader = new MemoryReader(Buffer.from(after));

    assert.equal(incremental.totalBytes, Buffer.byteLength(after), `${c.desc}：字节总数`);
    assert.equal(incremental.totalLines, rebuilt.totalLines, `${c.desc}：行数`);
    assert.deepEqual(await scanAll(incremental, reader), afterLines, `${c.desc}：逐行内容`);
    assert.deepEqual(
      await scanAll(incremental, reader),
      await scanAll(rebuilt, reader),
      `${c.desc}：与重建索引一致`
    );
  }
});

/* ------------- applyLineInsert / applyLineDelete：增删行 ------------- */

/** 取某行的真实字节区间（含行尾）。 */
async function rangeOf(li: LineIndex, reader: ByteReader, line: number) {
  const r = await li.resolveRange(line, reader);
  assert.ok(r, `行 ${line} 应可定位`);
  return { start: (r as { start: number }).start, end: (r as { end: number }).end };
}

test('applyLineInsert：插入后行号与偏移双双平移，且与重建索引一致', async () => {
  const base = makeLines(20);
  const before = base.join('\n') + '\n';
  const li = await buildFromString(before, 5, { checkpointInterval: 4 });

  const at = 7;
  const inserted = `INSERTED-${'q'.repeat(50)}`;
  const insertedBytes = Buffer.byteLength(inserted) + 1; // 含行尾
  const afterLines = [...base.slice(0, at), inserted, ...base.slice(at)];
  const after = afterLines.join('\n') + '\n';

  const incremental = li.applyLineInsert(at, insertedBytes);
  const rebuilt = await buildFromString(after, 5, { checkpointInterval: 4 });
  const reader = new MemoryReader(Buffer.from(after));

  assert.equal(incremental.totalLines, afterLines.length);
  assert.equal(incremental.totalBytes, Buffer.byteLength(after));
  assert.deepEqual(await scanAll(incremental, reader), afterLines);
  assert.deepEqual(
    await scanAll(incremental, reader),
    await scanAll(rebuilt, reader),
    '与重建索引完全一致'
  );
});

test('applyLineDelete：删首行 / 中间行 / 末行均与重建索引一致（末行检查点不得越界）', async () => {
  for (const target of [0, 9, 19]) {
    const base = makeLines(20);
    const before = base.join('\n') + '\n';
    const li = await buildFromString(before, 5, { checkpointInterval: 4 });
    const readerBefore = new MemoryReader(Buffer.from(before));
    const r = await rangeOf(li, readerBefore, target);
    const removedBytes = r.end - r.start;

    const afterLines = [...base.slice(0, target), ...base.slice(target + 1)];
    const after = afterLines.join('\n') + '\n';

    const incremental = li.applyLineDelete(target, removedBytes);
    const rebuilt = await buildFromString(after, 5, { checkpointInterval: 4 });
    const reader = new MemoryReader(Buffer.from(after));

    assert.equal(incremental.totalLines, 19, `删行 ${target}：行数`);
    assert.equal(incremental.totalBytes, Buffer.byteLength(after), `删行 ${target}：字节数`);
    assert.deepEqual(await scanAll(incremental, reader), afterLines, `删行 ${target}：内容`);
    assert.deepEqual(
      await scanAll(incremental, reader),
      await scanAll(rebuilt, reader),
      `删行 ${target}：与重建索引一致`
    );
  }
});

test('applyLineInsert：空文件首次插入会补上锚点（否则 scan 找不到起点）', async () => {
  const li = await buildFromString('', 5);
  assert.equal(li.totalLines, 0);
  assert.equal(li.checkpoints.length, 0);

  const text = '{"a":1}';
  const bytes = Buffer.byteLength(text) + 1;
  const next = li.applyLineInsert(0, bytes);

  assert.equal(next.totalLines, 1);
  assert.equal(next.totalBytes, bytes);
  const reader = new MemoryReader(Buffer.from(text + '\n'));
  assert.deepEqual(await scanAll(next, reader), [text]);
});

test('applyLineInsert / applyLineDelete：越界与非整数参数抛错', async () => {
  const li = await buildFromString('a\nb\nc\n');
  assert.throws(() => li.applyLineInsert(4, 1), RangeError, 'totalLines=3，插入位 4 越界');
  assert.throws(() => li.applyLineInsert(-1, 1), RangeError);
  assert.throws(() => li.applyLineInsert(0, -1), TypeError);
  assert.throws(() => li.applyLineInsert(0, 1.5), TypeError);
  assert.throws(() => li.applyLineDelete(3, 1), RangeError, 'totalLines=3，行 3 越界');
  assert.throws(() => li.applyLineDelete(-1, 1), RangeError);
  assert.throws(() => li.applyLineDelete(0, -1), TypeError);
  // 合法边界：插入到末尾（line === totalLines）
  assert.equal(li.applyLineInsert(3, 2).totalLines, 4);
});

/**
 * 回归：**在文件最开头插入**时必须补回第 0 行锚点。
 *
 * 缺陷原貌：`cp.line >= line` 在 `line === 0` 时会把唯一的 `{0,0}` 锚点平移到 `{1,bytes}`，
 * 索引于是失去「≤ 目标行的最近起点」—— `scan` 找不到顺读起点，**静默返回空**（不报错）。
 * 外部表现极具迷惑性：`totalLines` 说 4 行，但 `readRecord(0)` 报「行不存在」。
 *
 * 这条路径由「撤销批量删除」触发（把被删的行插回文件开头），是真实可达的。
 */
test('applyLineInsert(0)：开头插入后第 0 行锚点必须保留（否则 scan 静默读空）', async () => {
  const li = await buildFromString('a\nb\nc\n');
  assert.deepEqual(
    li.checkpoints.map((c) => c.line),
    [0],
    '小文件仅一个锚点'
  );

  const next = li.applyLineInsert(0, 2); // 在开头插入 "x\n"
  assert.strictEqual(next.checkpoints[0].line, 0, '第 0 行锚点必须保留');
  assert.strictEqual(next.checkpoints[0].offset, 0, '插入点在最开头，故偏移必为 0');
  assert.equal(next.totalLines, 4);

  // 连续两次插入到开头：仍须有且只有一个 line 0 锚点
  const twice = next.applyLineInsert(0, 2);
  assert.strictEqual(twice.checkpoints[0].line, 0);
  assert.equal(twice.checkpoints.filter((c) => c.line === 0).length, 1, '不得重复补锚点');
  assert.equal(twice.totalLines, 5);
});

test('applyLineInsert(0)：多检查点场景下开头插入后仍能扫出全部行', async () => {
  // checkpointInterval=2 → 三行文件有 2 个锚点（行 0 与行 2）
  const li = await buildFromString('a\nb\nc\n', 3, { checkpointInterval: 2 });
  assert.equal(li.checkpoints.length, 2, '确实是多锚点');

  const reader = new MemoryReader(Buffer.from('x\na\nb\nc\n', 'utf8'));
  const shifted = li.applyLineInsert(0, 2); // 逻辑上等同于文件变成 x\na\nb\nc\n
  const lines = await scanAll(shifted, reader);
  assert.deepEqual(lines, ['x', 'a', 'b', 'c'], '开头插入后仍能顺读全部行');
  assert.equal(shifted.checkpoints[0].line, 0, '锚点仍在最前');
});
