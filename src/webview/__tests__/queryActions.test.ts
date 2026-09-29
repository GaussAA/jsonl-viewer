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
    /** 各次请求的载荷（用于断言组合条件原样送出，而不是被拆成扁平字段）。 */
    payloads: unknown[];
    select: number[];
    scrollToLine: number[];
    /** 命中高亮词（null = 清除）。 */
    needles: (string | null)[];
    translations: (number[] | null)[];
    refresh: number;
    searchResult: [number, number][];
    filterTruncated: boolean[];
    layouts: FieldLayout[];
    detail: number[];
    queryErrors: (string | null)[];
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
    payloads: [],
    select: [],
    scrollToLine: [],
    needles: [],
    translations: [],
    refresh: 0,
    searchResult: [],
    filterTruncated: [],
    layouts: [],
    detail: [],
    queryErrors: [],
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
    request(endpoint: string, payload?: unknown) {
      calls.requests.push(endpoint);
      calls.payloads.push(payload);
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
    setSearchNeedle(n: string | null) {
      calls.needles.push(n);
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
    /** 失败态文案（null = 清除）。失败若冒充「0 匹配」，用户会误判文件里没有该词。 */
    setQueryError(m: string | null) {
      calls.queryErrors.push(m);
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
    // 装配层的选中入口：真实实现会设置 state.selectedLine、列表当前行与多选选区，
    // 并**一并拉取该行详情**（详情展示已收口到选中行写入口 focusTarget，不再是独立依赖）。
    // 这里模拟其可观测效果（选中行 + 列表当前行 + 详情请求），断言与改动前保持一致。
    selectLine: (l) => {
      calls.select.push(l);
      calls.detail.push(l);
      state.selectedLine = l;
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

    actions.runSearch('   ');

    assert.deepStrictEqual(h.state.searchMatches, [], '匹配清空');
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
    assert.deepStrictEqual(h.calls.searchResult, [[2, 0]], '工具栏计数 2/0');
    assert.deepStrictEqual(h.calls.select, [5], '跳转首个匹配');
    assert.strictEqual(h.state.selectedLine, 5, '选中行更新');
    assert.deepStrictEqual(h.calls.detail, [5], '详情跳转被触发');
    assert.ok(h.calls.nav >= 1, '导航态刷新');
  });

  it('runSearch：结果超限—按 SEARCH_LIMIT 截断', async () => {
    const h = makeHarness();
    const actions = createQueryActions(h.deps);

    actions.runSearch('big');
    h.resolveLast({
      matches: Array.from({ length: SEARCH_LIMIT + 1 }, (_, i) => i),
      total: SEARCH_LIMIT + 1,
    });
    await flush();

    assert.strictEqual(
      h.state.searchMatches.length,
      SEARCH_LIMIT,
      '超出 SEARCH_LIMIT 的部分被截掉'
    );
  });

  it('runSearch：请求失败—复位在途标记并显示失败态（而不是冒充 0 匹配）', async () => {
    const h = makeHarness();
    const actions = createQueryActions(h.deps);

    actions.runSearch('x');
    assert.ok(h.state.searchInFlight, '记录在途请求');
    h.rejectLast();
    await flush();

    assert.strictEqual(h.state.searchInFlight, null, '在途标记清空');
    // 关键：失败**不得**汇报成「0 匹配」——那会让用户以为文件里没有这个词。
    assert.deepStrictEqual(h.calls.searchResult, [], '不得把失败当成计数 0');
    assert.deepStrictEqual(h.calls.queryErrors, ['搜索失败（可重试）'], '给出可行动的失败文案');
  });

  it('runSearch：成功后清除失败态（失败提示不残留）', async () => {
    const h = makeHarness();
    const actions = createQueryActions(h.deps);

    actions.runSearch('x');
    h.rejectLast();
    await flush();
    assert.strictEqual(h.calls.queryErrors.at(-1), '搜索失败（可重试）');

    actions.runSearch('x');
    h.resolveLast({ matches: [3], total: 1, truncated: false });
    await flush();
    assert.strictEqual(h.calls.queryErrors.at(-1), null, '有结果即撤掉失败态');
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

  it('F3：组条件原样送入 FILTER 请求（不再被拆成 field/op/value）', async () => {
    const h = makeHarness();
    const actions = createQueryActions(h.deps);

    const cond = {
      kind: 'and' as const,
      items: [
        { field: 'level', op: 'eq' as const, value: 'error' },
        { field: 'msg', op: 'contains' as const, value: 'timeout' },
      ],
    };
    actions.runFilter(cond);
    assert.deepStrictEqual(h.calls.payloads.at(-1), { condition: cond }, '条件树原样送出');
    assert.strictEqual(h.state.filterCond, cond, '状态里存的是同一棵树');

    h.resolveLast({ matches: [1], truncated: false });
    await flush();
    assert.deepStrictEqual(h.state.filterMap, [1]);
  });

  it('F3：只有空叶子的条件被视为「未启用过滤」（不把视图清空）', async () => {
    const h = makeHarness();
    const actions = createQueryActions(h.deps);

    actions.runFilter({ kind: 'and', items: [{ field: '', op: 'eq', value: '' }] });
    assert.deepStrictEqual(h.calls.requests, [], '未发过滤请求（等同清除）');
    assert.strictEqual(h.state.filterCond, null, '条件被清空');
    assert.strictEqual(h.state.filterMap, null, '回到全量视图');
  });

  it('runFilter(cond)：应用过滤—写回映射、重建翻译、刷新列表', async () => {
    const h = makeHarness();
    const actions = createQueryActions(h.deps);

    actions.runFilter({ field: 'f', op: 'eq', value: '3' });
    assert.deepStrictEqual(
      h.state.filterCond,
      { field: 'f', op: 'eq', value: '3' },
      '过滤条件记录'
    );
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
