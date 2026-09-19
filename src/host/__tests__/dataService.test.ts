/**
 * dataService.test.ts — DataService（宿主数据服务）单测（M15：此前零覆盖）。
 *
 * 用临时 JSONL 文件驱动，覆盖：概览/读批/单行/字段推断/搜索过滤、
 * checkStale 变更检测、reload 重建、dispose 后复用（generation 代际）、
 * ensureIndex 失败自愈（P0-3）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataService } from '../dataService.ts';

async function makeFile(dir: string, lines: string[]): Promise<string> {
  const file = join(dir, 'data.jsonl');
  await writeFile(file, lines.join('\n') + '\n');
  return file;
}

function makeService(file: string): DataService {
  return new DataService('file:///test.jsonl', file, { sampleLines: 10 });
}

test('getOverview：返回行数/字节数/构建耗时', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"id":1}', '{"id":2}', '{"id":3}']);
    const ds = makeService(file);
    const ov = await ds.getOverview();
    assert.equal(ov.totalLines, 3);
    assert.ok(ov.totalBytes > 0);
    assert.ok(ov.buildMs >= 0);
    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readRecords：按需读回正确记录，坏行入 knownBadLines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"id":1}', 'not json', '{"id":3}']);
    const ds = makeService(file);
    const p = await ds.readRecords(0, 3);
    assert.equal(p.items.length, 3);
    assert.equal((p.items[0].value as { id: number }).id, 1);
    assert.equal(p.items[1].ok, false);
    assert.equal((p.items[2].value as { id: number }).id, 3);
    // 坏行命中缓存：第二次查询直接命中 knownBadLines（不抛错）
    const r = await ds.readRecord(1);
    assert.equal(r.ok, false);
    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('getSampleFields：抽样推断字段（对象记录抽键位，数组记录映射 $array）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"name":"a","tags":[1]}', '{"name":"b","tags":[2]}', '[1,2]', '[3,4]']);
    const ds = makeService(file);
    const res = await ds.getSampleFields();
    const keys = res.fields.map((f) => f.key);
    assert.ok(keys.includes('name'), `keys=${keys}`);
    assert.ok(keys.includes('$array'), `keys=${keys}`);
    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('search / filter：返回匹配行号', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"id":1,"tag":"a"}', '{"id":2,"tag":"b"}', '{"id":3,"tag":"a"}']);
    const ds = makeService(file);
    const s = await ds.search('"tag":"a"');
    assert.deepEqual(s.matches, [0, 2]);
    const f = await ds.filter({ field: 'tag', op: 'eq', value: 'b' });
    assert.deepEqual(f.matches, [1]);
    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkStale：文件变更后返回 changed，无变更返回 false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"id":1}']);
    const ds = makeService(file);
    await ds.getOverview(); // 建立快照基线
    assert.equal((await ds.checkStale())?.changed, false);
    await new Promise<void>((resolve, reject) => {
      const s = createWriteStream(file, { flags: 'a' });
      s.on('error', reject);
      s.end('\n{"id":2}\n', resolve);
    });
    const res = await ds.checkStale();
    assert.equal(res?.changed, true);
    assert.equal(res?.deleted, false);
    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reload：释放旧句柄并重建索引（统计更新）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"id":1}', '{"id":2}']);
    const ds = makeService(file);
    assert.equal((await ds.getOverview()).totalLines, 2);
    await new Promise<void>((resolve, reject) => {
      const s = createWriteStream(file, { flags: 'a' });
      s.on('error', reject);
      s.end('{"id":3}\n', resolve);
    });
    const ov = await ds.reload();
    assert.equal(ov.totalLines, 3);
    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dispose 后可重新构建（generation 代际：新生命周期不写回旧数据）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"id":1}']);
    const ds = makeService(file);
    assert.equal((await ds.getOverview()).totalLines, 1);
    await ds.dispose();
    // dispose 后再请求应重新惰性构建（而非复用已释放的索引）
    assert.equal((await ds.getOverview()).totalLines, 1);
    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('ensureIndex 失败后自愈（P0-3）：文件缺失 reject，恢复后重试成功', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const missing = join(dir, 'missing.jsonl');
    const ds = makeService(missing);
    await assert.rejects(() => ds.getOverview()); // 文件不存在 → 首次构建失败
    // 创建文件后，同一实例再次请求应能成功（building 已重置）
    await writeFile(missing, '{"id":1}\n');
    const ov = await ds.getOverview();
    assert.equal(ov.totalLines, 1);
    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
