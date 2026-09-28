/**
 * badLinesOps.test.ts — 前端坏行诊断域单测（jsdom）。
 *
 * 覆盖三条不变式：
 *   · 徽章刷新失败**静默**（辅助信息不打扰主流程），扫描的取消则必须如实反映；
 *   · 扫描取消**只发 CANCEL、不 settle 本地 Promise**，且不把半份结果写进徽章；
 *   · 坏行「全选」超上限**拒绝而非截断**（静默截断会让人以为坏行都选上了）。
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupWebviewDom } from './domHarness.ts';
import { createBadLinesOps } from '../badLinesOps.ts';
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

const badLinesPayload = (lines: number[], partial = true) => ({
  lines,
  partial,
  scanned: 0,
  totalLines: 10,
  truncated: false,
});

function boot() {
  setupWebviewDom(); // 面板会创建 DOM
  const state = createAppState();
  const { bus, sent } = makeBus();

  const calls = {
    badges: [] as { count: number; partial: boolean }[],
    banner: [] as string[],
    replaced: [] as number[][],
    selected: [] as number[],
    scrolled: [] as number[],
    shown: [] as number[],
    nav: 0,
    activeScan: [] as (string | null)[],
  };
  let lastAction: (() => void) | undefined;

  const focus = createFocusTarget({
    state,
    showDetail: (l) => calls.shown.push(l),
    clearDetail: () => {},
    cancelDetailRequest: () => {},
  });

  const ops = createBadLinesOps({
    bus,
    list: {
      select: (l) => calls.selected.push(l),
      scrollToLine: (l) => calls.scrolled.push(l),
    },
    toolbar: { update: (info) => calls.badges.push(info.badLines) },
    banner: {
      show: (text, _label, onAction) => {
        calls.banner.push(text);
        lastAction = onAction;
      },
    },
    selection: {
      replace: (lines) => {
        calls.replaced.push([...lines]);
        return lines.length;
      },
      selectSingle: (l) => calls.selected.push(l),
    },
    focus,
    updateNavEnabled: () => calls.nav++,
    setActiveScan: (rid) => calls.activeScan.push(rid),
  });

  /** 按文本找面板内的按钮（面板无专用 class，按文案定位最稳）。 */
  const buttonByText = (text: string): HTMLButtonElement | undefined =>
    Array.from(ops.root.querySelectorAll('button')).find((b) => b.textContent?.includes(text));

  return { state, bus, sent, calls, ops, buttonByText, cancelBanner: () => lastAction?.() };
}

test('refresh：取回计数即更新徽章（含 partial 如实透传）', async () => {
  const { bus, sent, calls, ops } = boot();
  const p = ops.refresh();
  const req = lastReq(sent, HostEndpoint.GET_BAD_LINES)!;
  deliver(bus, {
    type: HostReply.BAD_LINES,
    requestId: req.requestId,
    payload: badLinesPayload([1, 5], false),
  });
  await p;

  assert.deepEqual(calls.badges.at(-1), { count: 2, partial: false });
});

test('refresh：失败静默 —— 辅助信息不该弹错误横幅', async () => {
  const { bus, sent, calls, ops } = boot();
  const p = ops.refresh();
  const req = lastReq(sent, HostEndpoint.GET_BAD_LINES)!;
  deliver(bus, { type: HostReply.ERROR, requestId: req.requestId, message: '宿主未实现' });
  await p;

  assert.deepEqual(calls.badges, [], '取不到就不显示徽章');
  assert.deepEqual(calls.banner, [], '不得打扰用户');
});

test('scheduleRefresh：防抖后再拉取（滚动会连续触发读批）', async () => {
  const { sent, calls, ops } = boot();
  ops.scheduleRefresh();
  ops.scheduleRefresh();
  ops.scheduleRefresh();
  assert.equal(lastReq(sent, HostEndpoint.GET_BAD_LINES), undefined, '防抖窗口内不发请求');

  await sleep(520); // 防抖 400ms + 余量
  assert.ok(lastReq(sent, HostEndpoint.GET_BAD_LINES), '防抖落定后拉取一次');
  assert.deepEqual(calls.banner, []);
});

test('scan：请求 → 记录在途标记 → 结果直接写徽章（省一次往返）', async () => {
  const { bus, sent, calls, ops } = boot();
  // 面板里的「扫描整个文件」按钮即扫描入口
  ops.open();
  await sleep(5);
  const btn = Array.from(ops.root.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('扫描')
  )!;
  btn.click();
  await sleep(5);

  const req = lastReq(sent, HostEndpoint.SCAN_BAD_LINES)!;
  assert.ok(req, '必须发扫描请求');
  assert.deepEqual(calls.activeScan, [req.requestId], '在途标记供进度横幅使用');
  assert.match(calls.banner.at(-1) ?? '', /坏行|扫描/, '扫描期间横幅带进度与取消');

  deliver(bus, {
    type: HostReply.BAD_LINES,
    requestId: req.requestId,
    payload: badLinesPayload([2, 4, 6], false),
  });
  await sleep(5);

  assert.deepEqual(calls.badges.at(-1), { count: 3, partial: false }, '结果直接更新徽章');
  assert.deepEqual(calls.activeScan, [req.requestId, null], '收尾必须摘除在途标记');
});

test('scan：取消（cancelled）不得把半份结果写进徽章', async () => {
  const { bus, sent, calls, ops } = boot();
  ops.open();
  await sleep(5);
  Array.from(ops.root.querySelectorAll('button'))
    .find((b) => b.textContent?.includes('扫描'))!
    .click();
  await sleep(5);

  const req = lastReq(sent, HostEndpoint.SCAN_BAD_LINES)!;
  deliver(bus, {
    type: HostReply.BAD_LINES,
    requestId: req.requestId,
    payload: { ...badLinesPayload([1, 2]), cancelled: true },
  });
  await sleep(5);

  assert.deepEqual(calls.badges, [], '取消的结果不更新徽章（那是半份答案）');
  assert.deepEqual(calls.activeScan, [req.requestId, null]);
});

test('坏行「全选」：正常写入选区并落到首行', async () => {
  const { bus, sent, calls, ops, buttonByText } = boot();
  ops.open();
  await sleep(5);
  // 让面板拿到坏行列表
  const req = lastReq(sent, HostEndpoint.GET_BAD_LINES)!;
  deliver(bus, {
    type: HostReply.BAD_LINES,
    requestId: req.requestId,
    payload: badLinesPayload([3, 7], false),
  });
  await sleep(10);

  buttonByText('全选坏行')?.click();
  await sleep(5);

  assert.deepEqual(calls.replaced.at(-1), [3, 7]);
  assert.equal(calls.selected.at(-1), 3, '视口落到首个坏行');
});

test('坏行「全选」：超上限一律拒绝，绝不静默截断', async () => {
  const { bus, sent, calls, ops, buttonByText } = boot();
  ops.open();
  await sleep(5);
  const req = lastReq(sent, HostEndpoint.GET_BAD_LINES)!;
  const many = Array.from({ length: MAX_SELECTION_LINES + 1 }, (_, i) => i);
  deliver(bus, {
    type: HostReply.BAD_LINES,
    requestId: req.requestId,
    payload: badLinesPayload(many, false),
  });
  await sleep(10);

  buttonByText('全选坏行')?.click();
  await sleep(5);

  assert.deepEqual(calls.replaced, [], '超限不得写入选区（半份选择会让人删错行）');
  assert.match(calls.banner.at(-1) ?? '', /超过单次选择上限/);
});

test('dispose：清理防抖定时器与面板，重复调用安全', () => {
  const { ops } = boot();
  ops.scheduleRefresh();
  assert.doesNotThrow(() => {
    ops.dispose();
    ops.dispose();
  });
});

after(() => {
  for (const bus of buses) bus.dispose();
});
