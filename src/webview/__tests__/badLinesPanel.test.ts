import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { setupWebviewDom } from './domHarness.ts';
import { createBadLinesPanel, describeBadLines, scanProgressText } from '../badLinesPanel.ts';
import type { BadLinesPayload } from '../../protocol/rpc.ts';

/**
 * 坏行诊断浮层测试。
 *
 * 核心不变式（断言都围绕它展开）：
 *   1. `partial` 与全量两种状态**必须一眼可分** —— 把「已发现 3 个」说成「共 3 个」，
 *      会让用户据一个偏小的数字认定文件基本干净，这是与事实相反的结论；
 *   2. 取消**不得**被报成失败（取消是零风险的）；
 *   3. 「全选坏行」被拒（返回 0）时不得关闭浮层 —— 否则用户以为选上了。
 */

const REAL_SET_TIMEOUT = globalThis.setTimeout;
const wait = (ms: number): Promise<void> => new Promise((r) => REAL_SET_TIMEOUT(() => r(), ms));

const payload = (over: Partial<BadLinesPayload> = {}): BadLinesPayload => ({
  lines: [],
  partial: true,
  scanned: 0,
  totalLines: 0,
  truncated: false,
  ...over,
});

interface Harness {
  panel: ReturnType<typeof createBadLinesPanel>;
  calls: { jump: number[]; notify: string[] };
  selectArgs: number[][];
  selectResult: number;
  fetchPayload: BadLinesPayload;
  fetchError?: string;
  scanPayload: BadLinesPayload;
  scanError?: string;
  scanning: boolean;
  scanCount: number;
}

function makePanel(): Harness {
  globalThis.document.body.innerHTML = '';
  const h: Harness = {
    panel: undefined as unknown as ReturnType<typeof createBadLinesPanel>,
    calls: { jump: [], notify: [] },
    selectArgs: [],
    selectResult: 3,
    fetchPayload: payload(),
    scanPayload: payload({ partial: false, scanned: 5, totalLines: 5 }),
    scanning: false,
    scanCount: 0,
  };

  h.panel = createBadLinesPanel({
    fetchBadLines: async () => {
      if (h.fetchError) throw new Error(h.fetchError);
      return h.fetchPayload;
    },
    scanBadLines: async () => {
      h.scanCount++;
      if (h.scanError) throw new Error(h.scanError);
      // 模拟真实宿主：扫描成功后其坏行集合**被替换**，故后续查询反映的是全量。
      // （浮层在扫描后会再 refresh 一次；若 mock 不体现这一点，就会测出一个
      // 真实世界里不存在的「扫描结果被旧数据覆盖」的假象。）
      if (!h.scanPayload.cancelled) h.fetchPayload = h.scanPayload;
      return h.scanPayload;
    },
    isScanning: () => h.scanning,
    jumpTo: (line) => h.calls.jump.push(line),
    selectLines: (lines) => {
      h.selectArgs.push([...lines]);
      return h.selectResult;
    },
    notify: (message) => h.calls.notify.push(message),
  });
  globalThis.document.body.append(h.panel.root);
  return h;
}

const panelEl = (): HTMLElement => globalThis.document.querySelector<HTMLElement>('.jlv-bad')!;
const statusText = (): string =>
  globalThis.document.querySelector<HTMLElement>('.jlv-bad-status')!.textContent ?? '';
const noteEl = (): HTMLElement => globalThis.document.querySelector<HTMLElement>('.jlv-bad-note')!;
const rows = (): HTMLButtonElement[] =>
  Array.from(globalThis.document.querySelectorAll<HTMLButtonElement>('.jlv-bad-row'));
const emptyText = (): string =>
  globalThis.document.querySelector<HTMLElement>('.jlv-bad-empty')?.textContent ?? '';
/**
 * 按 `title` 定位按钮 —— 不能按文案：扫描按钮在扫描期间文案会变成「扫描中…」，
 * 用 /扫描整个文件/ 去找会在扫描中途失效（测试里踩到过）。
 */
const byTitle = (title: RegExp): HTMLButtonElement =>
  Array.from(panelEl().querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    title.test(b.title)
  )!;
const scanBtn = (): HTMLButtonElement => byTitle(/扫描整个文件/);
const selectBtn = (): HTMLButtonElement => byTitle(/写入选区/);

/**
 * 派发一次 Esc。
 *
 * 两个必须注意的点（都踩过）：
 *   1. jsdom 的 KeyboardEvent 挂在 window 上，不在 globalThis；
 *   2. **不得在模块顶层取它** —— DOM 桩由 `before` 里的 setupWebviewDom() 安装，
 *      顶层求值时 `globalThis.document` 还不存在，会让整个测试文件加载失败。
 */
function pressEscape(): void {
  const KE = globalThis.document.defaultView!.KeyboardEvent;
  globalThis.document.dispatchEvent(new KE('keydown', { key: 'Escape' }));
}

describe('badLinesPanel', () => {
  before(() => {
    setupWebviewDom();
  });

  it('打开后拉取并渲染坏行（行号按 1 基展示）', async () => {
    const h = makePanel();
    h.fetchPayload = payload({ lines: [3, 17], totalLines: 100 });
    await h.panel.open();
    await wait(20);

    assert.strictEqual(panelEl().classList.contains('open'), true);
    const rs = rows();
    assert.strictEqual(rs.length, 2);
    assert.strictEqual(rs[0].textContent?.includes('第 4 行'), true, '0 基 → 1 基');
    assert.strictEqual(rs[1].textContent?.includes('第 18 行'), true);
  });

  it('partial：状态行与提示都点明「仅在已浏览范围内」', async () => {
    const h = makePanel();
    h.fetchPayload = payload({ lines: [1], partial: true, totalLines: 500 });
    await h.panel.open();
    await wait(20);

    assert.match(statusText(), /已发现 1 个坏行/);
    assert.match(statusText(), /仅在已浏览范围内/);
    assert.strictEqual(noteEl().hidden, false, '提示必须可见');
    assert.match(noteEl().textContent ?? '', /不代表文件只有这些坏行/);
  });

  it('全量：状态行为「共 N 个」，提示隐藏', async () => {
    const h = makePanel();
    h.fetchPayload = payload({ lines: [1, 2], partial: false, scanned: 5, totalLines: 5 });
    await h.panel.open();
    await wait(20);

    assert.match(statusText(), /共 2 个坏行/);
    assert.ok(!/已浏览范围/.test(statusText()), '不得再提「已浏览范围」');
    assert.strictEqual(noteEl().hidden, true);
  });

  it('空态文案区分两种完整性（不能混为一谈）', async () => {
    // 注意：open() 是幂等的（已打开则直接返回），故两种状态各用一个新的浮层实例，
    // 而不是在同一个实例上改数据再 open（那样第二次不会重新拉取）。
    const partialH = makePanel();
    partialH.fetchPayload = payload({ lines: [], partial: true });
    await partialH.panel.open();
    await wait(20);
    assert.match(emptyText(), /尚未发现坏行/);
    assert.match(emptyText(), /也未做全文件扫描/, '必须说明「没查过」');

    const fullH = makePanel();
    fullH.fetchPayload = payload({ lines: [], partial: false });
    await fullH.panel.open();
    await wait(20);
    assert.match(emptyText(), /整个文件未发现坏行/);
  });

  it('truncated：状态行如实提示截断', async () => {
    const h = makePanel();
    h.fetchPayload = payload({ lines: [1, 2], partial: false, truncated: true });
    await h.panel.open();
    await wait(20);

    assert.match(statusText(), /已截断/);
  });

  it('点击某行 → 跳转该行并关闭浮层', async () => {
    const h = makePanel();
    h.fetchPayload = payload({ lines: [7], partial: false });
    await h.panel.open();
    await wait(20);

    rows()[0].click();
    await wait(20);

    assert.deepStrictEqual(h.calls.jump, [7], '跳转用 0 基行号');
    assert.strictEqual(h.panel.isOpen(), false);
  });

  it('扫描：调宿主、渲染结果、如实通知并含耗时', async () => {
    const h = makePanel();
    h.scanPayload = payload({ lines: [2, 4, 6], partial: false, costMs: 2500 });
    await h.panel.open();
    await wait(20);

    scanBtn().click();
    await wait(30);

    assert.strictEqual(h.scanCount, 1);
    assert.strictEqual(rows().length, 3);
    assert.match(h.calls.notify[0], /共 3 个坏行/);
    assert.match(h.calls.notify[0], /约 3 秒/, '耗时按秒展示');
    assert.match(statusText(), /共 3 个坏行/, '渲染也切到全量口径');
  });

  it('扫描中：按钮禁用且文案变为「扫描中…」', async () => {
    const h = makePanel();
    // 模拟装配层状态：扫描期间 isScanning() 为 true
    h.scanning = true;
    await h.panel.open();
    await wait(20);

    const btn = scanBtn();
    assert.strictEqual(btn.disabled, true, '扫描中不得再次触发');
  });

  it('取消：通知里说「已取消」，绝不报成失败', async () => {
    const h = makePanel();
    h.scanPayload = payload({ lines: [], partial: true, cancelled: true });
    await h.panel.open();
    await wait(20);

    scanBtn().click();
    await wait(30);

    assert.match(h.calls.notify[0], /已取消/);
    assert.match(h.calls.notify[0], /未被改动/);
    assert.ok(!/失败/.test(h.calls.notify[0]), '取消是零风险的，不得报成失败');
  });

  it('扫描抛错：通知里说「失败」并带原因', async () => {
    const h = makePanel();
    h.scanError = '磁盘读取错误';
    await h.panel.open();
    await wait(20);

    scanBtn().click();
    await wait(30);

    assert.match(h.calls.notify[0], /扫描失败/);
    assert.match(h.calls.notify[0], /磁盘读取错误/);
  });

  it('全选坏行：入参为全部坏行，选中成功则关闭浮层', async () => {
    const h = makePanel();
    h.fetchPayload = payload({ lines: [1, 5, 9], partial: false });
    h.selectResult = 3;
    await h.panel.open();
    await wait(20);

    selectBtn().click();
    await wait(20);

    assert.deepStrictEqual(h.selectArgs, [[1, 5, 9]]);
    assert.strictEqual(h.panel.isOpen(), false, '选中后关闭，让用户看到选区');
  });

  it('全选坏行被拒（返回 0）时保持打开，不假装成功', async () => {
    const h = makePanel();
    h.fetchPayload = payload({ lines: [1, 5], partial: false });
    h.selectResult = 0;
    await h.panel.open();
    await wait(20);

    selectBtn().click();
    await wait(20);

    assert.strictEqual(h.panel.isOpen(), true, '被拒却关闭会让用户以为选上了');
  });

  it('无坏行时「全选坏行」按钮禁用', async () => {
    const h = makePanel();
    h.fetchPayload = payload({ lines: [], partial: false });
    await h.panel.open();
    await wait(20);

    assert.strictEqual(selectBtn().disabled, true);
  });

  it('Esc 关闭；关闭是幂等的', async () => {
    const h = makePanel();
    await h.panel.open();
    await wait(20);
    assert.strictEqual(h.panel.isOpen(), true);

    pressEscape();
    await wait(20);
    assert.strictEqual(h.panel.isOpen(), false);

    assert.doesNotThrow(() => h.panel.close());
  });

  it('拉取失败：给出可读的失败文案，不渲染半成品', async () => {
    const h = makePanel();
    h.fetchError = '宿主无响应';
    await h.panel.open();
    await wait(20);

    assert.match(emptyText(), /读取坏行失败/);
    assert.match(emptyText(), /宿主无响应/);
    assert.strictEqual(rows().length, 0, '失败时不得渲染残留行');
  });
});

describe('坏行文案（纯函数）', () => {
  it('describeBadLines：取消 / 未完成 / 空 / 有坏行 / 截断 五种说法互不混淆', () => {
    assert.match(describeBadLines(payload({ cancelled: true })), /已取消/);
    assert.match(describeBadLines(payload({ partial: true })), /未完成/);
    assert.match(
      describeBadLines(payload({ partial: false, lines: [], costMs: 500 })),
      /全文件无坏行/
    );
    assert.match(describeBadLines(payload({ partial: false, lines: [1, 2] })), /共 2 个坏行/);
    assert.match(
      describeBadLines(payload({ partial: false, lines: [1], truncated: true })),
      /已截断/
    );
  });

  it('describeBadLines：不足 1 秒不显示小数（无意义的精度）', () => {
    assert.match(describeBadLines(payload({ partial: false, costMs: 300 })), /不足 1 秒/);
    assert.match(describeBadLines(payload({ partial: false, costMs: undefined })), /耗时未知/);
  });

  it('scanProgressText：百分比封顶 100，分母为 0 时退化为无百分比的文案', () => {
    assert.match(scanProgressText(512, 1024), /50%/);
    assert.match(scanProgressText(2048, 1024), /100%/, '尾块越界不得显示 101%');
    assert.strictEqual(scanProgressText(0, 0), '正在扫描坏行…');
    assert.match(scanProgressText(1024, 1024), /1 KB \/ 1 KB/);
  });
});
