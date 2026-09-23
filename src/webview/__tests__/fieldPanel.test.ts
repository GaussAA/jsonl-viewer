import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { setupWebviewDom } from './domHarness.ts';
import { createFieldPanel } from '../fieldPanel.ts';
import type { PathSeg } from '../detailLogic.ts';

/**
 * 字段级编辑浮层测试。
 *
 * 核心不变式：
 *   1. 输入语义**按类型分派**（string/number 走输入框、boolean 走两个按钮）——
 *      这两条路径各自都要能提交正确类型的值；
 *   2. 类型恒为原类型（输入 `42` 到 string 字段得到的是字符串 "42"）；
 *   3. **提交失败保持打开**（用户就在浮层里，关掉再重开只会丢掉输入）；
 *   4. 不可编辑的类型必须被拒绝并说明，而不是打开一个改不了任何东西的浮层。
 */

const REAL_SET_TIMEOUT = globalThis.setTimeout;
const wait = (ms: number): Promise<void> => new Promise((r) => REAL_SET_TIMEOUT(() => r(), ms));

const key = (k: string): PathSeg => ({ kind: 'key', key: k });
const idx = (i: number): PathSeg => ({ kind: 'index', key: String(i) });

interface Harness {
  panel: ReturnType<typeof createFieldPanel>;
  calls: { notify: string[] };
  /** 每次 submit 收到的 (path, value)。 */
  submitted: { segs: PathSeg[]; value: unknown }[];
  /** 下一次 submit 的返回值（改它可模拟失败）。 */
  nextResult: { ok: boolean; error?: string };
  /** 让 submit 挂起，便于测「提交中」的控件状态。 */
  hold: boolean;
  release?: () => void;
}

function makePanel(): Harness {
  globalThis.document.body.innerHTML = '';
  const h: Harness = {
    panel: undefined as unknown as ReturnType<typeof createFieldPanel>,
    calls: { notify: [] },
    submitted: [],
    nextResult: { ok: true },
    hold: false,
  };
  h.panel = createFieldPanel({
    submit: async (segs, value) => {
      h.submitted.push({ segs: [...segs], value });
      if (h.hold) {
        await new Promise<void>((r) => {
          h.release = r;
        });
      }
      return h.nextResult;
    },
    notify: (m) => h.calls.notify.push(m),
  });
  globalThis.document.body.append(h.panel.root);
  return h;
}

const panelEl = (): HTMLElement => globalThis.document.querySelector<HTMLElement>('.jlv-field')!;
const titleText = (): string =>
  globalThis.document.querySelector<HTMLElement>('.jlv-edit-title')!.textContent ?? '';
const metaText = (): string =>
  globalThis.document.querySelector<HTMLElement>('.jlv-field-meta')!.textContent ?? '';
const errorText = (): string =>
  globalThis.document.querySelector<HTMLElement>('.jlv-field-error')!.textContent ?? '';
// 注意：新版 DOM 类型里 hidden 是 `boolean | 'until-found'`，后者同样是隐藏态，
// 故用 Boolean() 而不是 === true。
const errorHidden = (): boolean =>
  Boolean(globalThis.document.querySelector<HTMLElement>('.jlv-field-error')!.hidden);
const textarea = (): HTMLTextAreaElement | null =>
  globalThis.document.querySelector<HTMLTextAreaElement>('textarea.jlv-field-input');
const textInput = (): HTMLInputElement | null =>
  globalThis.document.querySelector<HTMLInputElement>('input.jlv-field-input');
const saveBtn = (): HTMLButtonElement =>
  globalThis.document.querySelector<HTMLButtonElement>('.jlv-field-save')!;
const boolBtns = (): HTMLButtonElement[] =>
  Array.from(globalThis.document.querySelectorAll<HTMLButtonElement>('.jlv-field-bool button'));

function pressEscape(): void {
  const KE = globalThis.document.defaultView!.KeyboardEvent;
  globalThis.document.dispatchEvent(new KE('keydown', { key: 'Escape' }));
}

/** 在输入框里敲键（KeyboardEvent 必须来自 jsdom 的 window，不在 globalThis）。 */
function pressEnter(el: HTMLElement, opts: { ctrl?: boolean } = {}): void {
  const KE = globalThis.document.defaultView!.KeyboardEvent;
  el.dispatchEvent(new KE('keydown', { key: 'Enter', ctrlKey: opts.ctrl === true, bubbles: true }));
}

describe('fieldPanel', () => {
  before(() => {
    setupWebviewDom();
  });

  it('string：标题含路径、meta 含原值与类型、textarea 初值不带引号', async () => {
    const h = makePanel();
    h.panel.open([key('user'), key('name')], 'bob');
    await wait(20);

    assert.strictEqual(panelEl().classList.contains('open'), true);
    assert.strictEqual(titleText(), '编辑 .user.name');
    assert.match(metaText(), /原值 "bob"/);
    assert.match(metaText(), /string/);
    assert.ok(textarea(), 'string 用 textarea（保留改含换行值的能力）');
    assert.strictEqual(textarea()!.value, 'bob', '初值不含引号 —— 用户改的是值本身');
    assert.ok(!textInput(), '不该同时存在单行输入');
  });

  it('string：保存提交原始文本（含引号与换行都原样交给上层去转义）', async () => {
    const h = makePanel();
    h.panel.open([key('a')], 'old');
    await wait(20);
    textarea()!.value = 'he said "hi"';
    saveBtn().click();
    await wait(20);

    assert.deepStrictEqual(h.submitted, [{ segs: [key('a')], value: 'he said "hi"' }]);
    assert.strictEqual(h.panel.isOpen(), false, '成功后关闭');
    assert.match(h.calls.notify[0], /已更新 \.a/);
  });

  it('string：Ctrl+Enter 也能保存', async () => {
    const h = makePanel();
    h.panel.open([key('a')], 'old');
    await wait(20);
    textarea()!.value = 'x';
    pressEnter(textarea()!, { ctrl: true });
    await wait(20);

    assert.strictEqual(h.submitted.length, 1);
    assert.strictEqual(h.submitted[0].value, 'x');
  });

  it('number：用单行 input，Enter 即保存，且值仍是数字', async () => {
    const h = makePanel();
    h.panel.open([key('n')], 42);
    await wait(20);

    assert.ok(textInput(), 'number 用单行 input');
    assert.ok(!textarea(), '不该是 textarea');
    assert.strictEqual(textInput()!.value, '42');

    textInput()!.value = '7';
    pressEnter(textInput()!);
    await wait(20);

    assert.strictEqual(h.submitted.length, 1);
    assert.strictEqual(h.submitted[0].value, 7);
    assert.strictEqual(typeof h.submitted[0].value, 'number', '类型恒为原类型');
  });

  it('number：非法输入当场报错且不提交', async () => {
    const h = makePanel();
    h.panel.open([key('n')], 1);
    await wait(20);

    textInput()!.value = '0x10';
    saveBtn().click();
    await wait(20);

    assert.strictEqual(h.submitted.length, 0, '非法输入绝不提交');
    assert.strictEqual(errorHidden(), false);
    assert.match(errorText(), /不是合法的 JSON 数字/);
    assert.strictEqual(h.panel.isOpen(), true, '报错时保持打开');
  });

  it('number：输入到 string 字段也是字符串（类型不随输入漂移）', async () => {
    const h = makePanel();
    h.panel.open([key('s')], 'old');
    await wait(20);
    textarea()!.value = '42';
    saveBtn().click();
    await wait(20);

    assert.strictEqual(h.submitted[0].value, '42');
    assert.strictEqual(typeof h.submitted[0].value, 'string');
  });

  it('boolean：两个按钮直接给值，无需输入框；当前值高亮', async () => {
    const h = makePanel();
    h.panel.open([key('flag')], true);
    await wait(20);

    assert.ok(!textarea() && !textInput(), '布尔不给输入框');
    const [t, f] = boolBtns();
    assert.strictEqual(t.textContent, 'true');
    assert.strictEqual(f.textContent, 'false');
    assert.strictEqual(t.classList.contains('active'), true, '当前值高亮');
    assert.strictEqual(f.classList.contains('active'), false);

    f.click();
    await wait(20);
    assert.strictEqual(h.submitted.length, 1);
    assert.strictEqual(h.submitted[0].value, false);
  });

  it('boolean：点当前值也照常提交（幂等，不特殊处理）', async () => {
    const h = makePanel();
    h.panel.open([key('flag')], false);
    await wait(20);
    boolBtns()[1].click();
    await wait(20);
    assert.strictEqual(h.submitted[0].value, false);
  });

  it('提交失败：显示原因且保持打开（用户就在浮层里，不该丢输入）', async () => {
    const h = makePanel();
    h.nextResult = { ok: false, error: '文件已被外部修改，请先重新加载。' };
    h.panel.open([key('a')], 'x');
    await wait(20);
    textarea()!.value = 'y';
    saveBtn().click();
    await wait(20);

    assert.strictEqual(h.panel.isOpen(), true);
    assert.match(errorText(), /文件已被外部修改/);
    assert.strictEqual(h.calls.notify.length, 0, '失败不弹成功提示');
    assert.strictEqual(textarea()!.value, 'y', '输入内容保留');
  });

  it('提交中：控件禁用，防止重复提交第二次写入', async () => {
    const h = makePanel();
    h.hold = true;
    h.panel.open([key('a')], 'x');
    await wait(20);
    saveBtn().click();
    await wait(20);

    assert.strictEqual(saveBtn().disabled, true);
    assert.strictEqual(textarea()!.disabled, true, '输入框也禁用（避免改了但提交不上去）');

    h.release?.();
    h.hold = false;
    await wait(30);
    assert.strictEqual(h.panel.isOpen(), false, '放行后正常关闭');
  });

  it('不可编辑的类型（null/object/array）：拒绝打开并说明原因', async () => {
    const h = makePanel();
    for (const [value, label] of [
      [null, 'null'],
      [{ a: 1 }, 'object'],
      [[1, 2], 'array'],
    ] as const) {
      h.panel.open([key('x')], value);
      await wait(10);
      assert.strictEqual(h.panel.isOpen(), false, `${label} 不该打开浮层`);
    }
    assert.strictEqual(h.calls.notify.length, 3, '每次都应给出说明');
    assert.match(h.calls.notify[0], /不支持字段级编辑/);
    assert.match(h.calls.notify[0], /整行编辑/, '要告诉用户替代入口');
  });

  it('数组下标路径的标题用 [n] 呈现', async () => {
    const h = makePanel();
    h.panel.open([key('tags'), idx(2)], 'x');
    await wait(20);
    assert.strictEqual(titleText(), '编辑 .tags[2]');
  });

  it('Esc 关闭且幂等；关闭后再打开可复用', async () => {
    const h = makePanel();
    h.panel.open([key('a')], 'x');
    await wait(20);
    pressEscape();
    await wait(20);
    assert.strictEqual(h.panel.isOpen(), false);
    assert.doesNotThrow(() => h.panel.close());

    h.panel.open([key('b')], 'y');
    await wait(20);
    assert.strictEqual(h.panel.isOpen(), true);
    assert.strictEqual(titleText(), '编辑 .b');
    assert.strictEqual(textarea()!.value, 'y', '重新打开时输入区已按新值重建');
  });

  it('已经打开时不重复打开（幂等）', async () => {
    const h = makePanel();
    h.panel.open([key('a')], 'x');
    await wait(20);
    h.panel.open([key('b')], 'y');
    await wait(20);
    assert.strictEqual(titleText(), '编辑 .a', '第二次调用被忽略，不覆盖正在编辑的内容');
  });
});
