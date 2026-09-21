import { describe, it } from 'node:test';
import assert from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { setupWebviewDom, type FakeHost } from './domHarness.ts';
import { HostEndpoint, HostReply } from '../../protocol/rpc.ts';
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
): { line: number; ok: boolean; value?: unknown; error?: string; kind?: 'object'; count?: number }[] =>
  Array.from({ length: count }, (_, i) => {
    const line = start + i;
    return bad.includes(line)
      ? { line, ok: false, error: `第 ${line + 1} 行不是合法 JSON` }
      : { line, ok: true, value: { id: line, name: `n${line}` }, kind: 'object' as const, count: 2 };
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
        items: [{ line: 0, ok: true, truncated: true, kind: 'object', count: 2 }, ...makeItems(1, 19)],
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
});
