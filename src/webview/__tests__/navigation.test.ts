/**
 * navigation.test.ts — 详情导航（上一条 / 下一条）单测。
 *
 * 迁出装配层后，这块纯状态推导可脱离 DOM 直接驱动：边界可用态、无选中时的行为、
 * 过滤态下「只在结果内移动」的口径 —— 三条都曾有歧义，必须以测试钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNavigation } from '../navigation.ts';
import { createAppState } from '../appState.ts';
import { createFocusTarget } from '../focusTarget.ts';
import type { DetailTreeNavHandlers } from '../detailTree.ts';
import type { OverviewPayload } from '../../protocol/rpc.ts';
import { PROTOCOL_VERSION } from '../../protocol/rpc.ts';

const overview = (totalRecords: number): OverviewPayload => ({
  uri: 'file:///a.jsonl',
  protocolVersion: PROTOCOL_VERSION,
  totalLines: totalRecords,
  totalRecords,
  totalBytes: totalRecords * 10,
  buildMs: 1,
  eof: true,
});

function boot(totalRecords: number, filterMap: number[] | null = null) {
  const state = createAppState();
  state.overview = overview(totalRecords);
  state.filterMap = filterMap;

  const focused: number[] = [];
  const enabled: [boolean, boolean][] = [];
  const shown: number[] = [];
  const edited: number[] = [];
  const navHandlers: DetailTreeNavHandlers = {};

  // 真实 focusTarget + 假 showDetail：导航必须经"选中行唯一写入口"，顺带验证它会拉详情
  const focus = createFocusTarget({
    state,
    showDetail: (l) => shown.push(l),
    clearDetail: () => {},
    cancelDetailRequest: () => {},
  });

  const nav = createNavigation({
    state,
    list: { focus: (l) => focused.push(l) },
    detail: { setNavEnabled: (p, n) => enabled.push([p, n]) },
    navHandlers,
    focus,
    openEditForLine: (l) => edited.push(l),
  });

  return { state, nav, navHandlers, focused, enabled, shown, edited };
}

test('导航：空文件时两侧都禁用', () => {
  const { nav, enabled } = boot(0);
  nav.updateNavEnabled();
  assert.deepEqual(enabled.at(-1), [false, false]);
});

test('导航：无选中时两侧都放行（否则面板成了死路）', () => {
  const { nav, enabled } = boot(5);
  nav.updateNavEnabled();
  assert.deepEqual(enabled.at(-1), [true, true]);
});

test('导航：首行禁用「上一条」，末行禁用「下一条」', () => {
  const a = boot(5);
  a.state.selectedLine = 0;
  a.nav.updateNavEnabled();
  assert.deepEqual(a.enabled.at(-1), [false, true]);

  const b = boot(5);
  b.state.selectedLine = 4;
  b.nav.updateNavEnabled();
  assert.deepEqual(b.enabled.at(-1), [true, false]);
});

test('导航：无选中时按「下一条」从头开始、「上一条」从尾开始', () => {
  const a = boot(5);
  a.navHandlers.onNextRecord?.();
  assert.deepEqual(a.focused, [0]);
  assert.equal(a.state.selectedLine, 0);
  assert.deepEqual(a.shown, [0]);

  const b = boot(5);
  b.navHandlers.onPrevRecord?.();
  assert.deepEqual(b.focused, [4], '无选中时上一条从最后一条开始');
});

test('导航：走到边界即停（不回绕）', () => {
  const { state, navHandlers, focused } = boot(3);
  state.selectedLine = 2;
  navHandlers.onNextRecord?.();
  assert.deepEqual(focused, [], '末行再按下一条：无动作');

  state.selectedLine = 0;
  navHandlers.onPrevRecord?.();
  assert.deepEqual(focused, [], '首行再按上一条：无动作');
});

test('导航：过滤态下只在筛选结果内移动（跳到结果外的行是明显错乱）', () => {
  const { state, nav, navHandlers, focused } = boot(20, [2, 4, 7]);
  state.selectedLine = 4; // 展示位 1
  nav.updateNavEnabled();
  assert.deepEqual(nav.updateNavEnabled(), undefined, 'updateNavEnabled 无返回值');

  navHandlers.onNextRecord?.();
  assert.deepEqual(focused, [7], '下一条应到结果内的下一行（7），而非 5');
  navHandlers.onPrevRecord?.();
  assert.deepEqual(focused, [7, 4], '再上一条退回结果内的上一行（4）');
  navHandlers.onPrevRecord?.();
  assert.deepEqual(focused, [7, 4, 2], '继续上一条到结果内的首行（2）');
});

test('导航：选中行不在过滤结果内时（idx=-1）按方向从端点开始', () => {
  const { state, navHandlers, focused } = boot(20, [3, 6]);
  state.selectedLine = 10; // 不在结果内
  navHandlers.onNextRecord?.();
  assert.deepEqual(focused, [3], '索引为 -1 → 从首条开始');
});

test('导航：详情工具「编辑」——无选中不动作，有选中打开编辑浮层', () => {
  const a = boot(3);
  a.navHandlers.onEdit?.();
  assert.deepEqual(a.edited, [], '无选中时不应打开编辑浮层');

  const b = boot(3);
  b.state.selectedLine = 1;
  b.navHandlers.onEdit?.();
  assert.deepEqual(b.edited, [1]);
});
