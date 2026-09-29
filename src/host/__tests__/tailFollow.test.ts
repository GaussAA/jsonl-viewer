/**
 * tailFollow.test.ts — 追尾增量（F6）的宿主侧回归。
 *
 * 追尾的风险全在「静默」二字：判断错一次，行号就整体错位，而界面上看不出任何异常。
 * 因此每个用例都落在**可观测行为**上 —— tryTailAppend 的返回值、追尾后 readRecords /
 * search 能否读到新行、以及追尾成功后 checkStale 不再误报「文件已更改」。
 *
 * 宿主索引（worker / 主线程）的同步经 O1 的 applyIndexOps 通道，故「追尾后能搜到新行」
 * 同时也是两侧索引同步的判据：搜不到 = 回填丢了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataService, type DataServiceOptions } from '../dataService.ts';

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-tailfollow-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function makeService(file: string, opts: DataServiceOptions = {}): DataService {
  return new DataService('file:///test.jsonl', file, { sampleLines: 10, ...opts });
}

async function sizeOf(file: string): Promise<number> {
  return (await stat(file)).size;
}

test('F6：尾部增长被增量跟进 —— 新行可读、可搜，且不再误报「文件已更改」', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'data.jsonl');
    await writeFile(file, '{"i":0}\n{"i":1}\n{"i":2}\n');
    const ds = makeService(file);
    try {
      await ds.getOverview(); // 构建索引 + 记录基线

      await appendFile(file, '{"i":3}\n{"i":4}\n');
      const info = await ds.tryTailAppend();
      assert.ok(info, '应追尾成功');
      assert.equal(info?.totalLines, 5);
      assert.equal(info?.totalRecords, 5);
      assert.equal(info?.totalBytes, await sizeOf(file));

      // 新行按行号可读（主线程侧索引已并入）。
      const page = await ds.readRecords(3, 2);
      assert.equal(page.items.length, 2);
      assert.deepEqual(page.items[0].value, { i: 3 });

      // 宿主侧索引同步走 O1 通道：搜不到 = 回填丢了。
      const found = await ds.search('"i":4');
      assert.ok(found.matches.includes(4), '追尾后的新行必须能被搜索命中');

      // 基线已随追尾刷新：轮询不应再弹「文件已更改」。
      assert.deepEqual(await ds.checkStale(), { changed: false });
    } finally {
      await ds.dispose();
    }
  });
});

test('F6：残行分两轮跟进（写进程落了一半）—— 半行不当记录，补齐后整行并入', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'data.jsonl');
    await writeFile(file, '{"i":0}\n');
    const ds = makeService(file);
    try {
      await ds.getOverview();

      // 写进程只落了半行：磁盘上没有换行 → 本轮不吸收。
      await appendFile(file, '{"i":1}');
      assert.equal(await ds.tryTailAppend(), null, '半行不算一行');
      const page1 = await ds.readRecords(0, 10);
      assert.equal(page1.items.length, 1, '半行不应出现在记录里');

      // 写完剩下半行 + 换行：下一轮从 index.totalBytes 重读 → 整行并入。
      await appendFile(file, '\n');
      const info = await ds.tryTailAppend();
      assert.ok(info, '补齐后应吸收');
      assert.equal(info?.totalLines, 2);
      const page2 = await ds.readRecords(1, 1);
      assert.deepEqual(page2.items[0].value, { i: 1 }, '字节不丢：半行的前半也在');
    } finally {
      await ds.dispose();
    }
  });
});

test('F6：无增长 / 缩小 / 超限一律放弃（交给走样判定）', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'data.jsonl');
    await writeFile(file, '{"i":0}\n{"i":1}\n');
    const ds = makeService(file);
    try {
      await ds.getOverview();
      assert.equal(await ds.tryTailAppend(), null, 'size 未变时无事可做');

      // 缩小（截断 / 轮转）：不是「追加」，交给 checkStale 弹横幅。
      await writeFile(file, '{"i":0}\n');
      assert.equal(await ds.tryTailAppend(), null);

      // 超限：一次增长超过 TAIL_APPEND_MAX_BYTES(8MB) 不是「缓缓追加」的场景。
      await writeFile(file, `${'{"pad":"'.padEnd(8 * 1024 * 1024 + 2, 'x')}"}\n`);
      assert.equal(await ds.tryTailAppend(), null, '增量超限时应放弃');
    } finally {
      await ds.dispose();
    }
  });
});

test('F6：文件被整体替换（size 变大但内容不同）时指纹拦截，不硬凑', async () => {
  await withDir(async (dir) => {
    const file = join(dir, 'data.jsonl');
    await writeFile(file, '{"i":0}\n{"i":1}\n{"i":2}\n');
    const ds = makeService(file);
    try {
      await ds.getOverview();

      // 轮转后重写：size 比基线大，但吸收点之前的内容已面目全非。
      await writeFile(file, `{"rotated":true}\n{"i":1}\n{"i":2}\n{"i":3}\n`);
      assert.equal(await ds.tryTailAppend(), null, '指纹不符必须拒绝');

      // 拒绝后基线未动：轮询仍能正确报告走样（横幅路径完好）。
      const stale = await ds.checkStale();
      assert.equal(stale?.changed, true);
    } finally {
      await ds.dispose();
    }
  });
});

test('F6：非紧凑形态（多行记录 / 末行未闭合）不追，退回横幅', async () => {
  await withDir(async (dir) => {
    // pretty 文件：一条记录跨多行 → multiline 索引直接没有追尾资格。
    const pretty = join(dir, 'pretty.jsonl');
    await writeFile(pretty, '{\n  "a": 1\n}\n');
    const dsPretty = makeService(pretty);
    try {
      await dsPretty.getOverview();
      await appendFile(pretty, '{\n  "a": 2\n}\n');
      assert.equal(await dsPretty.tryTailAppend(), null, 'multiline 不追');
    } finally {
      await dsPretty.dispose();
    }

    // 末行未闭合（文件末尾没有换行）：新字节是在续写那一行。
    const open = join(dir, 'open.jsonl');
    await writeFile(open, '{"i":0}\n{"i":1}');
    const dsOpen = makeService(open);
    try {
      await dsOpen.getOverview();
      await appendFile(open, '\n{"i":2}\n');
      assert.equal(await dsOpen.tryTailAppend(), null, '末行未闭合时不追');
    } finally {
      await dsOpen.dispose();
    }
  });
});
