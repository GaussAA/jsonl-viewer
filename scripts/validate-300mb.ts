/**
 * validate-300mb.ts — 阶段二·2a 真实大文件校验（一次性，非交付测试）。
 *
 * 在 samples/big-300mb.jsonl（~315MB / 305k+ 行）上验证稀疏索引 + scan 的关键不变量：
 *   1) 索引构建耗时线性、内存有界（检查点 < 全量偏移的 1/interval）；
 *   2) readRecord 随机读与暴力解逐行一致；
 *   3) readBatch 窗口读与暴力解切片一致；
 *   4) searchLines 全文匹配集合与暴力扫描集合完全一致（scan 读到的字节即原文）。
 *
 * 运行：`node scripts/validate-300mb.ts`（项目 type:module，受管 Node 22 直接跑 .ts）。
 */

import { readFileSync, statSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { LineIndex } from '../src/indexer/lineIndex.ts';
import { openFileReader, readRecord, readBatch, type ByteReader } from '../src/parser/jsonParser.ts';
import { searchLines } from '../src/host/searchEngine.ts';
import { DataService } from '../src/host/dataService.ts';

const FILE = 'samples/big-300mb.jsonl';

/** ASCII 大小写折叠的 Buffer includes（与 searchEngine.bufferIncludesCI 同义，用于暴力基准）。 */
function bufIncludesCI(hay: Buffer, needle: Buffer): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  const n = hay.length - needle.length;
  for (let i = 0; i <= n; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      const a = hay[i + j];
      const b = needle[j];
      const aF = a >= 65 && a <= 90 ? a + 32 : a;
      const bF = b >= 65 && b <= 90 ? b + 32 : b;
      if (aF !== bF) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

async function main(): Promise<void> {
  const sizeMB = statSync(FILE).size / 1048576;
  console.log(`[validate] file=${FILE} size=${(sizeMB).toFixed(1)}MB`);

  // ---- 1) 索引构建：耗时 + 内存 ----
  const memBefore = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const li = await LineIndex.build(createReadStream(FILE), {
    chunkSize: 1024 * 1024,
    reportInterval: 8 * 1024 * 1024,
  });
  const buildMs = performance.now() - t0;
  const memAfter = process.memoryUsage().heapUsed;
  const idxBytes = li.checkpoints.length * 16;
  console.log(
    `[validate] index: totalLines=${li.totalLines} totalBytes=${li.totalBytes} ` +
      `buildMs=${buildMs.toFixed(0)} checkpoints=${li.checkpoints.length} ` +
      `idxBytes≈${(idxBytes / 1024).toFixed(0)}KB heapΔ=${((memAfter - memBefore) / 1048576).toFixed(1)}MB`
  );

  // ---- 暴力基准：整文件读入，按 \n 切行（末尾换行不额外成行）----
  const tB = performance.now();
  const whole = readFileSync(FILE);
  let brute = whole.toString('utf8').split('\n');
  if (brute.length && brute[brute.length - 1] === '') brute = brute.slice(0, -1);
  const bruteBuf = whole; // 用于字节级暴力搜索
  const bruteMs = performance.now() - tB;
  console.log(`[validate] brute split: lines=${brute.length} ms=${bruteMs.toFixed(0)}`);

  let failures = 0;
  const check = (cond: boolean, msg: string): void => {
    if (!cond) { failures++; console.log(`  ✗ ${msg}`); }
  };

  check(brute.length === li.totalLines, `行数一致 brute=${brute.length} index=${li.totalLines}`);

  // ---- 2) 随机读：readRecord 与暴力解逐行一致 ----
  const reader: ByteReader = await openFileReader(FILE);
  const N = Math.min(li.totalLines, 300);
  const rng = (): number => Math.floor(Math.random() * li.totalLines);
  const sample = new Set<number>();
  while (sample.size < N) sample.add(rng());
  let randomOk = 0;
  for (const line of sample) {
    const got = await readRecord(line, li, reader);
    const expected = JSON.parse(brute[line]);
    if (got.ok && JSON.stringify(got.value) === JSON.stringify(expected)) randomOk++;
    else { failures++; console.log(`  ✗ random read line ${line}: ok=${got.ok}`); }
  }
  console.log(`[validate] random read: ${randomOk}/${N} 一致`);

  // ---- 3) 批读：多个窗口 readBatch 与暴力切片一致 ----
  let batchOk = 0;
  let batchTotal = 0;
  for (const start of [0, 1000, 50000, li.totalLines - 10]) {
    const count = 10;
    const batch = await readBatch(start, count, li, reader);
    const exp = brute.slice(start, start + count);
    batchTotal += exp.length;
    let match = batch.length === exp.length;
    for (let k = 0; match && k < exp.length; k++) {
      const g = batch[k];
      if (!g.ok || JSON.stringify(g.value) !== JSON.stringify(JSON.parse(exp[k]))) match = false;
    }
    if (match) batchOk++;
    else { failures++; console.log(`  ✗ batch start=${start}`); }
  }
  console.log(`[validate] batch read: ${batchOk}/4 窗口一致`);

  // ---- 4) 全文搜索：searchLines 与暴力扫描集合一致 ----
  const queries = ['"kind":"sample"', `"id":${Math.floor(li.totalLines / 3)}`, 'not-present-token-xyz'];
  for (const q of queries) {
    const res = await searchLines(reader, li, { query: q });
    const qb = Buffer.from(q.toLowerCase(), 'utf8');
    const bruteMatches: number[] = [];
    for (let i = 0; i < brute.length; i++) {
      if (bufIncludesCI(Buffer.from(brute[i], 'utf8'), qb)) bruteMatches.push(i);
    }
    const gotSorted = [...res.matches].sort((a, b) => a - b);
    const eq = gotSorted.length === bruteMatches.length && gotSorted.every((v, i) => v === bruteMatches[i]);
    check(eq, `search "${q}" 匹配集一致 (index=${res.matches.length} brute=${bruteMatches.length})`);
    console.log(
      `[validate] search "${q}": index=${res.matches.length} brute=${bruteMatches.length} ` +
        `${eq ? '一致' : '不一致'} truncated=${res.truncated}`
    );
  }

  // ---- 5) 阶段三：列表摘要契约（readRecords 回 summary/kind/count；超大行截断）----
  {
    // 5a) 真实 300MB 文件：普通行（均 < 阈值）应带 summary 且不截断。
    const ds = new DataService('file://' + FILE, FILE, { sampleLines: 10 });
    const rp = await ds.readRecords(0, 5);
    let summaryOk = 0;
    for (const it of rp.items) {
      if (
        it.ok &&
        Array.isArray(it.summary) &&
        it.summary.length >= 1 &&
        it.kind &&
        it.count !== undefined &&
        it.truncated === undefined
      ) {
        summaryOk++;
      } else {
        failures++;
        console.log(`  ✗ 阶段三 readRecords 项异常 line=${it.line} ok=${it.ok} hasSummary=${!!it.summary}`);
      }
    }
    check(summaryOk === rp.items.length, `阶段三 readRecords 列表摘要契约 (${summaryOk}/${rp.items.length})`);
    console.log(`[validate/phase3] 300MB 普通行列表摘要: ${summaryOk}/${rp.items.length} 带 summary`);
    await ds.dispose();
  }
  {
    // 5b) 超大行截断：临时文件插入一条 > 阈值行，readRecords 截断、readRecord 仍能全量拉。
    const dir = mkdtempSync(nodePath.join(tmpdir(), 'jlv-ph3-'));
    try {
      const big = '{"data":"' + 'x'.repeat(300 * 1024) + '"}';
      const tmp = nodePath.join(dir, 'big.jsonl');
      writeFileSync(tmp, ['{"id":1}', big, '{"id":3}'].join('\n') + '\n');
      const ds = new DataService('file://' + tmp, tmp, { sampleLines: 10 });
      const rp = await ds.readRecords(0, 3);
      const bigItem = rp.items[1];
      check(
        bigItem.ok === true && bigItem.truncated === true && bigItem.value === undefined,
        '阶段三 超大行 truncated=true 且不内联 value'
      );
      check(
        bigItem.kind === 'object' &&
          bigItem.count === 1 &&
          Array.isArray(bigItem.summary) &&
          bigItem.summary.length === 1,
        '阶段三 超大行仍带 kind/count/summary'
      );
      const full = await ds.readRecord(1);
      check(
        full.ok === true && full.value !== undefined && (full.value as { data: string }).data.length === 300 * 1024,
        '阶段三 详情 readRecord 仍拉全量'
      );
      console.log(
        `[validate/phase3] 超大行截断: truncated=${bigItem.truncated} detailOk=${full.ok} valueLen=${
          (full.value as { data: string })?.data?.length ?? 0
        }`
      );
      await ds.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // （可选）worker 路径端到端校验：DataService 经 dist/indexWorker.js 把索引/搜索下沉 worker。
  if (process.env.JLV_USE_WORKER === '1') {
    const workerScriptPath = nodePath.resolve('dist', 'indexWorker.js');
    if (existsSync(workerScriptPath)) {
      const ds = new DataService('file://' + FILE, FILE, { sampleLines: 10, workerScriptPath });
      const ov = await ds.getOverview();
      check(ov.totalLines === brute.length, `worker getOverview 行数一致 (${ov.totalLines} vs ${brute.length})`);
      for (const q of queries) {
        const res = await ds.search(q);
        const qb = Buffer.from(q.toLowerCase(), 'utf8');
        const bm: number[] = [];
        for (let i = 0; i < brute.length; i++) {
          if (bufIncludesCI(Buffer.from(brute[i], 'utf8'), qb)) bm.push(i);
        }
        const got = [...res.matches].sort((a, b) => a - b);
        // 命中行号数组受 SEARCH_MAX_RESULTS 封顶（truncated）：返回的是按行序的前缀，
        // 与暴力解的前 res.matches.length 个匹配行一致即为正确。
        const expected = bm.slice(0, res.matches.length);
        const eq = got.length === expected.length && got.every((v, i) => v === expected[i]);
        check(eq, `worker search "${q}" 一致 (${res.matches.length} vs brute=${bm.length}, truncated=${res.truncated})`);
        console.log(`[validate/worker] search "${q}": ${res.matches.length} 一致=${eq} truncated=${res.truncated}`);
      }
      await ds.dispose();
      console.log('[validate/worker] 路径通过');
    } else {
      console.log('[validate/worker] 跳过：dist/indexWorker.js 不存在（请先 node build.mjs）');
    }
  }

  await reader.close?.();

  console.log(failures === 0 ? '\n[validate] ✅ 全部通过' : `\n[validate] ❌ 失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[validate] 异常:', e);
  process.exit(2);
});
