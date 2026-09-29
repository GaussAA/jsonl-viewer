import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { setupWebviewDom } from './domHarness.ts';
import {
  createDetailTree,
  type DetailTreeController,
  type DetailTreeNavHandlers,
} from '../detailTree.ts';
import type { PathSeg } from '../detailLogic.ts';

/**
 * detailTree 组件测试（覆盖率补强：视图层）。
 *
 * 价值：右栏 JSON 详情树是用户查看记录的主通道（展开/折叠、懒加载、复制、上下条导航）。
 * 断言全落可观测行为（DOM 结构 / 类名 / 文案 / 回调），不依赖内部实现细节。
 */

const REAL_SET_TIMEOUT = globalThis.setTimeout;

/** 等待若干毫秒（原生定时器；domHarness 的 setTimeout 被 unref，不可用于等待）。 */
function wait(ms: number): Promise<void> {
  return new Promise((r) => REAL_SET_TIMEOUT(() => r(), ms));
}

interface Harness {
  tree: DetailTreeController;
  host: HTMLElement;
  nav: { prev: number; next: number };
  /** 字段级编辑回调收到的 (路径, 值)。 */
  fields: { segs: PathSeg[]; value: unknown }[];
}

function makeTree(): Harness {
  const doc = globalThis.document;
  // 用例级隔离：清空文档，避免前序用例残留节点被内部文档级查询命中。
  doc.body.innerHTML = '';
  const host = doc.createElement('div');
  doc.body.append(host);
  const nav = { prev: 0, next: 0 };
  const fields: { segs: PathSeg[]; value: unknown }[] = [];
  const handlers: DetailTreeNavHandlers = {
    onPrevRecord: () => {
      nav.prev += 1;
    },
    onNextRecord: () => {
      nav.next += 1;
    },
    onEditField: (segs, value) => {
      fields.push({ segs: [...segs], value });
    },
  };
  const tree = createDetailTree(host, handlers);
  host.append(tree.root);
  return { tree, host, nav, fields };
}

const rows = (h: Harness): HTMLElement[] =>
  Array.from(h.tree.root.querySelectorAll<HTMLElement>('.jlv-tree-row'));
const keys = (h: Harness): string[] =>
  Array.from(h.tree.root.querySelectorAll('.jlv-key')).map((e) => e.textContent ?? '');
const tool = (h: Harness, title: string): HTMLButtonElement => {
  const btn = Array.from(h.tree.root.querySelectorAll('button')).find((b) => b.title === title);
  if (!btn) throw new Error(`未找到工具栏按钮「${title}」`);
  return btn as HTMLButtonElement;
};
/** 首个可展开容器行（data-container=1 且非根）。 */
const firstContainerRow = (h: Harness): HTMLElement => {
  const row = rows(h).find((r) => r.dataset.container === '1');
  if (!row) throw new Error('未找到容器行');
  return row;
};

describe('createDetailTree（视图层覆盖率补强）', () => {
  before(() => {
    setupWebviewDom();
  });

  it('showRecord：顶层键各成一行，头部显示 Record #<行号+1>', () => {
    const h = makeTree();
    h.tree.showRecord({ id: 1, name: 'x', nested: { a: 1 }, arr: [1, 2, 3] }, 7);

    assert.deepStrictEqual(keys(h), ['id', 'name', 'nested', 'arr'], '四个顶层键');
    assert.strictEqual(rows(h).length, 4, '每个键一行');
    assert.match(
      h.tree.root.querySelector('.jlv-detail-header')?.textContent ?? '',
      /Record #8/,
      '行号按 1 起展示'
    );
    assert.ok(h.tree.root.querySelector('.jlv-dh-crumb'), '存在面包屑根段');
  });

  it('嵌套容器默认处于折叠态（不含子树块）', () => {
    const h = makeTree();
    h.tree.showRecord({ nested: { a: 1 }, arr: [1, 2] });

    const containers = rows(h).filter((r) => r.dataset.container === '1');
    assert.strictEqual(containers.length, 2, 'nested 与 arr 均为容器行');
    for (const c of containers) {
      assert.strictEqual(c.getAttribute('aria-expanded'), 'false', '默认折叠');
      assert.ok(c.classList.contains('collapsed'), '带 collapsed 类');
    }
    assert.strictEqual(h.tree.root.querySelectorAll('.jlv-tree-block').length, 0, '无子树块');
  });

  it('点击容器行 → 展开（出现子树块与子键）；再次点击 → 收起（高度归零 + 折叠信号）', async () => {
    const h = makeTree();
    h.tree.showRecord({ nested: { a: 1, b: 2 } });
    const row = firstContainerRow(h);

    row.click();
    await wait(30);
    assert.strictEqual(row.getAttribute('aria-expanded'), 'true', '展开信号');
    assert.ok(row.classList.contains('expanded'), '带 expanded 类');
    assert.ok(h.tree.root.querySelector('.jlv-tree-block'), '生成子树块');
    assert.deepStrictEqual(keys(h), ['nested', 'a', 'b'], '子键出现');

    row.click();
    await wait(300); // 收起为抽屉动画（220ms 兜底）+ 余量
    assert.strictEqual(row.getAttribute('aria-expanded'), 'false', '折叠信号');
    assert.ok(row.classList.contains('collapsed'), '带 collapsed 类');
    assert.ok(!row.classList.contains('expanded'), '移除 expanded 类');
    // 注意：折叠**不移除**子树 DOM，而是把块高度收为 0（视觉收起，保留缓存以便快速重开）
    const block = h.tree.root.querySelector<HTMLElement>('.jlv-tree-block');
    assert.strictEqual(block?.style.height, '0px', '子树块收拢为零高');
    assert.notStrictEqual(
      row.querySelector('.jlv-summary')?.textContent ?? '',
      '',
      '折叠后恢复预览摘要'
    );
  });

  it('展开全部 / 全部折叠按钮：切换所有容器行并同步 aria-pressed', () => {
    const h = makeTree();
    h.tree.showRecord({ a: { x: 1 }, b: { y: 2 }, c: [1] });
    const btn = tool(h, '展开所有层级（再次点击可全部折叠）');
    assert.strictEqual(btn.getAttribute('aria-pressed'), 'false', '初始未展开');

    btn.click();
    assert.strictEqual(btn.getAttribute('aria-pressed'), 'true', '切换为展开态');
    const containers = rows(h).filter((r) => r.dataset.container === '1');
    assert.ok(containers.length > 0);
    assert.ok(
      containers.every((c) => c.getAttribute('aria-expanded') === 'true'),
      '所有容器行已展开'
    );

    btn.click();
    assert.strictEqual(btn.getAttribute('aria-pressed'), 'false', '再点回折叠态');
  });

  it('大数组懒加载：首屏只渲染一页并给出「加载更多」，点击后行数增长', () => {
    const h = makeTree();
    h.tree.showRecord(Array.from({ length: 5000 }, (_, i) => i));

    const firstPage = rows(h).length;
    assert.ok(firstPage > 0 && firstPage < 5000, `首屏仅渲染一页（实际 ${firstPage}）`);
    const more = h.tree.root.querySelector<HTMLElement>('.jlv-load-more');
    assert.ok(more, '存在「加载更多」入口');
    assert.match(more.textContent ?? '', /还有 \d+ 项/, '文案给出剩余项数');

    more.click();
    assert.ok(rows(h).length > firstPage, `加载更多后行数增长（${firstPage} → ${rows(h).length}）`);
  });

  it('showLoading / showRecord：加载占位出现后被真实内容替换', () => {
    const h = makeTree();
    h.tree.showLoading();
    assert.strictEqual(h.tree.root.querySelectorAll('.jlv-tree-loading').length, 1, '显示加载占位');

    h.tree.showRecord({ ok: true });
    assert.strictEqual(h.tree.root.querySelectorAll('.jlv-tree-loading').length, 0, '占位已移除');
    assert.deepStrictEqual(keys(h), ['ok'], '渲染真实内容');
  });

  it('showError：展示错误文案', () => {
    const h = makeTree();
    h.tree.showError('解析失败：第 3 行', 3);
    const err = h.tree.root.querySelector('.jlv-tree-error');
    assert.ok(err, '存在错误容器');
    assert.match(err.textContent ?? '', /解析失败/, '含错误消息');
  });

  it('clear：清空树体并回到未选中提示', () => {
    const h = makeTree();
    h.tree.showRecord({ a: 1 });
    assert.ok(rows(h).length > 0);

    h.tree.clear();
    assert.strictEqual(rows(h).length, 0, '树体清空');
    assert.match(
      h.tree.root.querySelector('.jlv-tree-body')?.textContent ?? '',
      /点击左侧记录/,
      '提示未选中'
    );
  });

  it('setNavEnabled：控制上一条/下一条按钮可用态', () => {
    const h = makeTree();
    const prev = tool(h, '上一条 JSON 条目');
    const next = tool(h, '下一条 JSON 条目');
    assert.strictEqual(prev.disabled, true, '初始禁用');
    assert.strictEqual(next.disabled, true, '初始禁用');

    h.tree.setNavEnabled(true, false);
    assert.strictEqual(prev.disabled, false, '启用上一条');
    assert.strictEqual(next.disabled, true, '下一条仍禁用');

    h.tree.setNavEnabled(false, true);
    assert.strictEqual(prev.disabled, true);
    assert.strictEqual(next.disabled, false);
  });

  it('上一条 / 下一条按钮触发导航回调', () => {
    const h = makeTree();
    h.tree.setNavEnabled(true, true);

    tool(h, '上一条 JSON 条目').click();
    assert.strictEqual(h.nav.prev, 1, 'onPrevRecord 触发');
    tool(h, '下一条 JSON 条目').click();
    assert.strictEqual(h.nav.next, 1, 'onNextRecord 触发');
  });

  it('复制按钮：走兼容复制路径并把整条 JSON 写入剪贴板缓冲区，附带脉冲反馈', () => {
    const doc = globalThis.document;
    const h = makeTree();
    h.tree.showRecord({ a: 1, b: [2, 3] });

    // jsdom 无 navigator.clipboard，故走 legacyCopy（textarea + execCommand）；
    // 借 execCommand 钩子读取临时 textarea 的内容，验证「复制了什么」。
    let copied = '';
    const original = (doc as unknown as { execCommand?: (c: string) => boolean }).execCommand;
    (doc as unknown as { execCommand: (c: string) => boolean }).execCommand = (_cmd: string) => {
      const ta = doc.body.querySelector('textarea');
      copied = ta ? (ta as HTMLTextAreaElement).value : '';
      return true;
    };

    try {
      const btn = tool(h, '复制 JSON');
      btn.click();
      assert.strictEqual(copied, JSON.stringify({ a: 1, b: [2, 3] }, null, 2), '复制了格式化 JSON');
      assert.ok(btn.classList.contains('copy-pulse'), '带脉冲反馈类');
      assert.strictEqual(doc.body.querySelector('textarea'), null, '临时节点已清理');
    } finally {
      (doc as unknown as { execCommand?: unknown }).execCommand = original;
    }
  });

  it('dispose：释放监听器且后续操作不抛错', () => {
    const h = makeTree();
    h.tree.showRecord({ a: { b: 1 } });
    assert.doesNotThrow(() => h.tree.dispose());
    assert.doesNotThrow(() => firstContainerRow(h).click(), 'dispose 后点击安全');
    assert.doesNotThrow(() => h.tree.clear());
  });

  /* ------------------------- 字段级编辑入口 ------------------------- */

  const entryOf = (row: HTMLElement): HTMLElement | null =>
    row.querySelector<HTMLElement>('.jlv-field-edit');
  const rowsWithEntry = (h: Harness): HTMLElement[] => rows(h).filter((r) => entryOf(r));
  /** 面包屑段数：只有根 `$` 时为 1，选中某字段后会增加。 */
  const crumbCount = (h: Harness): number => h.tree.root.querySelectorAll('.jlv-crumb-seg').length;

  it('原文可用时标量行才有编辑入口，容器行不给（改整个对象应走整行编辑）', () => {
    const h = makeTree();
    h.tree.showRecord({ name: 'bob', tags: ['a', 'b'], n: 1 }, 0, true);

    const withEntry = rowsWithEntry(h);
    assert.ok(withEntry.length >= 2, '标量行有入口');
    const containerRow = rows(h).find((r) => r.dataset.container === '1')!;
    assert.ok(containerRow, '存在容器行');
    assert.strictEqual(entryOf(containerRow), null, '容器行不给入口');
  });

  it('原文不可用时不渲染入口（点了必然报错的按钮，不如没有）', () => {
    const h = makeTree();
    h.tree.showRecord({ name: 'bob' }, 0, false);
    assert.strictEqual(rowsWithEntry(h).length, 0);

    // 缺省（不传第三参）同样不给 —— 老调用方不会被"意外"点亮入口
    h.tree.showRecord({ name: 'bob' });
    assert.strictEqual(rowsWithEntry(h).length, 0);
  });

  it('null 字段不给入口（没有「同类型的新值」可言）', () => {
    const h = makeTree();
    h.tree.showRecord({ z: null, s: 'x', b: true }, 0, true);
    assert.strictEqual(rowsWithEntry(h).length, 2, '只有 s 与 b 有入口');
    assert.deepStrictEqual(
      rowsWithEntry(h).map((r) => r.querySelector('.jlv-key')?.textContent),
      ['s', 'b']
    );
  });

  it('点击入口回调 (segs, value)，且**不**触发树行选中（阻止冒泡到委托）', () => {
    const h = makeTree();
    h.tree.showRecord({ name: 'bob' }, 0, true);
    const crumbsBefore = crumbCount(h);

    entryOf(rows(h)[0])!.click();

    assert.strictEqual(h.fields.length, 1);
    assert.deepStrictEqual(h.fields[0].segs, [{ kind: 'key', key: 'name' }]);
    assert.strictEqual(h.fields[0].value, 'bob');
    assert.strictEqual(crumbCount(h), crumbsBefore, '不该顺带把面包屑跳到该字段');
  });

  it('入口的无障碍属性与 tooltip 指明改的是哪个字段', () => {
    const h = makeTree();
    h.tree.showRecord({ name: 'bob' }, 0, true);
    const entry = entryOf(rows(h)[0])!;
    assert.strictEqual(entry.tagName, 'BUTTON');
    assert.strictEqual(entry.getAttribute('aria-label'), '编辑 .name');
    assert.match(entry.title, /编辑 \.name/);
  });

  it('进入加载态 / 错误态 / 清空后入口消失（原文与行号都可能已变）', () => {
    const h = makeTree();
    h.tree.showRecord({ name: 'bob' }, 0, true);
    assert.ok(h.tree.root.querySelector('.jlv-field-edit'), '前置：有入口');

    h.tree.showLoading();
    assert.strictEqual(h.tree.root.querySelector('.jlv-field-edit'), null, '加载态无入口');

    h.tree.showRecord({ name: 'bob' }, 0, true);
    h.tree.showError('不是合法 JSON', 0);
    assert.strictEqual(h.tree.root.querySelector('.jlv-field-edit'), null, '错误态无入口');

    h.tree.showRecord({ name: 'bob' }, 0, true);
    h.tree.clear();
    assert.strictEqual(h.tree.root.querySelector('.jlv-field-edit'), null, '清空后无入口');
  });
  it('可访问性：树行带 aria-selected，节点容器带 role=group（O13）', () => {
    const h = makeTree();
    h.tree.showRecord({ a: 1, nested: { b: 2 } }, 0);

    const ariaRows = Array.from(globalThis.document.querySelectorAll<HTMLElement>('.jlv-tree-row'));
    assert.ok(ariaRows.length > 0, '已渲染树行');
    for (const row of ariaRows) {
      assert.ok(
        row.getAttribute('aria-selected') === 'true' ||
          row.getAttribute('aria-selected') === 'false',
        '每行都要显式给出 aria-selected（读屏感知选中）'
      );
    }
    // 节点容器必须声明 group，否则 treeitem → div → treeitem 的层级对读屏是断的。
    const groups = globalThis.document.querySelectorAll('.jlv-tree-node[role="group"]');
    assert.ok(groups.length > 0, '节点容器应带 role=group');
  });
  it('F1：Ctrl+F 打开查找条，输入即高亮并给出计数，Esc 关闭后撤掉', () => {
    const doc = globalThis.document;
    const h = makeTree();
    // 默认只展开第 1 层：故用两个**顶层**键命中同一查找词，才好验证「上下条」。
    h.tree.showRecord({ name: 'alpha', nickname: 'beta' }, 0);

    const bar = (): HTMLElement => h.tree.root.querySelector<HTMLElement>('.jlv-find')!;
    const input = (): HTMLInputElement =>
      h.tree.root.querySelector<HTMLInputElement>('.jlv-find-input')!;
    const count = (): HTMLElement => h.tree.root.querySelector<HTMLElement>('.jlv-find-count')!;
    assert.strictEqual(bar().hidden, true, '前置：查找条隐藏');
    assert.strictEqual(h.tree.isFindOpen(), false);

    // Ctrl+F：焦点在详情内时打开
    h.tree.root.dispatchEvent(
      new (
        globalThis as unknown as {
          window: { KeyboardEvent: new (t: string, o?: unknown) => Event };
        }
      ).window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })
    );
    assert.strictEqual(h.tree.isFindOpen(), true, 'Ctrl+F 应打开查找条');
    assert.strictEqual(doc.activeElement, input(), '焦点移入输入框');

    input().value = 'name';
    input().dispatchEvent(
      new (globalThis as unknown as { window: { Event: new (t: string) => Event } }).window.Event(
        'input'
      )
    );
    const marks = h.tree.root.querySelectorAll('mark.jlv-hit');
    assert.strictEqual(marks.length, 2, `name / nickname 两个键名都命中，实得 ${marks.length}`);
    assert.ok(
      /^1\/\d+$/.test(count().textContent ?? ''),
      `计数形如 1/N，实得 ${count().textContent}`
    );

    // Enter 切到下一个命中：当前标记随之移动（「3/17」得能看出在看哪一处）
    input().dispatchEvent(
      new (
        globalThis as unknown as {
          window: { KeyboardEvent: new (t: string, o?: unknown) => Event };
        }
      ).window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
    );
    assert.ok(
      /^2\/\d+$/.test(count().textContent ?? ''),
      `Enter 后应为 2/N，实得 ${count().textContent}`
    );

    // Esc 关闭：高亮与计数一并撤掉
    input().dispatchEvent(
      new (
        globalThis as unknown as {
          window: { KeyboardEvent: new (t: string, o?: unknown) => Event };
        }
      ).window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
    assert.strictEqual(h.tree.isFindOpen(), false);
    assert.strictEqual(h.tree.root.querySelectorAll('mark.jlv-hit').length, 0, '高亮已撤');
    assert.strictEqual(count().textContent, '');
  });

  it('F1：查找高亮在展开/折叠后仍在（重渲染会重建行，必须重新套用）', () => {
    const h = makeTree();
    h.tree.showRecord({ alpha: 1, beta: { alpha: 2 } }, 0);
    h.tree.showFind();

    const input = h.tree.root.querySelector<HTMLInputElement>('.jlv-find-input')!;
    input.value = 'alpha';
    input.dispatchEvent(
      new (globalThis as unknown as { window: { Event: new (t: string) => Event } }).window.Event(
        'input'
      )
    );
    const hitsBefore = h.tree.root.querySelectorAll('mark.jlv-hit').length;
    assert.ok(hitsBefore > 0, '已高亮');

    // 触发一次重渲染（切换展开模式 → render()）
    const expand = h.tree.root.querySelector<HTMLButtonElement>('[data-act="expandToggle"]')!;
    expand.click();
    assert.ok(
      h.tree.root.querySelectorAll('mark.jlv-hit').length > 0,
      '重渲染后高亮必须还在（否则用户一展开就「查找结果全没了」）'
    );
  });

  it('F1：查找词为空或无命中时，计数如实显示（不谎报有命中）', () => {
    const h = makeTree();
    h.tree.showRecord({ a: 1 }, 0);
    h.tree.showFind();
    const input = h.tree.root.querySelector<HTMLInputElement>('.jlv-find-input')!;
    const count = h.tree.root.querySelector<HTMLElement>('.jlv-find-count')!;

    input.value = 'zzzz-not-present';
    input.dispatchEvent(
      new (globalThis as unknown as { window: { Event: new (t: string) => Event } }).window.Event(
        'input'
      )
    );
    assert.strictEqual(count.textContent, '无命中');
    assert.strictEqual(h.tree.root.querySelectorAll('mark.jlv-hit').length, 0);
  });
});
