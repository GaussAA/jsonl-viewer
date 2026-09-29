/**
 * multilineIndex.test.ts — 多行（pretty）文件的**索引语义不变式**（批次 1 · O3）。
 *
 * 背景（缺陷的形状）：
 *   `LineIndex.applyLineReplace/Insert/Delete` 只维护**检查点**，不维护**记录分组**
 *   （`recordEndLines/Offsets`），而构造函数里 `multiline = records !== undefined`。
 *   于是每在 pretty 文件上做一次这些增量，索引就**静默**从「记录语义」塌回「物理行语义」：
 *   `totalRecords` 从分组数变成行数，`readRecords` / 历史重放的行号随之全部错位 ——
 *   界面上看不出任何异常，这是最难发现的一类退化。
 *
 * 不变式（每个用例的核心断言都落到它）：**对多行文件的任何写操作之后，
 *   `peekIndex().multiline` 必须仍为 true、`totalRecords` 必须仍是记录数（而非行数）。**
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataService, type DataServiceOptions } from '../dataService.ts';

/** 3 条 pretty 记录（每条 3 行）＝ 9 行。 */
const PRETTY_3 = ['{', '  "a": 1', '}', '{', '  "a": 2', '}', '{', '  "a": 3', '}'];

/** pretty + 紧凑混排：4 行 / 2 条记录（第 0 条跨行、第 1 条单行）。 */
const MIXED = ['{', '  "a": 1', '}', '{"b":2}'];

async function withService<T>(
  dir: string,
  lines: string[],
  fn: (ds: DataService, file: string) => Promise<T>,
  opts: DataServiceOptions = {}
): Promise<T> {
  const file = join(dir, 'data.jsonl');
  await writeFile(file, `${lines.join('\n')}\n`);
  const ds = new DataService('file:///test.jsonl', file, { sampleLines: 10, ...opts });
  try {
    return await fn(ds, file);
  } finally {
    await ds.dispose();
  }
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-multiline-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('O3：多行文件插入一行后，索引仍是「记录语义」', async () => {
  await withDir((dir) =>
    withService(dir, PRETTY_3, async (ds) => {
      const before = await ds.getOverview();
      assert.equal(before.totalRecords, 3, '前置：3 条 pretty 记录');
      assert.equal(ds.peekIndex()?.multiline, true, '前置：多行索引');

      // `at === totalRecords` 即「追加到末尾」（插入位置按记录号计，与 recordRange 同一口径）。
      const res = await ds.insertRecord(3, '{"a":4}');
      assert.equal(res.ok, true, res.error ?? '');

      assert.equal(ds.peekIndex()?.multiline, true, '插入后不得塌回行语义');
      assert.equal(ds.totalRecords, 4, 'totalRecords 必须是记录数（此前会变成 9+1 行）');

      const page = await ds.readRecords(0, 4);
      assert.equal(page.items.length, 4, '记录目录应有 4 条');
      assert.equal((page.items[3].value as { a: number }).a, 4, '末条即新插入的记录');
    })
  );
});

test('O3：多行文件删除一行后，索引仍是「记录语义」', async () => {
  await withDir((dir) =>
    withService(dir, PRETTY_3, async (ds) => {
      await ds.getOverview();
      // 删掉最后一条记录的右括号（结构变更，且行数 -1）
      const res = await ds.deleteRecord(8);
      assert.equal(res.ok, true, res.error ?? '');

      assert.equal(ds.peekIndex()?.multiline, true, '删除后不得塌回行语义');
      // 第 2 条记录变成「悬空」（吞并到 EOF），记录语义下仍是 3 条
      assert.equal(ds.totalRecords, 3, 'totalRecords 不得退化为物理行数');
      const page = await ds.readRecords(0, 3);
      assert.equal(page.items.length, 3);
    })
  );
});

test('O3：混排文件里编辑单行记录后，多行语义保持', async () => {
  await withDir((dir) =>
    withService(dir, MIXED, async (ds) => {
      const ov = await ds.getOverview();
      assert.equal(ov.totalRecords, 2, '前置：跨行记录 + 单行记录');
      assert.equal(ds.peekIndex()?.multiline, true);

      // 记录 1 是单行记录 → 走 replaceLine 快路径（isMultiline=false），
      // 但索引必须继续以「记录」为单位维护。
      const res = await ds.editRecord(1, '{"b":2,"pad":"xxxxxxxx"}');
      assert.equal(res.ok, true, res.error ?? '');

      assert.equal(ds.peekIndex()?.multiline, true, '编辑单行记录后不得塌回行语义');
      assert.equal(ds.totalRecords, 2, 'totalRecords 必须仍是 2 条记录（此前会变成 4 行）');
      const rec = await ds.readRecord(1);
      assert.equal((rec.value as { pad: string }).pad, 'xxxxxxxx', '读回的是被编辑的那条记录');
    })
  );
});

test('O3：撤销多行文件的批量删除后，记录语义与内容都复原', async () => {
  await withDir((dir) =>
    withService(dir, PRETTY_3, async (ds) => {
      await ds.getOverview();
      const del = await ds.deleteRecords([1]); // 删中间那条记录（走重建分支）
      assert.equal(del.ok, true, del.error ?? '');
      assert.equal(ds.totalRecords, 2);

      const undo = await ds.undoStep(); // 撤销 → insertRangesInternal（区间插回）
      assert.equal(undo.ok, true, undo.error ?? '');

      assert.equal(ds.peekIndex()?.multiline, true, '插回后不得塌回行语义');
      assert.equal(ds.totalRecords, 3, 'totalRecords 必须是 3 条记录（此前会变成物理行数）');
      const rec = await ds.readRecord(1);
      assert.equal((rec.value as { a: number }).a, 2, '被删的记录原样回来');
    })
  );
});
