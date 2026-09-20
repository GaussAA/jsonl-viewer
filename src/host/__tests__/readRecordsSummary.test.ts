/**
 * readRecordsSummary.test.ts — 阶段三 DataService.readRecords 行为单测。
 *
 * 验证：普通行回传「完整 value + 有界 summary + kind/count」；超大行（> RECORD_INLINE_MAX_BYTES）
 * 跳过整条 parse、标记 truncated=true 且不内联 value（只回 summary 预览）；详情仍可由
 * readRecord 按需拉全量。坏行仍入 knownBadLines。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataService } from '../dataService.ts';
import { RECORD_INLINE_MAX_BYTES } from '../../constants.ts';

async function makeFile(dir: string, lines: string[]): Promise<string> {
  const file = join(dir, 'data.jsonl');
  await writeFile(file, lines.join('\n') + '\n');
  return file;
}

function makeService(file: string): DataService {
  return new DataService('file:///test.jsonl', file, { sampleLines: 10 });
}

test('readRecords：普通行带 summary/kind/count，坏行无 summary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-rs-'));
  try {
    const file = await makeFile(dir, ['{"id":1,"name":"a"}', 'not json', '{"id":3,"name":"c"}']);
    const ds = makeService(file);
    const p = await ds.readRecords(0, 3);
    assert.equal(p.items.length, 3);

    const r0 = p.items[0];
    assert.equal(r0.ok, true);
    assert.ok(r0.value !== undefined);
    assert.equal(r0.kind, 'object');
    assert.equal(r0.count, 2);
    assert.equal(r0.truncated, undefined);
    assert.ok(Array.isArray(r0.summary) && r0.summary.length === 2);

    // 坏行：ok=false，无 summary（仅 error）
    const r1 = p.items[1];
    assert.equal(r1.ok, false);
    assert.equal(r1.summary, undefined);
    assert.ok(r1.error && r1.error.length > 0);

    const r2 = p.items[2];
    assert.equal(r2.ok, true);
    assert.ok(r2.value !== undefined);
    assert.equal(r2.count, 2);

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readRecords：超大行截断（truncated=true, value=undefined），详情仍可按需拉全量', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-rs-big-'));
  try {
    // 构造一条 > RECORD_INLINE_MAX_BYTES 的单行（~300KB 字符串字段）。
    const big = '{"data":"' + 'x'.repeat(300 * 1024) + '"}';
    const file = await makeFile(dir, ['{"id":1,"name":"a"}', big, '{"id":3,"name":"c"}']);
    const ds = makeService(file);
    const p = await ds.readRecords(0, 3);
    assert.equal(p.items.length, 3);

    // 普通行不受截断影响
    assert.equal(p.items[0].ok, true);
    assert.ok(p.items[0].value !== undefined);
    assert.equal(p.items[0].truncated, undefined);

    // 超大行：截断
    const r1 = p.items[1];
    assert.equal(r1.ok, true);
    assert.equal(r1.truncated, true);
    assert.equal(r1.value, undefined);
    assert.equal(r1.kind, 'object');
    assert.equal(r1.count, 1); // 顶层一个 key: data
    assert.ok(Array.isArray(r1.summary) && r1.summary.length === 1);
    assert.ok(r1.summary![0].display.length > 0);

    // 详情路径：readRecord 仍整条解析（< 16MB），完整值可拉回
    const full = await ds.readRecord(1);
    assert.equal(full.ok, true);
    assert.ok(full.value !== undefined);
    assert.equal((full.value as { data: string }).data.length, 300 * 1024);

    // 第三行普通
    assert.equal(p.items[2].ok, true);
    assert.ok(p.items[2].value !== undefined);

    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readRecords：阈值边界——恰等于阈值不截断，超出才截断', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-rs-edge-'));
  try {
    const exact = '{"k":"' + 'y'.repeat(RECORD_INLINE_MAX_BYTES - 20) + '"}'; // 略小于阈值
    const over = '{"k":"' + 'z'.repeat(RECORD_INLINE_MAX_BYTES + 1024) + '"}'; // 超出阈值
    const file = await makeFile(dir, [exact, over]);
    const ds = makeService(file);
    const p = await ds.readRecords(0, 2);
    assert.equal(p.items[0].truncated, undefined);
    assert.ok(p.items[0].value !== undefined);
    assert.equal(p.items[1].truncated, true);
    assert.equal(p.items[1].value, undefined);
    await ds.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
