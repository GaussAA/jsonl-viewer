import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LineIndex } from '../../indexer/lineIndex.ts';
import { openFileReader } from '../../parser/jsonParser.ts';
import { TAIL_BACKUP_SUFFIX, REWRITE_TEMP_SUFFIX } from '../../constants.ts';
import {
  replaceLine,
  replaceRange,
  rewriteWithEdits,
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

test('replaceLine：搬移途中取消 → **零风险**（文件恢复原样 + sidecar 已清理）', async () => {
  // 语义变更：此前取消只保留 sidecar 让用户手动拼接（文件处于半搬移状态）。
  // 现在改为自动回滚 —— 与批量替换（rename 之前中止）一致，取消即「什么都没发生过」。
  const original = 'a\n' + 'x'.repeat(100) + '\n';
  const { dir, path } = await scaffold(original);
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
    assert.equal(await readFile(path, 'utf8'), original, '取消后文件必须逐字节原样');
    assert.equal((await stat(path)).size, Buffer.byteLength(original), '大小也要回到原样');
    assert.equal(
      existsSync(path + TAIL_BACKUP_SUFFIX),
      false,
      '回滚成功后 sidecar 随之清理（不留垃圾）'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceLine：Δ<0（变短）搬移途中取消同样恢复原样', async () => {
  // 变短时搬移方向相反（正序），回滚用的是同一份备份，故无需区分方向 ——
  // 这正是选「整体恢复」而非「反向搬移」的收益。
  const original = 'aaa\n' + 'x'.repeat(100) + '\n';
  const { dir, path } = await scaffold(original);
  try {
    const loc = await locate(path, 0);
    await assert.rejects(
      () =>
        replaceLine(path, loc.range, Buffer.from('a'), 'lf', {
          blockSize: 4,
          shouldCancel: () => true,
        }),
      WriteCancelledError
    );
    assert.equal(await readFile(path, 'utf8'), original);
    assert.equal(existsSync(path + TAIL_BACKUP_SUFFIX), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceLine：回滚失败时如实告知，绝不假装已恢复', async () => {
  const { dir, path } = await scaffold('a\n' + 'x'.repeat(100) + '\n');
  try {
    const loc = await locate(path, 0);
    const side = path + TAIL_BACKUP_SUFFIX;
    await assert.rejects(
      () =>
        replaceLine(path, loc.range, Buffer.from('aaa'), 'lf', {
          blockSize: 4,
          // 回滚前备份被外部移除 → 回滚无法完成，必须说出来而不是报「已恢复」
          shouldCancel: () => {
            rmSync(side, { force: true });
            return true;
          },
        }),
      (e: unknown) => e instanceof WriteCancelledError && /回滚未完成/.test((e as Error).message)
    );
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

/* ------------------ 批量重写：原子替换整个文件 ------------------ */

/** 临时文件是否残留（批量重写失败/取消后必须归零）。 */
async function tempLeftovers(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.includes(REWRITE_TEMP_SUFFIX));
}

test('rewriteWithEdits：多处区间一次替换，内容与增量正确', async () => {
  const { dir, path } = await scaffold('aaa\nbbb\nccc\n');
  try {
    const res = await rewriteWithEdits(path, [
      { start: 0, end: 3, replacement: Buffer.from('AAAA') }, // 3 → 4：+1
      { start: 8, end: 11, replacement: Buffer.from('C') }, // 3 → 1：−2
    ]);

    assert.equal(res.edits, 2);
    assert.equal(res.bytesDelta, -1);
    // 'aaa\nbbb\nccc\n' = 12 字节，两个区间各被替换 3 字节 → 复制量 = 12 − 6 = 6。
    assert.equal(res.copiedBytes, 6);
    assert.equal(await readFile(path, 'utf8'), 'AAAA\nbbb\nC\n');
    assert.equal((await stat(path)).size, 11);
    assert.deepEqual(await tempLeftovers(dir), [], '临时文件已清理');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rewriteWithEdits：乱序传入的编辑按位置正确应用', async () => {
  const { dir, path } = await scaffold('aaa\nbbb\nccc\n');
  try {
    await rewriteWithEdits(path, [
      { start: 8, end: 11, replacement: Buffer.from('C') },
      { start: 0, end: 3, replacement: Buffer.from('AAAA') },
    ]);
    assert.equal(await readFile(path, 'utf8'), 'AAAA\nbbb\nC\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rewriteWithEdits：重叠区间拒绝，且文件在任何写入之前保持原样', async () => {
  const { dir, path } = await scaffold('aaa\nbbb\n');
  try {
    await assert.rejects(
      () =>
        rewriteWithEdits(path, [
          { start: 0, end: 4, replacement: Buffer.from('X') },
          { start: 2, end: 5, replacement: Buffer.from('Y') },
        ]),
      /重叠/
    );
    assert.equal(await readFile(path, 'utf8'), 'aaa\nbbb\n', '校验失败必须零副作用');
    assert.deepEqual(await tempLeftovers(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rewriteWithEdits：越界区间拒绝', async () => {
  const { dir, path } = await scaffold('aaa\nbbb\n');
  try {
    await assert.rejects(
      () => rewriteWithEdits(path, [{ start: 0, end: 99, replacement: Buffer.from('X') }]),
      /越界/
    );
    await assert.rejects(
      () => rewriteWithEdits(path, [{ start: 5, end: 2, replacement: Buffer.from('X') }]),
      /越界/
    );
    assert.equal(await readFile(path, 'utf8'), 'aaa\nbbb\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rewriteWithEdits：空编辑列表拒绝（不做无谓的全量重写）', async () => {
  const { dir, path } = await scaffold('aaa\n');
  try {
    await assert.rejects(() => rewriteWithEdits(path, []), /没有需要应用的编辑/);
    assert.equal(await readFile(path, 'utf8'), 'aaa\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rewriteWithEdits：超过 maxBytes 时拒绝，文件原样保留', async () => {
  const { dir, path } = await scaffold('aaa\nbbb\n');
  try {
    await assert.rejects(
      () =>
        rewriteWithEdits(path, [{ start: 0, end: 3, replacement: Buffer.from('X') }], {
          maxBytes: 4,
        }),
      /超过批量替换上限/
    );
    assert.equal(await readFile(path, 'utf8'), 'aaa\nbbb\n');
    assert.deepEqual(await tempLeftovers(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rewriteWithEdits：取消时抛 WriteCancelledError 且清理临时文件', async () => {
  const { dir, path } = await scaffold('aaaa\nbbbb\ncccc\n');
  try {
    await assert.rejects(
      () =>
        rewriteWithEdits(path, [{ start: 10, end: 14, replacement: Buffer.from('C') }], {
          shouldCancel: () => true,
          blockSize: 4,
        }),
      (e: unknown) => e instanceof WriteCancelledError
    );
    assert.equal(await readFile(path, 'utf8'), 'aaaa\nbbbb\ncccc\n', '取消后原文件未被触碰');
    assert.deepEqual(await tempLeftovers(dir), [], '取消路径同样清理临时文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rewriteWithEdits：纯插入（空区间）与纯删除（空 replacement）', async () => {
  const { dir, path } = await scaffold('aa\nbb\ncc\n');
  try {
    await rewriteWithEdits(path, [
      { start: 3, end: 3, replacement: Buffer.from('XX\n') }, // 在 bb 前插入
      { start: 6, end: 9, replacement: Buffer.alloc(0) }, // 删掉 cc\n
    ]);
    assert.equal(await readFile(path, 'utf8'), 'aa\nXX\nbb\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rewriteWithEdits：成功重写不留 sidecar / 临时文件', async () => {
  const { dir, path } = await scaffold('aaa\n');
  try {
    await rewriteWithEdits(path, [{ start: 0, end: 3, replacement: Buffer.from('bbbb') }]);
    const files = await readdir(dir);
    assert.deepEqual(files, ['data.jsonl'], '目录内只应剩目标文件');
    assert.equal(existsSync(path + TAIL_BACKUP_SUFFIX), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
