/**
 * selection.test.ts — 多选选区单测（jsdom）。
 *
 * 覆盖三态点击（普通 / Ctrl / Shift）、过滤态下的范围口径、超上限拒绝、
 * 批量复制与批量删除的取消/失败分支。这些都是「删错行」类事故的最后一道闸。
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
// 必须用 node:timers/promises 的 setTimeout：domHarness 把全局 setTimeout 换成了
// unref 版本（为免握手定时器拖住进程），unref 的定时器在事件循环空转时可能永不触发。
import { setTimeout as sleep } from 'node:timers/promises';
import { setupWebviewDom } from './domHarness.ts';
import { createSelection } from '../selection.ts';
import { createAppState } from '../appState.ts';
import { createFocusTarget } from '../focusTarget.ts';
import { RpcBus } from '../rpc.ts';
import type { VSCodeApi } from '../rpc.ts';
import { HostEndpoint, HostReply } from '../../protocol/rpc.ts';
import { MAX_SELECTION_LINES } from '../../constants.ts';

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
  setupWebviewDom(); // selection 会创建 DOM，须先装配伪浏览器环境
  const state = createAppState();
  const { bus, sent } = makeBus();

  const calls = {
    rendered: [] as number[],
    selected: [] as number[],
    clearedList: 0,
    banner: [] as string[],
    shown: [] as number[],
    navUpdates: 0,
    drawer: [] as boolean[],
    bulkDeleted: [] as number[],
  };

  /** 最近一次横幅上的操作回调（「确认删除」按钮即由它触发）。 */
  let lastAction: (() => void) | undefined;

  // 真实 focusTarget：选区与"当前选中行"必须经同一条链路（历史上二者各写一次，极易不一致）
  const focus = createFocusTarget({
    state,
    showDetail: (l) => calls.shown.push(l),
    clearDetail: () => {},
    cancelDetailRequest: () => {},
  });

  const selection = createSelection({
    state,
    bus,
    list: {
      setSelectedLines: (s) => calls.rendered.push(s.size),
      select: (l) => calls.selected.push(l),
      clearAllSelection: () => calls.clearedList++,
    },
    banner: {
      show: (text, _label, onAction) => {
        calls.banner.push(text);
        lastAction = onAction;
      },
    },
    focus,
    updateNavEnabled: () => calls.navUpdates++,
    layout: {
      isNarrow: () => true,
      setDrawer: (open) => calls.drawer.push(open),
    },
    applyBulkDelete: (n) => calls.bulkDeleted.push(n),
  });

  return { state, bus, sent, calls, selection, confirm: () => lastAction?.() };
}

test('selectSingle：选区与详情来源同时设置（二者必须一致）', () => {
  const { state, calls, selection } = boot();
  selection.selectSingle(4);
  assert.deepEqual([...selection.lines], [4]);
  assert.equal(state.selectedLine, 4);
  assert.deepEqual(calls.selected, [4], '列表侧同步选中');
  assert.deepEqual(calls.shown, [4], '选中即展示详情（由写入口一并负责，不再各处各写一遍）');
  assert.equal(calls.navUpdates, 0, '导航可用态仍归渲染层（写入口只管状态一致性）');
});

test('handleSelect：普通点击 = 单选；Ctrl 点击 = 切换（再次点击取消选中）', () => {
  const { selection } = boot();
  selection.handleSelect(1, { ctrl: false, shift: false });
  assert.deepEqual([...selection.lines], [1]);

  selection.handleSelect(2, { ctrl: true, shift: false });
  assert.deepEqual(
    [...selection.lines].toSorted((a, b) => a - b),
    [1, 2]
  );
  selection.handleSelect(1, { ctrl: true, shift: false });
  assert.deepEqual([...selection.lines], [2], 'Ctrl 再点同一行 = 取消该行');

  selection.handleSelect(9, { ctrl: false, shift: false });
  assert.deepEqual([...selection.lines], [9], '普通点击清掉多选');
});

test('handleSelect：Shift 范围选择覆盖两端；窄容器下自动收起目录抽屉', () => {
  const { calls, selection } = boot();
  selection.handleSelect(2, { ctrl: false, shift: false }); // 锚点 2
  selection.handleSelect(5, { ctrl: false, shift: true });

  assert.deepEqual(
    [...selection.lines].toSorted((a, b) => a - b),
    [2, 3, 4, 5]
  );
  assert.equal(calls.drawer.at(-1), false, '选中后收起抽屉，回到详情主视图');
});

test('handleSelect：Shift 范围超上限时拒绝并提示（绝不静默截断）', () => {
  const { calls, selection } = boot();
  selection.handleSelect(0, { ctrl: false, shift: false });
  selection.handleSelect(MAX_SELECTION_LINES + 100, { ctrl: false, shift: true });

  assert.deepEqual([...selection.lines], [0], '超限时选区不变（不给「选了一半」的假象）');
  assert.match(calls.banner.at(-1) ?? '', new RegExp(`最多选择 ${MAX_SELECTION_LINES} 行`));
});

test('handleSelect：过滤态下 Shift 只覆盖当前显示中的行', () => {
  const { state, selection } = boot();
  state.filterMap = [10, 20, 30, 40]; // 展示位 0..3
  selection.handleSelect(10, { ctrl: false, shift: false });
  selection.handleSelect(40, { ctrl: false, shift: true });
  assert.deepEqual(
    [...selection.lines],
    [10, 20, 30, 40],
    '只选结果内的行（不是 10..40 的连续区间）'
  );
});

test('replace：整体替换选区并返回数量（坏行「全选」用）', () => {
  const { selection } = boot();
  assert.equal(selection.replace([3, 5, 7]), 3);
  assert.deepEqual(
    [...selection.lines].toSorted((a, b) => a - b),
    [3, 5, 7]
  );
  assert.equal(selection.replace([]), 0);
  assert.deepEqual([...selection.lines], []);
});

test('clear：只清多选，不动详情来源（两者是两个概念）', () => {
  const { state, calls, selection } = boot();
  selection.selectSingle(2);
  selection.clear();
  assert.deepEqual([...selection.lines], []);
  assert.equal(state.selectedLine, 2, '详情仍停留在原行');
  assert.deepEqual(calls.rendered.at(-1), 0);
});

test('copy：如实回报跳过与截断（静默截断会让用户以为复制全了）', async () => {
  const { bus, sent, calls, selection } = boot();
  selection.replace([1, 2]);
  const p = selection.copy();
  const req = lastReq(sent, HostEndpoint.COPY_LINES)!;
  deliver(bus, {
    type: HostReply.COPY_RESULT,
    requestId: req.requestId,
    payload: { ok: true, count: 1, bytes: 10, truncated: true, skipped: 1 },
  });
  await p;

  const msg = calls.banner.at(-1) ?? '';
  assert.match(msg, /已复制 1 行/);
  assert.match(msg, /1 行因过大跳过/);
  assert.match(msg, /已截断/);
});

test('copy：宿主拒绝时展示原因，不谎报成功', async () => {
  const { bus, sent, calls, selection } = boot();
  selection.replace([1]);
  const p = selection.copy();
  const req = lastReq(sent, HostEndpoint.COPY_LINES)!;
  deliver(bus, {
    type: HostReply.COPY_RESULT,
    requestId: req.requestId,
    payload: { ok: false, count: 0, bytes: 0, truncated: false, skipped: 0, error: '无权限' },
  });
  await p;
  assert.equal(calls.banner.at(-1), '无权限');
});

test('confirmDelete：未确认前绝不落盘；文案写明影响的行数', () => {
  const { sent, calls, selection } = boot();
  selection.replace([1, 2]);
  selection.confirmDelete();

  assert.match(calls.banner.at(-1) ?? '', /确定删除 2 行/, '不可逆写入必须先问一句');
  assert.equal(lastReq(sent, HostEndpoint.DELETE_RECORDS), undefined, '未确认前不发请求');
});

test('confirmDelete：取消（cancelled）如实说「文件未被修改」，不报成失败', async () => {
  const { bus, sent, calls, selection, confirm } = boot();
  selection.replace([1, 2]);
  selection.confirmDelete();
  confirm();
  await sleep(1);

  const req = lastReq(sent, HostEndpoint.DELETE_RECORDS)!;
  deliver(bus, {
    type: HostReply.DELETE_MANY_RESULT,
    requestId: req.requestId,
    payload: {
      ok: false,
      deleted: 0,
      ranges: 0,
      bytesDelta: 0,
      costMs: 0,
      skipped: 0,
      cancelled: true,
    },
  });
  await sleep(1);

  assert.match(calls.banner.at(-1) ?? '', /已取消：文件未被修改/);
  assert.deepEqual(calls.bulkDeleted, [], '取消不得触发复位（文件并未改动）');
});

test('confirmDelete：失败时展示原因，不触发复位', async () => {
  const { bus, sent, calls, selection, confirm } = boot();
  selection.replace([1]);
  selection.confirmDelete();
  confirm();
  await sleep(1);
  const req = lastReq(sent, HostEndpoint.DELETE_RECORDS)!;
  deliver(bus, {
    type: HostReply.DELETE_MANY_RESULT,
    requestId: req.requestId,
    payload: {
      ok: false,
      deleted: 0,
      ranges: 0,
      bytesDelta: 0,
      costMs: 0,
      skipped: 0,
      error: '空间不足',
    },
  });
  await sleep(1);

  assert.equal(calls.banner.at(-1), '空间不足');
  assert.deepEqual(calls.bulkDeleted, []);
});

test('confirmDelete：成功即调用批量删除复位，并按升序发送选区', async () => {
  const { bus, sent, calls, selection, state, confirm } = boot();
  state.selectedLine = 5;
  selection.replace([3, 1, 2]);
  selection.confirmDelete();
  confirm();
  await sleep(1);

  const req = lastReq(sent, HostEndpoint.DELETE_RECORDS)!;
  assert.deepEqual(req.lines, [1, 2, 3], '按升序发送选区');
  deliver(bus, {
    type: HostReply.DELETE_MANY_RESULT,
    requestId: req.requestId,
    payload: { ok: true, deleted: 3, ranges: 1, bytesDelta: -30, costMs: 2, skipped: 0 },
  });
  await sleep(1);

  assert.deepEqual(calls.bulkDeleted, [3], '删除后进入整体复位流程');
  assert.match(calls.banner.at(-1) ?? '', /已删除 3 行/);
});

after(() => {
  for (const bus of buses) bus.dispose();
});
