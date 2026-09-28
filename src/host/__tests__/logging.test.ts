/**
 * logging.test.ts — 宿主结构化日志单测。
 *
 * 覆盖：级别开关、字段透传、单行 JSON 可解析、异常输入降级、sink 抛错不外溢。
 * 日志是排障基础设施，它自己绝不能成为故障源 —— 这几条就是它的底线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, makeTraceId } from '../logging.ts';

/** 收集器：把写出的行收集起来供断言。 */
function collector(debugEnabled = true): {
  lines: string[];
  logger: ReturnType<typeof createLogger>;
} {
  const lines: string[] = [];
  const logger = createLogger({
    sink: (line) => lines.push(line),
    debugEnabled: () => debugEnabled,
    now: () => 1_700_000_000_000, // 固定时间源，便于断言 ts
  });
  return { lines, logger };
}

test('debug 级受开关控制：关闭时一行不出', () => {
  const off = collector(false);
  off.logger.debug('收到消息', { traceId: 't1' });
  assert.equal(off.lines.length, 0, 'debug 关闭时静默');

  const on = collector(true);
  on.logger.debug('收到消息', { traceId: 't1' });
  assert.equal(on.lines.length, 1);
});

test('error 级始终输出（错误不该被开关藏起来）', () => {
  const off = collector(false);
  off.logger.error('处理消息时异常', { traceId: 't1', error: 'boom' });
  assert.equal(off.lines.length, 1);
  assert.match(off.lines[0], /boom/);
});

test('输出为单行 JSON，且带 ts / level / msg 与上下文字段', () => {
  const { lines, logger } = collector();
  logger.info('消息处理完成', {
    traceId: 'tr-1',
    endpoint: 'readRecords',
    durationMs: 12,
    outcome: 'ok',
  });

  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes('\n'), false, '必须是一行（输出面板里一行一条）');
  const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.msg, '消息处理完成');
  assert.equal(parsed.traceId, 'tr-1');
  assert.equal(parsed.endpoint, 'readRecords');
  assert.equal(parsed.durationMs, 12);
  assert.equal(parsed.outcome, 'ok');
  assert.equal(typeof parsed.ts, 'string', 'ts 为 ISO 字符串，便于排序与聚合');
});

test('循环引用字段降级为最小行，绝不抛错', () => {
  const { lines, logger } = collector();
  const cyclic: Record<string, unknown> = { name: 'x' };
  cyclic.self = cyclic;

  assert.doesNotThrow(() => logger.info('带循环引用的日志', { traceId: 't', payload: cyclic }));
  assert.equal(lines.length, 1, '降级后仍要留下这条记录');
  const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(parsed.msg, '带循环引用的日志');
  assert.equal(parsed.payload, undefined, '无法序列化的字段被丢弃');
});

test('sink 抛错不外溢（日志不得成为新的故障源）', () => {
  const logger = createLogger({
    sink: () => {
      throw new Error('output channel 已释放');
    },
    debugEnabled: () => true,
  });
  assert.doesNotThrow(() => logger.error('写不出去也得继续活着'));
});

test('makeTraceId：带前缀且两次调用不相同', () => {
  const a = makeTraceId();
  const b = makeTraceId();
  assert.match(a, /^tr-/);
  assert.notEqual(a, b);
});
