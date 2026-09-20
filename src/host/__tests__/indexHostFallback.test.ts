/**
 * indexHostFallback.test.ts — worker 不可用时的降级回归测试（P0-2）。
 *
 * 背景：`new Worker(不存在的脚本)` **不会同步抛错**，而是异步 emit 'error'，
 * 因此 `createIndexHost` 的 try/catch 拦不住「worker 加载失败」。
 * 若不做兜底，`build` 直接 reject → 插件打不开任何文件且不回退主线程。
 *
 * 本测试锁定用户可见契约：**worker 不可用时插件必须仍然可用（自动回退主线程）**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activeWorkerCount,
  buildIndexWithFallback,
  createIndexHost,
  MAX_ACTIVE_WORKERS,
  type IndexHost,
} from '../indexHost.ts';
import { DataService } from '../dataService.ts';

/** 一个绝不可能存在的 worker 脚本路径。 */
const BOGUS_WORKER = '/definitely/not/exists/indexWorker.js';

async function makeFile(dir: string, lines: string[]): Promise<string> {
  const file = join(dir, 'data.jsonl');
  await writeFile(file, lines.join('\n') + '\n');
  return file;
}

test('buildIndexWithFallback：worker 加载失败时自动回退主线程且索引正确', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-fb-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"a":2}', '{"a":3}']);
    const built = await buildIndexWithFallback(BOGUS_WORKER, file);
    assert.equal(built.fellBack, true, '应发生回退');
    assert.equal(built.host.kind, 'main', '回退后宿主应为主线程实现');
    assert.equal(built.result.index.totalLines, 3);
    await built.host.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DataService：配了坏 worker 路径仍能正常打开并读批（端到端回退）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-fb-ds-'));
  try {
    const file = await makeFile(dir, ['{"id":1}', '{"id":2}']);
    const ds = new DataService('file:///fb.jsonl', file, {
      sampleLines: 10,
      workerScriptPath: BOGUS_WORKER,
    });
    const ov = await ds.getOverview();
    assert.equal(ov.totalLines, 2);

    const p = await ds.readRecords(0, 2);
    assert.equal(p.items.length, 2);
    assert.equal((p.items[0].value as { id: number }).id, 1);

    // 搜索同样应可用（回退后的主线程宿主承担 search/filter）
    const s = await ds.search('"id":2');
    assert.deepEqual(s.matches, [1]);

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createIndexHost：活跃 worker 达到上限后退化主线程（不耗尽线程）', async () => {
  const base = activeWorkerCount();
  const hosts: IndexHost[] = [];
  try {
    const room = Math.max(0, MAX_ACTIVE_WORKERS - base);
    for (let i = 0; i < room; i++) {
      hosts.push(createIndexHost(BOGUS_WORKER));
    }
    assert.equal(activeWorkerCount(), MAX_ACTIVE_WORKERS, '应正好达到上限');

    const extra = createIndexHost(BOGUS_WORKER);
    hosts.push(extra);
    assert.equal(extra.kind, 'main', '超出上限应退化为主线程实现');
  } finally {
    for (const h of hosts) await h.dispose().catch(() => {});
  }
  assert.equal(activeWorkerCount(), base, '全部释放后并发计数应回到基线');
});

test('createIndexHost 不存在时不影响主线程路径（回归：无 workerScriptPath 场景不变）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-fb-none-'));
  try {
    const file = await makeFile(dir, ['{"x":1}']);
    const ds = new DataService('file:///none.jsonl', file, { sampleLines: 5 });
    const ov = await ds.getOverview();
    assert.equal(ov.totalLines, 1);
    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
