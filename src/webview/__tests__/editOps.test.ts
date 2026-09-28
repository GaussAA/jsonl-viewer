/**
 * editOps.test.ts — 写操作域单测（编辑 / 删除 / 批量替换 / 写后复位）。
 *
 * 迁出装配层后这块的每条不变式都能脱离 DOM 直接验证：
 *   · 编辑框必须用**磁盘原文**（不是重新序列化的值）；
 *   · 行增删后整体清缓存 + 锚点位移 + 越界收敛；
 *   · 写后必须用宿主权威概览校正行数（本地只是乐观推算）；
 *   · 取消与失败必须分开报（取消 = 文件未被修改）。
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createEditOps } from '../editOps.ts';
import { createAppState } from '../appState.ts';
import { createFocusTarget } from '../focusTarget.ts';
import { RpcBus } from '../rpc.ts';
import type { VSCodeApi } from '../rpc.ts';
import { HostEndpoint, HostReply, PROTOCOL_VERSION } from '../../protocol/rpc.ts';
import type { OverviewPayload } from '../../protocol/rpc.ts';

/**
 * 本文件创建的所有 bus（供末尾统一 dispose）。
 *
 * 为何必须收口：editOps 内的请求一律用 `RPC_HEAVY_TIMEOUT_MS`（120s）——
 * 未回执的请求（如写后的 refreshOverview）会留下 120 秒的超时定时器，
 * 进程因此不肯退出，整个测试文件表现为「用例全过但卡住不结束」。
 */
const buses: RpcBus[] = [];

/** 收集 webview→宿主消息，并可直接把宿主回执塞回 bus。 */
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

function deliver(bus: RpcBus, data: unknown): void {
  (bus as unknown as { onMessage(e: { data?: unknown }): void }).onMessage({ data });
}

const overview = (totalRecords: number): OverviewPayload => ({
  uri: 'file:///a.jsonl',
  protocolVersion: PROTOCOL_VERSION,
  totalLines: totalRecords,
  totalRecords,
  totalBytes: totalRecords * 10,
  buildMs: 1,
  eof: true,
});

/** 最后一条发往宿主的某类请求。 */
const lastReq = (
  sent: Record<string, unknown>[],
  type: string
): Record<string, unknown> | undefined => [...sent].toReversed().find((m) => m.type === type);

function boot(totalRecords = 5) {
  const state = createAppState();
  state.overview = overview(totalRecords);
  const { bus, sent } = makeBus();

  const calls = {
    setTotalRows: [] as number[],
    selected: [] as number[],
    refreshed: 0,
    /** 注入的 clearSelection（selection 模块）被调用次数。 */
    clearedSelection: 0,
    /** 列表自身的 clearAllSelection 被调用次数（与上面是两个不同的出口）。 */
    listClearedSelection: 0,
    detailCleared: 0,
    editPanelOpened: [] as { line: number; text: string }[],
    banner: [] as { text: string; label?: string }[],
    bannerHidden: 0,
    replaceToggle: [] as boolean[],
    replaceBusy: [] as boolean[],
    shown: [] as number[],
    toolbarUpdates: 0,
    badgeRefreshes: 0,
    activeReplace: [] as (string | null)[],
    filters: 0,
    searches: [] as string[],
  };

  let bannerAction: (() => void) | undefined;

  // 真实 focusTarget：行增删的位移/收敛与复位都必须经"选中行唯一写入口"
  const focus = createFocusTarget({
    state,
    showDetail: (l) => calls.shown.push(l),
    clearDetail: () => calls.detailCleared++,
    cancelDetailRequest: () => {},
  });

  const editOps = createEditOps({
    state,
    bus,
    list: {
      setTotalRows: (n) => calls.setTotalRows.push(n),
      select: (l) => calls.selected.push(l),
      refresh: () => calls.refreshed++,
      clearAllSelection: () => calls.listClearedSelection++,
    },
    editPanel: { open: (line, text) => calls.editPanelOpened.push({ line, text }) },
    focus,
    banner: {
      show: (text, label, onAction) => {
        calls.banner.push({ text, ...(label ? { label } : {}) });
        bannerAction = onAction;
      },
      hide: () => calls.bannerHidden++,
    },
    toolbar: {
      toggleReplace: (open) => calls.replaceToggle.push(open),
      setReplaceBusy: (busy) => calls.replaceBusy.push(busy),
    },
    showDetailForLine: (l) => calls.shown.push(l),
    updateToolbar: () => calls.toolbarUpdates++,
    scheduleBadLinesRefresh: () => calls.badgeRefreshes++,
    clearSelection: () => calls.clearedSelection++,
    setActiveReplace: (rid) => calls.activeReplace.push(rid),
    rerunFilter: () => calls.filters++,
    rerunSearch: (q) => calls.searches.push(q),
  });

  return { state, bus, sent, calls, editOps, confirm: () => bannerAction?.() };
}

test('openEditForLine：用磁盘原文打开编辑框（不是重新序列化的值）', async () => {
  const { bus, sent, calls, editOps } = boot();
  const p = editOps.openEditForLine(2);

  const req = lastReq(sent, HostEndpoint.READ_RECORD);
  assert.ok(req, '必须发 READ_RECORD 取原文');
  assert.equal(req.line, 2);
  deliver(bus, {
    type: HostReply.RESULT,
    requestId: req.requestId,
    payload: { ok: true, rawText: '{ "a" : 1 }', rawBytes: 11 },
  });
  await p;

  assert.deepEqual(
    calls.editPanelOpened,
    [{ line: 2, text: '{ "a" : 1 }' }],
    '原文逐字节保留（键序与空白不变）'
  );
  assert.equal(editOps.getExpectedBytes(), 11, '乐观锁断言值 = 原文字节数');
});

test('openEditForLine：拿不到原文就如实提示，绝不打开空编辑框', async () => {
  const { bus, sent, calls, editOps } = boot();
  const p = editOps.openEditForLine(0);
  const req = lastReq(sent, HostEndpoint.READ_RECORD)!;
  deliver(bus, {
    type: HostReply.RESULT,
    requestId: req.requestId,
    payload: { ok: false, error: '该行过大' },
  });
  await p;

  assert.deepEqual(calls.editPanelOpened, [], '无原文不得打开编辑框');
  assert.match(calls.banner.at(-1)?.text ?? '', /该行过大/);
});

test('openEditForLine：宿主异常被兜住，不外溢成未处理拒绝', async () => {
  const { bus, sent, calls, editOps } = boot();
  const p = editOps.openEditForLine(0);
  const req = lastReq(sent, HostEndpoint.READ_RECORD)!;
  deliver(bus, { type: HostReply.ERROR, requestId: req.requestId, message: '磁盘读失败' });
  await p;
  assert.match(calls.banner.at(-1)?.text ?? '', /磁盘读失败/);
});

test('applyRowCountChange：插入后锚点落到新行；删除后其后锚点前移并收敛越界', () => {
  const a = boot(5);
  a.state.selectedLine = 1;
  a.editOps.applyRowCountChange(3, 'insert');
  assert.equal(a.state.overview?.totalRecords, 6);
  assert.equal(a.state.selectedLine, 3, '光标停在新行（编辑器习惯）');

  const b = boot(5);
  b.state.selectedLine = 4; // 末行
  b.editOps.applyRowCountChange(2, 'delete');
  assert.equal(b.state.overview?.totalRecords, 4);
  assert.equal(b.state.selectedLine, 3, '末行被删 → 选中收敛到新的末行');
});

test('refreshOverview：用宿主权威值校正行数；失败时静默（不打扰用户）', async () => {
  const { bus, sent, calls, editOps, state } = boot(5);
  state.selectedLine = 4;
  const p = editOps.refreshOverview();
  const req = lastReq(sent, HostEndpoint.GET_OVERVIEW)!;
  deliver(bus, {
    type: HostReply.RESULT,
    requestId: req.requestId,
    payload: overview(3), // 宿主说只有 3 行（例如批量删除跳过了一些）
  });
  await p;

  assert.equal(state.overview?.totalRecords, 3);
  assert.deepEqual(calls.setTotalRows, [3]);
  assert.equal(state.selectedLine, 2, '选中行越界 → 收敛到末行');

  // 失败路径：静默，不弹横幅
  const b = boot(5);
  const p2 = b.editOps.refreshOverview();
  const req2 = lastReq(b.sent, HostEndpoint.GET_OVERVIEW)!;
  deliver(b.bus, { type: HostReply.ERROR, requestId: req2.requestId, message: 'boom' });
  await p2;
  assert.deepEqual(b.calls.banner, [], '校正失败不应弹横幅');
});

test('deleteRecordAt：二次确认 → 删除成功 → 复位并取权威行数', async () => {
  const { bus, sent, calls, editOps, confirm } = boot(5);
  editOps.deleteRecordAt(1);
  assert.match(calls.banner.at(-1)?.text ?? '', /确定删除第 2 行/, '删除是不可逆写入，必须先问');
  assert.equal(calls.banner.at(-1)?.label, '确认删除');

  confirm();
  await new Promise((r) => setTimeout(r, 0));
  const req = lastReq(sent, HostEndpoint.DELETE_RECORD)!;
  assert.equal(req.line, 1);
  deliver(bus, {
    type: HostReply.EDIT_RESULT,
    requestId: req.requestId,
    payload: { ok: true, line: 1, bytesDelta: -10, inPlace: false, movedBytes: 20, costMs: 1 },
  });
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(calls.bannerHidden, 1);
  assert.ok(calls.refreshed > 0, '列表重绘');
  assert.ok(lastReq(sent, HostEndpoint.GET_OVERVIEW), '写后必须校正行数');
});

test('deleteRecordAt：失败时展示结构化原因，不假装成功', async () => {
  const { bus, sent, calls, editOps, confirm } = boot(5);
  editOps.deleteRecordAt(0);
  confirm();
  await new Promise((r) => setTimeout(r, 0));
  const req = lastReq(sent, HostEndpoint.DELETE_RECORD)!;
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
      error: '权限不足',
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.match(calls.banner.at(-1)?.text ?? '', /权限不足/);
});

test('replaceAll：空查询直接拒绝并打开替换框（不空跑一次全文件重写）', () => {
  const { sent, calls, editOps } = boot();
  editOps.replaceAll('   ', 'x');
  assert.deepEqual(calls.replaceToggle, [true]);
  assert.equal(lastReq(sent, HostEndpoint.REPLACE_TEXT), undefined);
});

test('replaceAll：取消与失败分开报（取消 = 文件未被修改）', async () => {
  const { bus, sent, calls, editOps, confirm } = boot();
  editOps.replaceAll('a', 'b');
  confirm();
  await new Promise((r) => setTimeout(r, 0));
  const req = lastReq(sent, HostEndpoint.REPLACE_TEXT)!;
  assert.equal(req.query, 'a');
  assert.deepEqual(
    calls.activeReplace.at(-1),
    req.requestId,
    '在途请求被记录（进度与取消据此工作）'
  );

  deliver(bus, {
    type: HostReply.REPLACE_RESULT,
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
  await new Promise((r) => setTimeout(r, 0));
  assert.match(calls.banner.at(-1)?.text ?? '', /已取消：文件未被修改/);
  assert.deepEqual(calls.activeReplace.at(-1), null, '收尾必须摘除在途标记');
});

test('replaceAll：成功后重跑搜索/过滤并如实报出跳过的行数', async () => {
  const { bus, sent, calls, editOps, confirm, state } = boot();
  state.filterCond = { field: 'a', op: 'eq', value: '1' };
  editOps.replaceAll('a', 'b');
  confirm();
  await new Promise((r) => setTimeout(r, 0));
  const req = lastReq(sent, HostEndpoint.REPLACE_TEXT)!;
  deliver(bus, {
    type: HostReply.REPLACE_RESULT,
    requestId: req.requestId,
    payload: {
      ok: true,
      replaced: 3,
      skippedInvalid: 2,
      unchanged: 1,
      total: 6,
      bytesDelta: 0,
      costMs: 5,
      undoable: true,
    },
  });
  await new Promise((r) => setTimeout(r, 0));

  assert.deepEqual(calls.searches, ['a'], '内容变了 → 命中计数须重算');
  assert.equal(calls.filters, 1, '有过滤条件 → 过滤结果须重算');
  assert.equal(calls.badgeRefreshes, 1, '可能把坏行改好 → 徽章须刷新');
  assert.match(calls.banner.at(-1)?.text ?? '', /2/, '跳过行数必须出现在结果文案里');
});

test('applyBulkDelete：整体复位 + 取宿主权威行数（不能只减 N）', async () => {
  const { bus, sent, calls, editOps, state } = boot(10);
  state.selectedLine = 3;
  state.detailRaw = { text: '{"a":1}', bytes: 7 };
  editOps.applyBulkDelete(4);

  assert.equal(calls.clearedSelection, 1, '选区状态清空');
  assert.equal(calls.listClearedSelection, 1, '列表侧选中态清空');
  assert.equal(calls.detailCleared, 1, '详情清空');
  assert.equal(state.detailRaw, null, '原文作废，避免对已消失的行发起字段编辑');
  assert.equal(state.overview?.totalRecords, 6, '本地先乐观减 N');

  const req = lastReq(sent, HostEndpoint.GET_OVERVIEW);
  assert.ok(req, '随后必须用宿主权威值校正');
  deliver(bus, {
    type: HostReply.RESULT,
    requestId: req.requestId,
    payload: overview(7), // 宿主实际只删掉 3 行（有 1 行因过大跳过）
  });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(state.overview?.totalRecords, 7, '以宿主为准，而非本地推算');
});

// 文件级收尾：清掉所有在途请求的超时定时器（否则进程不肯退出，整个文件卡住）。
after(() => {
  for (const bus of buses) bus.dispose();
});
