/**
 * profileOps.test.ts — 画像域（F4）：扫描接线、取消语义与横幅收尾。
 *
 * 三条不变式：
 *   1. 取消**只发 CANCEL**，不本地 settle —— 半份统计与全量统计在界面上一样，
 *      只有宿主回执能说明这次扫描算不算数；
 *   2. 自己开的横幅自己收（扫描结束必须 hide，否则「正在扫描…」会一直挂着）；
 *   3. 「筛选此字段」用 **exists** 语义（用户点的是「看看有这条字段的记录」）。
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { setupWebviewDom } from './domHarness.ts';
import { createProfileOps } from '../profileOps.ts';
import type { RpcBus } from '../rpc.ts';
import type { Condition } from '../../core/query.ts';
import type { ProfilePayload } from '../../protocol/rpc.ts';

const REAL_SET_TIMEOUT = globalThis.setTimeout;
const wait = (ms: number): Promise<void> => new Promise((r) => REAL_SET_TIMEOUT(() => r(), ms));

interface Harness {
  ops: ReturnType<typeof createProfileOps>;
  requests: Array<{ endpoint: string; payload: unknown }>;
  posts: Array<{ endpoint: string; payload: unknown }>;
  bannerShows: Array<{ text: string; actionLabel?: string; action?: () => void }>;
  bannerHides: number;
  applied: Array<Condition | null>;
  active: Array<string | null>;
  resolve: (p: ProfilePayload) => void;
  reject: (e: unknown) => void;
}

function makeOps(): Harness {
  const h: Harness = {
    ops: undefined as unknown as ReturnType<typeof createProfileOps>,
    requests: [],
    posts: [],
    bannerShows: [],
    bannerHides: 0,
    applied: [],
    active: [],
    resolve: () => {},
    reject: () => {},
  };
  let settle: { res: (v: ProfilePayload) => void; rej: (e: unknown) => void } | null = null;
  const bus = {
    request(endpoint: string, payload: unknown) {
      h.requests.push({ endpoint, payload });
      const promise = new Promise<ProfilePayload>((res, rej) => {
        settle = { res, rej };
      });
      return { requestId: 'req-1', promise };
    },
    post(endpoint: string, payload: unknown) {
      h.posts.push({ endpoint, payload });
    },
  } as unknown as RpcBus;
  h.resolve = (p) => settle?.res(p);
  h.reject = (e) => settle?.rej(e);

  h.ops = createProfileOps({
    bus,
    banner: {
      show: (text, actionLabel, onAction) =>
        h.bannerShows.push({
          text,
          ...(actionLabel ? { actionLabel } : {}),
          ...(onAction ? { action: onAction } : {}),
        }),
      hide: () => {
        h.bannerHides++;
      },
    },
    applyFilter: (cond) => h.applied.push(cond),
    setActiveProfile: (rid) => h.active.push(rid),
  });
  return h;
}

describe('profileOps（F4）', () => {
  before(() => {
    setupWebviewDom();
  });

  it('扫描走 SCAN_PROFILE，登记在途请求并给出可取消横幅', async () => {
    const h = makeOps();
    h.ops.open();
    await wait(10);

    assert.strictEqual(h.requests[0].endpoint, 'scanProfile');
    assert.deepStrictEqual(h.active, ['req-1'], '在途请求被登记（进度据此渲染）');
    assert.ok(
      h.bannerShows.some((b) => b.text.includes('扫描整个文件')),
      '横幅说明在做什么'
    );
  });

  it('点「取消」只发 CANCEL（携带 requestId），不本地 settle', async () => {
    const h = makeOps();
    h.ops.open();
    await wait(10);

    // **真的**触发横幅上那个取消按钮，而不是断言一条等价路径 —— 后者测不出
    // 「按钮没接线」这类缺陷。
    const cancelBtn = h.bannerShows.find((b) => b.action !== undefined);
    assert.ok(cancelBtn, '横幅给出了可点的动作');
    assert.strictEqual(cancelBtn!.actionLabel, '取消');
    cancelBtn!.action!();

    const posted = h.posts.find((p) => p.endpoint === 'cancel');
    assert.ok(posted, '发出了 CANCEL');
    assert.deepStrictEqual(posted!.payload, { requestId: 'req-1' }, '携带正确的请求号');
    // 关键：取消**不本地收尾** —— 半份统计与全量统计看起来一样，只有宿主回执能说清算不算数。
    assert.ok(!h.active.includes(null), '取消后仍在途，等宿主回执');
  });

  it('扫描结束收回横幅并清掉在途标记（不留「正在扫描…」挂屏）', async () => {
    const h = makeOps();
    h.ops.open();
    await wait(10);
    h.resolve({
      ok: true,
      result: {
        scanned: 1,
        parsed: 1,
        bad: 0,
        totalRecords: 1,
        totalLines: 1,
        fields: [],
        fieldsTruncated: false,
        costMs: 1,
      },
    });
    await wait(20);

    assert.strictEqual(h.bannerHides, 1, '自己开的横幅自己收');
    assert.deepStrictEqual(h.active, ['req-1', null], '在途标记被清空');
  });

  it('扫描失败同样收横幅（不能把「正在扫描」留在屏幕上）', async () => {
    const h = makeOps();
    h.ops.open();
    await wait(10);
    h.reject(new Error('读盘失败'));
    await wait(20);
    assert.strictEqual(h.bannerHides, 1);
    assert.deepStrictEqual(h.active, ['req-1', null]);
  });

  it('「筛选此字段」→ exists 语义，并关闭面板', async () => {
    const h = makeOps();
    h.ops.open();
    await wait(10);
    // 直接调用面板回调（panel 内部的 onFilterField）等价路径：通过渲染出的按钮触发。
    h.resolve({
      ok: true,
      result: {
        scanned: 1,
        parsed: 1,
        bad: 0,
        totalRecords: 1,
        totalLines: 1,
        costMs: 1,
        fieldsTruncated: false,
        fields: [
          {
            key: 'level',
            present: 1,
            missing: 0,
            nulls: 0,
            empties: 0,
            types: { string: 1 },
            type: 'string',
            top: [{ value: 'error', count: 1 }],
            valuesTruncated: false,
          },
        ],
      },
    });
    await wait(20);

    const row = h.ops.root.querySelector<HTMLElement>('.jlv-prof-row')!;
    const btn = Array.from(row.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      (b.textContent ?? '').includes('筛选')
    )!;
    btn.click();

    assert.deepStrictEqual(h.applied, [{ field: 'level', op: 'exists', value: '' }]);
    assert.strictEqual(h.ops.isOpen(), false, '点完筛选应回到列表（面板收起）');
  });
});
