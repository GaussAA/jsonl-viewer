/**
 * queryCancellation.test.ts — 被取消的查询不得被当作完整结论缓存或使用（批次 1 · O4）。
 *
 * 背景：`searchLines` / `filterLines` 原先只有 `truncated` 一个完整性标志，而取消是
 * **正常 return**（不是异常、也不置 truncated）——于是「扫到一半」与「扫完无命中」在返回值上
 * 完全同形。宿主据此把它写进查询缓存（键 = 快照 + 查询词），用户「再搜一次」拿到的
 * 依旧是那份空/残缺结果，还以为文件里真没有。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataService } from '../dataService.ts';

const ROWS = 30;

async function withService<T>(fn: (ds: DataService) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-cancel-'));
  const file = join(dir, 'data.jsonl');
  await writeFile(
    file,
    `${Array.from({ length: ROWS }, (_, i) => `{"v":"needle-${i}"}`).join('\n')}\n`
  );
  const ds = new DataService('file:///test.jsonl', file, { sampleLines: 10 });
  try {
    return await fn(ds);
  } finally {
    await ds.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

test('O4：被取消的搜索结果不进缓存 —— 再搜一次必须拿到完整命中', async () => {
  await withService(async (ds) => {
    const cancelled = await ds.search('needle', undefined, undefined, () => true);
    assert.equal(cancelled.cancelled, true, '首次搜索应被标记为已取消');
    assert.equal(cancelled.matches.length, 0, '取消得早，尚无命中');

    // 同一查询词、同一文件快照：若上一步的残缺结果进了缓存，这里会命中它。
    const full = await ds.search('needle');
    assert.equal(
      full.matches.length,
      ROWS,
      `完整搜索应命中 ${ROWS} 行，实得=${full.matches.length}`
    );
    assert.equal(full.cancelled, undefined, '完整结果不该带取消标记');
  });
});

test('O4：被取消的过滤结果不进缓存', async () => {
  await withService(async (ds) => {
    const cond = { field: 'v', op: 'contains' as const, value: 'needle' };
    const cancelled = await ds.filter(cond, () => true);
    assert.equal(cancelled.cancelled, true);
    assert.equal((cancelled.matches ?? []).length, 0);

    const full = await ds.filter(cond);
    assert.equal(
      (full.matches ?? []).length,
      ROWS,
      `完整过滤应命中 ${ROWS} 行，实得=${(full.matches ?? []).length}`
    );
  });
});

test('O4：未被取消的搜索结果照常入缓存（缓存未被这条守卫误伤）', async () => {
  await withService(async (ds) => {
    const first = await ds.search('needle');
    // 缓存命中时返回的是 clone（冻结副本），故第二次结果与第一次等值但非同一对象。
    const second = await ds.search('needle');
    assert.deepEqual(second.matches, first.matches);
    assert.equal(second.matches.length, ROWS);
  });
});
