import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { setupWebviewDom } from './domHarness.ts';
import { setupFocusTrap } from '../focusTrap.ts';

/**
 * 焦点陷阱测试：Esc 关闭、Tab/Shift+Tab 循环、自动聚焦、dispose 解绑。
 */

type KbCtor = new (t: string, o?: unknown) => Event;
const kbd = (): KbCtor =>
  (globalThis as unknown as { window: { KeyboardEvent: KbCtor } }).window.KeyboardEvent;

function press(el: HTMLElement, key: string, shiftKey = false): Event {
  const ev = new (kbd())('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

function makeDialog(): {
  box: HTMLElement;
  a: HTMLButtonElement;
  b: HTMLInputElement;
  c: HTMLButtonElement;
  outside: HTMLButtonElement;
} {
  const doc = globalThis.document;
  doc.body.innerHTML = '';
  const outside = doc.createElement('button');
  const box = doc.createElement('div');
  const a = doc.createElement('button');
  const b = doc.createElement('input');
  const c = doc.createElement('button');
  box.append(a, b, c);
  doc.body.append(outside, box);
  return { box, a, b, c, outside };
}

describe('setupFocusTrap', () => {
  before(() => {
    setupWebviewDom();
  });

  it('打开时自动聚焦第一个可聚焦控件', () => {
    const { box, a } = makeDialog();
    setupFocusTrap({ container: box, onClose: () => {} });
    assert.strictEqual(globalThis.document.activeElement, a);
  });

  it('noAutoFocus：不抢焦点', () => {
    const { box, outside } = makeDialog();
    outside.focus();
    setupFocusTrap({ container: box, onClose: () => {}, noAutoFocus: true });
    assert.strictEqual(globalThis.document.activeElement, outside);
  });

  it('容器内没有可聚焦元素：不抛错，Tab 不处理', () => {
    const doc = globalThis.document;
    doc.body.innerHTML = '';
    const box = doc.createElement('div');
    doc.body.append(box);
    let closed = 0;
    setupFocusTrap({ container: box, onClose: () => closed++ });
    const ev = press(box, 'Tab');
    assert.strictEqual(ev.defaultPrevented, false);
    assert.strictEqual(closed, 0);
  });

  it('Esc 触发 onClose', () => {
    const { box, b } = makeDialog();
    let closed = 0;
    setupFocusTrap({ container: box, onClose: () => closed++ });
    press(b, 'Escape');
    assert.strictEqual(closed, 1);
  });

  it('Tab 在最后一个控件上回绕到第一个', () => {
    const { box, a, c } = makeDialog();
    setupFocusTrap({ container: box, onClose: () => {} });
    c.focus();
    const ev = press(c, 'Tab');
    assert.strictEqual(ev.defaultPrevented, true);
    assert.strictEqual(globalThis.document.activeElement, a);
  });

  it('Tab 在中间控件上不拦截（交给浏览器默认顺序）', () => {
    const { box, b } = makeDialog();
    setupFocusTrap({ container: box, onClose: () => {} });
    b.focus();
    const ev = press(b, 'Tab');
    assert.strictEqual(ev.defaultPrevented, false);
  });

  it('Shift+Tab 在第一个控件上回绕到最后一个', () => {
    const { box, a, c } = makeDialog();
    setupFocusTrap({ container: box, onClose: () => {} });
    a.focus();
    const ev = press(a, 'Tab', true);
    assert.strictEqual(ev.defaultPrevented, true);
    assert.strictEqual(globalThis.document.activeElement, c);
  });

  it('Shift+Tab 时焦点已在容器外：拉回最后一个控件', () => {
    const { box, c, outside } = makeDialog();
    setupFocusTrap({ container: box, onClose: () => {} });
    outside.focus();
    const ev = press(box, 'Tab', true);
    assert.strictEqual(ev.defaultPrevented, true);
    assert.strictEqual(globalThis.document.activeElement, c);
  });

  it('disabled 控件与 tabindex=-1 不参与循环', () => {
    const { box, a, b, c } = makeDialog();
    b.disabled = true;
    c.setAttribute('tabindex', '-1');
    setupFocusTrap({ container: box, onClose: () => {} });
    // 只剩 a 可聚焦：Tab 在 a（既是第一个也是最后一个）上回绕到自己
    a.focus();
    const ev = press(a, 'Tab');
    assert.strictEqual(ev.defaultPrevented, true);
    assert.strictEqual(globalThis.document.activeElement, a);
  });

  it('其他按键被忽略', () => {
    const { box, a } = makeDialog();
    let closed = 0;
    setupFocusTrap({ container: box, onClose: () => closed++ });
    const ev = press(a, 'Enter');
    assert.strictEqual(ev.defaultPrevented, false);
    assert.strictEqual(closed, 0);
  });

  it('dispose 之后不再响应 Esc', () => {
    const { box, a } = makeDialog();
    let closed = 0;
    const trap = setupFocusTrap({ container: box, onClose: () => closed++ });
    trap.dispose();
    press(a, 'Escape');
    assert.strictEqual(closed, 0);
  });
});
