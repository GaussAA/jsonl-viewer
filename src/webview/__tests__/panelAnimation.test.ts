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
