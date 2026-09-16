import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arraySegmentCount,
  containerPreview,
  expandContainer,
  jsonKindOf,
  LARGE_ARRAY_PREVIEW,
  pathKey,
  pathToString,
  segText,
  TreeState,
} from '../detailLogic.ts';

/* --------------------- JSON 值分类 --------------------- */

test('jsonKindOf: 基本类型分类', () => {
  assert.equal(jsonKindOf('x'), 'string');
  assert.equal(jsonKindOf(1.5), 'number');
  assert.equal(jsonKindOf(true), 'boolean');
  assert.equal(jsonKindOf(null), 'null');
  assert.equal(jsonKindOf([]), 'array');
  assert.equal(jsonKindOf({}), 'object');
});

test('containerPreview: 对象/数组折叠摘要', () => {
  assert.equal(containerPreview([1, 2, 3]), '[…] 3 items');
  assert.equal(containerPreview([]), '[…] 0 items');
  assert.equal(containerPreview({ a: 1 }), '{…} 1 field');
});

/* --------------------- 路径 --------------------- */

test('pathToString: 拼接为 .a[3].b 形式', () => {
  const segs = [
    { kind: 'key' as const, key: 'a' },
    { kind: 'index' as const, key: '3' },
    { kind: 'key' as const, key: 'b' },
  ];
  assert.equal(pathToString(segs), '.a[3].b');
  assert.equal(pathToString([]), '');
});

test('segText: 特殊字符 key 用括号形式避免歧义', () => {
  assert.equal(segText({ kind: 'key', key: 'name' }), '.name');
  assert.equal(segText({ kind: 'index', key: '7' }), '[7]');
  assert.equal(segText({ kind: 'key', key: 'a b' }), '["a b"]');
});

test('pathKey: 无歧义（同类段可区分，不为 display 字符串）', () => {
  const a = [{ kind: 'key' as const, key: 'a.b' }];
  const b = [
    { kind: 'key' as const, key: 'a' },
    { kind: 'key' as const, key: 'b' },
  ];
  assert.notEqual(pathKey(a), pathKey(b), '含点键不应与分盘段混淆');
  assert.equal(pathKey([]), '$');
  assert.ok(pathKey(a).startsWith('k:"'), 'key 段带 kind 前缀');
});

/* --------------------- 折叠状态管理 --------------------- */

test('TreeState: 默认展开深度上限=1（root 恒展开，孙层折叠）', () => {
  const st = new TreeState(1);
  const seg1 = [{ kind: 'key' as const, key: 'a' }];
  const seg2 = [
    { kind: 'key' as const, key: 'a' },
    { kind: 'key' as const, key: 'b' },
  ];
  assert.equal(st.isExpanded([], 0), true);
  assert.equal(st.isExpanded(seg1, 1), true); // depth 1 在限内
  assert.equal(st.isExpanded(seg2, 2), false); // depth 2 超限
});

test('TreeState: toggle 折叠/展开并保持 Set 正确性', () => {
  const st = new TreeState(1);
  const seg1 = [{ kind: 'key' as const, key: 'a' }];
  assert.equal(st.isExpanded(seg1, 1), true);
  assert.equal(st.toggle(seg1, 1), false); // 折叠
  assert.equal(st.isExpanded(seg1, 1), false);
  assert.equal(st.collapseKeys().has(pathKey(seg1)), true);
  assert.equal(st.toggle(seg1, 1), true); // 再展开
  assert.equal(st.isExpanded(seg1, 1), true);
});

test('TreeState: forceExpand 可展开超出深度上限的深层节点（面包屑导航）', () => {
  const st = new TreeState(1);
  const deep = [
    { kind: 'key' as const, key: 'a' },
    { kind: 'index' as const, key: '0' },
    { kind: 'key' as const, key: 'b' },
  ];
  assert.equal(st.isExpanded(deep, 3), false);
  st.forceExpand(deep);
  assert.equal(st.isExpanded(deep, 3), true);
});

test('TreeState: collapseAll / expandAll / expandToLevel 重置覆盖', () => {
  const st = new TreeState(1);
  const seg1 = [{ kind: 'key' as const, key: 'a' }];
  st.forceExpand(seg1);
  st.collapseAll();
  assert.equal(st.maxDepth, 0);
  assert.equal(st.isExpanded(seg1, 1), false);
  assert.equal(st.collapseKeys().size, 0);

  st.expandToLevel(3);
  assert.equal(st.maxDepth, 3);
  assert.equal(st.isExpanded(seg1, 1), true);
  assert.equal(st.isExpanded([...seg1, { kind: 'key' as const, key: 'x' }], 2), true);
  assert.equal(st.isExpanded([...seg1, { kind: 'key' as const, key: 'x' }, { kind: 'key' as const, key: 'y' }], 3), true);

  st.expandAll();
  assert.equal(st.maxDepth > 100, true);
  assert.equal(st.isExpanded([...seg1, { kind: 'key' as const, key: 'x' }], 50), true);
});

/* --------------------- 大数组分段预览 --------------------- */

test('arraySegmentCount: 小数组全量可见，无剩余', () => {
  const { visible, remaining } = arraySegmentCount(10, 0);
  assert.equal(visible, 10);
  assert.equal(remaining, 0);
});

test('arraySegmentCount: 大数组仅渲染首屏 + 剩余计数', () => {
  const { visible, remaining } = arraySegmentCount(1000, 0);
  assert.equal(visible, LARGE_ARRAY_PREVIEW);
  assert.equal(remaining, 1000 - LARGE_ARRAY_PREVIEW);
});

test('arraySegmentCount: 加载更多逐步扩大 visible、减少 remaining', () => {
  const len = 260;
  const first = arraySegmentCount(len, 0);
  assert.equal(first.visible, LARGE_ARRAY_PREVIEW);
  assert.equal(first.remaining, len - LARGE_ARRAY_PREVIEW);
  const more = arraySegmentCount(len, 100);
  assert.equal(more.visible, LARGE_ARRAY_PREVIEW + 100);
  assert.equal(more.remaining, len - (LARGE_ARRAY_PREVIEW + 100));
});

test('expandContainer: 大数组只返回首屏项且带剩余；对象在硬上限内全量返回', () => {
  const big = Array.from({ length: 500 }, (_, i) => i);
  const r1 = expandContainer(big, '$', {});
  assert.equal(r1.items.length, LARGE_ARRAY_PREVIEW);
  assert.equal(r1.remaining, 500 - LARGE_ARRAY_PREVIEW);
  assert.equal(r1.items[0].value, 0);
  assert.equal(r1.items[0].kind, 'number');

  const obj = { a: 1, b: 'x', c: true };
  const r2 = expandContainer(obj, '$', {});
  assert.equal(r2.items.length, 3);
  assert.equal(r2.remaining, 0);
});

test('expandContainer: 分段索引正确从 0 开始、段正确', () => {
  const arr = ['zero', 'one', 'two'];
  const { items, remaining } = expandContainer(arr, '$', {});
  assert.equal(remaining, 0);
  assert.deepEqual(
    items.map((it) => ({ seg: it.seg, value: it.value })),
    [
      { seg: { kind: 'index', key: '0' }, value: 'zero' },
      { seg: { kind: 'index', key: '1' }, value: 'one' },
      { seg: { kind: 'index', key: '2' }, value: 'two' },
    ]
  );
});

test('expandContainer: 对象 key 正确映射为 PathSeg', () => {
  const { items } = expandContainer({ foo: 1, 'bar': 2 }, '$', {});
  assert.equal(items[0].seg.kind, 'key');
  assert.equal(items[0].seg.key, 'foo');
  assert.equal(items[0].value, 1);
});