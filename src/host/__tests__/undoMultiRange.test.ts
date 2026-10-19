/**
 * undoMultiRange.test.ts — 撤销「多段不相邻的批量删除」的回归。
 *
 * 缺陷的形状（务必读完再改）：`deleteRecords` 回传的 `DeletedRange.start` 是**删除前**
 * 文件里的偏移。撤销（`insertRanges`）把它们当作**删除后**文件里的插入点直接使用 ——
 * 这对第一段恰好成立（它之前没有被删的字节），对第二段及以后就错了：它们之前已有别的
 * 区间被删掉，真正的插入点应是 `start − 此前各段已删的字节数`。
 *
 * 后果是静默的：撤销返回 ok，行数也对，但后面的区间被插到了更靠后的位置，
 * 记录顺序悄悄被打乱。此前的撤销测试都只删了**一段连续行**，所以没人发现。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataService } from '../dataService.ts';

async function withService<T>(
  content: string,
  fn: (ds: DataService, file: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-undo-multi-'));
  const file = join(dir, 'data.jsonl');
  await writeFile(file, content);
  const ds = new DataService('file:///test.jsonl', file, { sampleLines: 10 });
  try {
    return await fn(ds, file);
  } finally {
    await ds.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

/** 逐行读回并与期望的原文比对：既验磁盘，也验索引偏移没有错位。 */
async function assertRecordsMatch(ds: DataService, expected: string[]): Promise<void> {
  assert.equal(ds.totalRecords, expected.length, '记录数');
  for (let i = 0; i < expected.length; i++) {
    const r = await ds.readRecord(i);
    assert.equal(r.ok, true, `第 ${i} 行可读`);
    assert.equal(r.rawText, expected[i], `第 ${i} 行内容与顺序正确`);
  }
}

test('两段不相邻：撤销后逐字节还原，记录顺序不变', async () => {
  const rows = ['{"a":1}', '{"c":2}', '{"a":3}', '{"a":4}', '{"c":5}'];
  const original = `${rows.join('\n')}\n`;
  await withService(original, async (ds, file) => {
    await ds.getOverview();
    const del = await ds.deleteRecords([0, 3]);
    assert.equal(del.ok, true, del.error ?? '');
    assert.equal(del.ranges, 2, '前提：两段不相邻');

    const back = await ds.insertRanges(del.changes!);
    assert.equal(back.ok, true, back.error ?? '');
    assert.equal(await readFile(file, 'utf8'), original);
    await assertRecordsMatch(ds, rows);
  });
});

test('三段长度各不相同：每段都回到原位（偏移累计扣除，而非只扣一次）', async () => {
  const rows = [
    '{"a":1}',
    '{"b":22}',
    '{"c":333}',
    '{"d":4444}',
    '{"e":55555}',
    '{"f":6}',
    '{"g":7}',
  ];
  const original = `${rows.join('\n')}\n`;
  await withService(original, async (ds, file) => {
    await ds.getOverview();
    const del = await ds.deleteRecords([6, 0, 2, 3]); // 0 / 2-3 / 6 三段，乱序传入
    assert.equal(del.ok, true, del.error ?? '');
    assert.equal(del.ranges, 3);

    const back = await ds.insertRanges(del.changes!);
    assert.equal(back.ok, true, back.error ?? '');
    assert.equal(await readFile(file, 'utf8'), original);
    await assertRecordsMatch(ds, rows);
  });
});

test('传入顺序不影响结果（撤销自己按偏移排序）', async () => {
  const rows = ['{"a":1}', '{"c":2}', '{"a":3}', '{"c":4}', '{"a":5}'];
  const original = `${rows.join('\n')}\n`;
  await withService(original, async (ds, file) => {
    await ds.getOverview();
    const del = await ds.deleteRecords([0, 2, 4]);
    assert.equal(del.ok, true, del.error ?? '');

    const back = await ds.insertRanges(del.changes!.toReversed());
    assert.equal(back.ok, true, back.error ?? '');
    assert.equal(await readFile(file, 'utf8'), original);
    await assertRecordsMatch(ds, rows);
  });
});

test('CRLF 文件：行尾字节一并还原', async () => {
  const rows = ['{"a":1}', '{"c":2}', '{"a":3}', '{"a":4}'];
  const original = `${rows.join('\r\n')}\r\n`;
  await withService(original, async (ds, file) => {
    await ds.getOverview();
    const del = await ds.deleteRecords([0, 3]);
    assert.equal(del.ok, true, del.error ?? '');

    const back = await ds.insertRanges(del.changes!);
    assert.equal(back.ok, true, back.error ?? '');
    assert.equal(await readFile(file, 'utf8'), original);
  });
});

test('末行无换行：删最后一行 + 另一段，撤销后仍与原文一致', async () => {
  const original = '{"a":1}\n{"c":2}\n{"a":3}'; // 没有结尾换行
  await withService(original, async (ds, file) => {
    await ds.getOverview();
    const del = await ds.deleteRecords([0, 2]);
    assert.equal(del.ok, true, del.error ?? '');

    const back = await ds.insertRanges(del.changes!);
    assert.equal(back.ok, true, back.error ?? '');
    assert.equal(await readFile(file, 'utf8'), original);
  });
});

test('走历史：批量删除 → 撤销 → 重做 → 再撤销，每一步磁盘都与预期一致', async () => {
  const rows = ['{"a":1}', '{"c":2}', '{"a":3}', '{"a":4}', '{"c":5}'];
  const original = `${rows.join('\n')}\n`;
  await withService(original, async (ds, file) => {
    await ds.getOverview();
    const del = await ds.deleteRecords([0, 3]);
    assert.equal(del.ok, true, del.error ?? '');
    const afterDelete = await readFile(file, 'utf8');
    assert.equal(afterDelete, '{"c":2}\n{"a":3}\n{"c":5}\n');

    const undo = await ds.undoStep();
    assert.equal(undo.ok, true, undo.error ?? '');
    assert.equal(await readFile(file, 'utf8'), original, '撤销应还原');
    await assertRecordsMatch(ds, rows);

    const redo = await ds.redoStep();
    assert.equal(redo.ok, true, redo.error ?? '');
    assert.equal(await readFile(file, 'utf8'), afterDelete, '重做应再次删除');

    const undoAgain = await ds.undoStep();
    assert.equal(undoAgain.ok, true, undoAgain.error ?? '');
    assert.equal(await readFile(file, 'utf8'), original);
    await assertRecordsMatch(ds, rows);
  });
});

test('偏移换算后仍越界 → 仍然拒绝（文件被别的编辑改过），磁盘不动', async () => {
  const rows = ['{"a":1}', '{"c":2}', '{"a":3}'];
  await withService(`${rows.join('\n')}\n`, async (ds, file) => {
    await ds.getOverview();
    const del = await ds.deleteRecords([0, 2]);
    assert.equal(del.ok, true, del.error ?? '');
    const afterDelete = await readFile(file, 'utf8');

    // 把每段偏移推到文件之外，模拟「文件已被别的编辑改动过」。
    const bogus = structuredClone(del.changes!);
    for (const r of bogus) {
      r.start += 99999;
      r.end += 99999;
    }
    const back = await ds.insertRanges(bogus);
    assert.equal(back.ok, false);
    assert.equal(back.conflict, true);
    assert.equal(await readFile(file, 'utf8'), afterDelete);
  });
});
