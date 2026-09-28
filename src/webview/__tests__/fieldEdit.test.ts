/**
 * fieldEdit.test.ts — 字段级编辑域单测（jsdom）。
 *
 * 覆盖两条不变式：
 *   · 必须基于**磁盘原文**定位（拿不到原文一律明确拒绝，绝不猜）；
 *   · 落盘复用整行编辑链路（`EDIT_RECORD` + 乐观锁），成功后后台重拉详情。
 * 另覆盖批量字段替换的确认 → 取消/成功分支（走真实浮层 DOM 驱动）。
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupWebviewDom } from './domHarness.ts';
import { createFieldEdit } from '../fieldEdit.ts';
import { createAppState } from '../appState.ts';
import { RpcBus } from '../rpc.ts';
import type { VSCodeApi } from '../rpc.ts';
import { HostEndpoint, HostReply } from '../../protocol/rpc.ts';
import type { DetailTreeNavHandlers } from '../detailTree.ts';

const buses: RpcBus[] = [];

function makeBus(): { bus: RpcBus; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const api: VSCodeApi = {
    postMessage: (m) => void sent.push(m as Record<string, unknown>),
    getState: () => undefined,
    setState: () => {},
  };
  const bus = new RpcBus(api);
  buses.push(bus);
  return { bus, sent };
}

const deliver = (bus: RpcBus, data: unknown): void => {
  (bus as unknown as { onMessage(e: { data?: unknown }): void }).onMessage({ data });
};

const lastReq = (
  sent: Record<string, unknown>[],
  type: string
): Record<string, unknown> | undefined => [...sent].toReversed().find((m) => m.type === type);

function boot() {
  setupWebviewDom(); // 字段浮层需要真实 DOM
  const state = createAppState();
  const { bus, sent } = makeBus();
  const navHandlers: DetailTreeNavHandlers = {};

  const calls = {
    banner: [] as string[],
    refreshed: 0,
    toolbarUpdates: 0,
    badgeRefreshes: 0,
    shown: [] as number[],
    activeFieldReplace: [] as (string | null)[],
  };
  let lastAction: (() => void) | undefined;

  const fieldEdit = createFieldEdit({
    state,
    bus,
    list: { refresh: () => calls.refreshed++ },
    banner: {
      show: (text, _label, onAction) => {
        calls.banner.push(text);
        lastAction = onAction;
      },
    },
    navHandlers,
    showDetailForLine: (l) => calls.shown.push(l),
    updateToolbar: () => calls.toolbarUpdates++,
    scheduleBadLinesRefresh: () => calls.badgeRefreshes++,
    setActiveFieldReplace: (rid) => calls.activeFieldReplace.push(rid),
  });

  return { state, bus, sent, calls, navHandlers, fieldEdit, confirm: () => lastAction?.() };
}

const seg = (key: string) => ({ kind: 'key' as const, key });

test('onEditField：没有磁盘原文时明确拒绝，绝不打开编辑浮层', () => {
  const { state, calls, navHandlers, fieldEdit } = boot();
  state.detailRaw = null;
  navHandlers.onEditField?.([seg('a')], 1);

  assert.match(calls.banner.at(-1) ?? '', /原文不可用/);
  assert.equal(fieldEdit.isOpen(), false, '拿不到原文就不能猜（否则会改错行）');
});

test('onEditField：有原文则打开浮层', () => {
  const { state, navHandlers, fieldEdit } = boot();
  state.selectedLine = 0;
  state.detailRaw = { text: '{"a":1}', bytes: 7 };
  navHandlers.onEditField?.([seg('a')], 1);
  assert.equal(fieldEdit.isOpen(), true);
});

test('onInlineEdit：没有原文时拒绝（返回错误而非静默）', () => {
  const { state, navHandlers } = boot();
  state.detailRaw = null;
  const res = navHandlers.onInlineEdit?.([seg('a')], 1, 2);
  assert.deepEqual(res, { ok: false, error: '该记录的原文不可用，无法定位字段。' });
});

test('onInlineEdit：路径在原文里不存在时如实报错，不发请求', async () => {
  const { state, sent, navHandlers } = boot();
  state.selectedLine = 0;
  state.detailRaw = { text: '{"a":1}', bytes: 7 };

  const res = await navHandlers.onInlineEdit?.([seg('missing')], 1, 2);
  assert.equal(res?.ok, false);
  assert.match(res?.error ?? '', /不存在|无法定位|找不到/);
  assert.equal(lastReq(sent, HostEndpoint.EDIT_RECORD), undefined, '定位失败不得写盘');
});

test('onInlineEdit：成功路径 —— 原文精确替换 + 乐观锁 + 后台重拉详情', async () => {
  const { state, bus, sent, calls, navHandlers } = boot();
  state.selectedLine = 3;
  // 原文保留用户格式（键序、空格）：字段编辑只替换目标值那一段字节
  state.detailRaw = { text: '{ "a" : 1, "b" : "x" }', bytes: 23 };

  const p = navHandlers.onInlineEdit?.([seg('a')], 1, 42) as Promise<{ ok: boolean }>;
  const req = lastReq(sent, HostEndpoint.EDIT_RECORD)!;
  assert.equal(req.line, 3);
  assert.equal(req.expectedBytes, 23, '乐观锁断言 = 磁盘原文字节数');
  assert.equal(req.text, '{ "a" : 42, "b" : "x" }', '只替换目标值，其余逐字节不变');

  deliver(bus, {
    type: HostReply.EDIT_RESULT,
    requestId: req.requestId,
    payload: { ok: true, line: 3, bytesDelta: 1, inPlace: false, movedBytes: 0, costMs: 1 },
  });
  const res = await p;

  assert.deepEqual(res, { ok: true });
  assert.equal(calls.refreshed, 1, '该行缓存失效 → 列表重绘');
  assert.deepEqual(calls.shown, [3], '后台重拉详情（原文随之更新，供下次编辑定位）');
  assert.equal(calls.badgeRefreshes, 1, '可能把坏行改好 → 徽章刷新');
});

test('onInlineEdit：宿主拒绝时把失败原因原样带回', async () => {
  const { state, bus, sent, navHandlers } = boot();
  state.selectedLine = 0;
  state.detailRaw = { text: '{"a":1}', bytes: 7 };

  const p = navHandlers.onInlineEdit?.([seg('a')], 1, 2) as Promise<{
    ok: boolean;
    error?: string;
  }>;
  const req = lastReq(sent, HostEndpoint.EDIT_RECORD)!;
  deliver(bus, {
    type: HostReply.EDIT_RESULT,
    requestId: req.requestId,
    payload: {
      ok: false,
      line: 0,
      bytesDelta: 0,
      inPlace: false,
      movedBytes: 0,
      costMs: 0,
      error: '该行内容已变化（与编辑前视图不一致），请重新加载。',
      conflict: true,
    },
  });
  const res = await p;
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /内容已变化/);
});

test('批量字段替换：确认后才落盘；取消时如实说「文件未被修改」', async () => {
  const { state, bus, sent, calls, navHandlers, confirm, fieldEdit } = boot();
  state.selectedLine = 0;
  state.overview = {
    uri: 'file:///a.jsonl',
    protocolVersion: 1,
    totalLines: 2,
    totalRecords: 2,
    totalBytes: 100,
    buildMs: 1,
    eof: true,
  };
  state.detailRaw = { text: '{"a":1}', bytes: 7 };

  // 走真实浮层：打开 → 勾「同时更新其他行」→ 保存
  navHandlers.onEditField?.([seg('a')], 1);
  const root = fieldEdit.root;
  const applyAll = root.querySelector<HTMLInputElement>('.jlv-field-applyall input')!;
  applyAll.checked = true;
  root.querySelector<HTMLButtonElement>('.jlv-field-save')!.click();
  await sleep(5);

  assert.match(calls.banner.at(-1) ?? '', /确认替换|替换/, '批量是不可逆写入，必须先确认');
  assert.equal(lastReq(sent, HostEndpoint.REPLACE_FIELD), undefined, '未确认前不得落盘');

  confirm();
  await sleep(5);
  const req = lastReq(sent, HostEndpoint.REPLACE_FIELD)!;
  assert.deepEqual(req.path, ['a']);
  assert.deepEqual(
    calls.activeFieldReplace.at(-1),
    req.requestId,
    '在途请求被记录（进度与取消据此工作）'
  );

  deliver(bus, {
    type: HostReply.REPLACE_FIELD_RESULT,
    requestId: req.requestId,
    payload: {
      ok: false,
      replaced: 0,
      skippedInvalid: 0,
      unchanged: 0,
      total: 0,
      bytesDelta: 0,
      costMs: 0,
      undoable: false,
      cancelled: true,
    },
  });
  await sleep(5);

  assert.match(calls.banner.at(-1) ?? '', /已取消：文件未被修改/);
  assert.deepEqual(calls.activeFieldReplace.at(-1), null, '收尾必须摘除在途标记');
  assert.deepEqual(calls.shown, [], '取消不得重拉详情（文件未改动）');
});

test('批量字段替换：成功后整体清缓存、重拉详情并给出结果统计', async () => {
  const { state, bus, sent, calls, navHandlers, confirm, fieldEdit } = boot();
  state.selectedLine = 1;
  state.overview = {
    uri: 'file:///a.jsonl',
    protocolVersion: 1,
    totalLines: 3,
    totalRecords: 3,
    totalBytes: 300,
    buildMs: 1,
    eof: true,
  };
  state.detailRaw = { text: '{"a":1}', bytes: 7 };
  state.cache.set(0, { ok: true, line: 0 } as never);

  navHandlers.onEditField?.([seg('a')], 1);
  const root = fieldEdit.root;
  root.querySelector<HTMLInputElement>('.jlv-field-applyall input')!.checked = true;
  root.querySelector<HTMLButtonElement>('.jlv-field-save')!.click();
  await sleep(5);
  confirm();
  await sleep(5);

  const req = lastReq(sent, HostEndpoint.REPLACE_FIELD)!;
  deliver(bus, {
    type: HostReply.REPLACE_FIELD_RESULT,
    requestId: req.requestId,
    payload: {
      ok: true,
      replaced: 2,
      skippedInvalid: 0,
      unchanged: 1,
      total: 3,
      bytesDelta: 0,
      costMs: 3,
      undoable: true,
    },
  });
  await sleep(5);

  assert.equal(state.cache.size, 0, '改动可能散落全文件 → 缓存整体清空');
  assert.deepEqual(calls.shown, [1], '重拉当前详情');
  assert.ok((calls.banner.at(-1) ?? '').length > 0, '结果统计走横幅（含替换行数）');
});

after(() => {
  for (const bus of buses) bus.dispose();
});
