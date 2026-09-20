/**
 * audit-stability.ts — 稳定性/可用性探针（一次性审计脚本，非交付测试）。
 *
 * 目的：把「读代码推断」换成「实测取证」。对每组边界条件构造真实文件，
 * 观察系统是「优雅降级」还是「挂起 / 抛错 / 静默失败」。
 *
 * 运行：`node scripts/audit-stability.ts`
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataService } from '../src/host/dataService.ts';
import { buildIndexWithFallback } from '../src/host/indexHost.ts';
import { parseJsonLine } from '../src/parser/jsonParser.ts';

let failures = 0;
const findings: string[] = [];

function pass(msg: string): void {
  console.log(`  ✅ ${msg}`);
}
function fail(msg: string, detail?: string): void {
  failures++;
  findings.push(msg + (detail ? ` — ${detail}` : ''));
  console.log(`  ❌ ${msg}${detail ? `\n      ↳ ${detail}` : ''}`);
}

async function tmpFile(lines: string[], name = 'data.jsonl'): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'jlv-audit-'));
  const file = join(dir, name);
  await writeFile(file, lines.join('\n'));
  return { dir, file };
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | 'TIMEOUT'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<'TIMEOUT'>((res) => {
    timer = setTimeout(() => res('TIMEOUT'), ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    if (timer) clearTimeout(timer);
    void label;
  }
}

async function main(): Promise<void> {
  console.log('\n================ 稳定性/可用性审计探针 ================\n');

  /* ---------- A. worker 脚本缺失 → 是否回退主线程（决定插件是否彻底不可用） ---------- */
  console.log('[A] worker 脚本缺失时的降级行为（最关键：决定插件是否"完全打不开"）');
  {
    const { dir, file } = await tmpFile(['{"a":1}', '{"a":2}'], 'w.jsonl');
    const bogus = '/definitely/not/exists/indexWorker.js';
    try {
      // A1) 底层契约：buildIndexWithFallback 应在 worker 加载失败后自动回退主线程。
      const built = await withTimeout(buildIndexWithFallback(bogus, file), 8000, 'fallback-build');
      if (built === 'TIMEOUT') {
        fail('worker 缺失时 buildIndexWithFallback 挂起（>8s）', '插件将完全不可用');
      } else {
        if (built.fellBack) pass('buildIndexWithFallback 已回退主线程（fellBack=true）');
        else fail('worker 缺失但未回退主线程', `kind=${built.host.kind}`);
        if (built.result.index.totalLines === 2) {
          pass(`回退后索引正确（行数=${built.result.index.totalLines}）`);
        } else {
          fail('回退后索引行数异常', `totalLines=${built.result.index.totalLines}`);
        }
        await built.host.dispose().catch(() => {});
      }

      // A2) 用户可见契约：DataService 配了坏 worker 路径，仍必须能正常打开文件。
      const ds = new DataService('file:///w', file, { sampleLines: 5, workerScriptPath: bogus });
      const ov = await withTimeout(ds.getOverview(), 8000, 'ds-overview');
      if (ov === 'TIMEOUT') {
        fail('DataService 配坏 worker 路径时 getOverview 挂起');
      } else if (ov.totalLines === 2) {
        pass('DataService 配坏 worker 路径仍可正常打开（端到端回退生效）');
      } else {
        fail('DataService 配坏 worker 路径返回异常', `totalLines=${ov.totalLines}`);
      }
      const pr = await ds.readRecords(0, 2);
      if (pr.items.length === 2) pass('回退后 readRecords 正常');
      else fail('回退后 readRecords 异常', `items=${pr.items.length}`);
      await ds.dispose();
    } catch (e) {
      fail(
        'worker 缺失 → 未回退主线程（插件彻底不可用）',
        e instanceof Error ? e.message : String(e)
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /* ---------- B. 空文件 / 仅换行 ---------- */
  console.log('\n[B] 空文件与纯换行文件');
  {
    const dir = await mkdtemp(join(tmpdir(), 'jlv-audit-'));
    const empty = join(dir, 'empty.jsonl');
    const newlines = join(dir, 'nl.jsonl');
    try {
      await writeFile(empty, '');
      await writeFile(newlines, '\n\n\n');
      const dsE = new DataService('file:///e', empty, { sampleLines: 5 });
      const ovE = await dsE.getOverview();
      if (ovE.totalLines === 0) pass(`空文件 getOverview.totalLines=0`);
      else fail('空文件行数不为 0', `totalLines=${ovE.totalLines}`);
      const pr = await dsE.readRecords(0, 10);
      if (pr.items.length === 0) pass('空文件 readRecords 返回空批，不抛错');
      else fail('空文件 readRecords 返回了记录', `items=${pr.items.length}`);
      const f = await dsE.getSampleFields();
      pass(`空文件 getSampleFields 未抛错（fields=${f.fields.length}）`);
      await dsE.dispose();

      const dsN = new DataService('file:///n', newlines, { sampleLines: 5 });
      const ovN = await dsN.getOverview();
      if (ovN.totalLines === 3) pass('纯换行文件行数正确（3）');
      else fail('纯换行文件行数异常', `totalLines=${ovN.totalLines}`);
      await dsN.dispose();
    } catch (e) {
      fail('空文件/纯换行处理抛错', e instanceof Error ? e.message : String(e));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /* ---------- C. UTF-8 BOM（首行易被误判为坏行） ---------- */
  console.log('\n[C] UTF-8 BOM 文件（Windows 记事本另存常见）');
  {
    const dir = await mkdtemp(join(tmpdir(), 'jlv-audit-'));
    const file = join(dir, 'bom.jsonl');
    try {
      await writeFile(file, '\uFEFF{"a":1}\n{"a":2}\n');
      const ds = new DataService('file:///b', file, { sampleLines: 5 });
      const p = await ds.readRecords(0, 2);
      const first = p.items[0];
      if (first?.ok === true) pass('BOM 首行解析成功');
      else fail('BOM 首行被误判为坏行', `ok=${first?.ok} error=${first?.error}`);
      await ds.dispose();
    } catch (e) {
      fail('BOM 文件处理抛错', e instanceof Error ? e.message : String(e));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /* ---------- D. 深层嵌套 JSON（栈溢出向量） ---------- */
  console.log('\n[D] 深层嵌套 JSON（潜在栈溢出）');
  {
    const deep = '['.repeat(5000) + '1' + ']'.repeat(5000);
    const parsed = parseJsonLine(deep);
    if (parsed.ok) pass('宿主 parseJsonLine 深嵌套 5000 层未崩溃');
    else pass(`宿主 parseJsonLine 对深嵌套优雅降级（ok=false, ${parsed.error.slice(0, 40)}…）`);

    const { dir, file } = await tmpFile([deep, '{"a":1}'], 'deep.jsonl');
    try {
      const ds = new DataService('file:///d', file, { sampleLines: 5 });
      const p = await ds.readRecords(0, 2);
      const it0 = p.items[0];
      pass(`深嵌套行走 readRecords 未崩溃（ok=${it0.ok} truncated=${it0.truncated ?? false}）`);
      const p2 = await ds.readRecords(1, 1);
      if (p2.items[0]?.ok === true) pass('深嵌套文件后续行仍可正常读取（未污染索引）');
      else fail('深嵌套行影响后续行读取', `ok=${p2.items[0]?.ok}`);
      await ds.dispose();
    } catch (e) {
      fail('深嵌套 JSON 导致宿主抛错', e instanceof Error ? e.message : String(e));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /* ---------- E. 非法/越界参数（防御性） ---------- */
  console.log('\n[E] 非法与越界参数');
  {
    const { dir, file } = await tmpFile(['{"a":1}', '{"a":2}'], 'p.jsonl');
    try {
      const ds = new DataService('file:///p', file, { sampleLines: 5 });
      await ds.getOverview();
      const cases: Array<[string, () => Promise<unknown>]> = [
        ['readRecords(NaN, 1)', () => ds.readRecords(Number.NaN, 1)],
        ['readRecords(-1, 1)', () => ds.readRecords(-1, 1)],
        ['readRecords(0, 0)', () => ds.readRecords(0, 0)],
        ['readRecords(0, -5)', () => ds.readRecords(0, -5)],
        ['readRecords(1e9, 10)', () => ds.readRecords(1e9, 10)],
        ['readRecords(0, 1e9)', () => ds.readRecords(0, 1_000_000_000)],
        ['readRecord(1e9)', () => ds.readRecord(1e9)],
        ['readRecord(-1)', () => ds.readRecord(-1)],
      ];
      for (const [label, run] of cases) {
        try {
          const r = await withTimeout(run(), 4000, label);
          if (r === 'TIMEOUT') fail(`${label} 挂起（>4s）`);
          else pass(`${label} 正常返回`);
        } catch (e) {
          fail(`${label} 抛错`, e instanceof Error ? e.message : String(e));
        }
      }
      await ds.dispose();
    } catch (e) {
      fail('非法参数组前置失败', e instanceof Error ? e.message : String(e));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /* ---------- F. readRecords(0, 巨大count) 的实际代价 ---------- */
  console.log('\n[F] readRecords 超大批量（防御性上限缺失会否一次吞全文件）');
  {
    const lines: string[] = [];
    for (let i = 0; i < 20000; i++) lines.push(`{"id":${i}}`);
    const { dir, file } = await tmpFile(lines, 'many.jsonl');
    try {
      const ds = new DataService('file:///m', file, { sampleLines: 5 });
      const t0 = Date.now();
      const r = await ds.readRecords(0, 1_000_000);
      const ms = Date.now() - t0;
      if (r.items.length === 20000) {
        fail(
          'readRecords 无批量上限：一次请求可解析并回传整个文件',
          `请求 1e6 → 实际返回 ${r.items.length} 条，耗时 ${ms}ms（webview 端将整批序列化/缓存）`
        );
      } else {
        pass(`readRecords 有批量上限（返回 ${r.items.length} 条，${ms}ms）`);
      }
      await ds.dispose();
    } catch (e) {
      fail('超大批量 readRecords 抛错', e instanceof Error ? e.message : String(e));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /* ---------- G. dispose 之后再调用（生命周期误用） ---------- */
  console.log('\n[G] dispose 后再调用接口');
  {
    const { dir, file } = await tmpFile(['{"a":1}'], 'l.jsonl');
    try {
      const ds = new DataService('file:///l', file, { sampleLines: 5 });
      await ds.getOverview();
      await ds.dispose();
      try {
        const r = await withTimeout(ds.search('a'), 4000, 'search-after-dispose');
        if (r === 'TIMEOUT') fail('dispose 后 search 挂起（>4s）');
        else pass('dispose 后 search 未抛错（已自愈重建）');
      } catch (e) {
        fail('dispose 后 search 抛错（调用方需自行兜底）', e instanceof Error ? e.message : String(e));
      }
      await ds.dispose();
    } catch (e) {
      fail('dispose 组前置失败', e instanceof Error ? e.message : String(e));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /* ---------- H. 文件在打开后被删除/替换 ---------- */
  console.log('\n[H] 索引构建后文件被删除');
  {
    const { dir, file } = await tmpFile(['{"a":1}', '{"a":2}'], 'del.jsonl');
    try {
      const ds = new DataService('file:///del', file, { sampleLines: 5 });
      await ds.getOverview();
      await rm(file, { force: true });
      const stale = await ds.checkStale();
      if (stale?.changed === true && stale.deleted === true) pass('文件删除被 checkStale 检出');
      else fail('文件删除未被检出', JSON.stringify(stale));
      try {
        const r = await withTimeout(ds.readRecords(0, 2), 4000, 'read-after-delete');
        if (r === 'TIMEOUT') fail('文件删除后 readRecords 挂起');
        else pass('文件删除后 readRecords 仍走已建索引（句柄有效），未崩溃');
      } catch (e) {
        pass(`文件删除后 readRecords 抛错但被调用方可见（${e instanceof Error ? e.message : String(e)}）`);
      }
      await ds.dispose();
    } catch (e) {
      fail('文件删除组抛错', e instanceof Error ? e.message : String(e));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /* ---------- I. 非 UTF-8（GBK）编码 ---------- */
  console.log('\n[I] GBK 编码文件（是否给出可理解的失败）');
  {
    const dir = await mkdtemp(join(tmpdir(), 'jlv-audit-'));
    const file = join(dir, 'gbk.jsonl');
    try {
      // "中文" 的 GBK 字节，放进字符串值里
      const gbk = Buffer.concat([
        Buffer.from('{"msg":"'),
        Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
        Buffer.from('"}'),
      ]);
      await writeFile(file, Buffer.concat([gbk, Buffer.from('\n'), Buffer.from('{"msg":"ok"}\n')]));
      const ds = new DataService('file:///g', file, { sampleLines: 5 });
      const p = await ds.readRecords(0, 2);
      const it0 = p.items[0];
      if (it0?.ok === false) {
        pass(`GBK 行被判为非法（error="${it0.error?.slice(0, 50)}"）——但无"编码"提示，用户可能困惑`);
      } else {
        pass('GBK 行被容错解析（乱码但未报错）');
      }
      const ov = await ds.getOverview();
      pass(`GBK 文件整体未崩溃（totalLines=${ov.totalLines}）`);
      await ds.dispose();
    } catch (e) {
      fail('GBK 文件导致宿主抛错', e instanceof Error ? e.message : String(e));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /* ---------- J. 文件权限不可读 ---------- */
  console.log('\n[J] 不存在的路径 / 目录路径');
  {
    const ds = new DataService('file:///nope', join(tmpdir(), 'jlv-not-exist-xyz.jsonl'), { sampleLines: 5 });
    try {
      await withTimeout(ds.getOverview(), 4000, 'overview-missing');
      fail('不存在的文件 getOverview 未抛错（应向上抛出以便 UI 提示）');
    } catch {
      pass('不存在的文件 getOverview 抛错（调用方可捕获并提示）');
    }
    const ds2 = new DataService('file:///dir', tmpdir(), { sampleLines: 5 });
    try {
      const r = await withTimeout(ds2.getOverview(), 4000, 'overview-dir');
      if (r === 'TIMEOUT') fail('对目录路径 getOverview 挂起');
      else pass('对目录路径 getOverview 返回结果（可能为空索引）');
    } catch (e) {
      pass(`对目录路径 getOverview 抛错（${e instanceof Error ? e.message.slice(0, 40) : ''}）`);
    }
  }

  /* ---------- 汇总 ---------- */
  console.log('\n================ 审计结论 ================');
  if (failures === 0) {
    console.log('✅ 未发现稳定性缺陷');
  } else {
    console.log(`❌ 发现 ${failures} 项需处理：`);
    findings.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[audit] 探针自身异常:', e);
  process.exit(2);
});
