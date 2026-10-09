/**
 * panelCoordinator.test.ts — 浮层面板协调器单测。
 *
 * 重点验证：
 *   1. 互斥逻辑：同时只能打开一个面板
 *   2. 惰性构建：builder 只在首次打开时调用
 *   3. toggle 行为：打开 → 关闭 → 打开
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { PanelCoordinator } from '../panelCoordinator.ts';
import type { ManagedPanel } from '../panelCoordinator.ts';

// 设置 jsdom 环境
const dom = new JSDOM('<!DOCTYPE html><body></body>');
global.document = dom.window.document as unknown as Document;

/** 创建模拟面板（记录 open/close 调用）。 */
function createMockPanel(): ManagedPanel & { openCount: number; closeCount: number } {
  const el = document.createElement('div');
  el.style.display = 'none';
  document.body.appendChild(el);

  return {
    style: el.style,
    openCount: 0,
    closeCount: 0,
    open() {
      this.openCount++;
      el.style.display = 'block';
    },
    close() {
      this.closeCount++;
      el.style.display = 'none';
    },
  };
}

test('register + toggle：首次打开时调用 builder', () => {
  const coordinator = new PanelCoordinator();
  let builderCalled = 0;
  const panel = createMockPanel();

  coordinator.register('test', () => {
    builderCalled++;
    return panel;
  });

  assert.equal(builderCalled, 0, 'builder 不应在注册时调用');

  coordinator.toggle('test');
  assert.equal(builderCalled, 1, 'builder 应在首次 toggle 时调用');
  assert.equal(panel.openCount, 1);
  assert.equal(coordinator.getCurrentOpen(), 'test');
});

test('toggle：打开 → 关闭 → 打开', () => {
  const coordinator = new PanelCoordinator();
  const panel = createMockPanel();
  coordinator.register('test', () => panel);

  // 首次 toggle：打开
  coordinator.toggle('test');
  assert.equal(panel.style.display, 'block');
  assert.equal(panel.openCount, 1);
  assert.equal(coordinator.getCurrentOpen(), 'test');

  // 再次 toggle：关闭
  coordinator.toggle('test');
  assert.equal(panel.style.display, 'none');
  assert.equal(panel.closeCount, 1);
  assert.equal(coordinator.getCurrentOpen(), null);

  // 第三次 toggle：重新打开
  coordinator.toggle('test');
  assert.equal(panel.style.display, 'block');
  assert.equal(panel.openCount, 2);
  assert.equal(coordinator.getCurrentOpen(), 'test');
});

test('互斥：打开面板 B 时自动关闭面板 A', () => {
  const coordinator = new PanelCoordinator();
  const panelA = createMockPanel();
  const panelB = createMockPanel();

  coordinator.register('A', () => panelA);
  coordinator.register('B', () => panelB);

  // 打开 A
  coordinator.toggle('A');
  assert.equal(panelA.style.display, 'block');
  assert.equal(coordinator.getCurrentOpen(), 'A');

  // 打开 B → 应自动关闭 A
  coordinator.toggle('B');
  assert.equal(panelA.style.display, 'none', 'A 应被关闭');
  assert.equal(panelA.closeCount, 1);
  assert.equal(panelB.style.display, 'block', 'B 应打开');
  assert.equal(panelB.openCount, 1);
  assert.equal(coordinator.getCurrentOpen(), 'B');
});

test('closeAll：关闭所有打开的面板', () => {
  const coordinator = new PanelCoordinator();
  const panelA = createMockPanel();
  const panelB = createMockPanel();

  coordinator.register('A', () => panelA);
  coordinator.register('B', () => panelB);

  coordinator.toggle('A');
  assert.equal(panelA.style.display, 'block');

  coordinator.closeAll();
  assert.equal(panelA.style.display, 'none');
  assert.equal(panelA.closeCount, 1);
  assert.equal(coordinator.getCurrentOpen(), null);
});

test('destroy：调用所有 dispose 函数', () => {
  const coordinator = new PanelCoordinator();
  let disposeACalled = 0;
  let disposeBCalled = 0;

  coordinator.register('A', createMockPanel, () => {
    disposeACalled++;
  });
  coordinator.register('B', createMockPanel, () => {
    disposeBCalled++;
  });

  coordinator.destroy();
  assert.equal(disposeACalled, 1);
  assert.equal(disposeBCalled, 1);
  assert.equal(coordinator.getCurrentOpen(), null);
});

test('重复注册抛出错误', () => {
  const coordinator = new PanelCoordinator();
  coordinator.register('test', createMockPanel);

  assert.throws(() => {
    coordinator.register('test', createMockPanel);
  }, /already registered/);
});

test('toggle 未注册的面板抛出错误', () => {
  const coordinator = new PanelCoordinator();

  assert.throws(() => {
    coordinator.toggle('nonexistent');
  }, /not registered/);
});

test('惰性构建：builder 只调用一次', () => {
  const coordinator = new PanelCoordinator();
  let builderCalled = 0;
  const panel = createMockPanel();

  coordinator.register('test', () => {
    builderCalled++;
    return panel;
  });

  // 打开 → 关闭 → 再打开
  coordinator.toggle('test');
  coordinator.toggle('test');
  coordinator.toggle('test');

  assert.equal(builderCalled, 1, 'builder 只应调用一次');
  assert.equal(panel.openCount, 2, '面板应打开两次');
});
