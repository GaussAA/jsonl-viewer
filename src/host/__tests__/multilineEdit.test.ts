/**
 * multlineEdit.test.ts — 多行（pretty）文件单条编辑的口径回归。
 *
 * 缺陷的形状（务必读完再改）：`editRecord` / `deleteRecords` 早就以**记录号**为口径
 * （`totalRecords` 上界 + `recordRange` 定位），而单条 `deleteRecord` / `insertRecord`
 * 却混用两种口径 —— 上界一个按 `totalLines`、插入点按物理行探测。紧凑文件里
 * 记录号 == 行号，一切正常；pretty 文件里两者错位：
 *   - 删除：用户选中的是一条记录，落盘只撕掉它的一个物理行，剩下两行变坏记录；
 *   - 插入：新行插进前面的 pretty 记录**中间**，而不是第 at 条记录之前。
 *
 * 附带修复（同一根因的另一半）：插入的「单行 / JSON 合法」约束原来在**内部实现**
 * 上，而撤销「删除」恰恰要走内部实现把原文插回 —— 多行原文会被单行约束拒绝、
 * 坏记录会被 JSON 校验拒绝，表现为「删得掉、撤不回」。约束上移到对外入口后，
 * 内部实现与 editRecord 同规：对外校验、内部放行。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataService, type DataServiceOptions } from '../dataService.ts';
import { MAX_LINE_BYTES } from '../../constants.ts';

const PRETTY_3 = ['{', '  "a": 1', '}', '{', '  "a": 2', '}', '{', '  "a": 3', '}'];

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ml-edit-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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

test('多行文件删除中间记录：磁盘上整条消失，其余记录原样', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'data.jsonl');
    await writeFile(file, `${PRETTY_3.join('\n')}\n`);
    const ds = new DataService('file:///test.jsonl', file, { sampleLines: 10 });
    try {
      await ds.getOverview();
      const res = await ds.deleteRecord(1);
      assert.equal(res.ok, true, res.error ?? '');

      const after = await readFile(file, 'utf8');
      assert.equal(after, '{\n  "a": 1\n}\n{\n  "a": 3\n}\n', '整条记录从磁盘消失');

      const page = await ds.readRecords(0, 10);
      assert.deepEqual(
        page.items.map((it) => it.value),
        [{ a: 1 }, { a: 3 }],
        '读取视图与磁盘一致'
      );
    } finally {
      await ds.dispose();
    }
  });
});

test('多行文件删除后撤销：多行聚合原文原样插回，文件逐字节复原', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'data.jsonl');
    const original = `${PRETTY_3.join('\n')}\n`;
    await writeFile(file, original);
    const ds = new DataService('file:///test.jsonl', file, { sampleLines: 10 });
    try {
      await ds.getOverview();
      assert.equal((await ds.deleteRecord(1)).ok, true);
      const undo = await ds.undoStep();
      assert.equal(undo.ok, true, undo.error ?? '');
      assert.equal(await readFile(file, 'utf8'), original, '撤销后逐字节复原');
      assert.equal((await ds.getOverview()).totalRecords, 3);
    } finally {
      await ds.dispose();
    }
  });
});

test('多行文件插入：新记录落在第 at 条记录之前（不是插进前面的记录中间）', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'data.jsonl');
    await writeFile(file, `${PRETTY_3.join('\n')}\n`);
    const ds = new DataService('file:///test.jsonl', file, { sampleLines: 10 });
    try {
      await ds.getOverview();
      const res = await ds.insertRecord(1, '{"b":9}');
      assert.equal(res.ok, true, res.error ?? '');

      const page = await ds.readRecords(0, 10);
      assert.deepEqual(
        page.items.map((it) => it.value),
        [{ a: 1 }, { b: 9 }, { a: 2 }, { a: 3 }],
        '新记录插入在第 1 条记录之前'
      );

      const undo = await ds.undoStep();
      assert.equal(undo.ok, true, undo.error ?? '');
      assert.equal(await readFile(file, 'utf8'), `${PRETTY_3.join('\n')}\n`, '撤销后复原');
    } finally {
      await ds.dispose();
    }
  });
});

test('撤销「删除坏记录」：内部不再做 JSON 校验，坏行原样回来', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'data.jsonl');
    const original = '{"ok":1}\nnot-json\n{"ok":3}\n';
    await writeFile(file, original);
    const ds = new DataService('file:///test.jsonl', file, { sampleLines: 10 });
    try {
      await ds.getOverview();
      assert.equal((await ds.deleteRecord(1)).ok, true);
      const undo = await ds.undoStep();
      assert.equal(undo.ok, true, `撤销坏行删除必须成功：${undo.error ?? ''}`);
      assert.equal(await readFile(file, 'utf8'), original, '坏行逐字节复原');
    } finally {
      await ds.dispose();
    }
  });
});

test('对外插入仍拒绝多行文本与坏 JSON（约束在上移后依然存在）', async () => {
  await withDir(async (dir) => {
    await withService(dir, ['{"a":1}'], async (ds) => {
      await ds.getOverview();
      const multi = await ds.insertRecord(0, '{\n  "a": 2\n}');
      assert.equal(multi.ok, false);
      assert.equal(multi.invalid, true, '多行文本必须被拒');

      const bad = await ds.insertRecord(0, 'not-json');
      assert.equal(bad.ok, false);
      assert.equal(bad.invalid, true, '坏 JSON 必须被拒');

      assert.equal((await ds.getOverview()).totalRecords, 1, '两次拒绝都未落盘');
    });
  });
});

test('超大 pretty 记录拒绝整条删除（撤销原文会超出单行读取上限）', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'data.jsonl');
    const pad = '"pad":"' + 'x'.repeat(MAX_LINE_BYTES + 1024) + '"';
    const original = `{\n${pad}\n}\n`;
    await writeFile(file, original);
    const ds = new DataService('file:///test.jsonl', file, { sampleLines: 10 });
    try {
      await ds.getOverview();
      const res = await ds.deleteRecord(0);
      assert.equal(res.ok, false, '超过上限的多行记录必须明确拒绝');
      assert.match(res.error ?? '', /过大/, '拒绝理由要说清楚');
      assert.equal(await readFile(file, 'utf8'), original, '文件未被改动');
    } finally {
      await ds.dispose();
    }
  });
});
