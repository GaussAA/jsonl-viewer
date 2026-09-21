import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  WorkerIndexHost,
  activeWorkerCount,
  createIndexHost,
  type WorkerLike,
} from '../indexHost.ts';
import type { WorkerRequest, WorkerResponse } from '../workerProtocol.ts';

/**
 * WorkerIndexHost 分支测试（覆盖率补强）。
 *
 * 价值：该类的消息分发（progress / built / searchResult / filterResult / error）、
 * 异常退出、崩溃结算、取消轮询与 dispose 资源归还是「大文件不卡主线程 + 出错不挂死」的命脉，
 * 原只能靠真实线程覆盖。此处注入伪 Worker 精确驱动每个分支（无需 spawn 真线程）。
 */

/** 伪 Worker：记录 postMessage，可手动 emit message / error / exit。 */
class FakeWorker {
  readonly posted: WorkerRequest[] = [];
  terminated = 0;
  private readonly handlers: {
    message: ((m: WorkerResponse) => void)[];
    error: ((e: Error) => void)[];
    exit: ((code: number) => void)[];
  } = { message: [], error: [], exit: [] };

  postMessage(msg: WorkerRequest): void {
    this.posted.push(msg);
  }

  /** 宽松签名：测试替身无需复刻 `Worker` 的重载面。 */
  on(event: 'message' | 'error' | 'exit', cb: unknown): unknown {
    (this.handlers[event] as unknown[]).push(cb);
    return this;
  }

  terminate(): Promise<number> {
    this.terminated += 1;
    return Promise.resolve(0);
  }

  emitMessage(m: WorkerResponse): void {
    for (const h of this.handlers.message) h(m);
  }
  emitError(e: Error): void {
    for (const h of this.handlers.error) h(e);
  }
  emitExit(code: number): void {
    for (const h of this.handlers.exit) h(code);
  }

  /** 某类请求的最近一条消息。 */
  lastOf(type: WorkerRequest['type']): WorkerRequest | undefined {
    return this.posted.toReversed().find((m) => m.type === type);
  }
  countOf(type: WorkerRequest['type']): number {
    return this.posted.filter((m) => m.type === type).length;
  }
  /** 某类请求的最近 requestId（不存在则抛）——内部完成联合类型收窄。 */
  lastRequestIdOf(type: 'build' | 'search' | 'filter'): number {
    const m = this.lastOf(type);
    if (!m || !('requestId' in m)) throw new Error(`未捕获到 ${type} 请求`);
    return m.requestId;
  }
}

/**
 * 构造 host + 伪 worker。
 *
 * `FakeWorker.on` 为宽松签名，故经 unknown 断言适配 `WorkerLike`；消息收发的类型安全由
 * `posted: WorkerRequest[]` 与 emit 的参数类型保证。
 */
function makeHost(): { host: WorkerIndexHost; worker: FakeWorker } {
  const worker = new FakeWorker();
  const host = new WorkerIndexHost('/fake/indexWorker.js', () => worker as unknown as WorkerLike);
  return { host, worker };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('WorkerIndexHost 分支（覆盖率补强）', () => {
  it('构造后登记活跃 worker 计数，dispose 归还（重复调用只归还一次）', async () => {
    const before = activeWorkerCount();
    const { host } = makeHost();
    assert.strictEqual(activeWorkerCount(), before + 1, '构造 +1');

    await host.dispose();
    assert.strictEqual(activeWorkerCount(), before, 'dispose 归还');

    await host.dispose(); // 重复调用不应重复递减
    assert.strictEqual(activeWorkerCount(), before, '重复 dispose 不重复归还');
  });

  it('build：发出 build 请求，progress 转发给 onProgress，built 解析出索引与统计', async () => {
    const { host, worker } = makeHost();
    const progress: Array<{ bytesRead: number; lines: number; done: boolean }> = [];

    const p = host.build('/data.jsonl', (i) => progress.push(i));
    const req = worker.lastOf('build');
    assert.ok(req && req.type === 'build', '已发出 build 请求');
    assert.strictEqual(req?.type === 'build' ? req.path : '', '/data.jsonl');

    worker.emitMessage({
      type: 'progress',
      requestId: worker.lastRequestIdOf('build'),
      bytesRead: 128,
      lines: 7,
    });
    assert.deepStrictEqual(progress, [{ bytesRead: 128, lines: 7, done: false }], '进度已转发');

    worker.emitMessage({
      type: 'built',
      requestId: worker.lastRequestIdOf('build'),
      checkpoints: [{ line: 0, offset: 0 }],
      totalBytes: 2048,
      totalLines: 42,
      buildMs: 12,
      eof: true,
      interval: 100,
    });

    const result = await p;
    assert.strictEqual(result.index.totalLines, 42, '重建索引行数');
    assert.strictEqual(result.index.totalBytes, 2048);
    assert.strictEqual(result.stats.buildMs, 12);
    assert.strictEqual(result.stats.eof, true);

    await host.dispose();
  });

  it('build：unknown requestId 的 built 响应被忽略，不抛错', async () => {
    const { host, worker } = makeHost();
    const p = host.build('/data.jsonl', undefined);

    assert.doesNotThrow(() =>
      worker.emitMessage({
        type: 'built',
        requestId: 9999,
        checkpoints: [],
        totalBytes: 0,
        totalLines: 0,
        buildMs: 0,
        eof: true,
        interval: 100,
      })
    );

    worker.emitMessage({
      type: 'built',
      requestId: worker.lastRequestIdOf('build'),
      checkpoints: [],
      totalBytes: 1,
      totalLines: 1,
      buildMs: 1,
      eof: true,
      interval: 100,
    });
    const r = await p;
    assert.strictEqual(r.index.totalLines, 1, '真实回执仍能解析');

    await host.dispose();
  });

  it('search：发出 search 请求，searchResult 解析', async () => {
    const { host, worker } = makeHost();

    const sp = host.search('needle', 'field', { startLine: 0, endLine: 10 }, 50);
    const sreq = worker.lastOf('search');
    assert.ok(sreq && sreq.type === 'search', '已发出 search 请求');
    if (sreq?.type === 'search') {
      assert.strictEqual(sreq.query, 'needle');
      assert.strictEqual(sreq.field, 'field');
      assert.strictEqual(sreq.maxResults, 50);
      assert.deepStrictEqual(sreq.scope, { startLine: 0, endLine: 10 });
    }

    worker.emitMessage({
      type: 'searchResult',
      requestId: worker.lastRequestIdOf('search'),
      result: { matches: [1, 2], total: 2, truncated: false },
    });
    const sres = await sp;
    assert.deepStrictEqual(sres.matches, [1, 2]);

    await host.dispose();
  });

  it('filter：发出 filter 请求，filterResult 解析', async () => {
    const { host, worker } = makeHost();

    const fp = host.filter({ field: 'a', op: 'eq', value: '1' }, 20);
    const freq = worker.lastOf('filter');
    assert.ok(freq && freq.type === 'filter', '已发出 filter 请求');

    worker.emitMessage({
      type: 'filterResult',
      requestId: worker.lastRequestIdOf('filter'),
      result: { matches: [3], total: 1, truncated: false },
    });
    const fres = await fp;
    assert.deepStrictEqual(fres.matches, [3]);

    await host.dispose();
  });

  it('error 响应：带 requestId → 该请求 reject；不带 / 未知 requestId → 忽略不抛', async () => {
    const { host, worker } = makeHost();

    const p = host.search('q', undefined, undefined, 10);
    worker.emitMessage({ type: 'error', message: 'no requestId' }); // 无 requestId：应被忽略
    worker.emitMessage({
      type: 'error',
      requestId: worker.lastRequestIdOf('search'),
      message: 'scan failed',
    });
    await assert.rejects(p, /scan failed/, '带 requestId 的 error 精确 reject');

    assert.doesNotThrow(() =>
      worker.emitMessage({ type: 'error', requestId: 424242, message: 'x' })
    );

    await host.dispose();
  });

  it('worker error 事件：结算全部在途请求', async () => {
    const { host, worker } = makeHost();
    const p = host.build('/f.jsonl');

    worker.emitError(new Error('worker crashed'));
    await assert.rejects(p, /worker crashed/);

    await host.dispose();
  });

  it('worker 非主动退出（exit）：在途请求以「意外退出」拒绝', async () => {
    const { host, worker } = makeHost();
    const p = host.search('q', undefined, undefined, 5);

    worker.emitExit(1);
    await assert.rejects(p, /exited unexpectedly/);

    await host.dispose();
  });

  it('dispose：终止 worker；在途请求以「worker disposed」结算（随后的 exit 不再报意外退出）', async () => {
    const { host, worker } = makeHost();
    const p = host.search('q', undefined, undefined, 5);

    const disposing = host.dispose();
    worker.emitExit(0); // dispose 置位后的 exit 属正常退出

    await assert.rejects(p, /worker disposed/, '结算原因为 disposed 而非意外退出');
    await disposing;
    assert.strictEqual(worker.terminated, 1, '已 terminate 一次');

    await host.dispose();
    assert.strictEqual(worker.terminated, 2, '重复 dispose 再次 terminate（幂等无害）');
  });

  it('search：shouldCancel 置位 → 经 30ms 轮询转发 cancel；结算后停止轮询', async () => {
    const { host, worker } = makeHost();
    let cancelled = false;

    const p = host.search('q', undefined, undefined, 5, () => cancelled);
    await wait(80);
    assert.strictEqual(worker.countOf('cancel'), 0, '未取消则不发 cancel');

    cancelled = true;
    await wait(80);
    assert.strictEqual(worker.countOf('cancel'), 1, '取消置位后转发 cancel');

    worker.emitMessage({
      type: 'searchResult',
      requestId: worker.lastRequestIdOf('search'),
      result: { matches: [], total: 0, truncated: false },
    });
    await p;
    const afterSettle = worker.countOf('cancel');
    await wait(80);
    assert.strictEqual(worker.countOf('cancel'), afterSettle, '结算后停止轮询（无定时器泄漏）');

    await host.dispose();
  });

  it('filter：shouldCancel 置位同样转发 cancel', async () => {
    const { host, worker } = makeHost();
    let cancelled = false;
    const p = host.filter(null, 5, () => cancelled);

    cancelled = true;
    await wait(80);
    assert.strictEqual(worker.countOf('cancel'), 1, '过滤取消已转发');

    worker.emitMessage({
      type: 'filterResult',
      requestId: worker.lastRequestIdOf('filter'),
      result: { matches: null, total: 0, truncated: false },
    });
    await p;
    await host.dispose();
  });

  it('createIndexHost：不传脚本路径 → 主线程实现（kind=main）', () => {
    const host = createIndexHost(undefined);
    assert.strictEqual(host.kind, 'main');
  });
});
