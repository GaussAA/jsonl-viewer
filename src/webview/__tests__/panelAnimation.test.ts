import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { setupWebviewDom } from './domHarness.ts';
import { createPanelAnimation } from '../panelAnimation.ts';

/**
 * 浮层开合状态机：四个面板（坏行 / 历史 / 画像 / 字段）共用，行为必须一致。
 */

const REAL_SET_TIMEOUT = globalThis.setTimeout;
const wait = (ms: number): Promise<void> => new Promise((r) => REAL_SET_TIMEOUT(() => r(), ms));

function make(opts: { closeDelayMs?: number; onOpen?: () => void } = {}) {
  const doc = globalThis.document;
  doc.body.innerHTML = '';
  const backdrop = doc.createElement('div');
  backdrop.hidden = true;
  const panel = doc.createElement('div');
  const btn = doc.createElement('button');
  panel.append(btn);
  backdrop.append(panel);
  doc.body.append(backdrop);
  const anim = createPanelAnimation({ panel, backdrop, ...opts });
  return { anim, backdrop, panel };
}

describe('createPanelAnimation', () => {
  before(() => {
    setupWebviewDom();
  });

  it('open：显示遮罩，下一帧加 open 类，并触发 onOpen', async () => {
    let opened = 0;
    const { anim, backdrop, panel } = make({ onOpen: () => opened++ });
    anim.open();
    assert.strictEqual(anim.isOpen(), true);
    assert.strictEqual(backdrop.hidden, false);
    assert.strictEqual(opened, 1);
    await wait(40);
    assert.ok(backdrop.classList.contains('open'));
    assert.ok(panel.classList.contains('open'));
  });

  it('重复 open 幂等：onOpen 只触发一次', () => {
    let opened = 0;
    const { anim } = make({ onOpen: () => opened++ });
    anim.open();
    anim.open();
    assert.strictEqual(opened, 1);
  });

  it('close：去掉 open 类，延迟后才真正隐藏', async () => {
    const { anim, backdrop, panel } = make({ closeDelayMs: 30 });
    anim.open();
    await wait(40);
    anim.close();
    assert.strictEqual(anim.isOpen(), false);
    assert.ok(!panel.classList.contains('open'));
    assert.strictEqual(backdrop.hidden, false, '收起过渡期间遮罩仍在');
    await wait(60);
    assert.strictEqual(backdrop.hidden, true);
  });

  it('未打开时 close 无操作', () => {
    const { anim, backdrop } = make();
    anim.close();
    assert.strictEqual(anim.isOpen(), false);
    assert.strictEqual(backdrop.hidden, true);
  });

  it('关闭过渡期间重新打开：旧定时器不得把新开的浮层藏掉', async () => {
    const { anim, backdrop } = make({ closeDelayMs: 40 });
    anim.open();
    await wait(20);
    anim.close();
    anim.open();
    await wait(80);
    assert.strictEqual(anim.isOpen(), true);
    assert.strictEqual(backdrop.hidden, false);
  });

  it('打开后挂上焦点陷阱：Esc 触发关闭', async () => {
    const { anim, panel } = make();
    anim.open();
    await wait(40);
    const Kb = (
      globalThis as unknown as {
        window: { KeyboardEvent: new (t: string, o?: unknown) => Event };
      }
    ).window.KeyboardEvent;
    panel.dispatchEvent(new Kb('keydown', { key: 'Escape', bubbles: true }));
    assert.strictEqual(anim.isOpen(), false);
  });

  describe('onDismiss（全局 Esc / 点击遮罩空白处）', () => {
    // 必须惰性取：describe 体在 before() 装配 DOM 之前就会执行。
    const Kb = function (t: string, o?: unknown): Event {
      const C = (
        globalThis as unknown as {
          window: { KeyboardEvent: new (t: string, o?: unknown) => Event };
        }
      ).window.KeyboardEvent;
      return new C(t, o);
    } as unknown as new (t: string, o?: unknown) => Event;
    const Mouse = function (t: string, o?: unknown): Event {
      const C = (
        globalThis as unknown as {
          window: { MouseEvent: new (t: string, o?: unknown) => Event };
        }
      ).window.MouseEvent;
      return new C(t, o);
    } as unknown as new (t: string, o?: unknown) => Event;

    function makeDismissable() {
      const doc = globalThis.document;
      doc.body.innerHTML = '';
      const backdrop = doc.createElement('div');
      const panel = doc.createElement('div');
      backdrop.append(panel);
      doc.body.append(backdrop);
      let dismissed = 0;
      const anim = createPanelAnimation({ panel, backdrop, onDismiss: () => dismissed++ });
      return { anim, backdrop, panel, count: () => dismissed };
    }

    it('打开后 document 级 Esc 触发 onDismiss 并 preventDefault；未打开时忽略', () => {
      const { anim, count } = makeDismissable();
      const closedEvt = new Kb('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      globalThis.document.dispatchEvent(closedEvt);
      assert.strictEqual(count(), 0, '未打开不响应');
      assert.strictEqual(closedEvt.defaultPrevented, false);

      anim.open();
      const evt = new Kb('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      globalThis.document.dispatchEvent(evt);
      assert.strictEqual(count(), 1);
      assert.strictEqual(evt.defaultPrevented, true);

      globalThis.document.dispatchEvent(new Kb('keydown', { key: 'a', bubbles: true }));
      assert.strictEqual(count(), 1, '非 Esc 按键不触发');
      anim.dispose();
    });

    it('点击遮罩空白处触发 onDismiss；点击浮层内部不触发', () => {
      const { anim, backdrop, panel, count } = makeDismissable();
      anim.open();
      panel.dispatchEvent(new Mouse('click', { bubbles: true }));
      assert.strictEqual(count(), 0, '冒泡自浮层内部的点击 target 不是遮罩');
      backdrop.dispatchEvent(new Mouse('click', { bubbles: true }));
      assert.strictEqual(count(), 1);
      anim.dispose();
    });

    it('dispose 卸掉全局 Esc 监听', () => {
      const { anim, count } = makeDismissable();
      anim.open();
      anim.dispose();
      globalThis.document.dispatchEvent(new Kb('keydown', { key: 'Escape', bubbles: true }));
      assert.strictEqual(count(), 0);
    });

    it('未传 onDismiss 时不挂全局 Esc / 遮罩点击', () => {
      const { anim, backdrop } = make();
      anim.open();
      globalThis.document.dispatchEvent(new Kb('keydown', { key: 'Escape', bubbles: true }));
      backdrop.dispatchEvent(new Mouse('click', { bubbles: true }));
      assert.strictEqual(anim.isOpen(), true, '由调用方自行决定是否启用');
      anim.dispose();
    });
  });

  it('dispose：撤掉焦点陷阱与定时器，之后 Esc 不再响应', async () => {
    const { anim, panel } = make({ closeDelayMs: 30 });
    anim.open();
    await wait(40);
    anim.dispose();
    const Kb = (
      globalThis as unknown as {
        window: { KeyboardEvent: new (t: string, o?: unknown) => Event };
      }
    ).window.KeyboardEvent;
    panel.dispatchEvent(new Kb('keydown', { key: 'Escape', bubbles: true }));
    assert.strictEqual(anim.isOpen(), true, 'dispose 后陷阱已卸载，Esc 不再关闭');
  });
});
