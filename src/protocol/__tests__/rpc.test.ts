import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchMessage,
  HostEndpoint,
  HostReply,
  initReply,
  isHostRequest,
} from '../rpc.ts';
import type { OverviewPayload } from '../rpc.ts';

/** 宿主真实类型请求消息的形态（webview 用 HostEndpoint 的值作为 type 发送）。 */
const req = (type: string): unknown => ({ type });

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
  const overview = { uri: 'file:///x.jsonl', totalLines: 3, totalBytes: 9, buildMs: 1, eof: true };
  const { response } = await dispatchMessage(
    req(HostEndpoint.READY),
    () => initReply(overview),
    async () => overview,
    async () => ({ startLine: 0, items: [], hasMore: false }),
    async () => ({ ok: true, value: 1 }),
    () => {},
    async () => ({ fields: [], total: 0, scanned: 0 }),
    () => {},
    async () => ({ matches: [], total: 0, truncated: false }),
    async () => ({ matches: null, total: 0 }),
    async () => {},
    async () => undefined,
    async () => null,
  );
  assert.ok(response, 'READY 必须产生回执');
  assert.equal(response.type, HostReply.INIT);
  if (response.type === HostReply.INIT) {
    assert.equal((response.payload as { totalLines: number }).totalLines, 3);
  }
});

test('GET_OVERVIEW 带 requestId 关联返回', async () => {
  const { response } = await dispatchMessage(
    { type: HostEndpoint.GET_OVERVIEW, requestId: 'rid-1' },
    async () => ({ type: HostReply.INIT, payload: {} as never }),
    async () => ({ uri: 'u', totalLines: 0, totalBytes: 0, buildMs: 0, eof: true }),
    async () => ({ startLine: 0, items: [], hasMore: false }),
    async () => ({ ok: true }),
    () => {},
    async () => ({ fields: [], total: 0, scanned: 0 }),
    () => {},
    async () => ({ matches: [], total: 0, truncated: false }),
    async () => ({ matches: null, total: 0 }),
    async () => {},
    async () => undefined,
    async () => null,
  );
  assert.ok(response);
  assert.equal(response.type, HostReply.OVERVIEW);
  assert.equal((response as unknown as { requestId: string }).requestId, 'rid-1');
});

/** dispatchMessage 其余端点参数化覆盖（M15：此前仅测 READY/GET_OVERVIEW 两个）。 */
const baseHandlers = {
  onReady: () => ({ type: HostReply.INIT, payload: {} as never }),
  onGetOverview: async (_r: string) => ({ uri: 'u', totalLines: 0, totalBytes: 0, buildMs: 0, eof: true }),
  onReadRecords: async (_r: string, startLine: number, _count: number) => ({
    startLine,
    items: [] as never[],
    hasMore: false,
  }),
  onReadRecord: async (_r: string, _line: number) => ({ ok: true }),
  onCancel: (_requestId: string) => {},
  onGetSampleFields: async (_r: string, _count?: number) => ({ fields: [] as never[], total: 0, scanned: 0 }),
  onJumpToSource: (_line: number, _requestId: string) => {},
  onSearch: async (_r: string, _query: string, _field?: string, _scope?: string) => ({
    matches: [] as never[],
    total: 0,
    truncated: false,
  }),
  onFilter: async (
    _r: string,
    _field?: string,
    _op?: string,
    _value?: string
  ): Promise<{ matches: number[] | null; total: number }> => ({ matches: null, total: 0 }),
  onPersistState: async (_r: string, _key: string, _value: unknown) => {},
  onLoadState: async (_r: string, _key: string): Promise<unknown> => undefined,
  onReload: async (_r: string): Promise<OverviewPayload | null> => null,
};
type H = typeof baseHandlers;
function call(msg: unknown, h: H) {
  return dispatchMessage(
    msg,
    h.onReady,
    h.onGetOverview,
    h.onReadRecords,
    h.onReadRecord,
    h.onCancel,
    h.onGetSampleFields,
    h.onJumpToSource,
    h.onSearch,
    h.onFilter,
    h.onPersistState,
    h.onLoadState,
    h.onReload
  );
}

test('READ_RECORDS 分发到 handler 并回 RECORDS', async () => {
  let got: [number, number] | undefined;
  const { response } = await call(
    { type: HostEndpoint.READ_RECORDS, requestId: 'r1', startLine: 3, count: 5 },
    { ...baseHandlers, onReadRecords: async (_r, s, c) => ((got = [s, c]), { startLine: s, items: [], hasMore: false }) }
  );
  assert.deepEqual(got, [3, 5]);
  assert.equal(response?.type, HostReply.RECORDS);
  assert.equal((response as unknown as { requestId: string }).requestId, 'r1');
});

test('READ_RECORD 分发并回 RESULT', async () => {
  let gotLine: number | undefined;
  const { response } = await call(
    { type: HostEndpoint.READ_RECORD, requestId: 'r2', line: 42 },
    { ...baseHandlers, onReadRecord: async (_r, l) => ((gotLine = l), { ok: true, value: 1 }) }
  );
  assert.equal(gotLine, 42);
  assert.equal(response?.type, HostReply.RESULT);
  assert.deepEqual((response as unknown as { payload: unknown }).payload, { ok: true, value: 1 });
});

test('GET_SAMPLE_FIELDS 传 count 并回 SAMPLE_FIELDS', async () => {
  let gotCount: number | undefined;
  const { response } = await call(
    { type: HostEndpoint.GET_SAMPLE_FIELDS, requestId: 'r3', count: 77 },
    { ...baseHandlers, onGetSampleFields: async (_r, c) => ((gotCount = c), { fields: [], total: 0, scanned: 0 }) }
  );
  assert.equal(gotCount, 77);
  assert.equal(response?.type, HostReply.SAMPLE_FIELDS);
});

test('SEARCH 传 query/field/scope 并回 SEARCH_RESULTS', async () => {
  let got: [string, string | undefined, string | undefined] | undefined;
  const { response } = await call(
    { type: HostEndpoint.SEARCH, requestId: 'r4', query: 'abc', field: 'name', scope: '0:5' },
    { ...baseHandlers, onSearch: async (_r, q, f, s) => ((got = [q, f, s]), { matches: [], total: 0, truncated: false }) }
  );
  assert.deepEqual(got, ['abc', 'name', '0:5']);
  assert.equal(response?.type, HostReply.SEARCH_RESULTS);
});

test('FILTER 分发并回 FILTER_RESULTS', async () => {
  let got: [string | undefined, string | undefined, string | undefined] | undefined;
  const { response } = await call(
    { type: HostEndpoint.FILTER, requestId: 'r5', field: 'ok', op: 'eq', value: 'true' },
    { ...baseHandlers, onFilter: async (_r, f, o, v) => ((got = [f, o, v]), { matches: [1, 2], total: 2 }) }
  );
  assert.deepEqual(got, ['ok', 'eq', 'true']);
  assert.equal(response?.type, HostReply.FILTER_RESULTS);
  assert.deepEqual((response as unknown as { payload: { matches: number[] } }).payload.matches, [1, 2]);
});

test('JUMP_TO_SOURCE 传行号并回 RESULT', async () => {
  let gotLine: number | undefined;
  const { response } = await call(
    { type: HostEndpoint.JUMP_TO_SOURCE, requestId: 'r6', line: 9 },
    { ...baseHandlers, onJumpToSource: (l) => void (gotLine = l) }
  );
  assert.equal(gotLine, 9);
  assert.equal(response?.type, HostReply.RESULT);
});

test('PERSIST_STATE / LOAD_STATE 转发 key 与 value', async () => {
  let persisted: [string, unknown] | undefined;
  const save = await call(
    { type: HostEndpoint.PERSIST_STATE, requestId: 'r7', key: 'k', value: { a: 1 } },
    { ...baseHandlers, onPersistState: async (_r, key, val) => void (persisted = [key, val]) }
  );
  assert.deepEqual(persisted, ['k', { a: 1 }]);
  assert.equal(save.response?.type, HostReply.RESULT);

  const load = await call(
    { type: HostEndpoint.LOAD_STATE, requestId: 'r8', key: 'k2' },
    { ...baseHandlers, onLoadState: async (_r, key) => (key === 'k2' ? 'v2' : undefined) }
  );
  assert.deepEqual((load.response as unknown as { payload: unknown }).payload, 'v2');
});

test('RELOAD 回新概览；CANCEL 无回执', async () => {
  const reload = await call(
    { type: HostEndpoint.RELOAD, requestId: 'r9' },
    { ...baseHandlers, onReload: async () => ({ uri: 'u', totalLines: 5, totalBytes: 50, buildMs: 1, eof: true }) }
  );
  assert.equal(reload.response?.type, HostReply.OVERVIEW);
  assert.equal((reload.response as unknown as { payload: { totalLines: number } }).payload.totalLines, 5);

  let cancelled: string | undefined;
  const cancel = await call(
    { type: HostEndpoint.CANCEL, requestId: 'r10' },
    { ...baseHandlers, onCancel: (rid) => void (cancelled = rid) }
  );
  assert.equal(cancelled, 'r10');
  assert.equal(cancel.response, undefined);
});

test('未知端点被 isHostRequest 过滤（无回执，不进 handler）', async () => {
  const { response } = await call({ type: 'nope', requestId: 'x' }, baseHandlers);
  assert.equal(response, undefined);
});