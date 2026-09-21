import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createPersistence, type PersistState } from '../persistence.ts';
import type { FieldLayout } from '../queryLogic.ts';
import type { RpcBus } from '../rpc.ts';

/**
 * persistence 模块级回归测试（T5 #32）。
 *
 * 价值：#32 把 main() 内联的偏好防抖写回抽成独立工厂。本测试用桩 bus 驱动工厂，覆盖
 * 「persistKey 未就绪跳过 / 防抖合并为单次请求 / 载荷由 toPersistedState 构建」关键分支，
 * 作为该模块的精确回归护栏。
 */

const LAYOUT: FieldLayout = { pinned: [], order: [], hidden: [], maxKeys: 4 };
const DEBOUNCE_MS = 5;

interface Harness {
  state: PersistState;
  calls: { requests: { endpoint: string; payload: unknown }[] };
  schedulePersist: () => void;
}

function makeHarness(persistKey: string | null): Harness {
  const calls: Harness['calls'] = { requests: [] };
  const state: PersistState = {
    persistKey,
    persistTimer: undefined,
    fieldLayout: LAYOUT,
    filterCond: null,
    searchQuery: '',
  };
  const bus = {
    request(endpoint: string, payload: unknown) {
      calls.requests.push({ endpoint, payload });
      return { requestId: 'r', promise: Promise.resolve({}) };
    },
  } as unknown as RpcBus;
  const { schedulePersist } = createPersistence({ bus, state, debounceMs: DEBOUNCE_MS });
  return { state, calls, schedulePersist };
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('createPersistence（T5 #32 抽取回归）', () => {
  it('persistKey 未就绪：不排定时器、不发请求', async () => {
    const h = makeHarness(null);
    h.schedulePersist();
    assert.strictEqual(h.state.persistTimer, undefined, '未排定定时器');
    await wait(DEBOUNCE_MS * 3);
    assert.strictEqual(h.calls.requests.length, 0, '未发起写回请求');
  });

  it('persistKey 就绪：防抖到期后写回一次，载荷含 key + value', async () => {
    const h = makeHarness('jsonlViewer.state.file');
    h.state.searchQuery = '  hi  ';
    h.schedulePersist();
    assert.ok(h.state.persistTimer, '已排定定时器');

    await wait(DEBOUNCE_MS * 4);
    assert.strictEqual(h.state.persistTimer, undefined, '定时器触发后清空');
    assert.strictEqual(h.calls.requests.length, 1, '写回一次');
    assert.strictEqual(h.calls.requests[0].endpoint, 'persistState', 'endpoint 正确');
    assert.deepStrictEqual(h.calls.requests[0].payload, {
      key: 'jsonlViewer.state.file',
      value: { fieldLayout: LAYOUT, filter: null, searchQuery: 'hi' },
    });
  });

  it('连续调度：防抖合并为单次写回', async () => {
    const h = makeHarness('k');
    h.schedulePersist();
    h.schedulePersist();
    h.schedulePersist();
    await wait(DEBOUNCE_MS * 4);
    assert.strictEqual(h.calls.requests.length, 1, '三次调度只写回一次');
  });
});
