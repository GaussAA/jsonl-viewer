import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchMessage,
  HostEndpoint,
  HostReply,
  initReply,
  isHostRequest,
} from '../rpc.ts';

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
    async () => [],
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
    async () => [],
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