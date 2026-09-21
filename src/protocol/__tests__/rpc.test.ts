import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchMessage,
  HostEndpoint,
  HostReply,
  initReply,
  okReply,
  isHostRequest,
  requestIdOf,
  type HostHandlerMap,
} from '../rpc.ts';
import type { OverviewPayload } from '../rpc.ts';

/** 宿主真实类型请求消息的形态（webview 用 HostEndpoint 的值作为 type 发送）。 */
const req = (type: string): unknown => ({ type });

/** 各端点的默认 handler：返回完整 HostResponse（含 reply 类型与 requestId）。 */
const baseHandlers: HostHandlerMap = {
  [HostEndpoint.READY]: () => initReply({ uri: 'u', totalLines: 0, totalBytes: 0, buildMs: 0, eof: true }),
  [HostEndpoint.GET_OVERVIEW]: (r) =>
    okReply(HostReply.OVERVIEW, r.requestId, { uri: 'u', totalLines: 0, totalBytes: 0, buildMs: 0, eof: true }),
  [HostEndpoint.GET_SAMPLE_FIELDS]: (r) =>
    okReply(HostReply.SAMPLE_FIELDS, r.requestId, { fields: [], total: 0, scanned: 0 }),
  [HostEndpoint.READ_RECORDS]: (r) =>
    okReply(HostReply.RECORDS, r.requestId, { startLine: 0, items: [], hasMore: false }),
  [HostEndpoint.READ_RECORD]: (r) => okReply(HostReply.RESULT, r.requestId, { ok: true }),
  [HostEndpoint.JUMP_TO_SOURCE]: (r) => okReply(HostReply.RESULT, r.requestId, { jumped: true }),
  [HostEndpoint.SEARCH]: (r) =>
    okReply(HostReply.SEARCH_RESULTS, r.requestId, { matches: [], total: 0, truncated: false }),
  [HostEndpoint.FILTER]: (r) => okReply(HostReply.FILTER_RESULTS, r.requestId, { matches: null, total: 0 }),
  [HostEndpoint.PERSIST_STATE]: (r) => okReply(HostReply.RESULT, r.requestId, { ok: true }),
  [HostEndpoint.LOAD_STATE]: (r) => okReply(HostReply.RESULT, r.requestId, undefined),
  [HostEndpoint.RELOAD]: (r) =>
    okReply(HostReply.OVERVIEW, r.requestId, { uri: 'u', totalLines: 0, totalBytes: 0, buildMs: 0, eof: true }),
  [HostEndpoint.CANCEL]: () => undefined,
};

/** 以注册表形式分发一条消息（覆盖单端点时用 spread 覆写一个 handler）。 */
async function call(msg: unknown, handlers: HostHandlerMap) {
  return dispatchMessage(msg, handlers);
}

test('isHostRequest 识别所有 HostEndpoint 值（键大写、值是小写端点名）', () => {
  for (const key of Object.keys(HostEndpoint)) {
    const value = (HostEndpoint as Record<string, string>)[key];
    assert.equal(isHostRequest(req(value)), true, `should accept ${value}`);
  }
  // 未知端点 / 非对象全局拒绝
  assert.equal(isHostRequest(req('nope')), false);
  assert.equal(isHostRequest({ nope: 1 }), false);
  assert.equal(isHostRequest(null), false);
});

test('READY 握手能返回 init 回执（此前 isHostRequest 误杀导致宿主永不回包）', async () => {
  const overview: OverviewPayload = { uri: 'file:///x.jsonl', totalLines: 3, totalBytes: 9, buildMs: 1, eof: true };
  const { response } = await call(req(HostEndpoint.READY), {
    ...baseHandlers,
    [HostEndpoint.READY]: () => initReply(overview),
  });
  assert.ok(response, 'READY 必须产生回执');
  assert.equal(response.type, HostReply.INIT);
  if (response.type === HostReply.INIT) {
    assert.equal((response.payload as { totalLines: number }).totalLines, 3);
  }
});

test('GET_OVERVIEW 带 requestId 关联返回', async () => {
  const { response } = await call(
    { type: HostEndpoint.GET_OVERVIEW, requestId: 'rid-1' },
    baseHandlers
  );
  assert.ok(response);
  assert.equal(response.type, HostReply.OVERVIEW);
  assert.equal((response as unknown as { requestId: string }).requestId, 'rid-1');
});

/** dispatchMessage 其余端点参数化覆盖（M15：此前仅测 READY/GET_OVERVIEW 两个）。 */
test('READ_RECORDS 分发到 handler 并回 RECORDS', async () => {
  let got: [number, number] | undefined;
  const { response } = await call(
    { type: HostEndpoint.READ_RECORDS, requestId: 'r1', startLine: 3, count: 5 },
    {
      ...baseHandlers,
      [HostEndpoint.READ_RECORDS]: (r) =>
        ((got = [r.startLine, r.count]), okReply(HostReply.RECORDS, r.requestId, { startLine: r.startLine, items: [], hasMore: false })),
    }
  );
  assert.deepEqual(got, [3, 5]);
  assert.equal(response?.type, HostReply.RECORDS);
  assert.equal((response as unknown as { requestId: string }).requestId, 'r1');
});

test('READ_RECORD 分发并回 RESULT', async () => {
  let gotLine: number | undefined;
  const { response } = await call(
    { type: HostEndpoint.READ_RECORD, requestId: 'r2', line: 42 },
    {
      ...baseHandlers,
      [HostEndpoint.READ_RECORD]: (r) => ((gotLine = r.line), okReply(HostReply.RESULT, r.requestId, { ok: true, value: 1 })),
    }
  );
  assert.equal(gotLine, 42);
  assert.equal(response?.type, HostReply.RESULT);
  assert.deepEqual((response as unknown as { payload: unknown }).payload, { ok: true, value: 1 });
});

test('GET_SAMPLE_FIELDS 传 count 并回 SAMPLE_FIELDS', async () => {
  let gotCount: number | undefined;
  const { response } = await call(
    { type: HostEndpoint.GET_SAMPLE_FIELDS, requestId: 'r3', count: 77 },
    {
      ...baseHandlers,
      [HostEndpoint.GET_SAMPLE_FIELDS]: (r) =>
        ((gotCount = r.count), okReply(HostReply.SAMPLE_FIELDS, r.requestId, { fields: [], total: 0, scanned: 0 })),
    }
  );
  assert.equal(gotCount, 77);
  assert.equal(response?.type, HostReply.SAMPLE_FIELDS);
});

test('SEARCH 传 query/field/scope 并回 SEARCH_RESULTS', async () => {
  let got: [string, string | undefined, string | undefined] | undefined;
  const { response } = await call(
    { type: HostEndpoint.SEARCH, requestId: 'r4', query: 'abc', field: 'name', scope: '0:5' },
    {
      ...baseHandlers,
      [HostEndpoint.SEARCH]: (r) =>
        ((got = [r.query, r.field, r.scope]), okReply(HostReply.SEARCH_RESULTS, r.requestId, { matches: [], total: 0, truncated: false })),
    }
  );
  assert.deepEqual(got, ['abc', 'name', '0:5']);
  assert.equal(response?.type, HostReply.SEARCH_RESULTS);
});

test('FILTER 分发并回 FILTER_RESULTS', async () => {
  let got: [string | undefined, string | undefined, string | undefined] | undefined;
  const { response } = await call(
    { type: HostEndpoint.FILTER, requestId: 'r5', field: 'ok', op: 'eq', value: 'true' },
    {
      ...baseHandlers,
      [HostEndpoint.FILTER]: (r) =>
        ((got = [r.field, r.op, r.value]), okReply(HostReply.FILTER_RESULTS, r.requestId, { matches: [1, 2], total: 2 })),
    }
  );
  assert.deepEqual(got, ['ok', 'eq', 'true']);
  assert.equal(response?.type, HostReply.FILTER_RESULTS);
  assert.deepEqual((response as unknown as { payload: { matches: number[] } }).payload.matches, [1, 2]);
});

test('JUMP_TO_SOURCE 传行号并回 RESULT', async () => {
  let gotLine: number | undefined;
  const { response } = await call(
    { type: HostEndpoint.JUMP_TO_SOURCE, requestId: 'r6', line: 9 },
    {
      ...baseHandlers,
      [HostEndpoint.JUMP_TO_SOURCE]: (r) => (void (gotLine = r.line), okReply(HostReply.RESULT, r.requestId, { jumped: true })),
    }
  );
  assert.equal(gotLine, 9);
  assert.equal(response?.type, HostReply.RESULT);
});

test('PERSIST_STATE / LOAD_STATE 转发 key 与 value', async () => {
  let persisted: [string, unknown] | undefined;
  const save = await call(
    { type: HostEndpoint.PERSIST_STATE, requestId: 'r7', key: 'k', value: { a: 1 } },
    {
      ...baseHandlers,
      [HostEndpoint.PERSIST_STATE]: (r) => (void (persisted = [r.key, r.value]), okReply(HostReply.RESULT, r.requestId, { ok: true })),
    }
  );
  assert.deepEqual(persisted, ['k', { a: 1 }]);
  assert.equal(save.response?.type, HostReply.RESULT);

  const load = await call(
    { type: HostEndpoint.LOAD_STATE, requestId: 'r8', key: 'k2' },
    {
      ...baseHandlers,
      [HostEndpoint.LOAD_STATE]: (r) => okReply(HostReply.RESULT, r.requestId, r.key === 'k2' ? 'v2' : undefined),
    }
  );
  assert.deepEqual((load.response as unknown as { payload: unknown }).payload, 'v2');
});

test('RELOAD 回新概览；CANCEL 无回执', async () => {
  const reload = await call(
    { type: HostEndpoint.RELOAD, requestId: 'r9' },
    {
      ...baseHandlers,
      [HostEndpoint.RELOAD]: (r) =>
        okReply(HostReply.OVERVIEW, r.requestId, { uri: 'u', totalLines: 5, totalBytes: 50, buildMs: 1, eof: true }),
    }
  );
  assert.equal(reload.response?.type, HostReply.OVERVIEW);
  assert.equal((reload.response as unknown as { payload: { totalLines: number } }).payload.totalLines, 5);

  let cancelled: string | undefined;
  const cancel = await call(
    { type: HostEndpoint.CANCEL, requestId: 'r10' },
    {
      ...baseHandlers,
      [HostEndpoint.CANCEL]: (r) => (void (cancelled = r.requestId), undefined),
    }
  );
  assert.equal(cancelled, 'r10');
  assert.equal(cancel.response, undefined);
});

test('未知端点被 isHostRequest 过滤（无回执，不进 handler）', async () => {
  const { response } = await call({ type: 'nope', requestId: 'x' }, baseHandlers);
  assert.equal(response, undefined);
});

/* -------- T7：异常回执保留 requestId（避免全局横幅 + 在途请求永不 settle） -------- */

test('requestIdOf：字符串取回；缺失 / 非字符串 / 非对象一律 undefined', () => {
  assert.equal(requestIdOf({ type: 'x', requestId: 'rid-9' }), 'rid-9');
  assert.equal(requestIdOf({ type: 'x' }), undefined, '缺失字段');
  assert.equal(requestIdOf({ requestId: 123 }), undefined, '非字符串');
  assert.equal(requestIdOf(null), undefined, 'null');
  assert.equal(requestIdOf('nope'), undefined, '非对象');
});

test('handler 抛异常：回执为 ERROR 且保留 requestId', async () => {
  const { response } = await call(
    { type: HostEndpoint.GET_OVERVIEW, requestId: 'rid-err' },
    {
      ...baseHandlers,
      [HostEndpoint.GET_OVERVIEW]: () => {
        throw new Error('boom');
      },
    }
  );
  assert.ok(response, '异常也须回执');
  assert.equal(response.type, HostReply.ERROR);
  assert.equal(
    (response as unknown as { requestId?: string }).requestId,
    'rid-err',
    'requestId 被保留，webview 可精确 reject 该请求'
  );
  assert.equal((response as unknown as { message: string }).message, 'boom');
});

test('handler 异步 reject：回执为 ERROR 且保留 requestId', async () => {
  const { response } = await call(
    { type: HostEndpoint.SEARCH, requestId: 'rid-async' },
    {
      ...baseHandlers,
      [HostEndpoint.SEARCH]: async () => {
        throw new Error('async boom');
      },
    }
  );
  assert.equal(response?.type, HostReply.ERROR);
  assert.equal((response as unknown as { requestId?: string }).requestId, 'rid-async');
});

test('无 requestId 的端点（READY）抛异常：回执 requestId 为 undefined', async () => {
  const { response } = await call(req(HostEndpoint.READY), {
    ...baseHandlers,
    [HostEndpoint.READY]: () => {
      throw new Error('ready boom');
    },
  });
  assert.equal(response?.type, HostReply.ERROR);
  assert.equal((response as unknown as { requestId?: string }).requestId, undefined);
});
