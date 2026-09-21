import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createServiceRegistry, type AsyncDisposableLike } from '../serviceRegistry.ts';

/**
 * serviceRegistry 单测（T4/A4）。
 *
 * 价值：该注册表原为 extension.ts 的模块级隐式全局，无法单测。抽为纯模块后，
 * 「复用 / 引用计数 / 归零释放 / 幂等 / 释放异常收口」均可直接验证。
 */

/** 计数型假资源：记录 dispose 次数。 */
function makeFake(): AsyncDisposableLike & { disposed: number } {
  const f = {
    disposed: 0,
    dispose(): Promise<unknown> {
      f.disposed += 1;
      return Promise.resolve(undefined);
    },
  };
  return f;
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('createServiceRegistry（T4/A4 抽取回归）', () => {
  it('首次 acquire 新建、再次 acquire 复用同一实例，create 只调用一次', () => {
    const reg = createServiceRegistry<AsyncDisposableLike>();
    let created = 0;
    const create = (): AsyncDisposableLike => {
      created += 1;
      return makeFake();
    };

    const a = reg.acquire('k', create);
    const b = reg.acquire('k', create);

    assert.strictEqual(a, b, '同 key 复用同一实例');
    assert.strictEqual(created, 1, 'create 仅未命中时调用一次');
    assert.strictEqual(reg.size(), 1, '受管条目数为 1');
    assert.strictEqual(reg.refsOf('k'), 2, '引用计数为 2');
  });

  it('release 递减引用；归零才真正 dispose', async () => {
    const reg = createServiceRegistry<AsyncDisposableLike>();
    const fake = makeFake();
    reg.acquire('k', () => fake);
    reg.acquire('k', () => fake);

    reg.release('k');
    await flush();
    assert.strictEqual(fake.disposed, 0, '仍有引用时不释放');
    assert.strictEqual(reg.refsOf('k'), 1, '引用计数降为 1');

    reg.release('k');
    await flush();
    assert.strictEqual(fake.disposed, 1, '归零后释放一次');
    assert.strictEqual(reg.size(), 0, '条目已移除');
    assert.strictEqual(reg.refsOf('k'), 0, '不存在 key 引用数为 0');
  });

  it('未知 key 的 release 幂等忽略（重复释放不抛）', () => {
    const reg = createServiceRegistry<AsyncDisposableLike>();
    assert.doesNotThrow(() => reg.release('missing'));
    reg.acquire('k', () => makeFake());
    reg.release('k');
    assert.doesNotThrow(() => reg.release('k'), '重复释放不抛');
    assert.strictEqual(reg.size(), 0);
  });

  it('多 key 相互独立', () => {
    const reg = createServiceRegistry<AsyncDisposableLike>();
    const a = makeFake();
    const b = makeFake();
    reg.acquire('a', () => a);
    reg.acquire('b', () => b);
    reg.acquire('b', () => b);

    assert.strictEqual(reg.size(), 2);
    assert.strictEqual(reg.refsOf('a'), 1);
    assert.strictEqual(reg.refsOf('b'), 2);

    reg.release('a');
    assert.strictEqual(reg.refsOf('b'), 2, '释放 a 不影响 b');
  });

  it('释放后重新 acquire 会再次 create（新实例）', () => {
    const reg = createServiceRegistry<AsyncDisposableLike>();
    let created = 0;
    const create = (): AsyncDisposableLike => {
      created += 1;
      return makeFake();
    };

    const first = reg.acquire('k', create);
    reg.release('k');
    const second = reg.acquire('k', create);

    assert.notStrictEqual(first, second, '释放后取到新实例');
    assert.strictEqual(created, 2, 'create 被再次调用');
  });

  it('dispose 异步 reject：经 onReleaseError 上报，不外抛', async () => {
    const errors: unknown[] = [];
    const reg = createServiceRegistry<AsyncDisposableLike>((e) => errors.push(e));
    const bad: AsyncDisposableLike = {
      dispose: () => Promise.reject(new Error('dispose boom')),
    };

    reg.acquire('k', () => bad);
    assert.doesNotThrow(() => reg.release('k'), 'release 本身不外抛');
    await flush();

    assert.strictEqual(errors.length, 1, '错误已上报');
    assert.ok(errors[0] instanceof Error);
    assert.strictEqual((errors[0] as Error).message, 'dispose boom');
  });

  it('dispose 同步抛：同样经 onReleaseError 收口', async () => {
    const errors: unknown[] = [];
    const reg = createServiceRegistry<AsyncDisposableLike>((e) => errors.push(e));
    const bad: AsyncDisposableLike = {
      dispose(): Promise<unknown> {
        throw new Error('sync boom');
      },
    };

    reg.acquire('k', () => bad);
    assert.doesNotThrow(() => reg.release('k'), '同步抛也被收口');
    await flush();

    assert.strictEqual(errors.length, 1);
    assert.strictEqual((errors[0] as Error).message, 'sync boom');
  });
});
