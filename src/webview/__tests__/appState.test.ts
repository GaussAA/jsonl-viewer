/**
 * appState.test.ts — 视图基线载荷（O7 的调用方一侧）。
 *
 * 值不大，但它决定了「陈旧视图能否改错行」：只要它漏带或带错，
 * 宿主侧那道乐观锁就形同虚设（且完全静默）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { viewBaseline } from '../appState.ts';
import type { OverviewPayload } from '../../protocol/rpc.ts';

function ov(totalLines: number): OverviewPayload {
  return {
    uri: 'file:///a.jsonl',
    protocolVersion: 1,
    totalLines,
    totalRecords: totalLines,
    totalBytes: 100,
    buildMs: 1,
    eof: true,
  };
}

test('O7：有概览时带上期望行数', () => {
  assert.deepEqual(viewBaseline({ overview: ov(42) }), { expectedTotalLines: 42 });
});

test('O7：尚无概览时不带该字段（不阻塞正常编辑，也不谎报 0）', () => {
  assert.deepEqual(viewBaseline({ overview: null }), {});
});
