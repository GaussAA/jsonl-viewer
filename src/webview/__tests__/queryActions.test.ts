import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createQueryActions,
  SEARCH_LIMIT,
  type QueryActionsDeps,
  type QueryState,
} from '../queryActions.ts';
import type { FieldLayout } from '../queryLogic.ts';
import type { RpcBus } from '../rpc.ts';
import type { VirtualRecordList } from '../virtualScroll.ts';
import type { createToolbar } from '../toolbar.ts';

/**
 * queryActions 模块级回归测试（T5 #31）。
 *
 * 价值：#31 把 main() 内联的搜索/过滤/字段布局动作抽成独立工厂。本测试用桩 bus/list/toolbar
 * 驱动工厂，覆盖「supersede 幂等 / 空查询短路 / 搜索解析与跳转 / SEARCH_LIMIT 截断 /
 * ±1 导航 / 过滤应用与清除 / 布局应用」关键分支，作为该模块的精确回归护栏。
 */

const LAYOUT: FieldLayout = { pinned: [], order: [], hidden: [], maxKeys: 4 };

interface Harness {
  deps: QueryActionsDeps;
  state: QueryState;
  calls: {
    superseded: string[];
    requests: string[];
    select: number[];
    scrollToLine: number[];
    translations: (number[] | null)[];
    refresh: number;
    searchResult: [number, number][];
    filterTruncated: boolean[];
    layouts: FieldLayout[];
    detail: number[];
    nav: number;
    persist: number;
  };
  /** 解析最近一次 bus.request 的 promise。 */
  resolveLast: (v: unknown) => void;
  /** 拒绝最近一次 bus.request 的 promise。 */
  rejectLast: () => void;
}

function makeHarness(): Harness {
  const calls: Harness['calls'] = {
    superseded: [],
    requests: [],
    select: [],
    scrollToLine: [],
    translations: [],
    refresh: 0,
    searchResult: [],
    filterTruncated: [],
    layouts: [],
    detail: [],
    nav: 0,
    persist: 0,
  };
  let resolveNext: ((v: unknown) => void) | null = null;
  let rejectNext: ((e: unknown) => void) | null = null;
  let seq = 0;

  const bus = {
    supersede(rid: string) {
      calls.superseded.push(rid);
    },
    request(endpoint: string) {
      calls.requests.push(endpoint);
      const requestId = `req-${++seq}`;
      const promise = new Promise<unknown>((res, rej) => {
        resolveNext = res;
        rejectNext = rej;
      });
      return { requestId, promise };
    },
  } as unknown as RpcBus;

  const state: QueryState = {
    searchQuery: '',
    searchMatches: [],
    searchTruncated: false,
    searchInFlight: null,
    filterMap: null,
    filterCond: null,
    filterInFlight: null,
    selectedLine: undefined,
    fieldLayout: LAYOUT,
  };

  const list = {
    select(l: number) {
      calls.select.push(l);
    },
    scrollToLine(l: number) {
      calls.scrollToLine.push(l);
    },
    setTranslation(m: number[] | null) {
      calls.translations.push(m);
    },
    refresh() {
      calls.refresh += 1;
    },
  } as unknown as VirtualRecordList;

  const toolbar = {
    setSearchResult(t: number, i: number) {
      calls.searchResult.push([t, i]);
    },
    setFilterTruncated(t: boolean) {
      calls.filterTruncated.push(t);
    },
    setLayout(l: FieldLayout) {
      calls.layouts.push(l);
    },
  } as unknown as ReturnType<typeof createToolbar>;

  const deps: QueryActionsDeps = {
    bus,
    state,
    getList: () => list,
    getToolbar: () => toolbar,
    showDetailForLine: (l) => {
      calls.detail.push(l);
    },
    updateNavEnabled: () => {
      calls.nav += 1;
    },
    schedulePersist: () => {
      calls.persist += 1;
    },
  };

  return {
    deps,
    state,
    calls,
    resolveLast: (v) => resolveNext?.(v),
    rejectLast: () => rejectNext?.(new Error('boom')),
  };
}

/** 让本轮微任务队列清空（供 .then/.catch 分支执行）。 */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('createQueryActions（T5 #31 抽取回归）', () => {
  it('supersede：标记 + 通知总线一次，且幂等、null 安全', () => {
    const h = makeHarness();
    const actions = createQueryActions(h.deps);

    const run = { rid: 'r1', superseded: false };
    actions.supersede(run);
    assert.strictEqual(run.superseded, true, '已标记 superseded');
    assert.deepStrictEqual(h.calls.superseded, ['r1'], '通知总线一次');

    actions.supersede(run); // 已 superseded → 不重复通知
    assert.deepStrictEqual(h.calls.superseded, ['r1'], '重复调用不重复通知');

    assert.doesNotThrow(() => actions.supersede(null), 'null 入参安全');
  });

  it('runSearch：空查询短路—清空匹配、复位工具栏、持久化,但不发请求', () => {
    const h = makeHarness();
    const actions = createQueryActions(h.deps);
    h.state.searchMatches = [1, 2];
    h.state.searchTruncated = true;

    actions.runSearch('   ');

    assert.deepStrictEqual(h.state.searchMatches, [], '匹配清空');
    assert.strictEqual(h.state.searchTruncated, false, '截断标记复位');
    assert.deepStrictEqual(h.calls.searchResult, [[0, 0]], '工具栏复位为 0/0');
    assert.strictEqual(h.calls.persist, 1, '触发持久化');
    assert.deepStrictEqual(h.calls.requests, [], '未发起搜索请求');
  });

  it('runSearch：命中结果—截断到 SEARCH_LIMIT 并跳转首个匹配', async () => {
    const h = makeHarness();
    const actions = createQueryActions(h.deps);

    actions.runSearch('  hello  ');
    assert.strictEqual(h.state.searchQuery, '  hello  ', 'searchQuery 原样记录');
    assert.deepStrictEqual(h.calls.requests, ['search'], '发起 SEARCH 请求');

    h.resolveLast({ matches: [5, 9], total: 2 });
    await flush();

    assert.deepStrictEqual(h.state.searchMatches, [5, 9], '匹配写入');
    assert.strictEqual(h.state.searchTruncated, false, 'total 未超则不截断');
    assert.deepStrictEqual(h.calls.searchResult, [[2, 0]], '工具栏计数 2/0');
    assert.deepStrictEqual(h.calls.select, [5], '跳转首个匹配');
    assert.strictEqual(h.state.selectedLine, 5, '选中行更新');
    assert.deepStrictEqual(h.calls.detail, [5], '详情跳转被触发');
    assert.ok(h.calls.nav >= 1, '导航态刷新');
  });

  it('runSearch：结果超限—按 SEARCH_LIMIT 截断并标记 truncated', async () => {
    const h = makeHarness();
    const actions = createQueryActions(h.deps);

    actions.runSearch('big');
    h.resolveLast({ matches: Array.from({ length: SEARCH_LIMIT + 1 }, (_, i) => i), total: SEARCH_LIMIT + 1 });
    await flush();

    assert.strictEqual(h.state.searchMatches.length, SEARCH_LIMIT, '截断到 SEARCH_LIMIT');
    assert.strictEqual(h.state.searchTruncated, true, '超出部分标记截断');
  });

  it('runSearch：请求失败—复位在途标记与工具栏，不抛错', async () => {
    const h = makeHarness();
    const actions = createQueryActions(h.deps);

    actions.runSearch('x');
    assert.ok(h.state.searchInFlight, '记录在途请求');
    h.rejectLast();
    await flush();

    assert.strictEqual(h.state.searchInFlight, null, '在途标记清空');
    assert.deepStrictEqual(h.calls.searchResult, [[0, 0]], '工具栏复位');
  });

  it('stepSearch：±1 导航按 nextMatchIndex/prevMatchIndex 计算并跳转', () => {
    const h = makeHarness();
    const actions = createQueryActions(h.deps);
    h.state.searchMatches = [10, 20, 30];
    h.state.selectedLine = 10;

    actions.stepSearch(1);
    assert.deepStrictEqual(h.calls.searchResult.at(-1), [3, 1], '下一个匹配索引 1');
    assert.strictEqual(h.state.selectedLine, 20, '跳转到 20');

    actions.stepSearch(-1);
    assert.deepStrictEqual(h.calls.searchResult.at(-1), [3, 0], '上一个匹配索引 0');
    assert.strictEqual(h.state.selectedLine, 10, '回到 10');

    const before = h.calls.select.length;
    h.state.searchMatches = [];
    actions.stepSearch(1);
    assert.strictEqual(h.calls.select.length, before, '无匹配时不动');
  });

  it('runFilter(null)：等同清除过滤—复位状态、清空翻译、持久化', () => {
    const h = makeHarness();
    const actions = createQueryActions(h.deps);
    h.state.filterCond = { field: 'a', op: 'eq', value: 'x' };
    h.state.filterMap = [1, 2];

    actions.runFilter(null);

    assert.strictEqual(h.state.filterCond, null, '过滤条件清空');
    assert.strictEqual(h.state.filterMap, null, '过滤映射清空');
    assert.deepStrictEqual(h.calls.filterTruncated, [false], '截断提示复位');
    assert.deepStrictEqual(h.calls.translations, [null], '翻译清空');
    assert.strictEqual(h.calls.persist, 1, '触发持久化');
    assert.ok(h.calls.nav >= 1, '导航态刷新');
    assert.deepStrictEqual(h.calls.requests, [], '未发过滤请求');
  });

  it('runFilter(cond)：应用过滤—写回映射、重建翻译、刷新列表', async () => {
    const h = makeHarness();
    const actions = createQueryActions(h.deps);

    actions.runFilter({ field: 'f', op: 'eq', value: '3' });
    assert.strictEqual(h.state.filterCond?.field, 'f', '过滤条件记录');
    assert.deepStrictEqual(h.calls.requests, ['filter'], '发起 FILTER 请求');

    h.resolveLast({ matches: [7, 8], truncated: true });
    await flush();

    assert.deepStrictEqual(h.state.filterMap, [7, 8], '映射写回');
    assert.deepStrictEqual(h.calls.filterTruncated, [true], '截断提示透出');
    assert.deepStrictEqual(h.calls.translations, [[7, 8]], '翻译重建');
    assert.strictEqual(h.calls.refresh, 1, '列表刷新');
    assert.strictEqual(h.calls.persist, 1, '触发持久化');
  });

  it('runFilter(cond)：空匹配—映射置空数组（非 null）且截断复位', async () => {
    const h = makeHarness();
    const actions = createQueryActions(h.deps);

    actions.runFilter({ field: 'f', op: 'eq', value: 'z' });
    h.resolveLast({ matches: null, truncated: false });
    await flush();

    assert.deepStrictEqual(h.state.filterMap, [], '空匹配落为空数组');
    assert.deepStrictEqual(h.calls.translations, [[]], '翻译为空映射');
  });

  it('applyLayout：写回布局、刷新列表、同步工具栏、持久化', () => {
    const h = makeHarness();
    const actions = createQueryActions(h.deps);
    const next: FieldLayout = { pinned: ['a'], order: ['a'], hidden: [], maxKeys: 2 };

    actions.applyLayout(next);

    assert.strictEqual(h.state.fieldLayout, next, '布局写回 state');
    assert.strictEqual(h.calls.refresh, 1, '列表刷新');
    assert.deepStrictEqual(h.calls.layouts, [next], '工具栏同步布局');
    assert.strictEqual(h.calls.persist, 1, '触发持久化');
  });
});
