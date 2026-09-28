/**
 * persistRestore.test.ts — 偏好恢复（两源合并）单测。
 *
 * 三条规则必须钉住：
 *   · 两源（持久化状态 / 字段推断）**都就绪**才合并，谁先到都不动作；
 *   · 脏数据不得覆盖当前布局（以当前字段集为白名单）；
 *   · 无数据 / 读取失败也要标记「已加载」，否则合并会永远等一个不会来的信号。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPersistRestore } from '../persistRestore.ts';
import { createAppState } from '../appState.ts';
import type { FieldLike } from '../logic.ts';
import type { FieldLayout } from '../queryLogic.ts';

const fields = ['a', 'b'].map((key) => ({ key }) as unknown as FieldLike);

function boot() {
  const state = createAppState();
  const calls = {
    layout: [] as FieldLayout[],
    refreshed: 0,
    filters: [] as unknown[],
  };
  let input: { value: string } | null = { value: '' };

  const restore = createPersistRestore({
    state,
    toolbar: {
      setLayout: (l) => calls.layout.push(l),
      searchInput: () => input as unknown as HTMLInputElement | null,
    },
    list: { refresh: () => calls.refreshed++ },
    runFilter: (cond) => calls.filters.push(cond),
  });

  return {
    state,
    calls,
    restore,
    setInput: (v: { value: string } | null) => {
      input = v;
    },
    /** 当前搜索框（用于断言回填结果）。 */
    getInput: () => input,
  };
}

test('只到一源时不动作：字段未就绪 → 不合并', () => {
  const h = boot();
  h.restore.onLoaded({ searchQuery: 'x' });
  assert.equal(h.calls.refreshed, 0);
  assert.deepEqual(h.calls.layout, []);
});

test('只到一源时不动作：持久化未到达 → 不合并', () => {
  const h = boot();
  h.state.fields = fields;
  h.restore.tryApply();
  assert.equal(h.calls.refreshed, 0);
});

test('两源就绪 → 应用布局 / 过滤 / 搜索词', () => {
  const h = boot();
  h.state.fields = fields;
  h.restore.onLoaded({
    fieldLayout: { pinned: ['a'], order: ['b'], hidden: [], maxKeys: 3 },
    filter: { field: 'a', op: 'eq', value: '1' },
    searchQuery: 'needle',
  });

  assert.deepEqual(h.calls.layout.at(-1), {
    pinned: ['a'],
    order: ['b'],
    hidden: [],
    maxKeys: 3,
  });
  assert.equal(h.calls.refreshed, 1, '布局变了 → 列表重绘');
  // 合并会给缺失项补默认值（caseInsensitive / negate），故只断言关键语义字段。
  const cond = h.calls.filters.at(-1) as Record<string, unknown> | undefined;
  assert.equal(cond?.field, 'a');
  assert.equal(cond?.op, 'eq');
  assert.equal(cond?.value, '1');
});

test('搜索词只回填空输入框（不覆盖用户已输入的内容）', () => {
  const a = boot();
  a.state.fields = fields;
  a.restore.onLoaded({ searchQuery: 'needle' });
  assert.equal(a.getInput()?.value, 'needle', '空输入框被回填');

  const b = boot();
  b.state.fields = fields;
  b.setInput({ value: '用户已输入' });
  b.restore.onLoaded({ searchQuery: 'needle' });
  assert.equal(b.getInput()?.value, '用户已输入', '不覆盖用户已输入的内容');
});

test('无持久化数据（undefined）也要标记已加载 —— 否则后续推断到达时永远等待', () => {
  const h = boot();
  h.restore.onLoaded(undefined); // 读失败 / 无数据的同一路径
  h.state.fields = fields;
  h.restore.tryApply();

  // 无数据可应用：不得混入任何外部字段、不得恢复过滤或搜索词。
  // （是否触发一次重绘属实现细节，不在此断言 —— 关键是流程走完且不悬挂。）
  assert.deepEqual(h.state.fieldLayout.pinned, []);
  assert.deepEqual(h.calls.filters, []);
  assert.equal(h.getInput()?.value, '', '搜索词不回填');
});

test('脏布局（含已不存在的字段）不覆盖当前布局', () => {
  const h = boot();
  h.state.fields = fields; // 当前只有 a / b
  h.restore.onLoaded({ fieldLayout: { pinned: ['gone'], order: [], hidden: [], maxKeys: 5 } });
  // mergePersistedState 以当前字段集为白名单，未知字段被丢弃
  const applied = h.calls.layout.at(-1);
  if (applied) {
    assert.deepEqual(applied.pinned, [], '已消失的字段不得进入布局');
  } else {
    assert.equal(h.calls.refreshed, 0, '无可应用的布局时不重绘');
  }
});
