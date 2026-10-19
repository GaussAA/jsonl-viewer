import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { setupWebviewDom } from './domHarness.ts';
import {
  createPanelButton,
  createPanelHead,
  createPanelTitle,
  createReportBody,
} from '../panelChrome.ts';

/**
 * 浮层外壳零件：DOM 结构与 class 名是样式契约，必须与原先内联写法逐字一致。
 */

describe('panelChrome', () => {
  before(() => {
    setupWebviewDom();
  });

  it('createPanelButton：jlv-btn 外观、type=button、点击回调；title 可缺省', () => {
    let clicks = 0;
    const withTitle = createPanelButton('关闭', () => clicks++, '提示');
    assert.strictEqual(withTitle.tagName, 'BUTTON');
    assert.strictEqual(withTitle.type, 'button');
    assert.strictEqual(withTitle.className, 'jlv-btn');
    assert.strictEqual(withTitle.textContent, '关闭');
    assert.strictEqual(withTitle.title, '提示');
    withTitle.click();
    assert.strictEqual(clicks, 1);

    const noTitle = createPanelButton('x', () => {});
    assert.strictEqual(noTitle.hasAttribute('title'), false, '缺省时不写 title 属性');
  });

  it('createPanelTitle：有文案则写入，缺省则留空', () => {
    const t = createPanelTitle('编辑历史');
    assert.strictEqual(t.className, 'jlv-edit-title');
    assert.strictEqual(t.textContent, '编辑历史');
    assert.strictEqual(createPanelTitle().textContent, '');
  });

  it('createPanelHead：标题在前，动作区按传入顺序排列', () => {
    const title = createPanelTitle('t');
    const a = createPanelButton('a', () => {});
    const b = createPanelButton('b', () => {});
    const head = createPanelHead(title, [a, b]);
    assert.strictEqual(head.className, 'jlv-edit-head');
    assert.strictEqual(head.children.length, 2);
    assert.strictEqual(head.children[0], title);
    const actions = head.children[1] as HTMLElement;
    assert.strictEqual(actions.className, 'jlv-edit-head-actions');
    assert.deepStrictEqual(Array.from(actions.children), [a, b]);
  });

  it('createReportBody：状态行 / 默认隐藏的提示 / 列表的 class 契约', () => {
    const { status, note, list } = createReportBody();
    assert.strictEqual(status.className, 'jlv-bad-status');
    assert.strictEqual(note.className, 'jlv-bad-note');
    assert.strictEqual(note.hidden, true);
    assert.strictEqual(list.className, 'jlv-bad-list');
  });
});
