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
    if (res && res.changed === true) {
      assert.equal(res.deleted, false);
    }
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

/* ------- 守卫 / 边界 / 解析（覆盖率补强） ------- */

test('readRecords：非整数 / 负数 / 非正 count 一律返回空批（脏行号不透传）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"id":1}', '{"id":2}']);
    const ds = makeService(file);
    const cases: Array<[number, number]> = [
      [NaN, 2],
      [-1, 2],
      [1.5, 2],
      [0, 0],
      [0, -5],
      [0, NaN],
      [0, 1.5],
    ];
    for (const [start, count] of cases) {
      const p = await ds.readRecords(start, count);
      assert.equal(p.items.length, 0, `start=${start} count=${count} 应为空批`);
    }
    // 合法请求仍正常
    assert.equal((await ds.readRecords(0, 2)).items.length, 2);
    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readRecord：非法行号返回 ok=false；越界行同样安全不抛', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"id":1}', '{"id":2}']);
    const ds = makeService(file);
    for (const line of [-1, NaN, 1.5]) {
      const r = await ds.readRecord(line);
      assert.equal(r.ok, false, `line=${line} 应失败`);
      assert.equal(r.value, undefined);
    }
    const beyond = await ds.readRecord(9999);
    assert.equal(beyond.ok, false, '越界行安全失败');
    assert.equal((await ds.readRecord(1)).ok, true, '边界内正常');
    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('search：scope "a:b" 限定行区间；非法 scope 视为全范围', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"tag":"a"}', '{"tag":"b"}', '{"tag":"a"}']);
    const ds = makeService(file);

    const ranged = await ds.search('"tag":"a"', undefined, '0:1');
    assert.deepEqual(ranged.matches, [0], '仅扫第 0 行');

    const rangedAll = await ds.search('"tag":"a"', undefined, '0:3');
    assert.deepEqual(rangedAll.matches, [0, 2], '覆盖全部 3 行');

    const unparsable = await ds.search('"tag":"a"', undefined, 'all');
    assert.deepEqual(unparsable.matches, [0, 2], '非法 scope → 全范围');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('totalLines / peekIndex：未构建时为 0 / undefined，构建后可见', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"id":1}', '{"id":2}', '{"id":3}']);
    const ds = makeService(file);

    assert.equal(ds.totalLines, 0, '未构建为 0');
    assert.equal(ds.peekIndex(), undefined, '未构建无索引');

    await ds.getOverview();
    assert.equal(ds.totalLines, 3, '构建后行数可见');
    assert.ok(ds.peekIndex(), '构建后索引可见');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkStale：文件被删除 → changed=true 且 deleted=true（索引失效提示）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"id":1}']);
    const ds = makeService(file);
    await ds.getOverview(); // 建立快照基线

    await rm(file, { force: true });
    const res = await ds.checkStale();
    assert.equal(res?.changed, true, '检出变更');
    if (res && res.changed === true) {
      assert.equal(res.deleted, true, '标记为已删除');
      assert.match(res.message, /删除/);
    }

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
