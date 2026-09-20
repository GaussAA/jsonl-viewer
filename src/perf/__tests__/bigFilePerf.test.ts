/**
 * bigFilePerf.test.ts — 超大文件打开 / 内存 / 随机访问基准（性能与稳定验证）。
 *
 * 目的：在本地落一个「中等规模」JSONL 临时文件，验证三条核心不变量：
 *   1. LineIndex.build 打开耗时随文件大小线性、GByte 级可秒开（OPS 参考文献见 README）；
 *   2. readBatch 随机访问正确性（任意窗口读回的记录内容与预期一致）；
 *   3. 滚动窗口内存有界：行偏移数组只与「行数」成正比，进程内存不随文件字节数暴涨。
 *
 * 为什么用「中等规模」而非真实刷几 GB：
 *   - 单元测试运行于 `node --test`，每次都要写盘、索引、清理；真刷数个 GB 会显著拖慢
 *     CI 与日常开发，且受磁盘 IO 波动影响导致指标不稳定。
 *   - 本测试用可配置行数（默认 60_000 行 × 约 0.5KB ≈ 30MB）把「路径正确性 + 指标量级」
 *     验证到位；多 GB 场景只需把 `JSONL_PERF_LINES` 调大（如 5_000_000 × 0.5KB ≈ 2.5GB）
 *     重跑即可得到同一方法的延展结论，方法论一致。
 *   - 指标以 console 输出（不写成断言，避免机器差异造成 flaky）。
 *
 * 额外覆盖稳定路径：超大单行不崩溃（友好报错）、readBatch 可中断。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LineIndex } from '../../indexer/lineIndex.ts';
import {
  openFileReader,
  readBatch,
  readRecord,
  MemoryReader,
} from '../../parser/jsonParser.ts';

/** 单行记录：固定约 0.5KB，含唯一 id 便于随机访问校验。 */
function makeLine(i: number): string {
  return (
    `{"id":${i},"name":"row-${i}","ok":${i % 5 !== 0},"meta":{"batch":${i},` +
    `"tags":["alpha","beta"],"desc":"${'x'.repeat(420)}"}}\n`
  );
}

/** 流式写 N 行 JSONL 到临时文件（不整文件驻留内存），返回字节数。 */
async function writeLines(file: string, n: number): Promise<{ bytes: number }> {
  const stream = createWriteStream(file);
  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    let done = 0;
    const pump = (): void => {
      while (done < n) {
        const line = makeLine(done);
        done++;
        if (!stream.write(line)) {
          stream.once('drain', pump);
          return;
        }
      }
      stream.end(resolve);
    };
    pump();
  });
  const s = await stat(file);
  return { bytes: s.size };
}

test('超大文件索引与随机访问基准（30MB 规模，可用 JSONL_PERF_LINES 放大到多 GB）', async () => {
  const n = Number(process.env.JSONL_PERF_LINES) || 60_000;
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-perf-'));
  const file = join(dir, 'big.jsonl');
  try {
    const { bytes } = await writeLines(file, n);
    const before = process.memoryUsage();
    const startMs = performance.now();
    const li = await LineIndex.build(createReadStream(file), {
      chunkSize: 1024 * 1024,
      reportInterval: 4 * 1024 * 1024,
    });
    const buildMs = performance.now() - startMs;
    const after = process.memoryUsage();

    assert.equal(li.totalLines, n);
    assert.ok(li.buildMs >= 0);
    // 稀疏检查点（约 16B/检查点 = 8B offset + 8B line）随「行数/间隔」稀疏增长，
    // 与单行内容无关 → 大文件索引内存由行数主导但被间隔摊薄（间隔 1024 时仅约全量的 1/1024）。
    const idxBytes = li.checkpoints.length * 16;
    const heapGrowthMb = (after.heapUsed - before.heapUsed) / 1048576;

    console.log(
      `[perf/JSONL] lines=${n} bytes=${(bytes / 1048576).toFixed(1)}MB ` +
        `buildMs=${buildMs.toFixed(1)} checkpointRows=${li.checkpoints.length} ` +
        `idxBytes≈${(idxBytes / 1024).toFixed(0)}KB heapΔ=${heapGrowthMb.toFixed(1)}MB`
    );

    // 随机访问正确性：多个窗口读回并校验 id / name。
    let reader;
    try {
      reader = await openFileReader(file);
      for (const start of [0, 17, 1000, 30_000, n - 5]) {
        const batch = await readBatch(start, 3, li, reader);
        assert.equal(batch.length, 3);
        for (let k = 0; k < batch.length; k++) {
          assert.equal(batch[k].ok, true);
          const v = batch[k].value as { id: number; name: string };
          assert.equal(v.id, start + k);
          assert.equal(v.name, `row-${start + k}`);
        }
      }
    } finally {
      if (reader && reader.close) await reader.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readBatch：宿主 CancelToken 置位即中断剩余行（真正的可中断）', async () => {
  const buf = Buffer.from(
    Array.from({ length: 20 }, (_, i) => JSON.stringify({ id: i })).join('\n'),
    'utf8'
  );
  const li = await LineIndex.build([buf]);
  const reader = new MemoryReader(buf);
  // 在第 3 行后取消：readBatch 应提前返回 <20 的结果，且不再扫剩余行。
  let checked = 0;
  const r = await readBatch(0, 20, li, reader, {
    shouldCancel: () => ++checked >= 3,
  });
  assert.ok(r.length < 20);
  assert.ok(checked < 20);
  // 一开始就取消：返回空数组。
  const r0 = await readBatch(0, 20, li, reader, { shouldCancel: () => true });
  assert.equal(r0.length, 0);
});

test('超大单行：超过 maxLineBytes 被友好拒绝（readRecord 捕获为坏行，不崩溃）', async () => {
  const big = `{"a":"${'y'.repeat(4096)}"}`;
  const buf = Buffer.from(big, 'utf8');
  const li = await LineIndex.build([buf]);
  const reader = new MemoryReader(buf);
  const r = await readRecord(0, li, reader, { maxLineBytes: 1024 });
  assert.equal(r.ok, false);
  assert.ok(r.error && /too large|exceeds/.test(r.error));
});

test('searchLines：shouldCancel 提前终止（不再扫剩余文件）', async () => {
  const buf = Buffer.from(
    Array.from({ length: 100 }, (_, i) => JSON.stringify({ id: i, tag: i % 2 ? 'hit' : 'miss' })).join('\n'),
    'utf8'
  );
  const li = await LineIndex.build([buf]);
  const reader = new MemoryReader(buf);
  const { searchLines } = await import('../../host/searchEngine.ts');
  let probe = 0;
  const res = await searchLines(reader, li, {
    query: 'hit',
    shouldCancel: () => ++probe >= 5,
  });
  // 取消后只登记了前几步，结果行号集合很小、total 不会是全量命中。
  assert.ok(res.matches.length < 50);
  assert.ok(probe < 100);
});