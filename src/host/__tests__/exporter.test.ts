/**
 * exporter.test.ts — 导出子集（F5）：只读源、原子写新文件、取消零风险。
 *
 * 这一组断言的核心不是「能写出文件」，而是三条**边界**：
 *   1. 源文件一个字节都不能变（导出不是编辑）；
 *   2. 取消/失败时**目标文件从未被创建**（不留半截文件骗人）；
 *   3. 取不出原文的记录必须**如实跳过并计数**（否则用户以为全导出了）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LineIndex } from '../../indexer/lineIndex.ts';
import { FileByteReader } from '../../parser/jsonParser.ts';
import { EXPORT_TEMP_SUFFIX, exportLinesToFile } from '../exporter.ts';

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-export-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 建一个源文件并返回 (路径, 索引, 读取器)。 */
async function makeSource(
  dir: string,
  lines: string[]
): Promise<{ file: string; li: LineIndex; reader: FileByteReader }> {
  const file = join(dir, 'src.jsonl');
  await writeFile(file, `${lines.join('\n')}\n`);
  const li = await LineIndex.build([Buffer.from(`${lines.join('\n')}\n`, 'utf8')]);
  const reader = await FileByteReader.open(file);
  return { file, li, reader };
}

test('F5：导出选定记录 —— 内容逐字节等于源里那些行的原文', async () => {
  await withDir(async (dir) => {
    const rows = ['{"i":0}', '{"i":1}', '{"i":2}', '{"i":3}'];
    const { file, li, reader } = await makeSource(dir, rows);
    const before = await readFile(file, 'utf8');
    const target = join(dir, 'out.jsonl');

    const res = await exportLinesToFile(li, reader, [1, 3], target);
    await reader.close();

    assert.deepEqual(res, {
      count: 2,
      bytes: Buffer.byteLength(rows[1]) + 1 + rows[3].length + 1,
      skipped: 0,
      cancelled: false,
    });
    assert.strictEqual(await readFile(target, 'utf8'), `${rows[1]}\n${rows[3]}\n`);
    // 源文件一个字节都没变（导出不是编辑）。
    assert.strictEqual(await readFile(file, 'utf8'), before, '源文件必须原样不动');
    // 临时文件已清理，目录里只应有源与目标。
    const names = (await readdir(dir)).toSorted();
    assert.deepEqual(names, ['out.jsonl', 'src.jsonl'], `残留文件：${names}`);
  });
});

test('F5：多行（pretty）记录整体导出，含内部换行', async () => {
  await withDir(async (dir) => {
    const rows = ['{', '  "a": 1', '}', '{"b":2}'];
    const { li, reader } = await makeSource(dir, rows);
    const target = join(dir, 'out.jsonl');

    const res = await exportLinesToFile(li, reader, [0], target);
    await reader.close();
    assert.strictEqual(res.count, 3, '一条记录 = 3 个物理行');
    assert.strictEqual(await readFile(target, 'utf8'), '{\n  "a": 1\n}\n');
  });
});

test('F5：取消时目标文件从未被创建，临时文件也已清理', async () => {
  await withDir(async (dir) => {
    const { li, reader } = await makeSource(dir, ['{"i":0}', '{"i":1}', '{"i":2}']);
    const target = join(dir, 'out.jsonl');

    // 第一条之后取消
    let seen = 0;
    const res = await exportLinesToFile(li, reader, [0, 1, 2], target, {
      shouldCancel: () => seen++ >= 1,
    });
    await reader.close();

    assert.strictEqual(res.cancelled, true, '必须报「已取消」而不是失败');
    assert.strictEqual(res.count, 0);
    const names = (await readdir(dir)).toSorted();
    assert.deepEqual(names, ['src.jsonl'], `取消后不得留下任何产物：${names}`);
    assert.ok(!names.includes(`out.jsonl${EXPORT_TEMP_SUFFIX}`), '临时文件必须删掉');
  });
});

test('F5：超长记录被如实跳过（不假装导出）', async () => {
  await withDir(async (dir) => {
    // 超长行要真实触发 scan 的 error 分支：该分支只在「单个行跨过读取块边界」时生效
    // （同一块内已有换行时，多长的行都会正常 yield），故这里造一条 >1MB 的行。
    const huge = '{"pad":"' + 'x'.repeat(1_200_000) + '"}';
    const { li, reader } = await makeSource(dir, [huge]);
    const target = join(dir, 'out.jsonl');

    const res = await exportLinesToFile(li, reader, [0], target, { maxLineBytes: 1024 });
    await reader.close();

    assert.strictEqual(res.skipped, 1, '超长记录必须如实计入跳过');
    assert.strictEqual(res.count, 0);
    // 一条都没写出来 → 不创建目标文件（留个空文件比明说失败更糟）。
    const names = (await readdir(dir)).toSorted();
    assert.deepEqual(names, ['src.jsonl'], `不得留下空的目标文件：${names}`);
  });
});

test('F5：目标已存在时原子覆盖（内容为本次导出结果）', async () => {
  await withDir(async (dir) => {
    const { li, reader } = await makeSource(dir, ['{"i":0}', '{"i":1}']);
    const target = join(dir, 'out.jsonl');
    await writeFile(target, '旧的无关内容\n');

    const res = await exportLinesToFile(li, reader, [1], target);
    await reader.close();
    assert.strictEqual(res.count, 1);
    assert.strictEqual(await readFile(target, 'utf8'), '{"i":1}\n', '目标被本次结果完全替换');
  });
});

test('F5：进度回调到达终态（停在 96% 的进度条比没有更糟）', async () => {
  await withDir(async (dir) => {
    const rows = Array.from({ length: 20 }, (_, i) => `{"i":${i}}`);
    const { li, reader } = await makeSource(dir, rows);
    const target = join(dir, 'out.jsonl');

    const ticks: number[] = [];
    await exportLinesToFile(
      li,
      reader,
      rows.map((_, i) => i),
      target,
      {
        onProgress: (info) => ticks.push(info.processedBytes),
      }
    );
    await reader.close();

    assert.ok(ticks.length > 0, '有进度回调');
    assert.strictEqual(ticks.at(-1), li.totalBytes, '最后一次必须是终态（= 源文件总字节）');
  });
});
