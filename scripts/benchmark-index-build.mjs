/**
 * benchmark-index-build.mjs — LineIndex.build 吞吐基准（self-improve 回路专用，密封文件）。
 *
 * 做两件事：
 *   1) 正确性闸门：用内嵌的参考实现（原版逐字节状态机）对多种边界夹具做差分比对，
 *      包含随机分块切分；任何不一致 → primary=0 且退出码 1。
 *   2) 吞吐测量：对 ~16MB 确定性夹具（零拷贝 1MiB 分块）重复构建，取中位数 MB/s。
 *
 * 输出：最后一行为 JSON，如 {"primary": 512.3, "sub_scores": {...}}。
 * 运行：node scripts/benchmark-index-build.mjs
 */

import { performance } from 'node:perf_hooks';
import { LineIndex } from '../src/indexer/lineIndex.ts';

const INTERVAL = 1024;
const CHUNK = 1024 * 1024;
const FIXTURE_BYTES = 16 * 1024 * 1024;
const RUNS = 60;
const WARMUPS = 4;

// ---------- 确定性 PRNG ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 参考实现（原版 build 的逐字节状态机，勿改） ----------
function referenceBuild(chunks, interval = INTERVAL) {
  const checkpoints = [];
  let line = 0;
  let startOff = 0;
  let totalBytes = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lineHasContent = false;
  let sawMultiline = false;
  const recordEndLines = [];
  const recordEndOffsets = [];
  for (const buf of chunks) {
    const n = buf.length;
    const chunkBase = totalBytes;
    for (let i = 0; i < n; i++) {
      const b = buf[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (b === 0x5c) escaped = true;
        else if (b === 0x22) inString = false;
        continue;
      }
      switch (b) {
        case 0x22:
          inString = true;
          lineHasContent = true;
          break;
        case 0x7b:
        case 0x5b:
          depth++;
          lineHasContent = true;
          break;
        case 0x7d:
        case 0x5d:
          if (depth > 0) depth--;
          lineHasContent = true;
          break;
        case 0x0a: {
          if (line % interval === 0) checkpoints.push({ line, offset: startOff });
          if (depth === 0 && !inString) {
            if (lineHasContent) {
              recordEndLines.push(line);
              recordEndOffsets.push(chunkBase + i + 1);
            } else {
              sawMultiline = true;
            }
          } else {
            sawMultiline = true;
          }
          line++;
          startOff = chunkBase + i + 1;
          lineHasContent = false;
          break;
        }
        default:
          if (b !== 0x20 && b !== 0x09 && b !== 0x0d) lineHasContent = true;
          break;
      }
    }
    totalBytes += n;
  }
  if (startOff < totalBytes) {
    if (line % interval === 0) checkpoints.push({ line, offset: startOff });
    if (depth > 0 || inString) sawMultiline = true;
    if (lineHasContent || depth > 0 || inString) {
      recordEndLines.push(line);
      recordEndOffsets.push(totalBytes);
    }
    line++;
  } else if (depth > 0 || inString) {
    sawMultiline = true;
    recordEndLines.push(line - 1);
    recordEndOffsets.push(totalBytes);
  }
  const multiline = sawMultiline || recordEndLines.length !== line;
  return {
    checkpoints,
    totalBytes,
    totalLines: line,
    multiline,
    recordEndLines: multiline ? recordEndLines : undefined,
    recordEndOffsets: multiline ? recordEndOffsets : undefined,
    endsWithNewline: startOff === totalBytes,
  };
}

function snapshot(li) {
  return {
    checkpoints: li.checkpoints.map((c) => ({ line: c.line, offset: c.offset })),
    totalBytes: li.totalBytes,
    totalLines: li.totalLines,
    multiline: li.multiline,
    recordEndLines: li.recordEndLines ? Array.from(li.recordEndLines) : undefined,
    recordEndOffsets: li.recordEndOffsets ? Array.from(li.recordEndOffsets) : undefined,
    endsWithNewline: li.endsWithNewline,
  };
}

function sameSnapshot(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function splitRandom(buf, rnd, maxChunk) {
  const out = [];
  let p = 0;
  while (p < buf.length) {
    const n = Math.max(1, Math.floor(rnd() * maxChunk));
    out.push(buf.subarray(p, Math.min(buf.length, p + n)));
    p += n;
  }
  return out;
}

// ---------- 夹具 ----------
function compactLine(i, rnd) {
  const k = Math.floor(rnd() * 6);
  switch (k) {
    case 0:
      return `{"id":${i},"name":"row-${i}","ok":${i % 5 !== 0}}\n`;
    case 1:
      return `{"id":${i},"meta":{"batch":${i},"tags":["alpha","beta","gamma"],"desc":"${'x'.repeat(
        200 + Math.floor(rnd() * 300)
      )}"}}\n`;
    case 2:
      return `{"id":${i},"text":"he said \\"hi {not a brace} [nor this]\\" \\\\ ok","n":${i * 7}}\n`;
    case 3:
      return `{"id":${i},"arr":[${Array.from({ length: 20 }, (_, j) => j * i).join(',')}]}\n`;
    case 4:
      return `{"id":${i},"nested":{"a":{"b":{"c":[1,2,{"d":"e"}]}}},"s":"${'y'.repeat(
        Math.floor(rnd() * 80)
      )}"}\n`;
    default:
      return `{"id":${i},"u":"\\u00e9\\u4e2d","pad":"${'z'.repeat(Math.floor(rnd() * 600))}"}\n`;
  }
}

function buildBigFixture(totalBytes) {
  const rnd = mulberry32(12345);
  const parts = [];
  let size = 0;
  let i = 0;
  while (size < totalBytes) {
    const s = Buffer.from(compactLine(i++, rnd), 'utf8');
    parts.push(s);
    size += s.length;
  }
  return Buffer.concat(parts, size);
}

function edgeFixtures() {
  const rnd = mulberry32(777);
  const L = (s) => Buffer.from(s, 'utf8');
  const fx = [];
  fx.push(['empty', L('')]);
  fx.push(['single-nl', L('\n')]);
  fx.push(['compact-nl', L('{"a":1}\n{"b":2}\n')]);
  fx.push(['compact-no-final-nl', L('{"a":1}\n{"b":2}')]);
  fx.push(['crlf', L('{"a":1}\r\n{"b":2}\r\n{"c":3}\r\n')]);
  fx.push(['empty-lines', L('{"a":1}\n\n\n{"b":2}\n   \n\t\n{"c":3}\n')]);
  fx.push(['pretty', L('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}\n{\n  "c": "x"\n}\n')]);
  fx.push(['string-with-nl-escape', L('{"a":"line1\\nline2"}\n{"b":"\\\\"}\n{"c":"\\""}\n')]);
  fx.push(['dangling-object', L('{"a":1}\n{"b":[1,2\n')]);
  fx.push(['dangling-string', L('{"a":1}\n{"b":"unterminated\n')]);
  fx.push(['dangling-string-eof-no-nl', L('{"a":1}\n{"b":"unterminated')]);
  fx.push(['unbalanced-closers', L('}]\n{"a":1}\n]]]\n')]);
  fx.push(['raw-newline-in-string', L('{"a":"x\ny"}\n{"b":2}\n')]);
  fx.push(['scalars', L('1\n"two"\ntrue\nnull\n[1,2]\n')]);
  fx.push(['whitespace-only-tail', L('{"a":1}\n   ')]);
  // 随机混合：压 interval 边界（>2048 行）与各种形态
  const parts = [];
  for (let i = 0; i < 5000; i++) {
    const r = rnd();
    if (r < 0.05) parts.push('\n');
    else if (r < 0.1) parts.push(`{\n  "id": ${i},\n  "v": [1,\n 2]\n}\n`);
    else if (r < 0.15) parts.push(`{"id":${i},"s":"a\\"b}c"}\r\n`);
    else parts.push(compactLine(i, rnd));
  }
  fx.push(['random-mixed', L(parts.join(''))]);
  // 纯紧凑、跨多个检查点间隔
  const compact = [];
  for (let i = 0; i < 5000; i++) compact.push(compactLine(i, rnd));
  fx.push(['compact-5000', L(compact.join(''))]);
  return fx;
}

async function correctnessGate() {
  const rnd = mulberry32(2024);
  let cases = 0;
  for (const [name, buf] of edgeFixtures()) {
    const splits = [
      [buf],
      splitRandom(buf, rnd, 1),
      splitRandom(buf, rnd, 7),
      splitRandom(buf, rnd, 64),
      splitRandom(buf, rnd, 1000),
      splitRandom(buf, rnd, 100000),
    ];
    // 小间隔也要对：把边界逻辑压得更紧
    for (const interval of [INTERVAL, 1, 3]) {
      const expected = referenceBuild(splits[0], interval);
      for (const chunks of splits) {
        const li = await LineIndex.build(chunks, { checkpointInterval: interval });
        const got = snapshot(li);
        cases++;
        if (!sameSnapshot(got, expected)) {
          return {
            ok: false,
            detail: `fixture=${name} interval=${interval} chunks=${chunks.length}`,
            cases,
          };
        }
      }
    }
  }
  // 字符串型 chunk 也要被接受（原实现 Buffer.from(string)）
  const sLi = await LineIndex.build(['{"a":1}\n', '{"b":2}\n']);
  if (sLi.totalLines !== 2 || sLi.totalBytes !== 16) {
    return { ok: false, detail: 'string chunks', cases };
  }
  return { ok: true, cases };
}

function median(xs) {
  const s = xs.toSorted((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main() {
  const gate = await correctnessGate();
  if (!gate.ok) {
    console.error(`[benchmark] 正确性闸门失败: ${gate.detail}`);
    console.log(JSON.stringify({ primary: 0, sub_scores: { correctness: 0 } }));
    process.exit(1);
  }
  console.error(`[benchmark] 正确性闸门通过 (${gate.cases} 组差分比对)`);

  const big = buildBigFixture(FIXTURE_BYTES);
  const chunks = [];
  for (let p = 0; p < big.length; p += CHUNK)
    chunks.push(big.subarray(p, Math.min(big.length, p + CHUNK)));

  // 大夹具也做一次差分（单次，不计时）
  const refBig = referenceBuild(chunks);
  const warm = await LineIndex.build(chunks);
  if (!sameSnapshot(snapshot(warm), refBig)) {
    console.error('[benchmark] 大夹具与参考实现不一致');
    console.log(JSON.stringify({ primary: 0, sub_scores: { correctness: 0 } }));
    process.exit(1);
  }

  const mb = big.length / 1048576;
  // 预热：让 JIT 稳定、页缓存就绪（不计入成绩）。
  for (let w = 0; w < WARMUPS; w++) {
    await LineIndex.build(chunks);
    referenceBuild(chunks);
  }
  // 成对交错测量：每轮「参考实现 vs 当前实现」背靠背计时（奇偶轮交换先后），
  // 两者处在同一机器状态（降频 / 后台负载），取逐轮比值的中位数 → 噪声大幅抵消。
  // primary = 当前实现相对「原版逐字节状态机」的加速比（原版 = 1.0）。
  const ratios = [];
  const speeds = [];
  const refSpeeds = [];
  const timeCur = async () => {
    const t0 = performance.now();
    const li = await LineIndex.build(chunks);
    const ms = performance.now() - t0;
    if (li.totalLines !== refBig.totalLines) {
      console.log(JSON.stringify({ primary: 0, sub_scores: { correctness: 0 } }));
      process.exit(1);
    }
    return ms;
  };
  const timeRef = () => {
    const t0 = performance.now();
    referenceBuild(chunks);
    return performance.now() - t0;
  };
  for (let r = 0; r < RUNS; r++) {
    let curMs;
    let refMs;
    if (r % 2 === 0) {
      refMs = timeRef();
      curMs = await timeCur();
    } else {
      curMs = await timeCur();
      refMs = timeRef();
    }
    ratios.push(refMs / curMs);
    speeds.push(mb / (curMs / 1000));
    refSpeeds.push(mb / (refMs / 1000));
  }
  const primary = Number(median(ratios).toFixed(3));
  console.error(
    `[benchmark] fixture=${mb.toFixed(1)}MB lines=${refBig.totalLines} ratios=${ratios
      .map((s) => s.toFixed(2))
      .join(',')}`
  );
  console.log(
    JSON.stringify({
      primary,
      sub_scores: {
        correctness: 1,
        cur_median_mb_s: Number(median(speeds).toFixed(2)),
        ref_median_mb_s: Number(median(refSpeeds).toFixed(2)),
        min_ratio: Number(Math.min(...ratios).toFixed(3)),
        max_ratio: Number(Math.max(...ratios).toFixed(3)),
      },
    })
  );
}

main().catch((e) => {
  console.error('[benchmark] 异常:', e);
  console.log(JSON.stringify({ primary: 0, sub_scores: { correctness: 0 } }));
  process.exit(2);
});
