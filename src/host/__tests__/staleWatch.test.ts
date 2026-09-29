/**
 * staleWatch.test.ts — 文件变更轮询看门狗（O14）。
 *
 * 这条状态机里最容易写错、且**完全静默**的一步是「复位」：
 * 变化消失后若不把已提示标记清掉，用户把文件改回正常、之后再改坏，就再也收不到提示 ——
 * 不报错、不提示，只是「这条横幅从此不出现了」。所以它值得一组专门的断言。
 *
 * 断言一律用「轮询等待条件成立」而非「等 interval × N 毫秒后数次数」：Windows 上
 * libuv 的定时器分辨率约 15ms，`setInterval(fn, 5)` 在 20ms 内实测只触发 2 次 ——
 * 按固定时长推算触发次数会让这条用例在慢平台 / 高负载下间歇性变红（实测踩过）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStaleWatch } from '../staleWatch.ts';
import type { StaleCheckLike } from '../staleWatch.ts';

const REAL_SET_TIMEOUT = globalThis.setTimeout;
const wait = (ms: number): Promise<void> => new Promise((r) => REAL_SET_TIMEOUT(() => r(), ms));

/** 轮询等待条件成立；到点仍未成立则返回（由调用方的断言给出可读失败信息）。 */
async function waitUntil(pred: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred() && Date.now() < deadline) await wait(10);
}

/** 让轮询确实跑过若干轮（仅用于「反证型」断言：证明某件事**没有**发生）。 */
const settle = (): Promise<void> => wait(200);

const POLL = 5;

test('O14：状态走样时推送一次；持续走样不重复推（否则每 5 秒弹一遍横幅）', async () => {
  let signals = 0;
  const timer = startStaleWatch({
    checkStale: async (): Promise<StaleCheckLike> => ({
      changed: true,
      deleted: false,
      message: '文件已变更',
    }),
    signal: () => {
      signals++;
    },
    pollMs: POLL,
  });
  await waitUntil(() => signals >= 1);
  await settle(); // 再放它跑若干轮：重复推的话 signals 会 > 1
  clearInterval(timer);
  assert.equal(signals, 1, '同一段走样状态只提示一次');
});

test('O14：变化消失后**复位** —— 再次变化时能重新提示（关键不变式）', async () => {
  let stale = true;
  const signals: string[] = [];
  const timer = startStaleWatch({
    checkStale: async (): Promise<StaleCheckLike> =>
      stale ? { changed: true, deleted: false, message: '变了' } : { changed: false },
    signal: (p) => signals.push(p.message),
    pollMs: POLL,
  });

  await waitUntil(() => signals.length >= 1); // 第一段走样 → 推一次
  stale = false;
  await settle(); // 恢复 → 应复位（这段时间内不该再推）
  assert.equal(signals.length, 1, '恢复期间不重复推');
  stale = true;
  await waitUntil(() => signals.length >= 2); // 再次走样 → 应再推一次
  clearInterval(timer);

  assert.equal(signals.length, 2, '复位失效的话这里会是 1（用户从此收不到提示且无从察觉）');
});

test('O14：checkStale 抛错按「没变化」处理（后台轮询不因读盘失败打扰用户）', async () => {
  const signals: string[] = [];
  let calls = 0;
  const timer = startStaleWatch({
    checkStale: async (): Promise<StaleCheckLike> => {
      calls++;
      throw new Error('盘挂了');
    },
    signal: () => signals.push('s'),
    pollMs: POLL,
  });
  await waitUntil(() => calls >= 2);
  clearInterval(timer);
  assert.equal(signals.length, 0, '不推送');
  assert.ok(calls >= 2, '也不中断轮询（仍在继续检测）');
});

test('O14：返回 null（尚无基线 / 正在编辑）视为不判定，且不改变状态', async () => {
  const signals: string[] = [];
  let next: StaleCheckLike = null;
  const timer = startStaleWatch({
    checkStale: async () => next,
    signal: () => signals.push('s'),
    pollMs: POLL,
  });
  await settle(); // null 段：确实跑过若干轮
  assert.equal(signals.length, 0, 'null 期间不推送');
  next = { changed: true, deleted: true, message: '文件已删除' };
  await waitUntil(() => signals.length >= 1);
  clearInterval(timer);
  assert.deepEqual(signals, ['s'], '恢复判定后正常推送');
});

test('O14：signal 抛错不会中断定时器（一次推送失败不该让看门狗停摆）', async () => {
  let attempts = 0;
  let stale = true;
  const timer = startStaleWatch({
    checkStale: async (): Promise<StaleCheckLike> =>
      stale ? { changed: true, deleted: false, message: 'x' } : { changed: false },
    signal: () => {
      attempts++;
      throw new Error('post 失败');
    },
    pollMs: POLL,
  });
  await waitUntil(() => attempts >= 1);
  assert.equal(attempts, 1, '抛错了，但…');
  stale = false;
  await settle(); // 复位窗口
  stale = true;
  await waitUntil(() => attempts >= 2);
  clearInterval(timer);
  assert.equal(attempts, 2, '…定时器仍在跑：复位与再次提示都照常发生');
});

test('O14：clearInterval 后彻底停止（teardown 不留后台轮询）', async () => {
  let calls = 0;
  const timer = startStaleWatch({
    checkStale: async (): Promise<StaleCheckLike> => {
      calls++;
      return { changed: false };
    },
    signal: () => {},
    pollMs: POLL,
  });
  await waitUntil(() => calls >= 1);
  clearInterval(timer);
  const frozen = calls;
  await settle();
  assert.equal(calls, frozen, '停止后不再有任何检测');
});
