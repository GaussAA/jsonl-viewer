import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupWebviewDom, type FakeHost } from './domHarness.ts';
import { HostEndpoint, HostReply } from '../../protocol/rpc.ts';
import type { BadLinesPayload } from '../../protocol/rpc.ts';
import { main } from '../webviewEntry.ts';

/**
 * webviewEntry 装配层集成测试（视图层覆盖率补强，第四阶段）。
 *
 * 定位：前三个视图层测试（virtualScroll / detailTree / toolbar）测「单组件行为」；
 * 本文件测「把组件接到一起的协调逻辑」——即 main() 内特有的：
 *   init 回执 → 派生请求（readRecord/loadState/getOverview/getSampleFields）
 *   按需拉取调度（ThrottleQueue 40ms 窗口 → readRecords 窗口计算 → 缓存填充）
 *   详情按需拉取与 supersede、上/下条导航
 *   横幅（宿主错误 / 文件变更 / 重载失败 / 非 JSONL 警示）+ reload 全局复位
 *   偏好持久化恢复（fieldLayout / filter / searchQuery）与写回
 *
 * 驱动方式：每例 setupWebviewDom() 新建隔离 jsdom + 伪 acquireVsCodeApi，再显式调用
 * 导出的 main()（模块顶层条件挂载在 node 环境不会触发）。宿主回执经 host.receive() 推入，
 * 请求经 host.posted 读取（RpcBus.request 把 payload 展平到消息顶层）。
 *
 * 定时器：domHarness 把所有 setTimeout 包成 unref 版（防握手定时器阻塞进程退出），
 * 故等待一律用 node:timers/promises 的原生 sleep。
 */

type Msg = { type?: unknown; requestId?: unknown; [k: string]: unknown };

const BASE_INIT = {
  uri: 'file:///tmp/a.jsonl',
  totalLines: 100,
  totalBytes: 4096,
  buildMs: 7,
  eof: true,
};

/** ThrottleQueue 窗口为 40ms，取其两倍作为「已落定」等待。 */
const FLUSH_MS = 90;

interface Boot {
  host: FakeHost;
  app: HTMLElement;
}

/** 新建隔离 DOM 并挂载 webviewEntry。 */
function boot(): Boot {
  const host = setupWebviewDom();
  main();
  const app = globalThis.document.getElementById('app');
  assert.ok(app, '#app 存在');
  return { host, app };
}

const reqs = (host: FakeHost, type: string): Msg[] =>
  (host.posted as Msg[]).filter((m) => m.type === type);

const lastReq = (host: FakeHost, type: string): Msg | undefined => {
  const list = reqs(host, type);
  return list[list.length - 1];
};

/** 回执某请求（type 用 RESULT：在 webview 侧走 requestId 精确关联分支）。 */
const reply = (host: FakeHost, req: Msg, payload: unknown): void => {
  host.receive({ type: HostReply.RESULT, requestId: req.requestId, payload });
};

/** 以错误回执某请求（带 requestId → 精确 reject 对应 Promise）。 */
const failReq = (host: FakeHost, req: Msg, message: string): void => {
  host.receive({ type: HostReply.ERROR, requestId: req.requestId, message });
};

const initWith = (host: FakeHost, over: Partial<typeof BASE_INIT> = {}): void => {
  host.receive({ type: HostReply.INIT, payload: { ...BASE_INIT, ...over } });
};

/** 归一化元素文本（jsdom 未实现 innerText，统一用 textContent）。 */
const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

const card = (app: HTMLElement, line: number): HTMLElement | null =>
  Array.from(app.querySelectorAll<HTMLElement>('[id^="jlv-opt-"]')).find(
    (c) => c.id === `jlv-opt-${line}`
  ) ?? null;

const cards = (app: HTMLElement): HTMLElement[] =>
  Array.from(app.querySelectorAll<HTMLElement>('.jlv-record-card'));

const byTitle = (root: ParentNode, title: string): HTMLButtonElement | null =>
  Array.from(root.querySelectorAll('button')).find((b) => b.title === title) ?? null;

const pagerButton = (app: HTMLElement, title: string): HTMLButtonElement | null =>
  byTitle(app.querySelector('.jlv-pager') ?? app, title);

const detailBtn = (app: HTMLElement, title: string): HTMLButtonElement | null =>
  byTitle(app.querySelector('.jlv-detail-header') ?? app, title);

const searchInput = (app: HTMLElement): HTMLInputElement =>
  app.querySelector<HTMLInputElement>('.jlv-search input')!;

/** jsdom 窗口构造器（Window 接口不含事件构造器，故显式断言形状）。 */
type WinCtor = {
  Event: new (t: string, o?: unknown) => Event;
  MouseEvent: new (t: string, o?: unknown) => MouseEvent;
};
const win = (): WinCtor => (globalThis as unknown as { window: WinCtor }).window;

const fireInput = (el: HTMLElement): void => {
  el.dispatchEvent(new (win().Event)('input', { bubbles: true }));
};

const fireStale = (host: FakeHost, message: string): void => {
  host.receive({ type: HostReply.FILE_STALE, payload: { message, deleted: false } });
};

/**
 * 在指定卡片上弹出右键菜单并返回菜单容器。
 * 注意：菜单容器是 virtualScroll 的模块级单例（仅首次创建时挂入当时的 document），
 * 故同一进程内只有首次右键能在当前文档查到容器——相关断言须合并在首个右键用例内。
 */
function openMenu(app: HTMLElement, line: number): HTMLElement {
  const target = card(app, line);
  assert.ok(target, `卡片 #jlv-opt-${line} 存在`);
  target.dispatchEvent(new (win().MouseEvent)('contextmenu', { bubbles: true }));
  const menu = globalThis.document.querySelector<HTMLElement>('.jlv-ctx');
  assert.ok(menu, '右键菜单容器已挂载');
  return menu;
}

/** 按文案取菜单项。 */
function menuItem(menu: HTMLElement, re: RegExp): HTMLButtonElement {
  const item = Array.from(menu.querySelectorAll<HTMLButtonElement>('.jlv-ctx-item')).find((b) =>
    re.test(b.textContent ?? '')
  );
  assert.ok(item, `未找到菜单项：${re}`);
  return item;
}

/** 造一批合法的 records 回执项。 */
const makeItems = (
  start: number,
  count: number,
  bad: number[] = []
): {
  line: number;
  ok: boolean;
  value?: unknown;
  error?: string;
  kind?: 'object';
  count?: number;
}[] =>
  Array.from({ length: count }, (_, i) => {
    const line = start + i;
    return bad.includes(line)
      ? { line, ok: false, error: `第 ${line + 1} 行不是合法 JSON` }
      : {
          line,
          ok: true,
          value: { id: line, name: `n${line}` },
          kind: 'object' as const,
          count: 2,
        };
  });

/** init → 等待节流窗口 → 返回首个 records 请求。 */
async function bootWithRecords(over: Partial<typeof BASE_INIT> = {}): Promise<Boot> {
  const b = boot();
  initWith(b.host, over);
  await sleep(FLUSH_MS);
  return b;
}

/**
 * 回执字段推断。
 * 注意：偏好恢复（tryApplyPersisted）以 state.fields 就绪为前提——字段未到时策略性跳过、
 * 待字段到位后补齐。凡测「恢复偏好」必先回执字段，否则不会应用。
 */
function replyFields(host: FakeHost, keys: string[] = ['a', 'b']): void {
  const req = lastReq(host, HostEndpoint.GET_SAMPLE_FIELDS);
  assert.ok(req, '存在未回执的字段推断请求');
  reply(host, req, { fields: keys.map((key) => ({ key })), total: 3, scanned: 3 });
}

/**
 * 回执详情请求。
 *
 * `rawText` 既是「字段级编辑」的定位依据，也是行编辑浮层的初始文本 —— 缺了它，
 * 详情树就不会给出字段编辑入口。
 */
function replyDetail(host: FakeHost, value: unknown, rawText?: string, rawBytes?: number): void {
  const req = lastReq(host, HostEndpoint.READ_RECORD);
  assert.ok(req, '存在未回执的详情请求');
  host.receive({
    type: HostReply.RESULT,
    requestId: req!.requestId,
    payload:
      rawText === undefined
        ? { ok: true, value }
        : { ok: true, value, rawText, rawBytes: rawBytes ?? rawText.length },
  });
}

describe('webviewEntry 装配层（集成）', () => {
  describe('main() 装配边界', () => {
    it('缺少 acquireVsCodeApi 时给出友好提示且不抛错', () => {
      setupWebviewDom();
      delete (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi;
      assert.doesNotThrow(() => main());
      const app = globalThis.document.getElementById('app')!;
      assert.match(text(app), /无法连接到插件宿主/);
    });

    it('缺少 #app 根节点时直接返回（不抛错）', () => {
      setupWebviewDom();
      globalThis.document.body.innerHTML = '';
      assert.doesNotThrow(() => main());
    });

    it('挂载即注入样式并发 ready 握手', () => {
      const { host, app } = boot();
      assert.ok(
        globalThis.document.head.querySelectorAll('style').length >= 2,
        '主样式 + 滚动条保护样式均已注入'
      );
      assert.ok(
        globalThis.document.head.querySelector('style[data-jlv-scrollbar]'),
        '滚动条保护样式带保护标记'
      );
      assert.strictEqual(reqs(host, HostEndpoint.READY).length, 1, '恰好一次 ready');
      assert.match(text(app.querySelector('.jlv-tree-hint')), /点击左侧记录查看详情/);
    });
  });

  describe('init 回执与派生请求', () => {
    it('init 后同步派发 readRecord / loadState / getOverview / getSampleFields', () => {
      const { host, app } = boot();
      initWith(host);

      assert.strictEqual(reqs(host, HostEndpoint.READ_RECORD).length, 1, '拉首条详情');
      assert.strictEqual(lastReq(host, HostEndpoint.READ_RECORD)?.line, 0, '详情取第 1 行');
      assert.strictEqual(
        lastReq(host, HostEndpoint.LOAD_STATE)?.key,
        'jsonlViewer.state.file:///tmp/a.jsonl',
        '持久化键按 uri 命名'
      );
      assert.strictEqual(reqs(host, HostEndpoint.GET_OVERVIEW).length, 1);
      assert.strictEqual(reqs(host, HostEndpoint.GET_SAMPLE_FIELDS).length, 1);

      assert.strictEqual(text(app.querySelector('.jlv-filename')), 'file:///tmp/a.jsonl');
      assert.match(text(app.querySelector('.jlv-sub')), /就绪/);
      assert.match(text(app.querySelector('.jlv-sub')), /100 行/);
      assert.strictEqual(card(app, 0)?.classList.contains('selected'), true, '默认选中首行');
      // 详情头部此时仍是占位（readRecord 未回执），回执后由 detailTree 更新为 Record #1。
      assert.strictEqual(text(app.querySelector('.jlv-dh-line')), 'Record #—');
    });

    it('init 后回执 getOverview 覆盖总行数并刷新分页信息', async () => {
      const { host, app } = boot();
      initWith(host);
      reply(host, lastReq(host, HostEndpoint.GET_OVERVIEW)!, { ...BASE_INIT, totalLines: 5000 });
      await sleep(10);

      assert.match(text(app.querySelector('.jlv-sub')), /5,000 行/);
      assert.match(text(app.querySelector('.jlv-pager-summary')), /5,000 行/);
      assert.ok(pagerButton(app, '末页'), '页数变化后分页条已更新');
    });

    it('init 总行数为 0 时不自动选中，也不拉详情', () => {
      const { host, app } = boot();
      initWith(host, { totalLines: 0 });

      assert.strictEqual(reqs(host, HostEndpoint.READ_RECORD).length, 0, '不拉详情');
      assert.strictEqual(card(app, 0), null, '无卡片');
      assert.strictEqual(detailBtn(app, '上一条 JSON 条目')?.disabled, true);
      assert.strictEqual(detailBtn(app, '下一条 JSON 条目')?.disabled, true);
    });
  });

  describe('记录按需拉取（ThrottleQueue）', () => {
    it('init 触发节流窗口后按当前页发起一次 readRecords', async () => {
      const { host, app } = await bootWithRecords();
      const rr = reqs(host, HostEndpoint.READ_RECORDS);
      assert.strictEqual(rr.length, 1, '节流合并为一次请求');
      assert.strictEqual(rr[0].startLine, 0);
      assert.strictEqual(rr[0].count, 20);
      assert.match(card(app, 0)?.className ?? '', /loading/, '未回执前为加载态');
    });

    it('records 回执填充缓存并刷新卡片（loading 态解除）', async () => {
      const { host, app } = await bootWithRecords();
      reply(host, lastReq(host, HostEndpoint.READ_RECORDS)!, {
        startLine: 0,
        items: makeItems(0, 20),
        hasMore: true,
      });
      await sleep(20);

      assert.strictEqual(cards(app).length, 20);
      assert.doesNotMatch(card(app, 0)?.className ?? '', /loading/);
      assert.doesNotMatch(card(app, 19)?.className ?? '', /loading/);
    });

    it('翻页后窗口随页移动（startLine=20）', async () => {
      const { host, app } = await bootWithRecords();
      reply(host, lastReq(host, HostEndpoint.READ_RECORDS)!, {
        startLine: 0,
        items: makeItems(0, 20),
        hasMore: true,
      });
      await sleep(20);

      pagerButton(app, '下一页')!.click();
      // 换页走「旧卡片滑出 → 动画结束重建」路径（jsdom 未 reduce-motion），
      // 卡片与 onRangeChange 均延迟到动画落定后，故等待须覆盖动画时长（160ms + 错峰）。
      await sleep(420);

      const rr = reqs(host, HostEndpoint.READ_RECORDS);
      assert.strictEqual(rr.length, 2, '翻页触发第二次拉取');
      assert.strictEqual(rr[1].startLine, 20);
      assert.strictEqual(card(app, 20)?.id, 'jlv-opt-20', '第二页首行渲染');
      assert.match(text(app.querySelector('.jlv-page-info')), /^21\D40$/);
    });

    it('空 items 回执被安全忽略（不抛错、维持加载态）', async () => {
      const { host, app } = await bootWithRecords();
      const req = lastReq(host, HostEndpoint.READ_RECORDS)!;
      assert.doesNotThrow(() => reply(host, req, { startLine: 0, items: [], hasMore: false }));
      await sleep(20);
      assert.match(card(app, 0)?.className ?? '', /loading/);
    });
  });

  describe('详情按需拉取', () => {
    it('readRecord 回执渲染 JSON 树（无错误态）', async () => {
      const { host, app } = await bootWithRecords();
      reply(host, lastReq(host, HostEndpoint.READ_RECORD)!, {
        ok: true,
        value: { alpha: 1, beta: { gamma: 'x' } },
      });
      await sleep(20);

      assert.strictEqual(app.querySelector('.jlv-tree-error'), null, '无错误态');
      assert.ok(app.querySelector('.jlv-tree-loading') === null, '加载态已收起');
      assert.ok(
        app.querySelectorAll('.jlv-tree-node').length >= 2,
        '顶层键渲染为树节点（嵌套键折叠）'
      );
    });

    it('readRecord 回执 ok=false 时展示错误态', async () => {
      const { host, app } = await bootWithRecords();
      reply(host, lastReq(host, HostEndpoint.READ_RECORD)!, { ok: false, error: '坏行' });
      await sleep(20);

      assert.ok(app.querySelector('.jlv-tree-error'), '详情显示错误态');
      assert.match(text(app.querySelector('.jlv-tree-error')), /坏行/);
    });

    it('readRecord 请求失败时展示错误消息', async () => {
      const { host, app } = await bootWithRecords();
      failReq(host, lastReq(host, HostEndpoint.READ_RECORD)!, '读取超时');
      await sleep(20);

      assert.match(text(app.querySelector('.jlv-tree-error')), /读取超时/);
    });

    it('缓存中的坏行：点选后直接展示错误且不再发起 readRecord', async () => {
      const { host, app } = await bootWithRecords();
      reply(host, lastReq(host, HostEndpoint.READ_RECORDS)!, {
        startLine: 0,
        items: makeItems(0, 20, [1]),
        hasMore: true,
      });
      await sleep(20);
      const before = reqs(host, HostEndpoint.READ_RECORD).length;

      card(app, 1)!.click();
      await sleep(20);

      assert.strictEqual(reqs(host, HostEndpoint.READ_RECORD).length, before, '坏行不再请求');
      assert.match(text(app.querySelector('.jlv-tree-error')), /第 2 行不是合法 JSON/);
      assert.strictEqual(text(app.querySelector('.jlv-dh-line')), 'Record #2');
      assert.match(card(app, 1)?.className ?? '', /error/, '卡片呈错误样式');
    });
  });

  describe('详情导航（上一条 / 下一条）', () => {
    it('下一条 → 选中下一行并拉其详情', async () => {
      const { host, app } = await bootWithRecords();
      reply(host, lastReq(host, HostEndpoint.READ_RECORD)!, { ok: true, value: { id: 0 } });
      await sleep(20);
      assert.strictEqual(text(app.querySelector('.jlv-dh-line')), 'Record #1');

      detailBtn(app, '下一条 JSON 条目')!.click();
      await sleep(20);

      const rr = reqs(host, HostEndpoint.READ_RECORD);
      assert.strictEqual(rr.length, 2);
      assert.strictEqual(rr[1].line, 1, '取下一行详情');
      assert.strictEqual(detailBtn(app, '上一条 JSON 条目')?.disabled, false, '上一行已可用');

      reply(host, rr[1], { ok: true, value: { id: 1 } });
      await sleep(20);
      assert.strictEqual(text(app.querySelector('.jlv-dh-line')), 'Record #2');
    });

    it('上一条 → 回到上一行详情', async () => {
      const { host, app } = await bootWithRecords();
      reply(host, lastReq(host, HostEndpoint.READ_RECORD)!, { ok: true, value: { id: 0 } });
      await sleep(20);
      detailBtn(app, '下一条 JSON 条目')!.click();
      await sleep(20);
      reply(host, lastReq(host, HostEndpoint.READ_RECORD)!, { ok: true, value: { id: 1 } });
      await sleep(20);
      assert.strictEqual(text(app.querySelector('.jlv-dh-line')), 'Record #2');

      detailBtn(app, '上一条 JSON 条目')!.click();
      await sleep(20);
      const rr = reqs(host, HostEndpoint.READ_RECORD);
      assert.strictEqual(rr[rr.length - 1].line, 0, '回到第 1 行');
      reply(host, rr[rr.length - 1], { ok: true, value: { id: 0 } });
      await sleep(20);

      assert.strictEqual(text(app.querySelector('.jlv-dh-line')), 'Record #1');
    });
  });

  describe('横幅：文件变更 / 重载 / 宿主错误 / 格式警示', () => {
    it('文件变更推送 → 横幅可见，点击「重新加载」发起 reload', async () => {
      const { host, app } = await bootWithRecords();
      fireStale(host, '文件已更改');
      await sleep(10);

      const banner = app.querySelector<HTMLElement>('.jlv-banner')!;
      assert.strictEqual(banner.hidden, false, '横幅已显示');
      assert.match(text(banner.querySelector('.jlv-banner-text')), /文件已更改/);
      const action = banner.querySelector<HTMLButtonElement>('.jlv-banner-action')!;
      assert.strictEqual(action.textContent, '重新加载');

      action.click();
      await sleep(20);
      assert.strictEqual(reqs(host, HostEndpoint.RELOAD).length, 1, '发起 reload');
    });

    it('reload 回执后全局复位：收起横幅、清过滤、清详情、重拉字段', async () => {
      const { host, app } = await bootWithRecords();
      // 先经持久化进入过滤态（也可顺带验证 filter 接线）
      replyFields(host);
      await sleep(10);
      reply(host, lastReq(host, HostEndpoint.LOAD_STATE)!, {
        filter: { field: 'a', op: 'eq', value: 'x' },
      });
      await sleep(20);
      reply(host, lastReq(host, HostEndpoint.FILTER)!, {
        matches: [0, 2, 4],
        total: 3,
        truncated: false,
      });
      await sleep(20);
      assert.match(text(app.querySelector('.jlv-pager-summary')), /3 行/, '已进入过滤态');

      fireStale(host, '文件已更改');
      await sleep(10);
      const fieldsBefore = reqs(host, HostEndpoint.GET_SAMPLE_FIELDS).length;
      app.querySelector<HTMLButtonElement>('.jlv-banner-action')!.click();
      await sleep(20);
      reply(host, lastReq(host, HostEndpoint.RELOAD)!, { ...BASE_INIT, totalLines: 100 });
      await sleep(20);

      const banner = app.querySelector<HTMLElement>('.jlv-banner')!;
      assert.strictEqual(banner.hidden, true, '横幅收起');
      assert.match(text(app.querySelector('.jlv-pager-summary')), /100 行/, '过滤态已清除');
      assert.ok(app.querySelector('.jlv-tree-hint'), '详情回到未选中提示');
      assert.strictEqual(
        reqs(host, HostEndpoint.GET_SAMPLE_FIELDS).length,
        fieldsBefore + 1,
        '重载后重新拉字段'
      );

      // 重载后字段回执：刷新字段与摘要卡片
      const fieldsReq = lastReq(host, HostEndpoint.GET_SAMPLE_FIELDS)!;
      reply(host, fieldsReq, { fields: [{ key: 'a' }], total: 3, scanned: 3 });
      await sleep(20);
      assert.ok(card(app, 0), '字段回执后列表仍可用');
    });

    it('reload 失败 → 横幅显示错误并提供「重试」', async () => {
      const { host, app } = await bootWithRecords();
      fireStale(host, '文件已更改');
      await sleep(10);
      app.querySelector<HTMLButtonElement>('.jlv-banner-action')!.click();
      await sleep(20);
      failReq(host, lastReq(host, HostEndpoint.RELOAD)!, '索引重建失败');
      await sleep(20);

      const banner = app.querySelector<HTMLElement>('.jlv-banner')!;
      assert.match(text(banner.querySelector('.jlv-banner-text')), /索引重建失败/);
      assert.strictEqual(
        banner.querySelector<HTMLButtonElement>('.jlv-banner-action')!.textContent,
        '重试'
      );
    });

    it('宿主通用错误（无 requestId）经 onError 透出到横幅', async () => {
      const { host, app } = await bootWithRecords();
      host.receive({ type: HostReply.ERROR, message: '索引构建失败' });
      await sleep(10);

      const banner = app.querySelector<HTMLElement>('.jlv-banner')!;
      assert.strictEqual(banner.hidden, false);
      assert.match(text(banner.querySelector('.jlv-banner-text')), /宿主错误：索引构建失败/);
    });

    it('抽样全部无法解析 → 警示可能不是 UTF-8 JSONL', async () => {
      const { host, app } = await bootWithRecords();
      reply(host, lastReq(host, HostEndpoint.GET_SAMPLE_FIELDS)!, {
        fields: [],
        total: 0,
        scanned: 30,
      });
      await sleep(20);

      const banner = app.querySelector<HTMLElement>('.jlv-banner')!;
      assert.strictEqual(banner.hidden, false);
      assert.match(text(banner.querySelector('.jlv-banner-text')), /不是 UTF-8 编码/);
    });

    it('抽样为空的少量文件不误报（scanned < 20）', async () => {
      const { host, app } = await bootWithRecords();
      reply(host, lastReq(host, HostEndpoint.GET_SAMPLE_FIELDS)!, {
        fields: [],
        total: 0,
        scanned: 5,
      });
      await sleep(20);

      assert.strictEqual(app.querySelector<HTMLElement>('.jlv-banner')!.hidden, true, '不误报');
    });
  });

  describe('偏好持久化恢复与写回', () => {
    it('loadState 回执的 searchQuery 填入搜索框但不自动搜索', async () => {
      const { host, app } = await bootWithRecords();
      replyFields(host);
      await sleep(10);
      reply(host, lastReq(host, HostEndpoint.LOAD_STATE)!, { searchQuery: 'needle' });
      await sleep(20);

      assert.strictEqual(searchInput(app).value, 'needle');
      assert.strictEqual(reqs(host, HostEndpoint.SEARCH).length, 0, '不自动触发搜索');
    });

    it('loadState 回执的 filter 触发过滤请求，回执后进入过滤态', async () => {
      const { host, app } = await bootWithRecords();
      replyFields(host);
      await sleep(10);
      reply(host, lastReq(host, HostEndpoint.LOAD_STATE)!, {
        filter: { field: 'a', op: 'eq', value: 'x' },
      });
      await sleep(20);

      const f = lastReq(host, HostEndpoint.FILTER);
      assert.ok(f, '已发起过滤请求');
      assert.strictEqual(f!.field, 'a');
      assert.strictEqual(f!.op, 'eq');
      assert.strictEqual(f!.value, 'x');

      reply(host, f!, { matches: [0, 2, 4], total: 3, truncated: false });
      await sleep(20);
      assert.match(text(app.querySelector('.jlv-pager-summary')), /3 行/, '展示行数=命中数');
    });

    it('loadState 先到、字段后到：字段到位后再应用持久化', async () => {
      const { host, app } = await bootWithRecords();
      reply(host, lastReq(host, HostEndpoint.LOAD_STATE)!, {
        searchQuery: 'late',
      });
      await sleep(20);
      assert.strictEqual(searchInput(app).value, '', '字段未到时不应用');

      reply(host, lastReq(host, HostEndpoint.GET_SAMPLE_FIELDS)!, {
        fields: [{ key: 'a' }, { key: 'b' }],
        total: 3,
        scanned: 3,
      });
      await sleep(20);
      assert.strictEqual(searchInput(app).value, 'late', '字段到位后补齐应用');
    });

    it('过滤应用后经防抖写回持久化', async () => {
      const { host } = await bootWithRecords();
      replyFields(host);
      await sleep(10);
      reply(host, lastReq(host, HostEndpoint.LOAD_STATE)!, {
        filter: { field: 'a', op: 'eq', value: 'x' },
      });
      await sleep(20);
      reply(host, lastReq(host, HostEndpoint.FILTER)!, {
        matches: [0],
        total: 1,
        truncated: false,
      });
      await sleep(500); // persistence 防抖 400ms

      const p = lastReq(host, HostEndpoint.PERSIST_STATE);
      assert.ok(p, '已写回偏好');
      assert.strictEqual(p!.key, 'jsonlViewer.state.file:///tmp/a.jsonl');
      assert.deepStrictEqual((p!.value as { filter?: unknown }).filter, {
        field: 'a',
        op: 'eq',
        value: 'x',
        negate: false,
        caseInsensitive: true,
      });
    });
  });

  describe('搜索接线', () => {
    it('搜索框输入经防抖发起搜索，回执后跳到首个匹配', async () => {
      const { host, app } = await bootWithRecords();
      reply(host, lastReq(host, HostEndpoint.READ_RECORD)!, { ok: true, value: { id: 0 } });
      await sleep(20);

      const input = searchInput(app);
      input.value = 'foo';
      fireInput(input);
      assert.strictEqual(reqs(host, HostEndpoint.SEARCH).length, 0, '防抖期内不发请求');
      await sleep(360);

      const s = lastReq(host, HostEndpoint.SEARCH);
      assert.ok(s, '防抖到期后发起搜索');
      assert.strictEqual(s!.query, 'foo');
      assert.strictEqual(s!.scope, 'all');

      const recordBefore = reqs(host, HostEndpoint.READ_RECORD).length;
      reply(host, s!, { matches: [5, 9], total: 2, truncated: false });
      await sleep(20);

      assert.strictEqual(
        reqs(host, HostEndpoint.READ_RECORD).length,
        recordBefore + 1,
        '跳到首个匹配并拉详情'
      );
      assert.strictEqual(lastReq(host, HostEndpoint.READ_RECORD)!.line, 5);
    });

    it('清除搜索：清空输入且不发起搜索请求（空查询短路）', async () => {
      const { host, app } = await bootWithRecords();
      const input = searchInput(app);
      input.value = 'foo';
      fireInput(input);
      await sleep(360);
      assert.ok(lastReq(host, HostEndpoint.SEARCH), '已搜索过一次');
      const before = reqs(host, HostEndpoint.SEARCH).length;

      app.querySelector<HTMLButtonElement>('.jlv-search-clear')!.click();
      await sleep(20);

      assert.strictEqual(input.value, '', '输入已清空');
      assert.strictEqual(reqs(host, HostEndpoint.SEARCH).length, before, '空查询不发请求');
    });
  });

  describe('右键菜单与生命周期', () => {
    it('卡片右键菜单：截断项按需拉取完整值 / 定位到源码行', async () => {
      const { host, app } = await bootWithRecords();
      reply(host, lastReq(host, HostEndpoint.READ_RECORDS)!, {
        startLine: 0,
        items: [
          { line: 0, ok: true, truncated: true, kind: 'object', count: 2 },
          ...makeItems(1, 19),
        ],
        hasMore: true,
      });
      await sleep(20);

      // 注意：右键菜单容器是 virtualScroll 的模块级单例，仅首次创建时挂入当时的 document，
      // 后续复用同一节点 → 同一进程内只有首次右键可在当前文档查到该容器。
      // 故「按需拉取」与「定位源码」两条路径合并到同一用例验证。
      const menu = openMenu(app, 0);
      const copyFull = menuItem(menu, /复制该行 JSON/);
      const recordBefore = reqs(host, HostEndpoint.READ_RECORD).length;
      copyFull.click();
      await sleep(20);
      assert.strictEqual(
        reqs(host, HostEndpoint.READ_RECORD).length,
        recordBefore + 1,
        '截断项按需拉取完整值'
      );
      assert.strictEqual(lastReq(host, HostEndpoint.READ_RECORD)!.line, 0);

      // 同一容器复用：再次右键仍可在当前文档取到
      const menu2 = openMenu(app, 0);
      menuItem(menu2, /定位到源码行/).click();
      await sleep(20);
      const jump = lastReq(host, HostEndpoint.JUMP_TO_SOURCE);
      assert.ok(jump, '已发起跳转');
      assert.strictEqual(jump!.line, 0);

      // 编辑入口：右键「编辑第 N 行」→ 先拉该行原文，回执后才打开编辑浮层
      // （不能用解析后的 value 当初始文本，否则一保存就把用户原有格式重排掉）。
      const menu3 = openMenu(app, 0);
      menuItem(menu3, /编辑第 1 行/).click();
      await sleep(20);
      const rawReq = lastReq(host, HostEndpoint.READ_RECORD);
      assert.ok(rawReq, '已请求该行原文');
      reply(host, rawReq!, { ok: true, rawText: '{"a":1}', rawBytes: 7 });
      await sleep(20);

      const panel = globalThis.document.querySelector<HTMLElement>('.jlv-edit-backdrop');
      assert.ok(panel, '编辑浮层已打开');
      assert.strictEqual(text(panel!.querySelector('.jlv-edit-title')), '编辑第 1 行');
      assert.strictEqual(
        (panel!.querySelector('.jlv-edit-input') as HTMLTextAreaElement).value,
        '{"a":1}',
        '初始文本必须是磁盘原文'
      );

      // 插入入口：右键「在第 N 行前插入」→ 直接以插入模式打开（插入不需要原文）
      const menu4 = openMenu(app, 0);
      menuItem(menu4, /在第 1 行前插入/).click();
      await sleep(20);
      const insertPanel = globalThis.document.querySelector<HTMLElement>('.jlv-edit-backdrop');
      assert.ok(insertPanel, '插入浮层已打开');
      assert.strictEqual(text(insertPanel!.querySelector('.jlv-edit-title')), '在第 1 行前插入');
      (insertPanel!.querySelector('.jlv-edit-input') as HTMLTextAreaElement).value = '{"new":1}';
      Array.from(insertPanel!.querySelectorAll<HTMLButtonElement>('.jlv-edit-btn'))
        .find((b) => b.textContent === '保存')!
        .click();
      await sleep(20);
      const insReq = lastReq(host, HostEndpoint.INSERT_RECORD);
      assert.ok(insReq, '已发起插入请求');
      assert.strictEqual(insReq!.at, 0);
      assert.strictEqual(insReq!.text, '{"new":1}');

      // 删除入口：右键「删除第 N 行」→ 必须先经横幅二次确认，不得直接落盘
      const menu5 = openMenu(app, 0);
      menuItem(menu5, /删除第 1 行/).click();
      await sleep(20);
      assert.strictEqual(
        reqs(host, HostEndpoint.DELETE_RECORD).length,
        0,
        '点击删除后必须先确认，不得直接发请求'
      );
      const confirmBtn = Array.from(app.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        (b.textContent ?? '').includes('确认删除')
      );
      assert.ok(confirmBtn, '横幅应出现「确认删除」按钮');
      confirmBtn!.click();
      await sleep(20);
      const delReq = lastReq(host, HostEndpoint.DELETE_RECORD);
      assert.ok(delReq, '确认后才发起删除请求');
      assert.strictEqual(delReq!.line, 0);
    });

    it('beforeunload 触发清理，重复派发安全', async () => {
      const { app } = await bootWithRecords();
      assert.doesNotThrow(() => {
        // globalThis.dispatchEvent 已由 harness 桥接到 window（cleanup 即挂在其上）。
        globalThis.dispatchEvent(new (win().Event)('beforeunload'));
        globalThis.dispatchEvent(new (win().Event)('beforeunload'));
      });
      assert.ok(app.querySelector('.jlv-toolbar'), '清理后 DOM 仍在（仅解绑监听）');
    });

    it('编辑浮层：详情工具打开 → 保存发 EDIT_RECORD（含乐观锁）', async () => {
      const { host, app } = await bootWithRecords();
      reply(host, lastReq(host, HostEndpoint.READ_RECORDS)!, {
        startLine: 0,
        items: makeItems(0, 20),
        hasMore: true,
      });
      await sleep(20);

      // 选中第 0 行 → 详情树就绪
      const target = card(app, 0);
      assert.ok(target, '卡片存在');
      target!.click();
      await sleep(20);
      reply(host, lastReq(host, HostEndpoint.READ_RECORD)!, {
        ok: true,
        value: { a: 1 },
        rawText: '{"a":1}',
        rawBytes: 7,
      });
      await sleep(20);

      // 详情工具「编辑」→ 打开面板
      const btn = detailBtn(app, '编辑当前记录的 JSON');
      assert.ok(btn, '详情工具含编辑按钮');
      btn!.click();
      await sleep(20);
      reply(host, lastReq(host, HostEndpoint.READ_RECORD)!, {
        ok: true,
        value: { a: 1 },
        rawText: '{"a":1}',
        rawBytes: 7,
      });
      await sleep(20);

      const panel = globalThis.document.querySelector<HTMLElement>('.jlv-edit-backdrop');
      assert.ok(panel, '编辑浮层已打开');
      const input = panel!.querySelector<HTMLTextAreaElement>('.jlv-edit-input')!;
      assert.strictEqual(input.value, '{"a":1}', '初始文本为磁盘原文');

      input.value = '{"a":22222}';
      const save = Array.from(panel!.querySelectorAll<HTMLButtonElement>('.jlv-edit-btn')).find(
        (b) => b.textContent === '保存'
      );
      assert.ok(save, '保存按钮存在');
      save!.click();
      await sleep(20);

      const editReq = lastReq(host, HostEndpoint.EDIT_RECORD);
      assert.ok(editReq, '已发起编辑请求');
      assert.strictEqual(editReq!.line, 0);
      assert.strictEqual(editReq!.text, '{"a":22222}');
      assert.strictEqual(editReq!.expectedBytes, 7, '必须带乐观锁（旧行字节长度）');
    });

    it('文档复位推送：复位本地状态并重拉字段，且不再向宿主发 RELOAD', async () => {
      const { host } = await bootWithRecords();
      reply(host, lastReq(host, HostEndpoint.READ_RECORDS)!, {
        startLine: 0,
        items: makeItems(0, 20),
        hasMore: true,
      });
      await sleep(20);
      const fieldsBefore = reqs(host, HostEndpoint.GET_SAMPLE_FIELDS).length;

      host.receive({
        type: HostReply.DOCUMENT_RESET,
        payload: { message: '已放弃更改并从磁盘重新加载。' },
      });
      await sleep(20);

      assert.ok(
        reqs(host, HostEndpoint.GET_SAMPLE_FIELDS).length > fieldsBefore,
        '复位后应重拉字段推断'
      );
      assert.strictEqual(
        reqs(host, HostEndpoint.RELOAD).length,
        0,
        '宿主已完成重载，webview 不得再发 RELOAD（否则大文件白扫一遍）'
      );
    });
  });

  describe('错误路径与剩余分支', () => {
    it('loadState 失败不阻断后续流程（字段到位后仍安全）', async () => {
      const { host, app } = await bootWithRecords();
      failReq(host, lastReq(host, HostEndpoint.LOAD_STATE)!, '读取偏好失败');
      await sleep(20);
      replyFields(host);
      await sleep(20);

      assert.strictEqual(searchInput(app).value, '', '无偏好可恢复');
      assert.strictEqual(app.querySelector<HTMLElement>('.jlv-banner')!.hidden, true, '不误报');
    });

    it('getOverview 失败静默（init 已含概览，不弹横幅）', async () => {
      const { host, app } = await bootWithRecords();
      failReq(host, lastReq(host, HostEndpoint.GET_OVERVIEW)!, '概览失败');
      await sleep(20);

      assert.strictEqual(app.querySelector<HTMLElement>('.jlv-banner')!.hidden, true);
      assert.match(text(app.querySelector('.jlv-sub')), /就绪/);
    });

    it('getSampleFields 失败静默回退（摘要退回顶层键）', async () => {
      const { host, app } = await bootWithRecords();
      failReq(host, lastReq(host, HostEndpoint.GET_SAMPLE_FIELDS)!, '字段推断未实现');
      await sleep(20);

      assert.strictEqual(app.querySelector<HTMLElement>('.jlv-banner')!.hidden, true);
      assert.strictEqual(cards(app).length, 20, '列表仍正常');
    });

    it('init 超时先柔性提示「正在构建索引…」，init 到达后自动收起', (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const { host, app } = boot();
      t.mock.timers.tick(8000);

      const banner = app.querySelector<HTMLElement>('.jlv-banner')!;
      assert.strictEqual(banner.hidden, false, '超时后显示柔性提示');
      assert.match(text(banner.querySelector('.jlv-banner-text')), /正在构建索引/);

      initWith(host);
      assert.strictEqual(banner.hidden, true, 'init 到达即收起提示');
    });

    it('折叠与拖拽调宽的偏好落盘（localStorage）', async () => {
      const { app } = await bootWithRecords();
      const store = globalThis.localStorage;

      app
        .querySelector<HTMLElement>('.jlv-resizer')!
        .dispatchEvent(new (win().MouseEvent)('dblclick', { bubbles: true }));
      assert.strictEqual(store.getItem('jsonlViewer.listWidth'), '320', '双击复位并落盘宽度');

      app.querySelector<HTMLButtonElement>('.jlv-resizer__toggle')!.click();
      await sleep(400); // 收起动画 300ms + 落定余量
      assert.strictEqual(store.getItem('jsonlViewer.listCollapsed'), '1', '收起态落盘');
    });

    it('localStorage 写入失败时交互仍安全（异常被吞）', async () => {
      const { app } = await bootWithRecords();
      const store = globalThis.localStorage;
      const original = store.setItem.bind(store);
      Object.defineProperty(store, 'setItem', {
        configurable: true,
        value: () => {
          throw new Error('QuotaExceededError');
        },
      });

      assert.doesNotThrow(() => {
        app
          .querySelector<HTMLElement>('.jlv-resizer')!
          .dispatchEvent(new (win().MouseEvent)('dblclick', { bubbles: true }));
        app.querySelector<HTMLButtonElement>('.jlv-resizer__toggle')!.click();
      });
      await sleep(400); // 动画落定后仍应无未捕获异常

      Object.defineProperty(store, 'setItem', { configurable: true, value: original });
      assert.ok(app.querySelector('.jlv-list-wrap'), '布局仍可用');
    });
  });

  describe('查找替换：入口 / 二次确认 / 结果反馈', () => {
    const replaceInput = (app: HTMLElement): HTMLInputElement =>
      app.querySelector<HTMLInputElement>('.jlv-replace-input')!;
    const replaceGo = (app: HTMLElement): HTMLButtonElement =>
      app.querySelector<HTMLButtonElement>('.jlv-replace-go')!;
    const bannerText = (app: HTMLElement): string =>
      text(app.querySelector('.jlv-banner')?.querySelector('.jlv-banner-text') ?? null);

    it('点击「全部替换」先二次确认，确认后才发 REPLACE_TEXT 并展示结果', async () => {
      const { host, app } = await bootWithRecords();
      searchInput(app).value = 'bob';
      replaceInput(app).value = 'alice';

      replaceGo(app).click();
      await sleep(10);

      const banner = app.querySelector<HTMLElement>('.jlv-banner')!;
      assert.strictEqual(banner.hidden, false, '横幅出现');
      assert.match(bannerText(app), /确定把全部「bob」替换为「alice」/, '确认文案含查找与替换内容');
      assert.strictEqual(text(banner.querySelector('.jlv-banner-action')), '确认替换');
      assert.strictEqual(
        reqs(host, HostEndpoint.REPLACE_TEXT).length,
        0,
        '确认之前绝不发起写入请求'
      );

      banner.querySelector<HTMLButtonElement>('.jlv-banner-action')!.click();
      await sleep(20);
      const req = lastReq(host, HostEndpoint.REPLACE_TEXT)!;
      assert.ok(req, '已发起批量替换');
      assert.strictEqual(req.query, 'bob');
      assert.strictEqual(req.replacement, 'alice');

      reply(host, req, {
        ok: true,
        replaced: 3,
        skippedInvalid: 1,
        unchanged: 0,
        total: 4,
        bytesDelta: 12,
        costMs: 1.5,
        undoable: true,
      });
      await sleep(40);

      assert.match(bannerText(app), /已替换 3 行/);
      assert.match(bannerText(app), /1 行因替换后 JSON 非法已跳过/, '跳过的行必须如实告知');
    });

    it('替换超限未纳入撤销栈时明确提示', async () => {
      const { host, app } = await bootWithRecords();
      searchInput(app).value = 'x';
      replaceInput(app).value = 'y';
      replaceGo(app).click();
      await sleep(10);
      app.querySelector<HTMLButtonElement>('.jlv-banner-action')!.click();
      await sleep(20);

      reply(host, lastReq(host, HostEndpoint.REPLACE_TEXT)!, {
        ok: true,
        replaced: 9000,
        skippedInvalid: 0,
        unchanged: 0,
        total: 9000,
        bytesDelta: 0,
        costMs: 2,
        undoable: false,
      });
      await sleep(40);

      assert.match(bannerText(app), /未纳入撤销栈/, '不能静默丢失撤销能力');
    });

    it('查找内容为空时提示并展开替换行，不发起写入', async () => {
      const { host, app } = await bootWithRecords();
      searchInput(app).value = '   ';
      replaceInput(app).value = 'y';

      replaceGo(app).click();
      await sleep(10);

      assert.strictEqual(reqs(host, HostEndpoint.REPLACE_TEXT).length, 0, '空查询绝不写盘');
      assert.match(bannerText(app), /请先在搜索框填入/);
      assert.strictEqual(
        app.querySelector<HTMLElement>('.jlv-replace')!.hidden,
        false,
        '自动展开替换行，让用户看到该填哪里'
      );
    });

    it('替换失败（业务失败回执）时展示原因，且不误报成功', async () => {
      const { host, app } = await bootWithRecords();
      searchInput(app).value = 'bob';
      replaceInput(app).value = 'alice';
      replaceGo(app).click();
      await sleep(10);
      app.querySelector<HTMLButtonElement>('.jlv-banner-action')!.click();
      await sleep(20);

      reply(host, lastReq(host, HostEndpoint.REPLACE_TEXT)!, {
        ok: false,
        replaced: 0,
        skippedInvalid: 0,
        unchanged: 0,
        total: 0,
        bytesDelta: 0,
        costMs: 0,
        undoable: false,
        error: '文件已被外部修改，请先重新加载再编辑。',
        conflict: true,
      });
      await sleep(40);

      assert.match(bannerText(app), /文件已被外部修改/);
      assert.ok(!/已替换/.test(bannerText(app)), '失败时不得出现成功文案');
    });

    /* ------------------ M3：成本分级 / 进度 / 取消 ------------------ */

    it('大文件确认文案说明「重写整个文件」与可取消（小文件不啰嗦）', async () => {
      const small = await bootWithRecords({ totalBytes: 4096 });
      searchInput(small.app).value = 'bob';
      replaceInput(small.app).value = 'alice';
      replaceGo(small.app).click();
      await sleep(10);
      assert.ok(!/重写整个/.test(bannerText(small.app)), '小文件不该出现重写成本说明');

      const big = await bootWithRecords({ totalBytes: 200 * 1024 * 1024 });
      searchInput(big.app).value = 'bob';
      replaceInput(big.app).value = 'alice';
      replaceGo(big.app).click();
      await sleep(10);
      assert.match(bannerText(big.app), /重写整个/);
      assert.match(bannerText(big.app), /可取消/);
      assert.match(bannerText(big.app), /取消后文件保持原样/, '取消的安全性要说清楚');
    });

    it('替换执行中：进度推送更新文案，且**不得重置**「取消」按钮', async () => {
      const { host, app } = await bootWithRecords({ totalBytes: 1024 });
      searchInput(app).value = 'bob';
      replaceInput(app).value = 'alice';
      replaceGo(app).click();
      await sleep(10);
      app.querySelector<HTMLButtonElement>('.jlv-banner-action')!.click();
      await sleep(20);

      const action = app.querySelector<HTMLButtonElement>('.jlv-banner-action')!;
      assert.strictEqual(text(action), '取消', '执行中出现取消按钮');

      host.receive({
        type: HostReply.EDIT_PROGRESS,
        payload: { kind: 'replace', processedBytes: 512, totalBytes: 1024 },
      });
      await sleep(10);

      assert.match(bannerText(app), /正在替换… 50%/, '进度文案已更新');
      assert.strictEqual(
        app.querySelector<HTMLButtonElement>('.jlv-banner-action'),
        action,
        '必须是同一个按钮节点 —— 走 show() 重建会让取消按钮在每次进度回调后闪烁'
      );
      assert.strictEqual(text(action), '取消', '按钮文案未被进度覆盖');
    });

    it('点「取消」发出 CANCEL 请求，且取消的是当前那次替换', async () => {
      const { host, app } = await bootWithRecords();
      searchInput(app).value = 'bob';
      replaceInput(app).value = 'alice';
      replaceGo(app).click();
      await sleep(10);
      app.querySelector<HTMLButtonElement>('.jlv-banner-action')!.click();
      await sleep(20);

      const replaceReq = lastReq(host, HostEndpoint.REPLACE_TEXT)!;
      assert.strictEqual(reqs(host, HostEndpoint.CANCEL).length, 0, '确认阶段还没取消');

      app.querySelector<HTMLButtonElement>('.jlv-banner-action')!.click();
      await sleep(20);

      const cancelReq = lastReq(host, HostEndpoint.CANCEL);
      assert.ok(cancelReq, '已发出取消');
      assert.strictEqual(cancelReq.requestId, replaceReq.requestId, '取消的是当前这次替换');
    });

    it('取消回执与失败严格区分：报「文件未被修改」而非「失败」', async () => {
      const { host, app } = await bootWithRecords();
      searchInput(app).value = 'bob';
      replaceInput(app).value = 'alice';
      replaceGo(app).click();
      await sleep(10);
      app.querySelector<HTMLButtonElement>('.jlv-banner-action')!.click();
      await sleep(20);

      reply(host, lastReq(host, HostEndpoint.REPLACE_TEXT)!, {
        ok: false,
        cancelled: true,
        replaced: 0,
        skippedInvalid: 0,
        unchanged: 0,
        total: 0,
        bytesDelta: 0,
        costMs: 0,
        undoable: false,
        error: '已取消',
      });
      await sleep(40);

      assert.match(bannerText(app), /已取消/);
      assert.match(bannerText(app), /文件未被修改/, '取消是零风险的，必须说清楚');
      assert.ok(!/替换失败/.test(bannerText(app)), '不得把取消报成失败');
    });
  });

  describe('多选：Ctrl/Shift 点击、选区操作条、批量删除/复制', () => {
    /** 带修饰键的卡片点击。 */
    const clickCard = (
      app: HTMLElement,
      line: number,
      mods: { ctrl?: boolean; shift?: boolean } = {}
    ): void => {
      const c = card(app, line);
      assert.ok(c, `卡片 L${line} 存在`);
      c!.dispatchEvent(
        new (win().MouseEvent)('click', {
          bubbles: true,
          ctrlKey: !!mods.ctrl,
          shiftKey: !!mods.shift,
        })
      );
    };
    const selBar = (app: HTMLElement): HTMLElement =>
      app.querySelector<HTMLElement>('.jlv-selbar')!;
    const selText = (app: HTMLElement): string =>
      text(selBar(app).querySelector('.jlv-selbar-text'));
    const selBtn = (app: HTMLElement, label: string): HTMLButtonElement =>
      Array.from(selBar(app).querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => b.textContent === label
      )!;
    const bannerText = (app: HTMLElement): string =>
      text(app.querySelector('.jlv-banner')?.querySelector('.jlv-banner-text') ?? null);
    /**
     * jsdom 的 KeyboardEvent 构造器。
     *
     * 必须是**惰性函数**：`describe` 回调在「收集用例」阶段就执行，那时 `before`
     * 钩子还没跑、`globalThis.window` 尚未由 domHarness 注入 —— 在描述体里直接求值
     * 会抛错并让整组用例静默消失（表现为「测试通过但根本没跑」）。
     */
    const KE = (): new (t: string, o?: { key?: string }) => KeyboardEvent =>
      (
        win() as unknown as {
          KeyboardEvent: new (t: string, o?: { key?: string }) => KeyboardEvent;
        }
      ).KeyboardEvent;

    it('单选不显示操作条；Ctrl 点击累加选中并显示「已选中 N 行」', async () => {
      const { app } = await bootWithRecords();
      assert.strictEqual(selBar(app).hidden, true, '未多选时不显示操作条');

      clickCard(app, 0);
      assert.strictEqual(selBar(app).hidden, true, '单选仍不显示');

      clickCard(app, 2, { ctrl: true });
      assert.strictEqual(selBar(app).hidden, false);
      assert.match(selText(app), /已选中 2 行/);
      assert.ok(card(app, 0)!.classList.contains('selected'));
      assert.ok(card(app, 2)!.classList.contains('selected'));

      clickCard(app, 4, { ctrl: true });
      assert.match(selText(app), /已选中 3 行/);
    });

    it('Ctrl 再次点击已选中的行 → 取消该行', async () => {
      const { app } = await bootWithRecords();
      clickCard(app, 0);
      clickCard(app, 1, { ctrl: true });
      assert.match(selText(app), /已选中 2 行/);

      clickCard(app, 1, { ctrl: true });
      assert.strictEqual(selBar(app).hidden, true, '只剩 1 行 → 操作条收起');
    });

    it('Shift 点击选中锚点到目标的整段范围', async () => {
      const { app } = await bootWithRecords();
      clickCard(app, 1);
      clickCard(app, 4, { shift: true });

      assert.match(selText(app), /已选中 4 行/, 'L2..L5 共 4 行');
      for (const l of [1, 2, 3, 4]) {
        assert.ok(card(app, l)!.classList.contains('selected'), `L${l} 已选中`);
      }
    });

    it('普通点击重置为单选（不保留上次多选）', async () => {
      const { app } = await bootWithRecords();
      clickCard(app, 0);
      clickCard(app, 3, { ctrl: true });
      assert.match(selText(app), /已选中 2 行/);

      clickCard(app, 5);
      assert.strictEqual(selBar(app).hidden, true, '普通点击清空多选');
      assert.ok(card(app, 5)!.classList.contains('selected'));
      assert.ok(!card(app, 0)!.classList.contains('selected'));
    });

    it('「取消选择」按钮与 Esc 都清空多选', async () => {
      const { app } = await bootWithRecords();
      clickCard(app, 0);
      clickCard(app, 1, { ctrl: true });
      selBtn(app, '取消选择').click();
      assert.strictEqual(selBar(app).hidden, true);

      clickCard(app, 0);
      clickCard(app, 1, { ctrl: true });
      globalThis.document.dispatchEvent(new (KE())('keydown', { key: 'Escape' }));
      assert.strictEqual(selBar(app).hidden, true, 'Esc 同样清空');
    });

    it('批量删除：横幅确认后发出正确的行号集合，回执后行数减少且选区清空', async () => {
      const { host, app } = await bootWithRecords();
      clickCard(app, 1);
      clickCard(app, 3, { ctrl: true });
      clickCard(app, 4, { ctrl: true });

      selBtn(app, '删除').click();
      await sleep(10);

      const banner = app.querySelector<HTMLElement>('.jlv-banner')!;
      assert.strictEqual(banner.hidden, false);
      assert.match(
        text(banner.querySelector('.jlv-banner-text')),
        /确定删除 3 行（2 段连续）/,
        '确认文案说明行数与段数，用户才能核对自己选对了没'
      );
      assert.strictEqual(reqs(host, HostEndpoint.DELETE_RECORDS).length, 0, '确认前不发请求');

      banner.querySelector<HTMLButtonElement>('.jlv-banner-action')!.click();
      await sleep(20);
      const req = lastReq(host, HostEndpoint.DELETE_RECORDS)!;
      assert.deepStrictEqual(req.lines, [1, 3, 4], '行号集合正确（升序）');

      host.receive({
        type: HostReply.DELETE_MANY_RESULT,
        requestId: req.requestId,
        payload: { ok: true, deleted: 3, ranges: 2, bytesDelta: -30, costMs: 1, skipped: 0 },
      });
      await sleep(40);

      assert.strictEqual(selBar(app).hidden, true, '删除后选区清空（行号已失效）');
      assert.match(text(app.querySelector('.jlv-pager-summary')), /97 行/, '总行数减少 3');
      assert.match(bannerText(app), /已删除 3 行/);
    });

    it('批量复制：发出行号集合并如实提示截断', async () => {
      const { host, app } = await bootWithRecords();
      clickCard(app, 2);
      clickCard(app, 5, { ctrl: true });

      selBtn(app, '复制').click();
      await sleep(20);

      const req = lastReq(host, HostEndpoint.COPY_LINES)!;
      assert.deepStrictEqual(req.lines, [2, 5]);

      host.receive({
        type: HostReply.COPY_RESULT,
        requestId: req.requestId,
        payload: { ok: true, count: 2, bytes: 40, truncated: true, skipped: 1 },
      });
      await sleep(40);

      const msg = bannerText(app);
      assert.match(msg, /已复制 2 行/);
      assert.match(msg, /1 行因过大跳过/);
      assert.match(msg, /已截断/, '截断必须如实告知，否则用户以为复制全了');
    });

    // 注：右键菜单里的批量项改在 virtualScroll 的单元测试里覆盖 —— 菜单容器是
    // virtualScroll 的**模块级单例**（仅首次创建时挂入当时的 document），
    // 在集成测试里只有全文件第一个右键用例能查到，硬塞进来只会得到一个假失败。
  });

  describe('编辑历史：入口与单步撤销', () => {
    const histBtn = (app: HTMLElement): HTMLButtonElement | null =>
      byTitle(app, '编辑历史（撤销 / 重做 / 回退到某一步）');
    const panelBtn = (app: HTMLElement, label: string): HTMLButtonElement | undefined =>
      Array.from(app.querySelectorAll<HTMLButtonElement>('.jlv-hist button')).find(
        (b) => b.textContent === label
      );

    it('工具栏「历史」按钮打开浮层并拉取快照；点「撤销一步」发起 UNDO_EDIT', async () => {
      const { host, app } = await bootWithRecords();

      const btn = histBtn(app);
      assert.ok(btn, '存在历史入口');
      btn!.click();
      await sleep(20);

      const backdrop = app.querySelector<HTMLElement>('.jlv-hist-backdrop');
      assert.ok(backdrop, '浮层已挂载');
      assert.strictEqual(backdrop!.hidden, false, '浮层可见');

      const req = lastReq(host, HostEndpoint.GET_HISTORY);
      assert.ok(req, '已拉取历史快照');
      host.receive({
        type: HostReply.HISTORY,
        requestId: req!.requestId,
        payload: {
          entries: [
            {
              id: 'h1',
              kind: 'edit',
              label: '编辑第 1 行',
              lines: 1,
              bytesDelta: 5,
              at: 1758600000000,
            },
          ],
          cursor: 1,
          dropped: false,
        },
      });
      await sleep(20);

      assert.match(text(app.querySelector('.jlv-hist-label')), /编辑第 1 行/, '条目已渲染');

      panelBtn(app, '撤销一步')!.click();
      await sleep(20);
      assert.ok(lastReq(host, HostEndpoint.UNDO_EDIT), '已发起撤销（走宿主同一光标）');
    });

    it('撤销回执后如实提示，并刷新主视图', async () => {
      const { host, app } = await bootWithRecords();
      histBtn(app)!.click();
      await sleep(20);
      const getReq = lastReq(host, HostEndpoint.GET_HISTORY)!;
      host.receive({
        type: HostReply.HISTORY,
        requestId: getReq.requestId,
        payload: {
          entries: [
            {
              id: 'h1',
              kind: 'delete',
              label: '删除 2 行',
              lines: 2,
              bytesDelta: -30,
              at: 1758600000000,
            },
          ],
          cursor: 1,
          dropped: false,
        },
      });
      await sleep(20);

      panelBtn(app, '撤销一步')!.click();
      await sleep(20);
      const undoReq = lastReq(host, HostEndpoint.UNDO_EDIT)!;
      host.receive({
        type: HostReply.HISTORY_RESULT,
        requestId: undoReq.requestId,
        payload: { ok: true, steps: 1, cursor: 0, total: 1, label: '删除 2 行' },
      });
      await sleep(40);

      const bannerText2 = text(
        app.querySelector('.jlv-banner')?.querySelector('.jlv-banner-text') ?? null
      );
      assert.match(bannerText2, /已撤销：删除 2 行/, '如实提示撤销了哪一步');
    });

    it('撤销失败时横幅显示宿主给出的原因', async () => {
      const { host, app } = await bootWithRecords();
      histBtn(app)!.click();
      await sleep(20);
      const getReq = lastReq(host, HostEndpoint.GET_HISTORY)!;
      host.receive({
        type: HostReply.HISTORY,
        requestId: getReq.requestId,
        payload: {
          entries: [
            {
              id: 'h1',
              kind: 'edit',
              label: '编辑第 1 行',
              lines: 1,
              bytesDelta: 1,
              at: 1758600000000,
            },
          ],
          cursor: 1,
          dropped: false,
        },
      });
      await sleep(20);

      panelBtn(app, '撤销一步')!.click();
      await sleep(20);
      const undoReq = lastReq(host, HostEndpoint.UNDO_EDIT)!;
      host.receive({
        type: HostReply.HISTORY_RESULT,
        requestId: undoReq.requestId,
        payload: {
          ok: false,
          steps: 0,
          cursor: 1,
          total: 1,
          error: '文件已被外部修改，请先重新加载再编辑。',
        },
      });
      await sleep(40);

      const msg = text(app.querySelector('.jlv-banner')?.querySelector('.jlv-banner-text') ?? null);
      assert.match(msg, /文件已被外部修改/);
      assert.ok(!/已撤销/.test(msg), '失败不得报成撤销成功');
    });
  });

  describe('坏行诊断（M3 收尾）', () => {
    const badPayload = (over: Partial<BadLinesPayload> = {}): BadLinesPayload => ({
      lines: [],
      partial: true,
      scanned: 0,
      totalLines: 500,
      truncated: false,
      ...over,
    });

    const chip = (app: HTMLElement): HTMLButtonElement =>
      app.querySelector<HTMLButtonElement>('.jlv-bad-chip')!;

    /** 浮层里按 title 找按钮 —— 扫描按钮的文案在扫描期间会变，不能按文案找。 */
    const panelAction = (app: HTMLElement, title: RegExp): HTMLButtonElement =>
      Array.from(app.querySelectorAll<HTMLButtonElement>('.jlv-bad button')).find((b) =>
        title.test(b.title)
      )!;

    it('init 后自动查询坏行；回执后徽章出现且未扫描时写「N+」下界', async () => {
      const { host, app } = await bootWithRecords();
      const req = lastReq(host, HostEndpoint.GET_BAD_LINES);
      assert.ok(req, 'init 后应自动查询坏行（宿主集合是惰性积累的，需要主动同步）');

      host.receive({
        type: HostReply.BAD_LINES,
        requestId: req!.requestId,
        payload: badPayload({ lines: [3], partial: true }),
      });
      await sleep(20);

      assert.strictEqual(chip(app).hidden, false);
      assert.match(
        chip(app).textContent ?? '',
        /1\+ 坏行/,
        '未扫描时是下界 —— 写成确数会让用户以为文件只有 1 个坏行'
      );
    });

    it('点击徽章打开浮层并渲染宿主返回的坏行', async () => {
      const { host, app } = await bootWithRecords();
      const payload = badPayload({ lines: [3], partial: false, scanned: 500 });
      host.receive({
        type: HostReply.BAD_LINES,
        requestId: lastReq(host, HostEndpoint.GET_BAD_LINES)!.requestId,
        payload,
      });
      await sleep(20);

      chip(app).click();
      await sleep(30);
      assert.ok(app.querySelector<HTMLElement>('.jlv-bad'), '浮层已打开');

      // 打开浮层会**重新拉取**（宿主是唯一真源）→ 断言必须在其回执之后，
      // 否则读到的是尚未渲染的空状态。
      const onOpen = lastReq(host, HostEndpoint.GET_BAD_LINES);
      assert.ok(onOpen, '打开浮层应重新拉取一次');
      host.receive({ type: HostReply.BAD_LINES, requestId: onOpen!.requestId, payload });
      await sleep(20);

      const panel = app.querySelector<HTMLElement>('.jlv-bad')!;
      assert.match(panel.querySelector('.jlv-bad-status')!.textContent ?? '', /共 1 个坏行/);
      assert.strictEqual(app.querySelectorAll('.jlv-bad-row').length, 1);
    });

    it('「全选坏行」写入选区并出现选区操作条（发现 → 一键清除的完整链路）', async () => {
      const { host, app } = await bootWithRecords();
      const payload = badPayload({ lines: [1, 5], partial: false, scanned: 10, totalLines: 10 });
      host.receive({
        type: HostReply.BAD_LINES,
        requestId: lastReq(host, HostEndpoint.GET_BAD_LINES)!.requestId,
        payload,
      });
      await sleep(20);

      chip(app).click();
      await sleep(30);
      const onOpen = lastReq(host, HostEndpoint.GET_BAD_LINES);
      assert.ok(onOpen, '打开浮层应重新拉取一次');
      host.receive({ type: HostReply.BAD_LINES, requestId: onOpen!.requestId, payload });
      await sleep(20);

      panelAction(app, /写入选区/).click();
      await sleep(30);

      const selbar = app.querySelector<HTMLElement>('.jlv-selbar')!;
      assert.strictEqual(selbar.hidden, false, '出现选区操作条');
      assert.match(
        selbar.querySelector('.jlv-selbar-text')!.textContent ?? '',
        /已选中 2 行/,
        '坏行被写进选区，用户可直接点「删除」清除'
      );
      assert.strictEqual(
        app.querySelector<HTMLElement>('.jlv-bad')!.classList.contains('open'),
        false
      );
    });
  });

  describe('字段级编辑（M3 收尾）', () => {
    /**
     * 按**字段名**取该行的编辑入口。
     *
     * 不能按「第 N 个入口」取：入口顺序取决于字段在树里的渲染顺序，一处改动就会
     * 让断言指向别的字段（第一版就因此取到了数字字段的入口）。
     */
    const entryFor = (app: HTMLElement, key: string): HTMLButtonElement | null => {
      const row = Array.from(app.querySelectorAll<HTMLElement>('.jlv-tree-row')).find(
        (r) => r.querySelector('.jlv-key')?.textContent === key
      );
      return row?.querySelector<HTMLButtonElement>('.jlv-field-edit') ?? null;
    };
    const hasEntry = (app: HTMLElement): boolean =>
      app.querySelectorAll('.jlv-field-edit').length > 0;
    const fieldPanelEl = (app: HTMLElement): HTMLElement =>
      app.querySelector<HTMLElement>('.jlv-field')!;

    it('原文可用时出现字段编辑入口；点开后浮层标题指明字段路径', async () => {
      const { host, app } = await bootWithRecords();
      replyDetail(host, { name: 'bob', n: 1 }, '{"name":"bob","n":1}');
      await sleep(20);

      const entry = entryFor(app, 'name');
      assert.ok(entry, '标量行应有字段编辑入口');
      assert.match(entry!.title, /编辑 \.name/);

      entry!.click();
      await sleep(30);

      const panel = fieldPanelEl(app);
      assert.ok(panel.classList.contains('open'), '浮层已打开');
      assert.strictEqual(
        text(panel.querySelector('.jlv-edit-title')),
        '编辑 .name',
        '标题指明改的是哪个字段'
      );
      assert.match(text(panel.querySelector('.jlv-field-meta')), /"bob"/);
    });

    it('保存后发出 EDIT_RECORD，且新文本**只改了那一段字节**（键序与空白原样保留）', async () => {
      const { host, app } = await bootWithRecords();
      // 刻意用「键序 + 空格风格都不常规」的原文：字段级编辑的价值就在不改动它们。
      const raw = '{ "b" : 2, "name" : "bob" }';
      replyDetail(host, { b: 2, name: 'bob' }, raw);
      await sleep(20);

      entryFor(app, 'name')!.click();
      await sleep(30);
      const panel = fieldPanelEl(app);
      const ta = panel.querySelector<HTMLTextAreaElement>('textarea.jlv-field-input')!;
      assert.strictEqual(ta.value, 'bob', '初值是磁盘原文里的值（不带引号）');
      ta.value = 'alice';
      panel.querySelector<HTMLButtonElement>('.jlv-field-save')!.click();
      await sleep(40);

      const edit = lastReq(host, HostEndpoint.EDIT_RECORD);
      assert.ok(edit, '已发起整行编辑');
      assert.strictEqual(edit!.line, 0);
      assert.strictEqual(
        edit!.text,
        '{ "b" : 2, "name" : "alice" }',
        '只有 name 的值变了 —— 键序、空格、逗号位置逐字节不变'
      );
      assert.strictEqual(edit!.expectedBytes, raw.length, '乐观锁用宿主回传的原文长度');

      // 回执成功后浮层才应关闭（未回执时提交必然挂起，那是宿主没响应，不是前端没关）
      host.receive({
        type: HostReply.EDIT_RESULT,
        requestId: edit!.requestId,
        payload: {
          ok: true,
          line: 0,
          bytesDelta: 3,
          inPlace: false,
          movedBytes: 0,
          costMs: 1,
        },
      });
      await sleep(30);
      assert.strictEqual(panel.classList.contains('open'), false, '成功后关闭浮层');
    });

    it('数字字段仍提交数字（类型不随输入漂移）', async () => {
      const { host, app } = await bootWithRecords();
      replyDetail(host, { n: 1, s: 'x' }, '{"n":1,"s":"x"}');
      await sleep(20);

      // 第一个标量行是 n
      entryFor(app, 'n')!.click();
      await sleep(30);
      const panel = fieldPanelEl(app);
      const inp = panel.querySelector<HTMLInputElement>('input.jlv-field-input')!;
      assert.ok(inp, '数字用单行输入');
      inp.value = '42';
      panel.querySelector<HTMLButtonElement>('.jlv-field-save')!.click();
      await sleep(40);

      const edit = lastReq(host, HostEndpoint.EDIT_RECORD)!;
      assert.strictEqual(edit.text, '{"n":42,"s":"x"}', '写成 42 而不是 "42"');
    });

    it('冲突失败：浮层保持打开并显示原因（用户就在浮层里，不该丢输入）', async () => {
      const { host, app } = await bootWithRecords();
      replyDetail(host, { name: 'bob' }, '{"name":"bob"}');
      await sleep(20);
      entryFor(app, 'name')!.click();
      await sleep(30);
      const panel = fieldPanelEl(app);
      panel.querySelector<HTMLTextAreaElement>('textarea.jlv-field-input')!.value = 'carol';
      panel.querySelector<HTMLButtonElement>('.jlv-field-save')!.click();
      await sleep(30);

      const edit = lastReq(host, HostEndpoint.EDIT_RECORD)!;
      host.receive({
        type: HostReply.EDIT_RESULT,
        requestId: edit.requestId,
        payload: {
          ok: false,
          line: 0,
          bytesDelta: 0,
          costMs: 0,
          conflict: true,
          error: '文件已被外部修改。',
        },
      });
      await sleep(40);

      assert.strictEqual(panel.classList.contains('open'), true, '失败不关浮层');
      assert.match(text(panel.querySelector('.jlv-field-error')), /已被外部修改/);
      assert.strictEqual(
        panel.querySelector<HTMLTextAreaElement>('textarea.jlv-field-input')!.value,
        'carol',
        '输入内容必须保留'
      );
    });

    it('宿主未回传原文时不出现入口（没有原文就无法安全定位）', async () => {
      const { host, app } = await bootWithRecords();
      replyDetail(host, { name: 'bob' }); // 不带 rawText
      await sleep(20);

      assert.strictEqual(hasEntry(app), false, '缺原文 → 不给入口');
    });

    it('切换选中行后入口消失（避免拿上一行的原文改到新行上）', async () => {
      const { host, app } = await bootWithRecords();
      replyDetail(host, { name: 'bob' }, '{"name":"bob"}');
      await sleep(20);
      assert.ok(hasEntry(app), '前置：有入口');

      // 选另一行 → 详情重新请求（未回执期间不该有入口）
      const other = card(app, 3);
      assert.ok(other, '卡片 L3 存在');
      other!.dispatchEvent(new (win().MouseEvent)('click', { bubbles: true }));
      await sleep(30);
      assert.strictEqual(
        hasEntry(app),
        false,
        `新行详情未到位前不得保留入口（树行=${app.querySelectorAll('.jlv-tree-row').length}, ` +
          `hint=${app.querySelector('.jlv-tree-hint')?.textContent ?? '无'}）`
      );
    });
  });

  describe('单行编辑的进度与取消（M3 收尾）', () => {
    /** 详情工具按钮（按 title 精确匹配）。 */
    const detailTool = (app: HTMLElement, title: string): HTMLButtonElement => {
      const btn = Array.from(app.querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => b.title === title
      );
      if (!btn) throw new Error(`未找到详情工具按钮「${title}」`);
      return btn;
    };
    const bannerTextOf = (app: HTMLElement): string => text(app.querySelector('.jlv-banner-text'));
    const bannerActionOf = (app: HTMLElement): HTMLButtonElement | null =>
      app.querySelector<HTMLButtonElement>('.jlv-banner-action');
    const editInput = (app: HTMLElement): HTMLTextAreaElement =>
      app.querySelector<HTMLTextAreaElement>('textarea.jlv-edit-input')!;
    const editSave = (app: HTMLElement): HTMLButtonElement =>
      app.querySelector<HTMLButtonElement>('.jlv-edit-primary')!;

    it('小改动不弹进度横幅（绝大多数编辑是毫秒级，闪一下反而烦）', async () => {
      const { host, app } = await bootWithRecords();
      replyDetail(host, { name: 'bob' }, '{"name":"bob"}');
      await sleep(20);

      detailTool(app, '编辑当前记录的 JSON').click();
      await sleep(30);
      // 编辑浮层打开前会**再拉一次**原文（初始文本必须是磁盘原文），回执后才会打开
      replyDetail(host, { name: 'bob' }, '{"name":"bob"}');
      await sleep(20);
      editInput(app).value = '{"name":"carol"}';
      editSave(app).click();
      await sleep(30);

      // 小文件（totalBytes=4096）的估算成本远低于阈值 → 不该出现进度横幅
      assert.ok(!/正在写入/.test(bannerTextOf(app)), '小改动不该打扰用户');
      assert.ok(lastReq(host, HostEndpoint.EDIT_RECORD), '但请求照常发出');
    });

    it('大成本编辑：弹可取消的进度横幅，点取消发出 CANCEL（同一 requestId）', async () => {
      // 64MB 的文件、编辑第 1 行 → 估算搬移成本远超阈值
      const { host, app } = await bootWithRecords({ totalBytes: 64 * 1024 * 1024 });
      replyDetail(host, { name: 'bob' }, '{"name":"bob"}');
      await sleep(20);

      detailTool(app, '编辑当前记录的 JSON').click();
      await sleep(30);
      // 编辑浮层打开前会**再拉一次**原文（初始文本必须是磁盘原文），回执后才会打开
      replyDetail(host, { name: 'bob' }, '{"name":"bob"}');
      await sleep(20);
      editInput(app).value = '{"name":"carol"}';
      editSave(app).click();
      await sleep(30);

      assert.match(bannerTextOf(app), /正在写入/, '大改动必须让用户看见进度');
      const cancel = bannerActionOf(app);
      assert.ok(cancel, '同时提供取消入口');
      assert.strictEqual(cancel!.textContent, '取消');

      const edit = lastReq(host, HostEndpoint.EDIT_RECORD)!;
      cancel!.click();
      await sleep(20);
      const abort = lastReq(host, HostEndpoint.CANCEL);
      assert.ok(abort, '已发出取消');
      assert.strictEqual(abort!.requestId, edit.requestId, '取消的是当前这次编辑');
    });

    it('取消回执：说「已取消」而**不**说失败（取消会自动回滚）', async () => {
      const { host, app } = await bootWithRecords({ totalBytes: 64 * 1024 * 1024 });
      replyDetail(host, { name: 'bob' }, '{"name":"bob"}');
      await sleep(20);

      detailTool(app, '编辑当前记录的 JSON').click();
      await sleep(30);
      // 编辑浮层打开前会**再拉一次**原文（初始文本必须是磁盘原文），回执后才会打开
      replyDetail(host, { name: 'bob' }, '{"name":"bob"}');
      await sleep(20);
      editInput(app).value = '{"name":"carol"}';
      editSave(app).click();
      await sleep(30);

      const edit = lastReq(host, HostEndpoint.EDIT_RECORD)!;
      host.receive({
        type: HostReply.EDIT_RESULT,
        requestId: edit.requestId,
        payload: {
          ok: false,
          line: 0,
          bytesDelta: 0,
          inPlace: false,
          movedBytes: 0,
          costMs: 1,
          cancelled: true,
          error: '已取消，文件已按备份恢复原样。',
        },
      });
      await sleep(40);

      const errText = text(app.querySelector('.jlv-edit-error'));
      assert.match(errText, /已取消/, '取消是可识别的第三态');
      assert.ok(!/保存失败/.test(errText), '取消不得报成失败');
      assert.ok(app.querySelector('.jlv-edit-backdrop'), '浮层保持打开，用户可重试');
    });
  });
});
