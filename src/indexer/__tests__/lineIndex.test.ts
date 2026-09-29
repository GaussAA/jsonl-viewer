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
import { LineIndex, applyIndexOps, tailAppendOp, type IndexDeltaOp } from '../lineIndex.ts';
import {
  MemoryReader,
  readLineBuffer,
  readRecord,
  type ByteReader,
} from '../../parser/jsonParser.ts';

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

/* ====================== 记录分组（多行记录支持） ====================== */

test('recordRange：多行 pretty 记录正确分组，紧凑记录单行成组', async () => {
  // 8 个物理行：{ / "a": 1 / } / {"b":2} / [ / 1, / 2 / ]
  const s = '{\n  "a": 1\n}\n{"b":2}\n[\n 1,\n 2\n]\n';
  const li = await buildFromString(s, 4);
  assert.equal(li.multiline, true);
  assert.equal(li.totalRecords, 3);
  assert.equal(li.totalLines, 8);

  assert.deepEqual(
    { ...li.recordRange(0) },
    { startLine: 0, endLine: 2, startOffset: 0, endOffset: 13 }
  );
  assert.deepEqual(li.recordRange(1), { startLine: 3, endLine: 3, startOffset: 13, endOffset: 21 });
  assert.deepEqual(li.recordRange(2), { startLine: 4, endLine: 7, startOffset: 21, endOffset: 32 });
  assert.equal(li.totalBytes, 32);
});

test('recordRange：紧凑文件走零内存快路径（记录号==行号）', async () => {
  const li = await buildFromString('{"a":1}\n{"b":2}\n', 3);
  assert.equal(li.multiline, false, '无空行、无跨行 → 不存分组数组');
  assert.equal(li.totalRecords, 2);
  assert.equal(li.recordRange(1).startLine, 1);
  assert.equal(li.recordRange(1).endLine, 1);
});

test('recordRange：字符串内的换行与括号不干扰分组', async () => {
  // 值里含转义引号、字面 { } [ ] 与物理换行（JSON 不允许裸换行，但分组扫描须容忍）
  const s = '{"a":"he said \\"hi\\"","b":"x{[y]\\nz"}\n{"c":3}\n';
  const li = await buildFromString(s, 5);
  assert.equal(li.multiline, false, '字符串内的括号与换行转义不影响闭合判定，仍每行一条');
  assert.equal(li.totalRecords, 2);
});

test('recordRange：空行跳过，不构成记录也不打断分组', async () => {
  const s = '{"a":1}\n\n{"b":2}\n';
  const li = await buildFromString(s, 3);
  assert.equal(li.multiline, true);
  assert.equal(li.totalRecords, 2, '空行不算记录');
  // 记录 1 的区间从空行后起（含前导空行无害，parse 走 trim）
  assert.equal(li.recordRange(1).startLine, 1);
  assert.equal(li.recordRange(1).endLine, 2);
});

test('recordRange：悬空到 EOF 的残缺记录以 EOF 收尾（坏记录）', async () => {
  const s = '{"a":1}\n{"b":\n1\n';
  const li = await buildFromString(s, 3);
  assert.equal(li.multiline, true);
  assert.equal(li.totalRecords, 2);
  assert.equal(li.recordRange(1).startLine, 1);
  assert.equal(li.recordRange(1).endLine, 2, '悬空记录吞并后续行直到 EOF');
  assert.equal(li.recordRange(1).endOffset, li.totalBytes);
});

test('recordRange：深度钳制 —— 多余右括号按单行坏记录处理', async () => {
  const s = '{"a":1}}\n{"b":2}\n';
  const li = await buildFromString(s, 3);
  // 第二个 } 使深度触底（钳 0），该行即结束 —— 不得吞并下一行
  assert.equal(li.totalRecords, 2);
  assert.equal(li.recordRange(0).endLine, 0);
  assert.equal(li.recordRange(1).startLine, 1);
});

test('recordNoByStartLine：多行文件按起始行反查记录号', async () => {
  const s = '{\n  "a": 1\n}\n{"b":2}\n';
  const li = await buildFromString(s, 4);
  assert.equal(li.recordNoByStartLine(0), 0);
  assert.equal(li.recordNoByStartLine(3), 1);
  assert.equal(li.recordNoByStartLine(1), -1, '多行记录的中间行不是任何记录的起始');
});

test('recordRange：单个顶层标量也是一条记录', async () => {
  const s = '123\n"str"\ntrue\n';
  const li = await buildFromString(s, 3);
  assert.equal(li.totalRecords, 3);
  assert.equal(li.multiline, false, '顶层标量单行即闭合');
});

/* ---------------------- applyIndexOps（两侧索引同源的共用底座） ---------------------- */

test('applyIndexOps：空 ops 返回同一实例（零分配）', async () => {
  const li = await buildFromString('{"a":1}\n{"b":2}\n');
  assert.equal(applyIndexOps(li, []), li, '无变更时不该产生新对象');
});

test('applyIndexOps：按序应用 replace / insert / delete 三种 op', async () => {
  const li = await buildFromString('{"a":1}\n{"b":2}\n{"c":3}\n');
  const after = applyIndexOps(li, [
    { kind: 'replace', line: 1, delta: 10 },
    { kind: 'insert', line: 0, bytes: 5 },
    { kind: 'delete', line: 3, bytes: 7 },
  ]);
  assert.equal(after.totalLines, 3, '插入 1 行 + 删除 1 行 → 行数不变');
  assert.equal(after.totalBytes, li.totalBytes + 10 + 5 - 7);
  assert.equal(after.checkpoints[0]?.line, 0, '首检查点必须仍是第 0 行（scan 的顺读起点）');
});

test('applyIndexOps：顺序敏感 —— 重排会让行号漂移（调用方必须自己排好序）', async () => {
  // interval=1：每行都有检查点，行号漂移才看得见（默认 1024 行一个小文件时只有 {0,0}）。
  const li = await buildFromString('{"a":1}\n{"b":2}\n{"c":3}\n', 3, { checkpointInterval: 1 });
  // 先删后插（合法倒序）
  const delThenInsert = applyIndexOps(li, [
    { kind: 'delete', line: 2, bytes: 7 },
    { kind: 'insert', line: 1, bytes: 4 },
  ]);
  // 先插后删（同一批 op 换了顺序，语义已变：删除的是另一行）
  const insertThenDel = applyIndexOps(li, [
    { kind: 'insert', line: 1, bytes: 4 },
    { kind: 'delete', line: 2, bytes: 7 },
  ]);
  assert.notDeepEqual(
    delThenInsert.checkpoints.map((c) => [c.line, c.offset]),
    insertThenDel.checkpoints.map((c) => [c.line, c.offset]),
    '两种顺序必须不同 —— 若相同，说明 op 的行号漂移语义被抹平了'
  );
});

test('applyIndexOps：同一批 op 可让两份索引实例完全对齐（宿主同步的前提）', async () => {
  // 场景即「主线程 DataService.index」与「worker 内那份」：起点相同 + 同一批 op ⇒ 结果相同。
  const ops: IndexDeltaOp[] = [
    { kind: 'replace', line: 0, delta: 12 },
    { kind: 'insert', line: 2, bytes: 9 },
    { kind: 'delete', line: 1, bytes: 6 },
  ];
  const a = await buildFromString('{"a":1}\n{"b":2}\n{"c":3}\n{"d":4}\n');
  const b = await buildFromString('{"a":1}\n{"b":2}\n{"c":3}\n{"d":4}\n');
  const ra = applyIndexOps(a, ops);
  const rb = applyIndexOps(b, ops);
  assert.deepEqual(ra.checkpoints, rb.checkpoints);
  assert.equal(ra.totalBytes, rb.totalBytes);
  assert.equal(ra.totalLines, rb.totalLines);
});

/* ------------------- applyLineDeltas（批量替换的索引更新快速路径） ------------------- */

test('applyLineDeltas：与逐个 applyLineReplace 完全等价', async () => {
  // interval=1 → 每个检查点都可能受某个 delta 影响，等价性检查才有杀伤力。
  const li = await buildFromString(
    Array.from({ length: 30 }, (_, i) => `{"i":${i}}`).join('\n') + '\n',
    7,
    { checkpointInterval: 1 }
  );
  const deltas = [
    { line: 0, delta: 5 },
    { line: 7, delta: -3 },
    { line: 7, delta: 8 }, // 同一行两次：必须累加（+5）
    { line: 29, delta: 100 },
  ];

  let one = li;
  for (const d of deltas) one = one.applyLineReplace(d.line, d.delta);
  const batch = li.applyLineDeltas(deltas);

  assert.deepEqual(batch.checkpoints, one.checkpoints, '检查点逐条一致');
  assert.equal(batch.totalBytes, one.totalBytes);
  assert.equal(batch.totalLines, one.totalLines);
});

test('applyLineDeltas：边界 —— 空数组返回同一实例、零偏移不产生新对象', async () => {
  const li = await buildFromString('{"a":1}\n{"b":2}\n');
  assert.equal(li.applyLineDeltas([]), li, '空批不做任何事');
  assert.equal(li.applyLineDeltas([{ line: 1, delta: 0 }]), li, '全零 delta 视为无变更');
});

test('applyLineDeltas：越界行号与非整数 delta 一律抛错（不静默算错）', async () => {
  const li = await buildFromString('{"a":1}\n{"b":2}\n');
  assert.throws(() => li.applyLineDeltas([{ line: 2, delta: 1 }]), RangeError);
  assert.throws(() => li.applyLineDeltas([{ line: -1, delta: 1 }]), RangeError);
  assert.throws(() => li.applyLineDeltas([{ line: 0, delta: 1.5 }]), TypeError);
});

test('applyLineDeltas：整批 replace 的 applyIndexOps 走同一结果（快速路径不改语义）', async () => {
  const li = await buildFromString(
    Array.from({ length: 20 }, (_, i) => `{"i":${i}}`).join('\n') + '\n',
    5,
    { checkpointInterval: 1 }
  );
  const ops: IndexDeltaOp[] = [
    { kind: 'replace', line: 3, delta: 40 },
    { kind: 'replace', line: 11, delta: -7 },
  ];
  const viaOps = applyIndexOps(li, ops);
  const viaDeltas = li.applyLineDeltas([
    { line: 3, delta: 40 },
    { line: 11, delta: -7 },
  ]);
  assert.deepEqual(viaOps.checkpoints, viaDeltas.checkpoints);
  assert.equal(viaOps.totalBytes, viaDeltas.totalBytes);
});

test('applyLineDeltas：混合 op 不走快速路径（插入/删除必须按序逐条应用）', async () => {
  const li = await buildFromString('{"a":1}\n{"b":2}\n{"c":3}\n');
  // 插入会改变后续行号，若被误并入「一次平移」就会算错 —— 结果必须与逐条应用一致。
  const ops: IndexDeltaOp[] = [
    { kind: 'replace', line: 0, delta: 4 },
    { kind: 'insert', line: 2, bytes: 9 },
  ];
  let one = li;
  for (const op of ops) one = applyIndexOps(one, [op]);
  const all = applyIndexOps(li, ops);
  assert.deepEqual(all.checkpoints, one.checkpoints);
  assert.equal(all.totalLines, one.totalLines);
  assert.equal(all.totalBytes, one.totalBytes);
});

/* ------------------- O16：超长行之后的行号与内容不漂移 ------------------- */

test('O16：超长行只占**一个**行号，其后各行取回原文（构建与扫描同一口径）', async () => {
  // 首行 1.2MB：**必须跨过 1MB 的读取块边界**才会触发超长行分支
  //（块内已有换行时，再长的行也会被正常 yield —— 该分支只在「已读满一块仍无换行」时生效）。
  // 构建阶段按**真实换行**数行 → 3 行；扫描阶段若把超长行按「块」切段各计一行，
  // 扫描给出的行号就会多于索引的，其后每次读取都整体前移 —— 读到的是超长行的尾巴。
  const huge = '{"pad":"' + 'x'.repeat(1_200_000) + '"}';
  const content = `${huge}\n{"i":1}\n{"i":2}\n`;
  const buf = Buffer.from(content, 'utf8');
  const li = await LineIndex.build([buf], {});
  assert.equal(li.totalLines, 3, '索引按真实换行数行');

  const reader = new MemoryReader(buf);
  const got: Array<{ line: number; text: string; error?: string }> = [];
  for await (const r of li.scan(reader, 0, li.totalLines, { maxLineBytes: 4096 })) {
    got.push({
      line: r.line,
      text: r.bytes.toString('utf8'),
      ...(r.error ? { error: r.error } : {}),
    });
  }

  assert.equal(got.length, 3, `扫描必须给出与索引一致的 3 行，实得 ${got.length}`);
  assert.ok(got[0].error, '超长行本身以 error 标记（不把 1.2MB 正文交出去）');
  assert.equal(got[1].line, 1);
  assert.equal(got[1].text, '{"i":1}', '第二行必须是它自己');
  assert.equal(got[2].text, '{"i":2}', '第三行必须是它自己');
});

test('O16：超长行位于文件末尾（无换行收尾）时也不多计一行', async () => {
  const huge = 'x'.repeat(1_200_000);
  const content = `{"i":1}\n${huge}`;
  const buf = Buffer.from(content, 'utf8');
  const li = await LineIndex.build([buf], {});
  assert.equal(li.totalLines, 2);

  const reader = new MemoryReader(buf);
  const lines: number[] = [];
  for await (const r of li.scan(reader, 0, li.totalLines, { maxLineBytes: 4096 })) {
    lines.push(r.line);
  }
  assert.deepEqual(lines, [0, 1], '恰好两行，超长行只占一个行号');
});

test('O16：readRecord 能正确取回超长行**之后**的记录', async () => {
  const huge = '{"pad":"' + 'y'.repeat(1_200_000) + '"}';
  const content = `${huge}\n{"i":7}\n`;
  const buf = Buffer.from(content, 'utf8');
  const li = await LineIndex.build([buf], {});
  const reader = new MemoryReader(buf);

  const r = await readRecord(1, li, reader, { maxLineBytes: 4096 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { i: 7 }, '第 1 行（0 基）应取回第二条记录，而不是超长行的尾巴');
});

/* ------------------------- F6：追尾增量（appendTail） ------------------------- */

/**
 * 判据：「先建前段 + 追尾后段」必须与「一次性整量构建」**逐字段一致**。
 *
 * 这比「行数对不对」强得多 —— 检查点只要错一格，其后每次读取都会整体错位一行，
 * 而那恰恰是最难从症状反推的故障（内容看着大体正确，只是贴错了行号）。
 */
async function expectTailEqualsFullBuild(full: string, head: string, interval = 4): Promise<void> {
  const base = await buildFromString(head, 3, { checkpointInterval: interval });
  const res = base.appendTail(Buffer.from(full.slice(head.length)));
  assert.equal(res.ok, true, '前提满足时应吸收');
  if (!res.ok) return;

  const whole = await buildFromString(full, 3, { checkpointInterval: interval });
  assert.equal(res.index.totalLines, whole.totalLines, '总行数一致');
  assert.equal(res.index.totalBytes, whole.totalBytes, '总字节一致');
  assert.deepEqual(res.index.checkpoints, whole.checkpoints, '检查点逐条一致');
  assert.equal(res.index.multiline, whole.multiline, '紧凑性判定一致');
  assert.equal(res.index.endsWithNewline, whole.endsWithNewline, '吸收点性质一致');
}

test('F6：追尾与整量重建逐字段等价（多个切分点，含检查点对齐）', async () => {
  const lines = makeLines(20);
  const full = lines.join('\n') + '\n';
  // 切分点覆盖：不落在检查点间隔上 / 正落在间隔上 / 末尾一行。
  for (const at of [1, 2, 4, 5, 8, 17, 19]) {
    await expectTailEqualsFullBuild(full, lines.slice(0, at).join('\n') + '\n');
  }
});

test('F6：连续逐行追尾（模拟日志增长）最终与整量重建等价，且 scan 可读', async () => {
  const lines = makeLines(30);
  const full = lines.join('\n') + '\n';
  let li = await buildFromString('', 3, { checkpointInterval: 4 });
  assert.equal(li.totalLines, 0, '空文件起步');

  for (const line of lines) {
    const res = li.appendTail(Buffer.from(`${line}\n`));
    assert.equal(res.ok, true);
    if (res.ok) li = res.index;
  }

  const whole = await buildFromString(full, 3, { checkpointInterval: 4 });
  assert.equal(li.totalLines, whole.totalLines);
  assert.equal(li.totalBytes, whole.totalBytes);
  assert.deepEqual(li.checkpoints, whole.checkpoints, '逐行追尾与一次性构建的锚点必须一致');
  assert.deepEqual(await scanAll(li, new MemoryReader(Buffer.from(full))), lines);
});

test('F6：尾部残行不吸收（consumedBytes=0，返回原实例）', async () => {
  const li = await buildFromString('{"a":1}\n', 3);
  const res = li.appendTail(Buffer.from('{"a":2}'));
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.consumedBytes, 0, '写了一半的行不算一行');
  assert.equal(res.index, li, '没有完整行时原样返回');
});

test('F6：残行补齐后整行才并入（消费位置记在 totalBytes，字节不丢）', async () => {
  const head = '{"a":1}\n';
  const half = '{"a":2}'; // 写进程此刻只落了这半行
  const full = `${head}${half}\n`;
  const li = await buildFromString(head, 3);

  // 两轮读都从**同一个** index.totalBytes 起（下列切片按字节取；此处内容为纯 ASCII，
  // 字节偏移与字符下标重合）。第一轮那半行没换行 → 不吸收。
  const first = li.appendTail(Buffer.from(full.slice(li.totalBytes, li.totalBytes + half.length)));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.consumedBytes, 0, '写了一半的行不吸收');

  // 第二轮：半行写完了，这次读到整行 → 并入。
  const second = li.appendTail(Buffer.from(full.slice(li.totalBytes)));
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.index.totalLines, 2);
  assert.deepEqual(await scanAll(second.index, new MemoryReader(Buffer.from(full))), [
    '{"a":1}',
    '{"a":2}',
  ]);
});

test('F6：三类前提不成立时一律拒绝（调用方退回整量重建）', async () => {
  // open-tail：旧内容末尾没有换行 —— 新字节是在**续写**末行，不是开启新行。
  const open = await buildFromString('{"a":1}', 3);
  assert.equal(open.endsWithNewline, false);
  assert.deepEqual(open.appendTail(Buffer.from('\n')), { ok: false, reason: 'open-tail' });

  // multiline：含空行的文件（记录号 ≠ 行号），尾部续算不可靠。
  const multi = await buildFromString('{"a":1}\n\n', 3);
  assert.equal(multi.multiline, true);
  assert.deepEqual(multi.appendTail(Buffer.from('{"a":2}\n')), { ok: false, reason: 'multiline' });

  // not-compact：新增区间里出现空行 / 跨行结构。
  const base = await buildFromString('{"a":1}\n', 3);
  assert.deepEqual(base.appendTail(Buffer.from('\n')), { ok: false, reason: 'not-compact' });
  assert.deepEqual(base.appendTail(Buffer.from('{"a":\n2}\n')), {
    ok: false,
    reason: 'not-compact',
  });
});

test('F6：追尾可经 applyIndexOps 同步到另一份索引（O1 通道）', async () => {
  const head = '{"a":1}\n{"a":2}\n';
  const tail = '{"a":3}\n{"a":4}\n';
  const a = await buildFromString(head, 3, { checkpointInterval: 2 });
  const res = a.appendTail(Buffer.from(tail));
  assert.equal(res.ok, true);
  if (!res.ok) return;

  // b 模拟索引宿主里那份「同一状态」的索引 —— 两侧必须停在同一条 checkpoints 上。
  const b = await buildFromString(head, 3, { checkpointInterval: 2 });
  const synced = applyIndexOps(b, [tailAppendOp(a, res.index)]);
  assert.equal(synced.totalLines, res.index.totalLines);
  assert.equal(synced.totalBytes, res.index.totalBytes);
  assert.deepEqual(synced.checkpoints, res.index.checkpoints);
});
