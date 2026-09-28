/**
 * focusTarget.test.ts — 选中行唯一写入口单测。
 *
 * 核心是一条**安全不变式**：任何改动选中行的路径，都必须同时作废详情原文
 * （`detailRaw`）——否则字段编辑会"基于 A 行的原文、把改动写到 B 行上"（不可逆错改）。
 * 此前 `refreshOverview` 的越界收敛路径正是漏了这一步，本文件把它钉死。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFocusTarget } from '../focusTarget.ts';
import { createAppState } from '../appState.ts';

function boot() {
  const state = createAppState();
  state.detailRaw = { text: '{"a":1}', bytes: 7 }; // 默认带着"上一行的原文"，便于验证是否被作废

  const calls = {
    shown: [] as number[],
    cleared: 0,
    cancelled: 0,
  };

  const focus = createFocusTarget({
    state,
    showDetail: (l) => calls.shown.push(l),
    clearDetail: () => calls.cleared++,
    cancelDetailRequest: () => calls.cancelled++,
  });

  return { state, calls, focus };
}

test('set：写选中行 + 作废旧原文 + 取消在途详情 + 重拉详情', () => {
  const h = boot();
  h.state.detailInFlight = { rid: 'r1' };
  h.focus.set(3);

  assert.equal(h.focus.get(), 3);
  assert.equal(h.state.detailRaw, null, '原文必须作废（否则会基于旧行原文改到新行）');
  assert.equal(h.state.detailInFlight, null, '在途详情属于旧目标，必须掐掉');
  assert.equal(h.calls.cancelled, 1);
  assert.deepEqual(h.calls.shown, [3], '详情随选中行刷新');
});

test('afterInsert：落点移到新行（并作废旧原文）', () => {
  const h = boot();
  h.focus.afterInsert(2);
  assert.equal(h.focus.get(), 2);
  assert.equal(h.state.detailRaw, null);
  assert.deepEqual(h.calls.shown, [2]);
});

test('afterDelete：选中行在删除点之后 → 前移一位', () => {
  const h = boot();
  h.state.selectedLine = 5;
  h.focus.afterDelete(2, 9);
  assert.equal(h.focus.get(), 4);
  assert.deepEqual(h.calls.shown, [4]);
});

test('afterDelete：选中行在删除点之前 → 行号不变，但原文仍须作废并重拉', () => {
  const h = boot();
  h.state.selectedLine = 1;
  h.focus.afterDelete(4, 9);

  assert.equal(h.focus.get(), 1, '行号不变');
  assert.equal(h.state.detailRaw, null, '内容因重排而变 —— 原文不可留（这是最容易漏的一步）');
  assert.deepEqual(h.calls.shown, [1], '仍要重拉，否则详情停在旧内容上');
});

test('afterDelete：删除后总数变小 → 末行越界即收敛', () => {
  const h = boot();
  h.state.selectedLine = 9;
  h.focus.afterDelete(3, 9); // 删 1 行后只剩 9 行（0..8）
  assert.equal(h.focus.get(), 8, '收敛到新的末行');

  const empty = boot();
  empty.state.selectedLine = 0;
  empty.focus.afterDelete(0, 0);
  assert.equal(empty.focus.get(), undefined, '删空了则无选中');
  assert.equal(empty.calls.cleared, 1, '详情面板一并清空');
  assert.equal(empty.state.detailRaw, null);
});

test('afterDelete：无选中时不动（删除不该凭空产生选中）', () => {
  const h = boot();
  h.state.selectedLine = undefined;
  h.focus.afterDelete(0, 5);
  assert.equal(h.focus.get(), undefined);
  assert.deepEqual(h.calls.shown, []);
});

test('clampTo：未越界返回 false 且完全不动作', () => {
  const h = boot();
  h.state.selectedLine = 2;
  assert.equal(h.focus.clampTo(10), false);
  assert.equal(h.focus.get(), 2);
  assert.equal(h.state.detailRaw === null, false, '未收敛时不得动原文');
  assert.deepEqual(h.calls.shown, []);
});

test('clampTo：越界收敛 —— 作废原文并重拉详情（此前漏做，是真实缺陷）', () => {
  const h = boot();
  h.state.selectedLine = 9;
  const changed = h.focus.clampTo(3);

  assert.equal(changed, true, '如实回报"发生了收敛"');
  assert.equal(h.focus.get(), 2, '收敛到新的末行');
  assert.equal(h.state.detailRaw, null, '必须作废 —— 否则用户此刻做字段编辑会改错行');
  assert.deepEqual(h.calls.shown, [2], '必须重拉详情，否则面板停留在旧行内容');
});

test('clampTo：总数为 0 → 清空选中与详情', () => {
  const h = boot();
  h.state.selectedLine = 3;
  assert.equal(h.focus.clampTo(0), true);
  assert.equal(h.focus.get(), undefined);
  assert.equal(h.state.detailRaw, null);
  assert.equal(h.calls.cleared, 1);
});

test('clear：清选中 + 作废原文 + 清详情面板', () => {
  const h = boot();
  h.state.selectedLine = 7;
  h.state.detailInFlight = { rid: 'r2' };
  h.focus.clear();

  assert.equal(h.focus.get(), undefined);
  assert.equal(h.state.detailRaw, null);
  assert.equal(h.state.detailInFlight, null);
  assert.equal(h.calls.cleared, 1);
});

test('不变式总查：所有变更路径跑一遍后，原文一律为 null（绝不允许残留）', () => {
  const paths: (() => {
    state: { detailRaw: unknown };
    focus: ReturnType<typeof boot>['focus'];
  })[] = [
    () => {
      const h = boot();
      h.focus.set(1);
      return h;
    },
    () => {
      const h = boot();
      h.focus.afterInsert(1);
      return h;
    },
    () => {
      const h = boot();
      h.state.selectedLine = 2;
      h.focus.afterDelete(0, 5);
      return h;
    },
    () => {
      const h = boot();
      h.state.selectedLine = 9;
      h.focus.clampTo(2);
      return h;
    },
    () => {
      const h = boot();
      h.focus.clear();
      return h;
    },
  ];

  for (const [i, run] of paths.entries()) {
    const h = run();
    assert.equal(h.state.detailRaw, null, `第 ${i} 条路径留下了未作废的原文`);
  }
});
