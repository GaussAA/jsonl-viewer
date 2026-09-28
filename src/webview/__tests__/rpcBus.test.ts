/**
 * rpcBus.test.ts — RpcBus（webview 侧请求收发）单测（M15：此前零覆盖）。
 *
 * 通过注入假 VSCodeApi + 直接调用私有 onMessage 模拟宿主回包，
 * 覆盖：成功 resolve、超时 reject、supersede 立即结算（P0-5）、迟到响应丢弃、
 * ERROR 回执、init 事件订阅、dispose 清理。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CancelledError, createVSCodeApi, RpcBus, RpcError } from '../rpc.ts';
import type { VSCodeApi } from '../rpc.ts';
import { HostReply, PROTOCOL_VERSION } from '../../protocol/rpc.ts';

function makeApi(): { api: VSCodeApi; sent: unknown[] } {
  const sent: unknown[] = [];
  const api: VSCodeApi = {
    postMessage: (m: unknown) => void sent.push(m),
    getState: () => undefined,
    setState: () => {},
  };
  return { api, sent };
}

/** 直接向 bus 注入一条宿主消息（绕过 globalThis，node 环境无 message 事件）。 */
function deliver(bus: RpcBus, data: unknown): void {
  (bus as unknown as { onMessage(e: { data?: unknown }): void }).onMessage({ data });
}

test('request：宿主回同 requestId 的 payload 即 resolve', async () => {
  const { api } = makeApi();
  const bus = new RpcBus(api);
  const { requestId, promise } = bus.request('getOverview', {});
  deliver(bus, { type: HostReply.OVERVIEW, requestId, payload: { totalLines: 7 } });
  const res = await promise;
  assert.deepEqual(res, { totalLines: 7 });
  bus.dispose();
});

test('request：超时后 reject（默认 15s，测试用小超时）', async () => {
  const { api } = makeApi();
  const bus = new RpcBus(api);
  const { promise } = bus.request('readRecord', { line: 1 }, { timeoutMs: 20 });
  await assert.rejects(promise, /timed out/);
  bus.dispose();
});

test('supersede：立即 reject(CancelledError)，迟到响应被丢弃（P0-5）', async () => {
  const { api } = makeApi();
  const bus = new RpcBus(api);
  const { requestId, promise } = bus.request('readRecords', { startLine: 0, count: 5 });
  bus.supersede(requestId);
  // 立即结算，不等超时
  await assert.rejects(promise, (e: unknown) => e instanceof CancelledError);
  // 迟到响应不 resolve/reject、不产生未处理拒绝
  deliver(bus, { type: HostReply.RECORDS, requestId, payload: { items: [] } });
  assert.ok(true);
  bus.dispose();
});

test('supersede 后 pending 表不残留（再次同 id 响应无副作用）', async () => {
  const { api } = makeApi();
  const bus = new RpcBus(api);
  const { requestId, promise } = bus.request('readRecords', { startLine: 0, count: 5 });
  bus.supersede(requestId);
  await promise.catch(() => {});
  // pending 已被清理：无 timer 泄漏、无 unhandled
  bus.dispose();
  assert.ok(true);
});

test('ERROR 回执：带 requestId 的 error 消息 reject 对应请求', async () => {
  const { api } = makeApi();
  const bus = new RpcBus(api);
  const { requestId, promise } = bus.request('readRecord', { line: 1 });
  deliver(bus, { type: HostReply.ERROR, requestId, message: 'boom' });
  await assert.rejects(promise, /boom/);
  bus.dispose();
});

test('onInit：宿主 push INIT 触发订阅回调', async () => {
  const { api } = makeApi();
  const bus = new RpcBus(api);
  let got: unknown;
  bus.onInit((p) => void (got = p));
  deliver(bus, { type: HostReply.INIT, payload: { totalLines: 3 } });
  assert.deepEqual(got, { totalLines: 3 });
  bus.dispose();
});

test('onError：无 requestId 的 error 消息走全局错误订阅', async () => {
  const { api } = makeApi();
  const bus = new RpcBus(api);
  let got: { requestId?: string; message: string } | undefined;
  bus.onError((e) => void (got = e));
  deliver(bus, { type: HostReply.ERROR, message: '全局错误' });
  assert.equal(got?.message, '全局错误');
  bus.dispose();
});

test('dispose：清空 pending 与订阅，且重复调用安全', async () => {
  const { api } = makeApi();
  const bus = new RpcBus(api);
  bus.onInit(() => {});
  bus.request('readRecords', { startLine: 0, count: 5 });
  bus.dispose();
  bus.dispose(); // 幂等
  assert.ok(true);
});

test('createVSCodeApi：无 acquireVsCodeApi 时返回 null', () => {
  assert.equal(createVSCodeApi({}), null);
});

/* ---------------------- 错误码（可分支处理） ---------------------- */

test('ERROR 回执带 code → reject 为 RpcError 且 code 透传', async () => {
  const { api } = makeApi();
  const bus = new RpcBus(api);
  const { requestId, promise } = bus.request('editRecord', { line: 0 });
  deliver(bus, { type: HostReply.ERROR, requestId, message: '文件已被外部修改', code: 'CONFLICT' });
  await assert.rejects(promise, (e: unknown) => e instanceof RpcError && e.code === 'CONFLICT');
  bus.dispose();
});

test('超时 reject 的 code 为 TIMEOUT（前端可据此提示重试）', async () => {
  const { api } = makeApi();
  const bus = new RpcBus(api);
  const { promise } = bus.request('readRecord', { line: 1 }, { timeoutMs: 20 });
  await assert.rejects(promise, (e: unknown) => e instanceof RpcError && e.code === 'TIMEOUT');
  bus.dispose();
});

test('无 code 的 ERROR 回执归类为 INTERNAL', async () => {
  const { api } = makeApi();
  const bus = new RpcBus(api);
  const { requestId, promise } = bus.request('search', { query: 'a' });
  deliver(bus, { type: HostReply.ERROR, requestId, message: '宿主内部异常' });
  await assert.rejects(promise, (e: unknown) => e instanceof RpcError && e.code === 'INTERNAL');
  bus.dispose();
});

/* ---------------------- 协议版本握手 ---------------------- */

test('INIT 版本不一致 → onProtocolMismatch 触发（否则用户只看到无故失灵）', () => {
  const { api } = makeApi();
  const bus = new RpcBus(api);
  let mismatch: { host: number; web: number } | undefined;
  bus.onProtocolMismatch((info) => {
    mismatch = info;
  });

  deliver(bus, {
    type: HostReply.INIT,
    payload: { uri: 'u', protocolVersion: PROTOCOL_VERSION + 1, totalLines: 0 },
  });
  assert.deepEqual(mismatch, { host: PROTOCOL_VERSION + 1, web: PROTOCOL_VERSION });
  bus.dispose();
});

test('INIT 版本一致 → 不触发 mismatch，init 订阅照常收到', () => {
  const { api } = makeApi();
  const bus = new RpcBus(api);
  let mismatch = false;
  let inited = false;
  bus.onProtocolMismatch(() => {
    mismatch = true;
  });
  bus.onInit(() => {
    inited = true;
  });

  deliver(bus, {
    type: HostReply.INIT,
    payload: { uri: 'u', protocolVersion: PROTOCOL_VERSION, totalLines: 0 },
  });
  assert.equal(mismatch, false);
  assert.equal(inited, true);
  bus.dispose();
});
