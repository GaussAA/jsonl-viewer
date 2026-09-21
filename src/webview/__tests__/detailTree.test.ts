import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { setupWebviewDom } from './domHarness.ts';
import { createDetailTree, type DetailTreeController, type DetailTreeNavHandlers } from '../detailTree.ts';

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
}

function makeTree(): Harness {
  const doc = globalThis.document;
  // 用例级隔离：清空文档，避免前序用例残留节点被内部文档级查询命中。
  doc.body.innerHTML = '';
  const host = doc.createElement('div');
  doc.body.append(host);
  const nav = { prev: 0, next: 0 };
  const handlers: DetailTreeNavHandlers = {
    onPrevRecord: () => {
      nav.prev += 1;
    },
    onNextRecord: () => {
      nav.next += 1;
    },
  };
  const tree = createDetailTree(host, handlers);
  host.append(tree.root);
  return { tree, host, nav };
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
    assert.match(h.tree.root.querySelector('.jlv-detail-header')?.textContent ?? '', /Record #8/, '行号按 1 起展示');
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
    assert.match(h.tree.root.querySelector('.jlv-tree-body')?.textContent ?? '', /点击左侧记录/, '提示未选中');
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
});
