import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LineIndex } from '../../indexer/lineIndex.ts';
import { openFileReader } from '../../parser/jsonParser.ts';
import { TAIL_BACKUP_SUFFIX } from '../../constants.ts';
import {
  replaceLine,
  replaceRange,
  detectLineEnding,
  lineEndingBytes,
  WriteCancelledError,
  type ByteRange,
} from '../fileWriter.ts';

/* ---------------------------- 夹具 ---------------------------- */

/** 建临时目录并写入初始内容；调用方负责在 finally 中清理 dir。 */
async function scaffold(content: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'jlv-filewriter-'));
  const path = join(dir, 'data.jsonl');
  await writeFile(path, content);
  return { dir, path };
}

/** 用真实行索引定位第 line 行，返回「含行尾的字节区间」与「剥离行尾后的内容长度」。 */
async function locate(
  path: string,
  line: number
): Promise<{ range: ByteRange; contentLength: number }> {
  const li = await LineIndex.build(createReadStream(path));
  const reader = await openFileReader(path);
  try {
    for await (const r of li.scan(reader, line, line + 1)) {
      return { range: { start: r.start, end: r.end }, contentLength: r.bytes.length };
    }
  } finally {
    await reader.close?.();
  }
  throw new Error(`夹具错误：行 ${line} 不存在`);
}

/* ------------------------ 纯函数：行尾 ------------------------ */

test('lineEndingBytes：三种形态的字节序列', () => {
  assert.deepEqual([...lineEndingBytes('lf')], [10]);
  assert.deepEqual([...lineEndingBytes('crlf')], [13, 10]);
  assert.equal(lineEndingBytes('none').length, 0);
});

test('detectLineEnding：由区间差推断行尾形态', () => {
  assert.equal(detectLineEnding({ start: 0, end: 8 }, 7), 'lf'); // 8-0-7 = 1
  assert.equal(detectLineEnding({ start: 0, end: 9 }, 7), 'crlf'); // 9-0-7 = 2
  assert.equal(detectLineEnding({ start: 3, end: 5 }, 2), 'none'); // 末行无换行
});

/* ---------------------- 等长：原位覆写 ---------------------- */

test('replaceLine：等长替换走原位覆写（零搬移、长度不变、其余行不动）', async () => {
  const { dir, path } = await scaffold('{"a":1}\n{"b":2}\n{"c":3}\n');
  try {
    const before = (await stat(path)).size;
    const loc = await locate(path, 1);
    assert.equal(loc.contentLength, 7); // {"b":2}

    const res = await replaceLine(path, loc.range, Buffer.from('{"b":9}'), 'lf');

    assert.equal(res.inPlace, true);
    assert.equal(res.bytesDelta, 0);
    assert.equal(res.movedBytes, 0);
    assert.equal(await readFile(path, 'utf8'), '{"a":1}\n{"b":9}\n{"c":3}\n');
    assert.equal((await stat(path)).size, before);
    assert.equal(existsSync(path + TAIL_BACKUP_SUFFIX), false, '等长替换不应产生 sidecar');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------------------- 变长：尾部搬移 ---------------------- */

test('replaceLine：变长替换（Δ>0）正确搬移尾部并延长文件', async () => {
  const { dir, path } = await scaffold('aa\nbb\ncc\n');
  try {
    const loc = await locate(path, 1); // 'bb\n' = [3,6)
    const res = await replaceLine(path, loc.range, Buffer.from('BBBBBB'), 'lf');

    assert.equal(res.inPlace, false);
    assert.equal(res.bytesDelta, 4); // 'BBBBBB\n'(7) - 'bb\n'(3)
    assert.equal(res.movedBytes, 3); // 尾部 'cc\n'
    assert.equal(await readFile(path, 'utf8'), 'aa\nBBBBBB\ncc\n');
    assert.equal((await stat(path)).size, 13);
    assert.equal(existsSync(path + TAIL_BACKUP_SUFFIX), false, '成功后应删除 sidecar');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceLine：变短替换（Δ<0）正序搬移并截断文件', async () => {
  const { dir, path } = await scaffold('aaaa\nbb\ncc\n');
  try {
    const loc = await locate(path, 0); // 'aaaa\n' = [0,5)
    const res = await replaceLine(path, loc.range, Buffer.from('a'), 'lf');

    assert.equal(res.bytesDelta, -3); // 'a\n'(2) - 'aaaa\n'(5)
    assert.equal(res.movedBytes, 6); // 尾部 'bb\ncc\n'
    assert.equal(await readFile(path, 'utf8'), 'a\nbb\ncc\n');
    assert.equal((await stat(path)).size, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceLine：末行无换行（ending=none）可正常改写且零搬移', async () => {
  const { dir, path } = await scaffold('aa\nbb');
  try {
    const loc = await locate(path, 1); // 'bb' = [3,5)，无行尾
    assert.equal(detectLineEnding(loc.range, loc.contentLength), 'none');

    const res = await replaceLine(path, loc.range, Buffer.from('bbbb'), 'none');

    assert.equal(res.movedBytes, 0, '末行无尾部可搬移');
    assert.equal(res.bytesDelta, 2);
    assert.equal(await readFile(path, 'utf8'), 'aa\nbbbb');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceLine：CRLF 文件改写后保持 CRLF（不被规范化成 LF）', async () => {
  const { dir, path } = await scaffold('{"a":1}\r\n{"b":2}\r\n');
  try {
    const loc = await locate(path, 0);
    assert.equal(detectLineEnding(loc.range, loc.contentLength), 'crlf');

    await replaceLine(path, loc.range, Buffer.from('{"a":111}'), 'crlf');

    assert.equal(await readFile(path, 'utf8'), '{"a":111}\r\n{"b":2}\r\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceLine：首行变长（最大位移）后全文与逐行期望一致', async () => {
  const { dir, path } = await scaffold('a\nb\nc\nd\n');
  try {
    const loc = await locate(path, 0);
    const res = await replaceLine(path, loc.range, Buffer.from('aaaa'), 'lf');

    assert.equal(res.movedBytes, 6, '尾部 b/c/d 共 6 字节全部搬移');
    assert.equal(await readFile(path, 'utf8'), 'aaaa\nb\nc\nd\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceLine：连续编辑（变长/变短交替）后全文与期望一致', async () => {
  const { dir, path } = await scaffold('{"i":0}\n{"i":1}\n{"i":2}\n{"i":3}\n');
  try {
    const expected = ['{"i":0}', '{"i":1}', '{"i":2}', '{"i":3}'];

    const edits: Array<{ line: number; next: string }> = [
      { line: 1, next: '{"i":1,"pad":"xxxxx"}' }, // 变长
      { line: 3, next: '{}' }, // 变短
      { line: 0, next: '{"i":0,"x":1,"y":2}' }, // 变长（最大位移）
    ];
    for (const e of edits) {
      const loc = await locate(path, e.line);
      await replaceLine(
        path,
        loc.range,
        Buffer.from(e.next),
        detectLineEnding(loc.range, loc.contentLength)
      );
      expected[e.line] = e.next;
      // 每步之后立刻用真实索引复读，确保索引与磁盘始终一致
      const li = await LineIndex.build(createReadStream(path));
      assert.equal(li.totalLines, 4, `第 ${e.line} 行编辑后行数应不变`);
      assert.equal(await readFile(path, 'utf8'), expected.join('\n') + '\n');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------------------- 拒绝与取消 ---------------------- */

test('replaceLine：尾部超过备份上限时拒绝执行，且文件原样不变', async () => {
  const { dir, path } = await scaffold('a\n' + 'x'.repeat(100) + '\n');
  const original = await readFile(path, 'utf8');
  try {
    const loc = await locate(path, 0);
    await assert.rejects(
      () => replaceLine(path, loc.range, Buffer.from('aaa'), 'lf', { maxTailBackupBytes: 10 }),
      /超过备份上限/
    );
    assert.equal(await readFile(path, 'utf8'), original, '拒绝必须发生在任何写入之前');
    assert.equal(existsSync(path + TAIL_BACKUP_SUFFIX), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceLine：搬移途中取消 → 抛 WriteCancelledError 且保留 sidecar 供恢复', async () => {
  const { dir, path } = await scaffold('a\n' + 'x'.repeat(100) + '\n');
  try {
    const loc = await locate(path, 0);
    await assert.rejects(
      () =>
        replaceLine(path, loc.range, Buffer.from('aaa'), 'lf', {
          blockSize: 4,
          shouldCancel: () => true,
        }),
      WriteCancelledError
    );
    const side = path + TAIL_BACKUP_SUFFIX;
    assert.equal(existsSync(side), true, '取消后 sidecar 必须保留');
    assert.equal((await readFile(side, 'utf8')).length, 101, 'sidecar 应完整保存原始尾部');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceLine：越界或非整数区间抛 RangeError（防越界写坏文件）', async () => {
  const { dir, path } = await scaffold('abc\n');
  try {
    await assert.rejects(
      () => replaceLine(path, { start: 0, end: 999 }, Buffer.from('x'), 'lf'),
      RangeError
    );
    await assert.rejects(
      () => replaceLine(path, { start: 2, end: 1 }, Buffer.from('x'), 'lf'),
      RangeError
    );
    await assert.rejects(
      () => replaceLine(path, { start: 0.5, end: 2 }, Buffer.from('x'), 'lf'),
      RangeError
    );
    assert.equal(await readFile(path, 'utf8'), 'abc\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ---------------------- 进度与文件不存在 ---------------------- */

test('replaceLine：搬移过程按分块上报进度，末次等于尾部总长', async () => {
  const { dir, path } = await scaffold('a\n' + 'x'.repeat(40) + '\n');
  try {
    const loc = await locate(path, 0);
    const tailLen = (await stat(path)).size - loc.range.end;
    const seen: number[] = [];

    await replaceLine(path, loc.range, Buffer.from('BIG'.repeat(50)), 'lf', {
      blockSize: 8,
      onProgress: (i) => seen.push(i.movedBytes),
    });

    assert.ok(seen.length > 1, '尾部大于分块时应多次上报');
    assert.equal(seen.at(-1), tailLen);
    assert.ok(
      seen.every((v, i) => i === 0 || v > seen[i - 1]),
      '进度必须单调递增'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceLine：目标文件不存在时抛友好错误', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jlv-filewriter-'));
  try {
    await assert.rejects(
      () => replaceLine(join(dir, 'missing.jsonl'), { start: 0, end: 1 }, Buffer.from('x'), 'lf'),
      /文件不存在/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------ replaceRange：行插入 / 行删除的公用原语 ------------------ */

test('replaceRange：空区间插入 —— 新内容写入且其后数据整体后移', async () => {
  const { dir, path } = await scaffold('aa\nbb\ncc\n');
  try {
    const loc = await locate(path, 1); // 'bb\n' = [3,6)
    const at = loc.range.start;
    const res = await replaceRange(path, { start: at, end: at }, Buffer.from('NEW\n'));

    assert.equal(res.inPlace, false);
    assert.equal(res.bytesDelta, 4);
    assert.equal(res.movedBytes, 6, "尾部 'bb\\ncc\\n' 整体后移");
    assert.equal(await readFile(path, 'utf8'), 'aa\nNEW\nbb\ncc\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceRange：空 replacement 删除区间 —— 其后数据整体前移并截断', async () => {
  const { dir, path } = await scaffold('aa\nbb\ncc\n');
  try {
    const loc = await locate(path, 1); // 'bb\n' = [3,6)
    const res = await replaceRange(path, loc.range, Buffer.alloc(0));

    assert.equal(res.bytesDelta, -3);
    assert.equal(res.movedBytes, 3, "尾部 'cc\\n' 整体前移");
    assert.equal(await readFile(path, 'utf8'), 'aa\ncc\n');
    assert.equal((await stat(path)).size, 6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceRange：追加到文件末尾（空区间 + 末尾偏移）无需搬移', async () => {
  const { dir, path } = await scaffold('aa\nbb\n');
  try {
    const size = (await stat(path)).size;
    const res = await replaceRange(path, { start: size, end: size }, Buffer.from('cc\n'));

    assert.equal(res.bytesDelta, 3);
    assert.equal(res.movedBytes, 0);
    assert.equal(await readFile(path, 'utf8'), 'aa\nbb\ncc\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
