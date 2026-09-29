/**
 * backupRecovery.test.ts — 中断编辑遗留备份的检测与恢复（O8）。
 *
 * 这里最有价值的一条是「恢复后**逐字节**等于编辑前」：孤儿备份的整个意义就是
 * 把文件还原成一个可信的状态；如果恢复出来的东西只是「看起来差不多」，
 * 那它比不提供恢复更危险 —— 用户会以为已经还原了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discardOrphanBackup,
  inspectOrphanBackup,
  restoreOrphanBackup,
  tailBackupPath,
} from '../backupRecovery.ts';
import { tailBackupMetaPath } from '../fileWriter.ts';
import type { TailBackupMeta } from '../fileWriter.ts';

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'jlv-bak-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 造一个「编辑中断」的现场：当前文件是被改过的，备份里是编辑前的原字节。 */
async function makeScene(
  dir: string,
  opts: {
    /** 编辑前的完整原文。 */
    original: string;
    /** 备份起点（= 被编辑一行的起点）。 */
    backupStart: number;
    /** 当前文件的内容（模拟崩溃时磁盘上的样子）。 */
    current: string;
    /** 覆盖写入的元数据；null 表示不写元数据。 */
    meta?: Partial<TailBackupMeta> | null;
  }
): Promise<{ path: string; backupPath: string }> {
  const path = join(dir, 'data.jsonl');
  await writeFile(path, opts.current, 'utf8');
  const backupContent = Buffer.from(opts.original, 'utf8').subarray(opts.backupStart);
  const backupPath = tailBackupPath(path);
  await writeFile(backupPath, backupContent);
  if (opts.meta !== null) {
    const meta: TailBackupMeta = {
      version: 1,
      backupStart: opts.backupStart,
      backupLen: backupContent.length,
      fileSize: Buffer.byteLength(opts.original, 'utf8'),
      at: Date.now(),
      ...opts.meta,
    };
    await writeFile(tailBackupMetaPath(path), JSON.stringify(meta), 'utf8');
  }
  return { path, backupPath };
}

test('O8：没有备份时返回 null（绝大多数情况，调用方据此什么都不做）', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'plain.jsonl');
    await writeFile(path, '{"a":1}\n');
    assert.equal(await inspectOrphanBackup(path), null);
  });
});

test('O8：有效备份 + 有效元数据 → 可恢复，且恢复后**逐字节**等于编辑前', async () => {
  await withDir(async (dir) => {
    const original = '{"i":0}\n{"i":1}\n{"i":2}\n';
    // 模拟：第一行被改成更长的内容、尾部搬移未完成（文件被撑大）。
    const current = '{"i":0,"long":"xxxxxxxx"}\n{"i":1}\n{"i":2}\n{"i":2}\n';
    const { path, backupPath } = await makeScene(dir, {
      original,
      backupStart: 0,
      current,
    });

    const info = await inspectOrphanBackup(path);
    assert.ok(info, '检测到备份');
    assert.equal(info!.recoverable, true);
    assert.equal(info!.backupBytes, Buffer.byteLength(original));

    const res = await restoreOrphanBackup(path);
    assert.equal(res.ok, true, res.error ?? '');
    assert.equal(res.restoredBytes, Buffer.byteLength(original));

    assert.equal(await readFile(path, 'utf8'), original, '恢复后与编辑前逐字节一致');
    // 备份与元数据都已清理：留着会让下次打开又提示一遍「发现遗留备份」。
    await assert.rejects(stat(backupPath));
    await assert.rejects(stat(tailBackupMetaPath(path)));
  });
});

test('O8：恢复会把文件截回编辑前的大小（崩溃可能停在搬移后、截断前）', async () => {
  await withDir(async (dir) => {
    const original = 'a\nb\nc\n';
    // 当前文件更长：尾部多出一段（搬移完成但 truncate 尚未执行的形态）。
    const current = 'a\nUPDATED\nb\nc\nb\nc\n';
    const { path } = await makeScene(dir, { original, backupStart: 2, current });

    const res = await restoreOrphanBackup(path);
    assert.equal(res.ok, true, res.error ?? '');
    const after = await readFile(path, 'utf8');
    assert.equal(after, original);
    assert.equal(Buffer.byteLength(after), Buffer.byteLength(original), '大小也回到了编辑前');
  });
});

test('O8：缺元数据 → 不可自动恢复，且给出原因（只能丢弃）', async () => {
  await withDir(async (dir) => {
    const { path, backupPath } = await makeScene(dir, {
      original: 'a\nb\n',
      backupStart: 2,
      current: 'a\nX\n',
      meta: null,
    });
    const info = await inspectOrphanBackup(path);
    assert.ok(info);
    assert.equal(info!.recoverable, false, '没有起点信息就不能拼回 —— 不能假装能恢复');
    assert.match(info!.reason ?? '', /元数据/);

    const res = await restoreOrphanBackup(path);
    assert.equal(res.ok, false, '拒绝恢复');
    assert.match(res.error ?? '', /元数据/);
    // 拒绝恢复时**不动**备份：用户还能人工处理。
    assert.ok((await stat(backupPath)).isFile(), '备份必须保留');
  });
});

test('O8：备份大小与元数据不符 → 拒绝恢复（备份本身已被改动）', async () => {
  await withDir(async (dir) => {
    // 备份实际 6 字节，元数据却声称 4 字节（其余字段自洽）—— 说明备份被改过。
    const { path } = await makeScene(dir, {
      original: 'a\nb\nc\n',
      backupStart: 0,
      current: 'a\nb\nc\n',
      meta: { backupLen: 4 },
    });
    const info = await inspectOrphanBackup(path);
    assert.equal(info?.recoverable, false);
    assert.match(info?.reason ?? '', /不符/);

    // 另一形态：元数据自身就不自洽（声称的区间超出原文件）→ 视为「没有可用的元数据」。
    const other = await makeScene(dir, {
      original: 'a\nb\n',
      backupStart: 0,
      current: 'a\nb\n',
      meta: { backupLen: 999 },
    });
    const info2 = await inspectOrphanBackup(other.path);
    assert.equal(info2?.recoverable, false);
    assert.match(info2?.reason ?? '', /元数据/);
  });
});

test('O8：目标文件短于备份起点 → 拒绝恢复（文件已被外部改动）', async () => {
  await withDir(async (dir) => {
    const { path } = await makeScene(dir, {
      original: 'a\nb\nc\nd\n',
      backupStart: 6,
      current: 'a\n',
      meta: { backupStart: 6 },
    });
    const info = await inspectOrphanBackup(path);
    assert.equal(info?.recoverable, false);
    assert.match(info?.reason ?? '', /短于备份起点/);
  });
});

test('O8：元数据损坏（非 JSON / 非法 kind）→ 按「无元数据」处理', async () => {
  await withDir(async (dir) => {
    const { path } = await makeScene(dir, {
      original: 'a\nb\n',
      backupStart: 0,
      current: 'a\nb\n',
      meta: null,
    });
    await writeFile(tailBackupMetaPath(path), '{ 不是 JSON', 'utf8');
    const info = await inspectOrphanBackup(path);
    assert.equal(info?.recoverable, false);

    await writeFile(
      tailBackupMetaPath(path),
      JSON.stringify({ version: 1, backupStart: -1, backupLen: 2, fileSize: 4 }),
      'utf8'
    );
    assert.equal((await inspectOrphanBackup(path))?.recoverable, false, '负数起点非法');
  });
});

test('O8：丢弃会同时删除备份与元数据', async () => {
  await withDir(async (dir) => {
    const { path, backupPath } = await makeScene(dir, {
      original: 'a\nb\n',
      backupStart: 0,
      current: 'a\nb\n',
    });
    assert.ok((await stat(backupPath)).isFile());
    await discardOrphanBackup(path);
    await assert.rejects(stat(backupPath));
    await assert.rejects(stat(tailBackupMetaPath(path)));
    assert.equal(await inspectOrphanBackup(path), null, '之后不再报告');
    // 数据文件本身不动 —— 丢弃的是「恢复的可能性」，不是用户的数据。
    assert.equal(await readFile(path, 'utf8'), 'a\nb\n');
  });
});

test('O8：恢复后数据文件可被正常读取（不留下悬空句柄/半截内容）', async () => {
  await withDir(async (dir) => {
    const original = '{"i":0}\n{"i":1}\n';
    const { path } = await makeScene(dir, {
      original,
      backupStart: 8,
      current: '{"i":0}\n{"i":1,"x":true}\n',
    });
    assert.equal((await restoreOrphanBackup(path)).ok, true);
    assert.equal(await readFile(path, 'utf8'), original);
    // 再恢复一次：备份已删 → 明确报「没有可恢复的备份」，而不是静默成功。
    const again = await restoreOrphanBackup(path);
    assert.equal(again.ok, false);
    assert.match(again.error ?? '', /没有发现/);
  });
});
