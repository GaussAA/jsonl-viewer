/**
 * profilePanel.test.ts — 数据画像浮层（F4）。
 *
 * 两条核心不变式：
 *   1. **中断的结果必须自曝**：半份统计与全量统计在界面上长得一样，
 *      唯一能把它们分开的就是文案 —— 所以取消时抬头与提示条都要说话；
 *   2. **进度只改文案、不重建节点**：否则每 ~100ms 一次的回调会让「重新扫描」
 *      按钮闪烁甚至吞掉点击（本项目在长任务上踩过这个坑）。
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { setupWebviewDom } from './domHarness.ts';
import { createProfilePanel } from '../profilePanel.ts';
import type { FieldProfile, ProfilePayload, ProfileResult } from '../../protocol/rpc.ts';

const REAL_SET_TIMEOUT = globalThis.setTimeout;
const wait = (ms: number): Promise<void> => new Promise((r) => REAL_SET_TIMEOUT(() => r(), ms));

function field(partial: Partial<FieldProfile> & { key: string }): FieldProfile {
  return {
    present: 10,
    missing: 0,
    nulls: 0,
    empties: 0,
    types: { string: 10 },
    type: 'string',
    top: [{ value: 'error', count: 7 }],
    valuesTruncated: false,
    ...partial,
  };
}

function profile(over: Partial<ProfileResult> = {}): ProfileResult {
  return {
    scanned: 10,
    parsed: 10,
    bad: 0,
    totalRecords: 10,
    totalLines: 10,
    fields: [field({ key: 'level' }), field({ key: 'msg', missing: 3 })],
    fieldsTruncated: false,
    costMs: 20,
    ...over,
  };
}

interface Harness {
  panel: ReturnType<typeof createProfilePanel>;
  calls: { filtered: string[] };
  payload: ProfilePayload;
  scanCount: number;
  scanning: boolean;
}

function makePanel(): Harness {
  const calls = { filtered: [] as string[] };
  const h: Harness = {
    panel: undefined as unknown as ReturnType<typeof createProfilePanel>,
    calls,
    payload: { ok: true, result: profile() },
    scanCount: 0,
    scanning: false,
  };
  h.panel = createProfilePanel({
    scan: async () => {
      h.scanCount++;
      h.scanning = true;
      try {
        // 模拟宿主往返：让 open() 之后的 await 真正经过一次微任务。
        await wait(1);
        return h.payload;
      } finally {
        h.scanning = false;
      }
    },
    isScanning: () => h.scanning,
    onFilterField: (key) => calls.filtered.push(key),
    notify: () => {},
  });
  return h;
}

const rows = (h: Harness): HTMLElement[] =>
  Array.from(h.panel.root.querySelectorAll<HTMLElement>('.jlv-prof-row'));
const statusOf = (h: Harness): HTMLElement =>
  h.panel.root.querySelector<HTMLElement>('.jlv-bad-status')!;

describe('profilePanel（F4 数据画像）', () => {
  before(() => {
    setupWebviewDom();
  });

  it('打开即自动扫描一次并渲染字段行（点「画像」就是想看数据）', async () => {
    const h = makePanel();
    h.panel.open();
    await wait(20);

    assert.strictEqual(h.scanCount, 1, '自动扫一次，不需要用户再点「开始扫描」');
    assert.strictEqual(rows(h).length, 2, '两个字段各一行');
    const text = rows(h)
      .map((r) => r.textContent ?? '')
      .join(' | ');
    assert.match(text, /level/);
    assert.match(text, /error ×7/, 'top 取值与次数都要给出');
  });

  it('中断的结果自曝：抬头第一句 + 提示条', async () => {
    const h = makePanel();
    h.payload = { ok: true, result: profile({ cancelled: true, scanned: 3, totalRecords: 999 }) };
    h.panel.open();
    await wait(20);

    assert.match(statusOf(h).textContent ?? '', /^已中断/, '抬头第一句就说结果不可信');
    const note = h.panel.root.querySelector<HTMLElement>('.jlv-bad-note')!;
    assert.strictEqual(note.hidden, false, '另有一条醒目提示');
    assert.match(note.textContent ?? '', /不代表整个文件/);
  });

  it('未中断时不显示警示条（不给正常结果加戏）', async () => {
    const h = makePanel();
    h.panel.open();
    await wait(20);
    const note = h.panel.root.querySelector<HTMLElement>('.jlv-bad-note')!;
    assert.strictEqual(note.hidden, true);
  });

  it('进度只改文案，不重建按钮（否则「重新扫描」会闪、可能吞掉点击）', async () => {
    const h = makePanel();
    h.panel.open();
    await wait(20);

    const btnBefore = h.panel.root.querySelector<HTMLButtonElement>('.jlv-btn')!;
    const statusBefore = statusOf(h);
    h.panel.setProgress(512, 1024);

    assert.match(statusOf(h).textContent ?? '', /50%/, '百分比如实显示');
    assert.strictEqual(statusOf(h), statusBefore, '抬头节点是同一个（只换了文字）');
    assert.strictEqual(
      h.panel.root.querySelector<HTMLButtonElement>('.jlv-btn'),
      btnBefore,
      '按钮节点没有被重建'
    );
  });

  it('进度百分比封顶 100（尾块越界不得显示 101%）', async () => {
    const h = makePanel();
    h.panel.open();
    await wait(20);
    h.panel.setProgress(2048, 1024);
    assert.match(statusOf(h).textContent ?? '', /100%/);
  });

  it('「筛选」按钮用 exists 语义回传字段名（不是让用户先猜一个值）', async () => {
    const h = makePanel();
    h.panel.open();
    await wait(20);

    const first = rows(h)[0];
    const filterBtn = Array.from(first.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      (b.textContent ?? '').includes('筛选')
    );
    assert.ok(filterBtn, '每行都有「筛选」按钮');
    filterBtn!.click();
    assert.deepStrictEqual(h.calls.filtered, ['level']);
  });

  it('扫描失败要说话，且不留一屏旧数字', async () => {
    const h = makePanel();
    h.panel.open();
    await wait(20);
    assert.strictEqual(rows(h).length, 2, '前置：先有一次成功渲染');

    h.payload = { ok: false, error: '读取失败' };
    // 再次扫描（点「重新扫描」）
    const rescan = Array.from(h.panel.root.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => (b.textContent ?? '').includes('扫描')
    )!;
    rescan.click();
    await wait(20);

    assert.match(statusOf(h).textContent ?? '', /画像失败/);
    assert.match(statusOf(h).textContent ?? '', /读取失败/);
    assert.strictEqual(
      h.panel.root.querySelector<HTMLElement>('.jlv-bad-empty')?.textContent,
      '未能取得画像。',
      '失败态与「一屏旧数字」必须分开'
    );
  });

  it('排序切换按缺失最多重排（数据清洗先看最不完整的字段）', async () => {
    const h = makePanel();
    h.panel.open();
    await wait(20);
    assert.strictEqual(rows(h)[0].textContent?.includes('level'), true, '默认按出现次数');

    const sortSel = h.panel.root.querySelector<HTMLSelectElement>('select')!;
    sortSel.value = 'missing';
    sortSel.dispatchEvent(
      new (globalThis as unknown as { window: { Event: new (t: string) => Event } }).window.Event(
        'change'
      )
    );
    assert.strictEqual(rows(h)[0].textContent?.includes('msg'), true, '按缺失最多时 msg 在前');
  });

  it('关闭后再打开不重复扫描（已有结果就复用）', async () => {
    const h = makePanel();
    h.panel.open();
    await wait(20);
    h.panel.close();
    await wait(140); // 等淡出定时器
    h.panel.open();
    await wait(20);
    assert.strictEqual(h.scanCount, 1, '结果还在，不该再扫一遍');
  });

  it('dispose 后移除根节点（不留孤儿 DOM）', () => {
    const h = makePanel();
    const doc = globalThis.document;
    doc.body.appendChild(h.panel.root);
    assert.ok(doc.body.contains(h.panel.root));
    h.panel.dispose();
    assert.strictEqual(doc.body.contains(h.panel.root), false);
  });
});
