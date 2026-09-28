/**
 * dataServiceHostSync.test.ts — 「写 → 搜索」一致性与宿主生命周期防线（批次 0：O1 + O2）。
 *
 * 背景（此处的注释是**缺陷的形状**，务必读完再改测试）：
 *   行索引在进程内有**两份实例** —— `DataService.index`（随机读 / 编辑定位用）与
 *   `IndexHost` 内部那份（`search` / `filter` 唯独用它）。编辑原先只 patch 前者，
 *   后者的检查点自 `build()` 之后再没更新过：
 *     - 增删行后，宿主的 `totalLines` 仍是旧值 → 新插入的行**搜不到**；
 *     - 变长编辑后，其后每个检查点的 offset 都失配 → 从该检查点起的行号**整体偏移**
 *       （不报错，只是悄悄给错行号）；
 *     - 而 `replaceText` 的第一步恰恰是 `search()` → 错误行号会被直接写进磁盘。
 *   另一面：`rebuildIndex()` 覆写 `this.host` 前未 dispose 旧宿主，worker 与文件句柄泄漏。
 *
 * 因此本文件的用例全部是「**先编辑、再查询、然后逐字节核对磁盘**」的形态：
 * 单看编辑、或单看查询都正确，只有两者相连才暴露 —— 这正是缺陷能潜伏至今的原因。
 * 每个用例在设计上都**必须能通过改动 `stageIndexOps`/`rebuildIndex` 而失败**。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataService, type DataServiceOptions, type IndexHostBuilder } from '../dataService.ts';
import { buildIndexWithFallback } from '../indexHost.ts';
import { MainThreadIndexHost, WorkerIndexHost, type IndexHost } from '../indexHost.ts';
import type { BuildResult } from '../workerProtocol.ts';
import type { IndexDeltaOp } from '../../indexer/lineIndex.ts';
import type { WorkerRequest, WorkerResponse } from '../workerProtocol.ts';
import type { WorkerLike } from '../indexHost.ts';

/** 检查点间隔 —— 只有跨过第二个检查点，offset 失配才会表现为「行号整体偏移」。 */
const CHECKPOINT_INTERVAL = 1024;

async function writeFile_(dir: string, lines: string[]): Promise<string> {
  const file = join(dir, 'data.jsonl');
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

function makeService(file: string, opts: DataServiceOptions = {}): DataService {
  return new DataService('file:///test.jsonl', file, { sampleLines: 10, ...opts });
}

/** 构造 N 行唯一标记的紧凑 JSONL：`{"i":3,"tok":"t3"}`，偶/奇行带不同 status。 */
function makeLines(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `{"i":${i},"tok":"t${i}"}`);
}

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-hostsync-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('O1：变长编辑后，其后（跨检查点）的行仍是原行号可搜到', async () => {
  await withDir(async (dir) => {
    // 行数必须越过第二个检查点：否则索引里只有 {line:0} 一个锚点，offset 失配不显形。
    const n = CHECKPOINT_INTERVAL + 76;
    const file = await writeFile_(dir, makeLines(n));
    const ds = makeService(file);
    try {
      await ds.getOverview();

      // 在第 5 行做一次**变长**编辑（+80 字节）：其后所有行的真实偏移整体右移。
      const long = JSON.stringify({ i: 5, tok: 't5', pad: 'x'.repeat(60) });
      const res = await ds.editRecord(5, long);
      assert.equal(res.ok, true, res.error ?? '');
      assert.notEqual(res.bytesDelta, 0, '本用例依赖「长度发生变化」的编辑');

      // 命中必须精确落在第 1099 行（旧实现会给出 1100 —— 行号整体偏移一位）。
      const target = n - 1;
      const found = await ds.search(`t${target}`);
      assert.deepEqual(found.matches, [target], `搜索结果的形=${found.matches}`);

      // 反向校准：该行内容确为期望值（排除「行号对了但读的是别行」的可能）。
      const rec = await ds.readRecord(target);
      assert.equal(rec.ok, true);
      assert.equal((rec.value as { tok: string }).tok, `t${target}`);
    } finally {
      await ds.dispose();
    }
  });
});

test('O1：末尾插入的行能被立刻搜到（宿主不再停留在旧 totalLines）', async () => {
  await withDir(async (dir) => {
    const file = await writeFile_(dir, ['{"tok":"a"}', '{"tok":"b"}', '{"tok":"c"}']);
    const ds = makeService(file);
    try {
      await ds.getOverview();
      const ins = await ds.insertRecord(3, '{"tok":"BRAND_NEW"}');
      assert.equal(ins.ok, true, ins.error ?? '');

      const found = await ds.search('BRAND_NEW');
      assert.deepEqual(found.matches, [3], `新插入的行必须可被命中，实得=${found.matches}`);

      // 删除后再插入的复合场景：行数先 -1 再 +1，宿主必须两次都跟上。
      const del = await ds.deleteRecord(0);
      assert.equal(del.ok, true, del.error ?? '');
      const ins2 = await ds.insertRecord(2, '{"tok":"TAIL"}');
      assert.equal(ins2.ok, true, ins2.error ?? '');
      const found2 = await ds.search('TAIL');
      assert.deepEqual(found2.matches, [2], `增删复合后=${found2.matches}`);
    } finally {
      await ds.dispose();
    }
  });
});

test('O1：编辑后再「全部替换」，改动落在正确的行上（错误写盘的防线）', async () => {
  await withDir(async (dir) => {
    const n = CHECKPOINT_INTERVAL + 40;
    // 偶数行带 pending（待改），奇数行干净 —— 改动错位时会被立刻看出来。
    const lines = Array.from(
      { length: n },
      (_, i) => `{"i":${i},"status":"${i % 2 === 0 ? 'pending' : 'ok'}"}`
    );
    const file = await writeFile_(dir, lines);
    const ds = makeService(file);
    try {
      await ds.getOverview();
      // 先做一次变长编辑，把其后的检查点全部推歪。
      const pad = JSON.stringify({ i: 1, status: 'ok', pad: 'y'.repeat(50) });
      const res = await ds.editRecord(1, pad);
      assert.equal(res.ok, true, res.error ?? '');

      const rep = await ds.replaceText('pending', 'done');
      assert.equal(rep.ok, true, rep.error ?? '');

      // 逐字节核对磁盘：不得残留任何 pending（漏改），且非目标行不得被波及。
      const after = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
      const pending = after.filter((l) => l.includes('pending'));
      const done = after.filter((l) => l.includes('done'));
      assert.deepEqual(pending, [], `以下行未被替换（命中集错位）：${pending.slice(0, 3)}`);
      // 第 1 行被改成了带 pad 的那条（奇数 → ok），故偶数行的数量即替换数。
      const evenCount = Math.ceil(n / 2);
      assert.equal(done.length, evenCount, `替换行数应为 ${evenCount}，实得 ${done.length}`);
      // 奇数行（不含被编辑的第 1 行）必须原样保留 ok，没被跨行污染。
      assert.equal(after[3], '{"i":3,"status":"ok"}');
    } finally {
      await ds.dispose();
    }
  });
});

test('O1：字段过滤同样跟随编辑后的索引（过滤走的是同一份宿主索引）', async () => {
  await withDir(async (dir) => {
    const n = CHECKPOINT_INTERVAL + 20;
    const lines = Array.from({ length: n }, (_, i) => `{"tok":"t${i}","flag":${i % 2 === 0}}`);
    const file = await writeFile_(dir, lines);
    const ds = makeService(file);
    try {
      await ds.getOverview();
      const long = JSON.stringify({ tok: 't0', flag: true, pad: 'z'.repeat(40) });
      const res = await ds.editRecord(0, long);
      assert.equal(res.ok, true, res.error ?? '');

      const filtered = await ds.filter({ field: 'tok', op: 'contains', value: `t${n - 1}` });
      assert.deepEqual(
        filtered.matches,
        [n - 1],
        `过滤结果的行号必须与磁盘一致，实得=${filtered.matches}`
      );
    } finally {
      await ds.dispose();
    }
  });
});

/* ------------------------------ O2：宿主生命周期 ------------------------------ */

/** 观测型宿主：记录 dispose / build 次数，其余行为全权委派。 */
class SpyHost implements IndexHost {
  readonly kind = 'main' as const;
  disposed = 0;
  built = 0;
  private readonly inner: MainThreadIndexHost;
  /** 为 true 时让增量回填失败，用于验证「回填失败 → 查询前重建」的兜底。 */
  failOps = false;

  constructor(inner: MainThreadIndexHost) {
    this.inner = inner;
  }

  async build(path: string, onProgress?: never): Promise<BuildResult> {
    this.built += 1;
    return this.inner.build(path, onProgress);
  }
  search(...a: Parameters<MainThreadIndexHost['search']>) {
    return this.inner.search(...a);
  }
  filter(...a: Parameters<MainThreadIndexHost['filter']>) {
    return this.inner.filter(...a);
  }
  async applyIndexOps(ops: readonly IndexDeltaOp[]): Promise<void> {
    if (this.failOps) throw new Error('模拟回填失败');
    return this.inner.applyIndexOps(ops);
  }
  releaseFile() {
    return this.inner.releaseFile();
  }
  reacquireFile(path: string) {
    return this.inner.reacquireFile(path);
  }
  async dispose(): Promise<void> {
    this.disposed += 1;
    await this.inner.dispose();
  }
}

/** 宿主工厂接缝：每次构建产出一个可观测宿主（生产环境不传此参数）。 */
function spyHostFactory(record: SpyHost[]): IndexHostBuilder {
  return async (workerScriptPath: string | undefined, path: string) => {
    const built = await buildIndexWithFallback(workerScriptPath, path);
    const spy = new SpyHost(built.host as MainThreadIndexHost);
    record.push(spy);
    return { host: spy, result: built.result, fellBack: built.fellBack };
  };
}

test('O2：rebuildIndex 释放旧宿主（多次重建不累积）', async () => {
  await withDir(async (dir) => {
    // 多行（pretty）文件：批量删除在其中走「索引全量重建」分支（行号结构被破坏，无法增量平移）。
    const pretty = [
      '{',
      '  "tok": "one"',
      '}',
      '{',
      '  "tok": "two"',
      '}',
      '{',
      '  "tok": "three"',
      '}',
    ];
    const file = await writeFile_(dir, pretty);
    const hosts: SpyHost[] = [];
    const ds = makeService(file, { hostFactory: spyHostFactory(hosts) });
    try {
      await ds.getOverview();
      assert.equal(hosts.length, 1);

      // 第一次重建
      const r1 = await ds.deleteRecords([0]);
      assert.equal(r1.ok, true, r1.error ?? '');
      assert.equal(hosts.length, 2, '重建后应产生第二个宿主');
      assert.equal(hosts[0].disposed, 1, '旧宿主必须被 dispose（否则 worker/句柄泄漏）');

      // 第二次：连上一次重建出来的宿主也必须被释放
      const r2 = await ds.deleteRecords([0]);
      assert.equal(r2.ok, true, r2.error ?? '');
      assert.equal(hosts.length, 3);
      assert.equal(hosts[0].disposed, 1);
      assert.equal(hosts[1].disposed, 1, '第二次重建前，第一次重建出的宿主同样要释放');
      assert.equal(hosts[2].disposed, 0, '当前在用宿主不应被释放');
    } finally {
      await ds.dispose();
    }
  });
});

/* ------------------------- worker 路径：重建宿主的 worker 回收 ------------------------- */

/**
 * 伪 worker：记录 postMessage，并**自动 ack 无载荷类请求** —— 否则 releaseFile /
 * reacquireFile / applyIndexOps 会让调用方永久挂起（真实 worker 会回执，伪件必须同形）。
 */
class FakeWorker {
  readonly posted: WorkerRequest[] = [];
  terminated = 0;
  /**
   * 请求处理器（可选）：返回要投递回主线程的响应。
   *
   * 缺省行为只自动 ack 无载荷请求；装上处理器后，伪 worker 就变成「**协议通道是真的、
   * 计算由真引擎承担**」的替身 —— 既不必 spawn 线程，也能测出通道是否真的通了。
   */
  handler: ((m: WorkerRequest) => Promise<WorkerResponse[]>) | undefined;
  private readonly handlers: ((m: WorkerResponse) => void)[] = [];

  asWorkerLike(): WorkerLike {
    return {
      postMessage: (m: WorkerRequest) => this.post(m),
      on: (event: string, cb: unknown) => {
        if (event === 'message') this.handlers.push(cb as (m: WorkerResponse) => void);
        return this;
      },
      terminate: () => {
        this.terminated += 1;
        return Promise.resolve(0);
      },
    } as unknown as WorkerLike;
  }

  private post(m: WorkerRequest): void {
    this.posted.push(m);
    void this.handle(m);
  }

  private async handle(m: WorkerRequest): Promise<void> {
    if (this.handler) {
      for (const r of await this.handler(m)) this.deliver(r);
      return;
    }
    if (m.type === 'releaseFile' || m.type === 'reacquireFile' || m.type === 'applyIndexOps') {
      this.deliver({ type: 'ack', requestId: m.requestId });
    }
  }

  deliver(m: WorkerResponse): void {
    for (const h of this.handlers) h(m);
  }

  /** 某类请求的最近一条。 */
  lastOf(type: WorkerRequest['type']): WorkerRequest | undefined {
    return this.posted.toReversed().find((m) => m.type === type);
  }
}

/**
 * 用真索引算出 worker 应回传的 `built` 载荷，再由伪 worker 投递。
 * —— 走「真实现算数据 + 伪件走通道」的组合，既不 spawn 线程，也不用手工编造检查点。
 */
async function workerHostFactory(
  queue: FakeWorker[],
  path: string
): Promise<{ host: IndexHost; result: BuildResult; fellBack: boolean }> {
  const fake = queue.shift();
  if (!fake) {
    const host = new MainThreadIndexHost();
    return { host, result: await host.build(path), fellBack: false };
  }

  // 「worker 内部」的那份索引：真引擎，但只经消息通道对外 —— 与真实 worker 同形。
  const inside = new MainThreadIndexHost();
  const truth = await inside.build(path);
  const li = truth.index;
  const built = (requestId: number): WorkerResponse => ({
    type: 'built',
    requestId,
    checkpoints: li.checkpoints.map((c) => ({ line: c.line, offset: c.offset })),
    totalBytes: li.totalBytes,
    totalLines: li.totalLines,
    buildMs: li.buildMs,
    eof: li.eof,
    interval: li.interval,
    records: li.multiline
      ? {
          endLines: [...(li.recordEndLines as number[])],
          endOffsets: [...(li.recordEndOffsets as number[])],
        }
      : undefined,
  });

  fake.handler = async (m) => {
    switch (m.type) {
      case 'build':
        return [built(m.requestId)];
      case 'applyIndexOps':
        // 真 worker 在收到 op 后做的唯一一件事：把同一批 op 应用到自己的索引上。
        await inside.applyIndexOps(m.ops);
        return [{ type: 'ack', requestId: m.requestId }];
      case 'search':
        return [
          {
            type: 'searchResult',
            requestId: m.requestId,
            result: await inside.search(m.query, m.field, m.scope, m.maxResults),
          },
        ];
      case 'filter':
        return [
          {
            type: 'filterResult',
            requestId: m.requestId,
            result: await inside.filter(m.cond, m.maxResults),
          },
        ];
      case 'releaseFile':
        await inside.releaseFile();
        return [{ type: 'ack', requestId: m.requestId }];
      case 'reacquireFile':
        await inside.reacquireFile(m.path);
        return [{ type: 'ack', requestId: m.requestId }];
      default:
        return [];
    }
  };

  const host = new WorkerIndexHost('/fake/indexWorker.js', () => fake.asWorkerLike());
  return { host, result: await host.build(path), fellBack: false };
}

test('O2：worker 路径下每次重建都会 terminate 上一根 worker（额度不泄漏）', async () => {
  await withDir(async (dir) => {
    const pretty = [
      '{',
      '  "tok": "one"',
      '}',
      '{',
      '  "tok": "two"',
      '}',
      '{',
      '  "tok": "three"',
      '}',
    ];
    const file = await writeFile_(dir, pretty);
    const fake1 = new FakeWorker();
    const fake2 = new FakeWorker();
    const queue = [fake1, fake2];
    const ds = makeService(file, {
      hostFactory: async (_workerPath, path) => workerHostFactory(queue, path),
    });
    try {
      await ds.getOverview();
      const r1 = await ds.deleteRecords([0]);
      assert.equal(r1.ok, true, r1.error ?? '');
      assert.equal(fake1.terminated, 1, '重建时必须 terminate 上一根 worker（不再泄漏线程额度）');
      assert.equal(fake2.terminated, 0, '新 worker 应仍在使用中');
      // 伪 worker 走的是真实消息通道：重建前的 releaseFile 应被 ack 而非挂起。
      assert.ok(
        fake1.posted.some((m) => m.type === 'releaseFile'),
        '重建前应先松开文件句柄'
      );
    } finally {
      await ds.dispose();
    }
  });
});

test('O1：worker 路径下编辑会回传增量 op（两侧索引同源）', async () => {
  await withDir(async (dir) => {
    const file = await writeFile_(dir, makeLines(3));
    const fake = new FakeWorker();
    const ds = makeService(file, {
      hostFactory: async (_workerPath, path) => workerHostFactory([fake], path),
    });
    try {
      await ds.getOverview();
      const res = await ds.editRecord(1, '{"i":1,"tok":"t1","pad":"xxxxxxxx"}');
      assert.equal(res.ok, true, res.error ?? '');

      const opMsg = fake.lastOf('applyIndexOps');
      assert.ok(opMsg, '编辑后必须向 worker 回传增量 op（否则其索引停在搬迁前）');
      assert.ok('ops' in opMsg && opMsg.ops.length === 1, '一次编辑 = 一条 op');
      assert.deepEqual(opMsg.ops[0], { kind: 'replace', line: 1, delta: res.bytesDelta });

      // 通道打通后，worker 侧搜索也能给出搬迁后的正确行号。
      const found = await ds.search('t2');
      assert.deepEqual(found.matches, [2], `实得=${found.matches}`);
    } finally {
      await ds.dispose();
    }
  });
});

/* --------------------- 兜底：回填失败时，下一次查询前重建 --------------------- */

test('O1 兜底：宿主回填失败也不会出错 —— 查询前重建，结果依然正确', async () => {
  await withDir(async (dir) => {
    const file = await writeFile_(dir, ['{"tok":"keep"}', '{"tok":"drop"}']);
    const hosts: SpyHost[] = [];
    const ds = makeService(file, { hostFactory: spyHostFactory(hosts) });
    try {
      await ds.getOverview();
      hosts[0].failOps = true; // 模拟 worker 崩了 / 消息丢失

      const res = await ds.editRecord(0, '{"tok":"keep-padded-xxxxxxxxxxxxxxxxxxx"}');
      assert.equal(res.ok, true, '回填失败不应把成功的写操作汇报为失败');

      const builtBefore = hosts[0].built;
      const found = await ds.search('drop');
      // 关键断言：重建发生在查询之前，故命中行号是**搬迁之后**的正确结果。
      assert.deepEqual(found.matches, [1], `实得=${found.matches}`);
      assert.ok(hosts.length >= 2, '失同步后应以重建宿主兜底');
      assert.equal(builtBefore, hosts[0].built, '旧宿主不应被重复构建');
    } finally {
      await ds.dispose();
    }
  });
});
