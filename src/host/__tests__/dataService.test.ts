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
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataService } from '../dataService.ts';
import { MAX_SELECTION_LINES, MAX_HISTORY_ENTRIES } from '../../constants.ts';

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
    const file = await makeFile(dir, [
      '{"name":"a","tags":[1]}',
      '{"name":"b","tags":[2]}',
      '[1,2]',
      '[3,4]',
    ]);
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
    const file = await makeFile(dir, [
      '{"id":1,"tag":"a"}',
      '{"id":2,"tag":"b"}',
      '{"id":3,"tag":"a"}',
    ]);
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

/* ------------------------- editRecord：就地行替换 ------------------------- */

test('editRecord：等长编辑走原位覆写（零搬移）且磁盘内容正确', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"id":1}', '{"id":2}', '{"id":3}']);
    const ds = makeService(file);
    await ds.getOverview();

    const res = await ds.editRecord(1, '{"id":9}'); // 与 {"id":2} 等长

    assert.equal(res.ok, true);
    assert.equal(res.inPlace, true);
    assert.equal(res.bytesDelta, 0);
    assert.equal(res.movedBytes, 0);
    assert.equal(await readFile(file, 'utf8'), '{"id":1}\n{"id":9}\n{"id":3}\n');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('editRecord：变长编辑搬移尾部并同步索引，编辑行与其后各行均可正确读回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"id":1}', '{"id":2}', '{"id":3}']);
    const ds = makeService(file);
    await ds.getOverview();

    const next = '{"id":2,"note":"a much longer payload"}';
    const res = await ds.editRecord(1, next);

    assert.equal(res.ok, true);
    assert.equal(res.inPlace, false);
    assert.equal(res.bytesDelta, Buffer.byteLength(next) - Buffer.byteLength('{"id":2}'));
    assert.equal(res.movedBytes, Buffer.byteLength('{"id":3}\n'), '仅其后第 3 行被搬移');
    assert.equal(await readFile(file, 'utf8'), `{"id":1}\n${next}\n{"id":3}\n`);

    // 索引已增量同步：三行都能按新偏移读回
    assert.deepEqual((await ds.readRecord(0)).value, { id: 1 });
    assert.deepEqual((await ds.readRecord(1)).value, { id: 2, note: 'a much longer payload' });
    assert.deepEqual((await ds.readRecord(2)).value, { id: 3 });

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('editRecord：写后同步基线 —— checkStale 不把「自写」误判为外部变更', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}']);
    const ds = makeService(file);
    await ds.getOverview();
    assert.equal((await ds.checkStale())?.changed, false, '前置：无变更');

    const res = await ds.editRecord(0, '{"a":111111}');
    assert.equal(res.ok, true);

    const stale = await ds.checkStale();
    assert.equal(stale?.changed, false, '自写后不得报告外部变更');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('editRecord：文件被外部修改或乐观锁不符 → 拒绝并保持文件原样', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}']);
    const ds = makeService(file);
    await ds.getOverview();

    // 外部追加一行（size 变化）
    const external = '{"a":1}\n{"b":2}\n{"c":3}\n';
    await writeFile(file, external);

    const conflict = await ds.editRecord(0, '{"a":9}');
    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflict, true);
    assert.match(conflict.error ?? '', /外部修改/);
    assert.equal(await readFile(file, 'utf8'), external, '冲突时绝不能写盘');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('editRecord：乐观锁 expectedBytes 与磁盘实际不符 → 判冲突', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}']);
    const ds = makeService(file);
    await ds.getOverview();
    const original = await readFile(file, 'utf8');

    const res = await ds.editRecord(0, '{"a":9}', 999); // 谎报旧长度
    assert.equal(res.ok, false);
    assert.equal(res.conflict, true);
    assert.equal(await readFile(file, 'utf8'), original);

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('editRecord：JSON 非法或行号越界 → 拒绝且不写盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}']);
    const ds = makeService(file);
    await ds.getOverview();
    const original = await readFile(file, 'utf8');

    const bad = await ds.editRecord(0, '{"a":1,,}');
    assert.equal(bad.ok, false);
    assert.equal(bad.invalid, true);
    assert.match(bad.error ?? '', /JSON 校验未通过/);

    const oob = await ds.editRecord(99, '{"x":1}');
    assert.equal(oob.ok, false);
    assert.match(oob.error ?? '', /无效行号/);

    assert.equal(await readFile(file, 'utf8'), original, '拒绝时必须保持文件原样');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('editRecord：把坏行改成合法 JSON 后可正常读回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', 'not-json', '{"c":3}']);
    const ds = makeService(file);
    await ds.getOverview();
    assert.equal((await ds.readRecord(1)).ok, false, '前置：第 1 行是坏行');

    const res = await ds.editRecord(1, '{"b":2}');
    assert.equal(res.ok, true);

    const after = await ds.readRecord(1);
    assert.equal(after.ok, true);
    assert.deepEqual(after.value, { b: 2 });

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readRecord：回传该行磁盘原文与字节长度（编辑初始文本 + 乐观锁依据）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', 'not-json']);
    const ds = makeService(file);
    await ds.getOverview();

    const good = await ds.readRecord(0);
    assert.equal(good.rawText, '{"a":1}');
    assert.equal(good.rawBytes, 7);

    // 坏行同样要回原文 —— 编辑中最常见的动作就是「把坏行改好」。
    const bad = await ds.readRecord(1);
    assert.equal(bad.ok, false);
    assert.equal(bad.rawText, 'not-json');
    assert.equal(bad.rawBytes, 8);

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* --------------------- deleteRecord / insertRecord（增删行） --------------------- */

test('deleteRecord：删中间行 → 行数减一、其后行号前移，且回传被删原文', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}', '{"c":3}']);
    const ds = makeService(file);
    await ds.getOverview();

    const res = await ds.deleteRecord(1);
    assert.equal(res.ok, true);
    assert.equal(res.beforeText, '{"b":2}', '被删原文须回传（撤销的逆操作要用）');
    assert.equal(await readFile(file, 'utf8'), '{"a":1}\n{"c":3}\n');

    // 索引已同步：原第 2 行现在是第 1 行，越界行不存在
    assert.deepEqual((await ds.readRecord(0)).value, { a: 1 });
    assert.deepEqual((await ds.readRecord(1)).value, { c: 3 });
    assert.equal((await ds.readRecord(2)).ok, false);

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deleteRecord：删最后一行 → 文件正确收尾，总字节数同步', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}']);
    const ds = makeService(file);
    const before = await ds.getOverview();

    const res = await ds.deleteRecord(1);
    assert.equal(res.ok, true);
    assert.equal(await readFile(file, 'utf8'), '{"a":1}\n');

    const after = await ds.getOverview();
    assert.equal(after.totalLines, 1);
    assert.equal(after.totalBytes, before.totalBytes - Buffer.byteLength('{"b":2}\n'));

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('insertRecord：在指定行之前插入，其后行号后移；追加到末尾亦可用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"c":3}']);
    const ds = makeService(file);
    await ds.getOverview();

    const res = await ds.insertRecord(1, '{"b":2}');
    assert.equal(res.ok, true);
    assert.equal(await readFile(file, 'utf8'), '{"a":1}\n{"b":2}\n{"c":3}\n');
    assert.deepEqual((await ds.readRecord(1)).value, { b: 2 });
    assert.deepEqual((await ds.readRecord(2)).value, { c: 3 });

    // at === totalLines → 追加到末尾
    const appended = await ds.insertRecord(3, '{"d":4}');
    assert.equal(appended.ok, true);
    assert.equal(await readFile(file, 'utf8'), '{"a":1}\n{"b":2}\n{"c":3}\n{"d":4}\n');
    assert.deepEqual((await ds.readRecord(3)).value, { d: 4 });

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('insertRecord：CRLF 文件中插入的新行沿用 CRLF（不搅乱行尾风格）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = join(dir, 'crlf.jsonl');
    await writeFile(file, '{"a":1}\r\n{"c":3}\r\n');
    const ds = new DataService('file:///crlf.jsonl', file, { sampleLines: 10 });
    await ds.getOverview();

    const res = await ds.insertRecord(1, '{"b":2}');
    assert.equal(res.ok, true);
    assert.equal(await readFile(file, 'utf8'), '{"a":1}\r\n{"b":2}\r\n{"c":3}\r\n');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('insertRecord / deleteRecord：非法 JSON、越界、外部冲突一律拒绝且不写盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}']);
    const ds = makeService(file);
    await ds.getOverview();
    const original = await readFile(file, 'utf8');

    const badJson = await ds.insertRecord(0, '{"x":1,,}');
    assert.equal(badJson.ok, false);
    assert.equal(badJson.invalid, true);
    assert.equal(await readFile(file, 'utf8'), original);

    assert.equal((await ds.insertRecord(99, '{"x":1}')).ok, false, '插入位置越界');
    assert.equal((await ds.deleteRecord(99)).ok, false, '删除行号越界');
    assert.equal(await readFile(file, 'utf8'), original);

    // 外部改动后再删 → 冲突
    const external = '{"a":1}\n{"b":2}\n{"c":3}\n';
    await writeFile(file, external);
    const conflict = await ds.deleteRecord(0);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflict, true);
    assert.equal(await readFile(file, 'utf8'), external, '冲突时绝不写盘');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('insertRecord / deleteRecord：写后同步基线 —— checkStale 不误报自写', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}', '{"c":3}']);
    const ds = makeService(file);
    await ds.getOverview();

    await ds.deleteRecord(1);
    assert.equal((await ds.checkStale())?.changed, false, '删除后不得报告外部变更');

    await ds.insertRecord(1, '{"b2":22}');
    assert.equal((await ds.checkStale())?.changed, false, '插入后不得报告外部变更');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* ------------------------- 查找替换（M2） ------------------------- */

test('replaceText：多行命中一次改写，行数不变且后续行仍可正确读回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"name":"bob"}', '{"name":"alice"}', '{"name":"bob"}']);
    const ds = makeService(file);
    await ds.getOverview();

    const res = await ds.replaceText('bob', 'carol');
    assert.equal(res.ok, true);
    assert.equal(res.replaced, 2);
    assert.equal(res.total, 2);
    assert.equal(res.skippedInvalid, 0);
    assert.equal(
      await readFile(file, 'utf8'),
      '{"name":"carol"}\n{"name":"alice"}\n{"name":"carol"}\n'
    );

    // 索引增量更新（逐行 applyLineReplace 累加）后每一行仍能被正确读回 ——
    // 若平移算错，这里会读到错位的内容或直接扫描失败。
    assert.equal(ds.totalLines, 3);
    assert.deepEqual((await ds.readRecord(0)).value, { name: 'carol' });
    assert.deepEqual((await ds.readRecord(1)).value, { name: 'alice' });
    assert.deepEqual((await ds.readRecord(2)).value, { name: 'carol' });

    assert.equal((await ds.checkStale())?.changed, false, '替换不得被误报为外部变更');
    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceText：替换后 JSON 非法的行跳过，其余行照常改', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const original = '{"a":1}\n{"b":"1"}\n';
    const file = join(dir, 'data.jsonl');
    await writeFile(file, original);
    const ds = makeService(file);
    await ds.getOverview();

    // 第一行 '1' → 'x' 得到 {"a":x} 非法；第二行得 {"b":"x"} 合法。
    const res = await ds.replaceText('1', 'x');
    assert.equal(res.ok, true);
    assert.equal(res.replaced, 1, '合法的那一行照常改');
    assert.equal(res.skippedInvalid, 1, '非法的那一行被跳过并如实计数');
    assert.equal(res.total, 2);
    assert.equal(await readFile(file, 'utf8'), '{"a":1}\n{"b":"x"}\n', '跳过的行必须原样保留');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceText：无命中 / 空查询', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const original = '{"a":1}\n{"b":2}\n';
    const file = join(dir, 'data.jsonl');
    await writeFile(file, original);
    const ds = makeService(file);
    await ds.getOverview();

    const miss = await ds.replaceText('zzz', 'y');
    assert.equal(miss.ok, true);
    assert.equal(miss.replaced, 0);
    assert.equal(miss.total, 0);

    // 空查询会匹配每一行的每个位置 —— 那不是替换而是毁文件，必须拒绝。
    const empty = await ds.replaceText('', 'y');
    assert.equal(empty.ok, false);
    assert.match(empty.error ?? '', /不能为空/);

    assert.equal(await readFile(file, 'utf8'), original, '两种情形都不得写盘');
    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceText：外部改动后拒绝替换（冲突时绝不写盘）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":"x"}', '{"b":"x"}']);
    const ds = makeService(file);
    await ds.getOverview();

    const external = '{"a":"x"}\n{"b":"x"}\n{"c":"x"}\n';
    await writeFile(file, external);

    const res = await ds.replaceText('x', 'y');
    assert.equal(res.ok, false);
    assert.equal(res.conflict, true);
    assert.equal(await readFile(file, 'utf8'), external, '冲突时文件必须原样保留');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceText：changes 可用于一次性还原整批（撤销往返）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const original = '{"n":"x"}\n{"n":"y"}\n{"n":"x"}\n';
    const file = join(dir, 'data.jsonl');
    await writeFile(file, original);
    const ds = makeService(file);
    await ds.getOverview();

    const res = await ds.replaceText('x', 'X');
    assert.equal(res.undoable, true);
    assert.equal(res.changes?.length, 2);

    const back = await ds.applyLineTexts(
      res.changes!.map((c) => ({ line: c.line, text: c.before }))
    );
    assert.equal(back.ok, true);
    assert.equal(await readFile(file, 'utf8'), original, '撤销后必须逐字节还原');

    // 重做：写回 after 应再次得到替换后的内容
    const again = await ds.applyLineTexts(
      res.changes!.map((c) => ({ line: c.line, text: c.after }))
    );
    assert.equal(again.ok, true);
    assert.equal(await readFile(file, 'utf8'), '{"n":"X"}\n{"n":"y"}\n{"n":"X"}\n');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceText：CRLF 文件的替换保留 CRLF 行尾', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = join(dir, 'crlf.jsonl');
    await writeFile(file, '{"n":"x"}\r\n{"n":"x"}\r\n');
    const ds = new DataService('file:///crlf.jsonl', file, { sampleLines: 10 });
    await ds.getOverview();

    const res = await ds.replaceText('x', 'y');
    assert.equal(res.replaced, 2);
    assert.equal(await readFile(file, 'utf8'), '{"n":"y"}\r\n{"n":"y"}\r\n');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceText：命中但不发生变化时如实归类为 unchanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const original = '{"n":"x"}\n';
    const file = join(dir, 'data.jsonl');
    await writeFile(file, original);
    const ds = makeService(file);
    await ds.getOverview();

    const res = await ds.replaceText('x', 'x');
    assert.equal(res.ok, true);
    assert.equal(res.replaced, 0, '内容没变就不该写入');
    assert.equal(res.unchanged, 1);
    assert.equal(res.undoable, false, '没有变更就不该声称可撤销');
    assert.equal(await readFile(file, 'utf8'), original);

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceText：大小写不敏感命中时只改命中片段，不污染其余大小写', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"Name":"bob","TAG":"bob"}']);
    const ds = makeService(file);
    await ds.getOverview();

    const res = await ds.replaceText('name', 'title');
    assert.equal(res.replaced, 1);
    // 键名 Name 被替换为 title；值 "bob" 与另一个键 TAG 不受影响。
    assert.equal(await readFile(file, 'utf8'), '{"title":"bob","TAG":"bob"}\n');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* --------------------- 大文件：进度与取消（M3） --------------------- */

test('replaceText：进度回调终态必达 100%（否则进度条会永远停在中途）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"n":"x"}', '{"n":"x"}', '{"n":"x"}']);
    const ds = makeService(file);
    await ds.getOverview();

    const seen: { processedBytes: number; totalBytes: number }[] = [];
    const res = await ds.replaceText('x', 'y', { onProgress: (i) => seen.push(i) });

    assert.equal(res.ok, true);
    assert.ok(seen.length > 0, '至少有回调');
    const last = seen[seen.length - 1];
    assert.equal(last.totalBytes, 30, '总分母为原文件字节数（3 × 9 字节 + 3 个换行）');
    assert.equal(last.processedBytes, last.totalBytes, '终态 processed === total');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('replaceText：取消 → cancelled 标记、文件分毫未动、不留临时文件、句柄已恢复', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const original = '{"a":1}\n{"n":"x"}\n{"n":"x"}\n';
    const file = join(dir, 'data.jsonl');
    await writeFile(file, original);
    const ds = makeService(file);
    await ds.getOverview();

    // 第一个命中行不在文件开头，故重写会在「复制前导区」时命中取消检查点。
    const res = await ds.replaceText('x', 'y', { shouldCancel: () => true });

    assert.equal(res.ok, false);
    assert.equal(res.cancelled, true, '取消必须可识别，不能混同为失败');
    assert.equal(await readFile(file, 'utf8'), original, '取消发生在 rename 之前：文件必须原样');
    assert.deepEqual(await readdir(dir), ['data.jsonl'], '临时文件已清理');

    // 句柄在 finally 中拿回 —— 取消后读取仍须可用（否则用户一取消就「文件读不了」）。
    const rec = await ds.readRecord(2);
    assert.equal(rec.ok, true);
    assert.deepEqual(rec.value, { n: 'x' });

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* --------------------- 多选批量删除（M2） --------------------- */

test('deleteRecords：相邻行合并成一个区间，不相邻行各自成区间', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}', '{"e":5}']);
    const ds = makeService(file);
    await ds.getOverview();

    // 删 1、2（相邻）+ 4（不相邻）；故意重复传 1 验证去重
    const res = await ds.deleteRecords([1, 2, 4, 1, 4]);

    assert.equal(res.ok, true);
    assert.equal(res.deleted, 3, '去重后删除 3 行');
    assert.equal(res.ranges, 2, '相邻的 1、2 合并成一个区间，4 单独一个');
    assert.equal(await readFile(file, 'utf8'), '{"a":1}\n{"d":4}\n');
    assert.equal(ds.totalLines, 2);

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deleteRecords：整段连续删除合并为单个区间（框选场景的核心优化）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(
      dir,
      Array.from({ length: 100 }, (_, i) => `{"i":${i}}`)
    );
    const ds = makeService(file);
    await ds.getOverview();

    const targets = Array.from({ length: 80 }, (_, i) => 10 + i); // 删 10..89
    const res = await ds.deleteRecords(targets);

    assert.equal(res.deleted, 80);
    assert.equal(res.ranges, 1, '80 个连续行合并成 1 个区间编辑（否则会是 80 个）');
    assert.equal(ds.totalLines, 20);

    // 首尾行内容正确 —— 索引倒序应用若写错，这里会读到错位内容
    assert.deepEqual((await ds.readRecord(0)).value, { i: 0 });
    assert.deepEqual((await ds.readRecord(9)).value, { i: 9 });
    assert.deepEqual((await ds.readRecord(19)).value, { i: 99 });

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deleteRecords → insertRanges：撤销逐字节还原，且索引偏移精确', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    // 各行长度刻意不同：若用「平均字节」平移检查点，撤销后读到的内容就会错位。
    const original = ['{"a":1}', '{"b":22}', '{"c":333}', '{"d":4444}', '{"e":55555}'];
    const file = await makeFile(dir, original);
    const ds = makeService(file);
    await ds.getOverview();

    const del = await ds.deleteRecords([1, 2]);
    assert.equal(del.ok, true);
    assert.ok(del.changes && del.changes.length === 1, '相邻行合并为一个区间');
    assert.deepEqual(del.changes![0].lineBytes.length, 2, '每行字节数逐行记录');
    assert.equal(await readFile(file, 'utf8'), '{"a":1}\n{"d":4444}\n{"e":55555}\n');

    const back = await ds.insertRanges(del.changes!);
    assert.equal(back.ok, true);
    assert.equal(back.deleted, 2);
    assert.equal(await readFile(file, 'utf8'), original.join('\n') + '\n', '逐字节还原');
    assert.equal(ds.totalLines, 5);

    for (let i = 0; i < original.length; i++) {
      const r = await ds.readRecord(i);
      assert.equal(r.ok, true, `第 ${i} 行可读`);
      assert.equal(r.rawText, original[i], `第 ${i} 行内容正确（偏移未错位）`);
    }

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deleteRecords / insertRanges：撤销后可再次删除（重做往返一致）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}']);
    const ds = makeService(file);
    await ds.getOverview();

    const first = await ds.deleteRecords([1, 2]);
    const afterDelete = await readFile(file, 'utf8');

    const back = await ds.insertRanges(first.changes!);
    assert.equal(back.ok, true);

    // 重做：用同一组行号再删一次，结果必须一致（区间偏移未漂移）
    await ds.deleteRecords(first.changes!.flatMap((r) => r.lines));
    assert.equal(await readFile(file, 'utf8'), afterDelete, '重做结果与首次删除一致');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deleteRecords：超过选区上限时拒绝，文件不变', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const count = MAX_SELECTION_LINES + 1;
    const file = await makeFile(
      dir,
      Array.from({ length: count }, (_, i) => `{"i":${i}}`)
    );
    const original = await readFile(file, 'utf8');
    const ds = makeService(file);
    await ds.getOverview();

    const targets = Array.from({ length: count }, (_, i) => i);
    const res = await ds.deleteRecords(targets);

    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /最多删除/);
    assert.equal(await readFile(file, 'utf8'), original, '拒绝时文件必须原样');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readLinesText：按行取磁盘原文，CRLF 原样保留', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = join(dir, 'crlf.jsonl');
    await writeFile(file, '{"a":1}\r\n{"b":2}\r\n{"c":3}\r\n');
    const ds = new DataService('file:///crlf.jsonl', file, { sampleLines: 10 });
    await ds.getOverview();

    const res = await ds.readLinesText([0, 2]);

    assert.equal(res.ok, true);
    assert.equal(res.count, 2);
    assert.equal(res.text, '{"a":1}\r\n{"c":3}\r\n', '只取指定行且行尾原样（可安全粘贴）');
    assert.equal(res.truncated, false);

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readLinesText：总字节超过上限时截断并如实标记', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}']);
    // 造一个超过 COPY_MAX_BYTES（8MB）的单行
    await writeFile(file, `{"x":"${'a'.repeat(9 * 1024 * 1024)}"}\n{"b":2}\n`);
    const ds = makeService(file);
    await ds.getOverview();

    const res = await ds.readLinesText([0, 1]);

    assert.equal(res.truncated, true, '必须如实标记截断（静默截断会让用户以为复制全了）');
    assert.equal(res.count, 0, '放不下的行不复制');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readLinesText：空输入与全越界行号都报「没有可复制的行」', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}']);
    const ds = makeService(file);
    await ds.getOverview();

    const empty = await ds.readLinesText([]);
    assert.equal(empty.ok, false);
    assert.match(empty.error ?? '', /没有可复制的行/);

    // 越界 / 小数 / 负数混合输入：归一化后为空 → 同样拒绝（不做部分静默复制）
    const oob = await ds.readLinesText([99, -1, 1.5]);
    assert.equal(oob.ok, false);
    assert.equal(oob.text, '', '失败时不返回任何内容');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readLinesText：超过选区上限时拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const count = MAX_SELECTION_LINES + 1;
    const file = await makeFile(
      dir,
      Array.from({ length: count }, (_, i) => `{"i":${i}}`)
    );
    const ds = makeService(file);
    await ds.getOverview();

    const res = await ds.readLinesText(Array.from({ length: count }, (_, i) => i));
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /最多复制/);

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * 坏行标记的批量位移。
 *
 * 注：`knownBadLines` 目前**只写不读**（除本模块自身的位移逻辑外无消费方），
 * 故这里只能通过「磁盘上坏行的位置」间接验证位移被正确执行。补此测试是为了锁定
 * 位移语义 —— 一旦将来接入消费方（如坏行列表视图），它必须仍然正确。
 */
test('deleteRecords：坏行标记随删除位移，且删除坏行本身时被丢弃', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}', 'not-json', '{"d":4}']);
    const ds = makeService(file);
    await ds.getOverview();

    // 先让第 2 行（坏行）进入 knownBadLines
    const bad = await ds.readRecord(2);
    assert.equal(bad.ok, false, '第 3 行确为坏行');

    // 删掉它前面的两行 → 坏行前移到第 0 行（主路径：不在 deleted 集合中）
    const first = await ds.deleteRecords([0, 1]);
    assert.equal(first.ok, true);
    assert.equal(ds.totalLines, 2);
    const moved = await ds.readRecord(0);
    assert.equal(moved.ok, false, '坏行随之前移到第 1 行');
    assert.equal(moved.rawText, 'not-json');

    // 再删掉坏行自己（分支：deleted 集合命中 → 丢弃而非位移）
    const second = await ds.deleteRecords([0]);
    assert.equal(second.ok, true);
    assert.equal(ds.totalLines, 1);
    assert.deepEqual((await ds.readRecord(0)).value, { d: 4 });

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('insertRanges：偏移越界时拒绝（文件已被其它编辑改动过）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}']);
    const ds = makeService(file);
    await ds.getOverview();

    // 伪造一个远超文件大小的插入点：宁可拒绝，也不要在错误位置插入
    const bogus = [
      { start: 999_999, end: 999_999, content: '{"x":1}\n', lines: [0], lineBytes: [8] },
    ];
    const res = await ds.insertRanges(bogus);

    assert.equal(res.ok, false);
    assert.equal(res.conflict, true);
    assert.match(res.error ?? '', /失效/);
    assert.equal(await readFile(file, 'utf8'), '{"a":1}\n{"b":2}\n', '拒绝时文件必须原样');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/* --------------------- 会话编辑历史（M3） --------------------- */

test('history：每次写操作入栈，快照反映类型与行数', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}']);
    const ds = makeService(file);
    await ds.getOverview();

    await ds.editRecord(0, '{"a":11}');
    await ds.insertRecord(1, '{"x":9}');
    await ds.deleteRecord(2);
    await ds.replaceText('11', '12');
    await ds.deleteRecords([0, 1]);

    const h = ds.getHistory();
    assert.equal(h.entries.length, 5);
    assert.equal(h.cursor, 5, '全部已应用');
    assert.equal(h.dropped, false);
    assert.deepEqual(
      h.entries.map((e) => e.kind),
      ['edit', 'insert', 'delete', 'replaceAll', 'deleteMany'],
      '五种写操作都被记录且类型正确'
    );
    assert.match(h.entries[0].label, /编辑第 1 行/);
    assert.match(h.entries[4].label, /删除 2 行/);

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history：undoStep / redoStep 逐步往返，文件逐字节还原', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const original = '{"a":1}\n{"b":2}\n';
    const file = join(dir, 'data.jsonl');
    await writeFile(file, original);
    const ds = makeService(file);
    await ds.getOverview();

    await ds.editRecord(0, '{"a":99}');
    const edited = await readFile(file, 'utf8');

    const u = await ds.undoStep();
    assert.equal(u.ok, true);
    assert.equal(u.steps, 1);
    assert.equal(u.cursor, 0, '光标回到起点');
    assert.equal(await readFile(file, 'utf8'), original, '撤销后逐字节还原');

    const r = await ds.redoStep();
    assert.equal(r.ok, true);
    assert.equal(r.cursor, 1);
    assert.equal(await readFile(file, 'utf8'), edited, '重做后回到编辑态');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history：撤销/重做自身不产生新记录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}']);
    const ds = makeService(file);
    await ds.getOverview();

    await ds.editRecord(0, '{"a":2}');
    assert.equal(ds.getHistory().entries.length, 1);

    await ds.undoStep();
    assert.equal(ds.getHistory().entries.length, 1, '撤销不得追加记录（否则栈会无限增长）');
    await ds.redoStep();
    assert.equal(ds.getHistory().entries.length, 1, '重做同样不得追加');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history：新操作截断「已撤销」的重做分支', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}']);
    const ds = makeService(file);
    await ds.getOverview();

    await ds.editRecord(0, '{"a":2}');
    await ds.editRecord(0, '{"a":3}');
    await ds.undoStep(); // 回到 a:2，光标 1
    assert.equal(ds.getHistory().cursor, 1);

    await ds.editRecord(0, '{"a":9}'); // 在光标处发生新操作
    const h = ds.getHistory();
    assert.equal(h.entries.length, 2, '被撤销的分支作废（标准撤销栈语义）');
    assert.equal(h.cursor, 2);
    assert.equal((await ds.redoStep()).ok, false, '已无可重做');
    assert.equal(await readFile(file, 'utf8'), '{"a":9}\n{"b":2}\n');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history：setHistoryCursor 后退多步 / 前进多步', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const original = '{"a":1}\n{"b":2}\n';
    const file = join(dir, 'data.jsonl');
    await writeFile(file, original);
    const ds = makeService(file);
    await ds.getOverview();

    await ds.editRecord(0, '{"a":2}');
    await ds.editRecord(0, '{"a":3}');
    await ds.editRecord(0, '{"a":4}');

    const back = await ds.setHistoryCursor(0);
    assert.equal(back.ok, true);
    assert.equal(back.steps, 3, '逐条走完三步');
    assert.equal(back.cursor, 0);
    assert.equal(await readFile(file, 'utf8'), original, '退回原点即逐字节还原');

    const fwd = await ds.setHistoryCursor(2);
    assert.equal(fwd.ok, true);
    assert.equal(fwd.steps, 2);
    assert.equal(await readFile(file, 'utf8'), '{"a":3}\n{"b":2}\n');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history：revertTo 让该条成为最新已应用（其后的被撤销）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}']);
    const ds = makeService(file);
    await ds.getOverview();

    await ds.editRecord(0, '{"a":2}');
    await ds.editRecord(0, '{"a":3}');
    const first = ds.getHistory().entries[0].id; // 第 1 条

    const res = await ds.revertTo(first);
    assert.equal(res.ok, true);
    assert.equal(res.cursor, 1, '第 1 条成为最新已应用 → 第 2 条被撤销');
    assert.equal(await readFile(file, 'utf8'), '{"a":2}\n{"b":2}\n', '只剩第 1 次编辑的效果');

    // 点最新的那条：从第 1 步重做回第 2 步
    const latest = ds.getHistory().entries[1].id;
    const fwd = await ds.revertTo(latest);
    assert.equal(fwd.ok, true);
    assert.equal(fwd.steps, 1, '从第 1 步重做回第 2 步');
    assert.equal(await readFile(file, 'utf8'), '{"a":3}\n{"b":2}\n', '回到最新状态');

    // 已在最新一步时再点它 → 无任何动作（这正是「停在这一步」语义的价值）
    const noop = await ds.revertTo(latest);
    assert.equal(noop.ok, true);
    assert.equal(noop.steps, 0, '已在最新一步，点它不产生动作');
    assert.equal(await readFile(file, 'utf8'), '{"a":3}\n{"b":2}\n');

    // 已丢弃的 id：如实报错而不是静默无操作
    const gone = await ds.revertTo('h-不存在');
    assert.equal(gone.ok, false);
    assert.match(gone.error ?? '', /已不存在/);

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history：空历史时撤销/重做如实报错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}']);
    const ds = makeService(file);
    await ds.getOverview();

    const u = await ds.undoStep();
    assert.equal(u.ok, false);
    assert.match(u.error ?? '', /没有可撤销/);
    const r = await ds.redoStep();
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /没有可重做/);

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history：超过条数上限时丢弃最旧并标记 dropped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}']);
    const ds = makeService(file);
    await ds.getOverview();

    for (let i = 0; i < MAX_HISTORY_ENTRIES + 3; i++) {
      await ds.editRecord(0, `{"a":${i + 2}}`);
    }

    const h = ds.getHistory();
    assert.equal(h.entries.length, MAX_HISTORY_ENTRIES, '只保留最近的 N 条');
    assert.equal(h.dropped, true, '必须如实标记「更早的记录已丢弃」');
    assert.equal(h.cursor, MAX_HISTORY_ENTRIES, '光标同步调整');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history：撤销失败时如实报错且光标不动（不假装成功）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}']);
    const ds = makeService(file);
    await ds.getOverview();

    await ds.editRecord(0, '{"a":2}');

    // 外部改动文件 → 撤销会命中冲突检测
    const external = '{"z":9}\n{"b":2}\n';
    await writeFile(file, external);

    const u = await ds.undoStep();
    assert.equal(u.ok, false);
    assert.equal(u.steps, 0);
    assert.equal(u.cursor, 1, '失败时光标保持不动');
    assert.equal(await readFile(file, 'utf8'), external, '冲突时绝不写盘');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history：reload 后历史作废（行号与偏移已整体失效）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const file = await makeFile(dir, ['{"a":1}', '{"b":2}']);
    const ds = makeService(file);
    await ds.getOverview();

    await ds.editRecord(0, '{"a":2}');
    assert.equal(ds.getHistory().entries.length, 1);

    await ds.reload();
    assert.equal(ds.getHistory().entries.length, 0, '重载后旧历史必须作废');
    assert.equal((await ds.undoStep()).ok, false, '不能再拿旧行号去撤销');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history：批量删除可整体撤销（与单步撤销共用同一套数据）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const original = '{"a":1}\n{"b":2}\n{"c":3}\n{"d":4}\n';
    const file = join(dir, 'data.jsonl');
    await writeFile(file, original);
    const ds = makeService(file);
    await ds.getOverview();

    await ds.deleteRecords([1, 2]);
    assert.equal(await readFile(file, 'utf8'), '{"a":1}\n{"d":4}\n');

    const u = await ds.undoStep();
    assert.equal(u.ok, true);
    assert.equal(u.label, '删除 2 行');
    assert.equal(await readFile(file, 'utf8'), original, '批量删除一步撤销即完整还原');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * 五种写操作各自的双向执行，以及**整条链的完整可逆性**。
 *
 * 这是本功能最有价值的不变式：把每一种操作的「正向 + 反向」都走一遍，
 * 且验证「一路撤销到底 = 回到最初」「再一路重做 = 回到当初」。
 * 任何一处反向实现写错（行号、区间、字节），这条链都会对不上。
 */
test('history：五种操作混合后一路撤销到底，再一路重做，两个端点都逐字节一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-ds-'));
  try {
    const original = '{"a":1}\n{"b":2}\n{"c":3}\n{"d":4}\n';
    const file = join(dir, 'data.jsonl');
    await writeFile(file, original);
    const ds = makeService(file);
    await ds.getOverview();

    await ds.editRecord(0, '{"a":11}');
    await ds.insertRecord(1, '{"x":9}');
    await ds.deleteRecord(2);
    await ds.replaceText('11', '12');
    await ds.deleteRecords([0, 1]);
    const finalState = await readFile(file, 'utf8');
    assert.equal(ds.getHistory().entries.length, 5);

    // 一路撤销到底：五种操作的反向各执行一次
    const back = await ds.setHistoryCursor(0);
    assert.equal(back.ok, true);
    assert.equal(back.steps, 5, '五步全部走完');
    assert.equal(await readFile(file, 'utf8'), original, '回到最初，逐字节一致');

    // 再一路重做到底：五种操作的正向各执行一次
    const fwd = await ds.setHistoryCursor(5);
    assert.equal(fwd.ok, true);
    assert.equal(fwd.steps, 5);
    assert.equal(await readFile(file, 'utf8'), finalState, '回到当初，逐字节一致');

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
