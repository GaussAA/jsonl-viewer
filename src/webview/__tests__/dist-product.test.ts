/**
 * dist 产物守卫：用**真实发布产物**（minify IIFE）跑字段编辑端到端。
 *
 * 存在的意义：集成测试跑的是 src（transform-types 直跑），而用户装的是 minify 后的
 * dist —— 两者的行为差异（esbuild 转换、作用域压缩、正则处理）只有对着产物测才能发现。
 * dist 不存在（未构建）时自动跳过，避免 CI 在纯测试环境脆弱。
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { setupWebviewDom } from './domHarness.ts';
import { HostEndpoint, HostReply } from '../../protocol/rpc.ts';

const DIST = fileURLToPath(new URL('../../../dist/webview.js', import.meta.url));
const HAS_DIST = existsSync(DIST);
// 与其他 jsdom 测试并行时 globalThis（document/window）相互覆盖，必须串行：
// 仅在显式设置 JLV_DIST_PRODUCT=1 时运行（发布链路抽查 / 本地验证）。

const REAL_SET_TIMEOUT = globalThis.setTimeout;
const sleep = (ms: number): Promise<void> => new Promise((r) => REAL_SET_TIMEOUT(r, ms));

interface Msg {
  type: string;
  requestId?: string;
  [k: string]: unknown;
}

const reqs = (host: { posted: unknown[] }, type: string): Msg[] =>
  (host.posted as Msg[]).filter((m) => m.type === type);
const lastReq = (host: { posted: unknown[] }, type: string): Msg | undefined => {
  const list = reqs(host, type);
  return list[list.length - 1];
};
const reply = (host: { receive: (m: unknown) => void }, req: Msg, payload: unknown): void => {
  host.receive({ type: HostReply.RESULT, requestId: req.requestId, payload });
};

describe('dist 产物（minify IIFE）字段编辑链路', () => {
  before(() => {});

  it(
    '改字段值 → 保存 → 发出的新行文本必须是合法 JSON',
    {
      skip: !HAS_DIST
        ? 'dist/webview.js 不存在（先 pnpm compile 构建）'
        : process.env.JLV_DIST_PRODUCT !== '1'
          ? '默认跳过（与并行 jsdom 测试存在 globalThis 竞态；JLV_DIST_PRODUCT=1 串行运行）'
          : false,
    },
    async () => {
      const host = setupWebviewDom();
      // 注入发布产物：acquireVsCodeApi 已就位，IIFE 加载即自动 main()。
      // 用 vm.runInThisContext 而非 eval：语义相同（当前上下文执行），但可声明文件名
      // 便于堆栈定位，也不触发 no-eval 门禁。
      runInThisContext(readFileSync(DIST, 'utf8'), { filename: 'dist/webview.js' });

      host.receive({
        type: HostReply.INIT,
        payload: {
          uri: 'file:///t.jsonl',
          totalLines: 100,
          totalRecords: 100,
          totalBytes: 4096,
          buildMs: 5,
          eof: true,
        },
      });
      await sleep(150);

      // 回执字段推断
      const sf = lastReq(host, HostEndpoint.GET_SAMPLE_FIELDS);
      if (sf) reply(host, sf, { fields: [{ key: 'name' }, { key: 'n' }], total: 2, scanned: 2 });

      // 回执首屏批次
      const rr = lastReq(host, HostEndpoint.READ_RECORDS);
      assert.ok(rr, '存在首屏批量请求');
      reply(host, rr, {
        records: [
          { line: 0, ok: true, value: { name: 'bob', n: 1 } },
          { line: 1, ok: true, value: { name: 'alice', n: 2 } },
        ],
        total: 100,
      });
      await sleep(120);

      // 回执第 0 行详情（带原文）
      const detailReq = lastReq(host, HostEndpoint.READ_RECORD);
      assert.ok(detailReq, '存在详情请求');
      host.receive({
        type: HostReply.RESULT,
        requestId: detailReq!.requestId,
        payload: {
          ok: true,
          value: { name: 'bob', n: 1 },
          rawText: '{"name":"bob","n":1}',
          rawBytes: 19,
        },
      });
      await sleep(120);

      // 找到标量行 name 的字段编辑入口并点击
      const row = Array.from(
        globalThis.document.querySelectorAll<HTMLElement>('.jlv-tree-row')
      ).find((r) => r.querySelector('.jlv-key')?.textContent === 'name');
      assert.ok(row, '存在 name 行');
      const entry = row!.querySelector<HTMLButtonElement>('.jlv-field-edit');
      assert.ok(entry, '存在字段编辑入口');
      entry!.click();
      await sleep(60);

      const panel = globalThis.document.querySelector<HTMLElement>('.jlv-field')!;
      assert.ok(panel.classList.contains('open'), '浮层已打开');
      const ta = panel.querySelector<HTMLTextAreaElement>('textarea.jlv-field-input')!;
      ta.value = 'carol';
      panel.querySelector<HTMLButtonElement>('.jlv-field-save')!.click();
      await sleep(80);

      const edit = lastReq(host, HostEndpoint.EDIT_RECORD);
      assert.ok(edit, '已发起 EDIT_RECORD');
      const text = String(edit!.text);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        assert.fail(
          `minify 产物产出的新行文本非法: ${JSON.stringify(text)} / ${(e as Error).message}`
        );
      }
      assert.deepStrictEqual(parsed, { name: 'carol', n: 1 }, '新行文本语义正确');
      assert.strictEqual(edit!.expectedBytes, 19, '乐观锁口径正确');
    }
  );
});
