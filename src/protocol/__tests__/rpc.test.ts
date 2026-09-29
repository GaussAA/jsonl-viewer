import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchMessage,
  errReply,
  HostEndpoint,
  HostReply,
  initReply,
  isAllowedPersistKey,
  isWithinPersistBudget,
  isWithinTextBudget,
  okReply,
  isHostRequest,
  requestIdOf,
  PROTOCOL_VERSION,
  type HostHandlerMap,
} from '../rpc.ts';
import type { OverviewPayload } from '../rpc.ts';
import { MAX_PERSIST_VALUE_BYTES } from '../../constants.ts';

/** 宿主真实类型请求消息的形态（webview 用 HostEndpoint 的值作为 type 发送）。 */
const req = (type: string): unknown => ({ type });

/** 各端点的默认 handler：返回完整 HostResponse（含 reply 类型与 requestId）。 */
const baseHandlers: HostHandlerMap = {
  [HostEndpoint.READY]: () =>
    initReply({
      uri: 'u',
      protocolVersion: PROTOCOL_VERSION,
      totalLines: 0,
      totalRecords: 0,
      totalBytes: 0,
      buildMs: 0,
      eof: true,
    }),
  [HostEndpoint.GET_OVERVIEW]: (r) =>
    okReply(HostReply.OVERVIEW, r.requestId, {
      uri: 'u',
      protocolVersion: PROTOCOL_VERSION,
      totalLines: 0,
      totalBytes: 0,
      buildMs: 0,
      eof: true,
    }),
  [HostEndpoint.GET_SAMPLE_FIELDS]: (r) =>
    okReply(HostReply.SAMPLE_FIELDS, r.requestId, { fields: [], total: 0, scanned: 0 }),
  [HostEndpoint.READ_RECORDS]: (r) =>
    okReply(HostReply.RECORDS, r.requestId, { startLine: 0, items: [], hasMore: false }),
  [HostEndpoint.READ_RECORD]: (r) => okReply(HostReply.RESULT, r.requestId, { ok: true }),
  [HostEndpoint.JUMP_TO_SOURCE]: (r) => okReply(HostReply.RESULT, r.requestId, { jumped: true }),
  [HostEndpoint.SEARCH]: (r) =>
    okReply(HostReply.SEARCH_RESULTS, r.requestId, { matches: [], total: 0, truncated: false }),
  [HostEndpoint.FILTER]: (r) =>
    okReply(HostReply.FILTER_RESULTS, r.requestId, { matches: null, total: 0 }),
  [HostEndpoint.PERSIST_STATE]: (r) => okReply(HostReply.RESULT, r.requestId, { ok: true }),
  [HostEndpoint.LOAD_STATE]: (r) => okReply(HostReply.RESULT, r.requestId, undefined),
  [HostEndpoint.RELOAD]: (r) =>
    okReply(HostReply.OVERVIEW, r.requestId, {
      uri: 'u',
      totalLines: 0,
      totalBytes: 0,
      buildMs: 0,
      eof: true,
    }),
  [HostEndpoint.EDIT_RECORD]: (r) =>
    okReply(HostReply.EDIT_RESULT, r.requestId, {
      line: r.line,
      ok: true,
      bytesDelta: 0,
      inPlace: true,
      movedBytes: 0,
      costMs: 0,
    }),
  [HostEndpoint.INSERT_RECORD]: (r) =>
    okReply(HostReply.EDIT_RESULT, r.requestId, {
      line: r.at,
      ok: true,
      bytesDelta: 0,
      inPlace: false,
      movedBytes: 0,
      costMs: 0,
    }),
  [HostEndpoint.DELETE_RECORD]: (r) =>
    okReply(HostReply.EDIT_RESULT, r.requestId, {
      line: r.line,
      ok: true,
      bytesDelta: 0,
      inPlace: false,
      movedBytes: 0,
      costMs: 0,
    }),
  [HostEndpoint.REPLACE_TEXT]: (r) =>
    okReply(HostReply.REPLACE_RESULT, r.requestId, {
      ok: true,
      replaced: 0,
      skippedInvalid: 0,
      unchanged: 0,
      total: 0,
      bytesDelta: 0,
      costMs: 0,
      undoable: false,
    }),
  [HostEndpoint.REPLACE_FIELD]: (r) =>
    okReply(HostReply.REPLACE_FIELD_RESULT, r.requestId, {
      ok: true,
      replaced: 0,
      skippedInvalid: 0,
      unchanged: 0,
      total: 0,
      bytesDelta: 0,
      costMs: 0,
      undoable: false,
    }),
  [HostEndpoint.DELETE_RECORDS]: (r) =>
    okReply(HostReply.DELETE_MANY_RESULT, r.requestId, {
      ok: true,
      deleted: 0,
      ranges: 0,
      bytesDelta: 0,
      costMs: 0,
      skipped: 0,
    }),
  [HostEndpoint.COPY_LINES]: (r) =>
    okReply(HostReply.COPY_RESULT, r.requestId, {
      ok: true,
      count: 0,
      bytes: 0,
      truncated: false,
      skipped: 0,
    }),
  [HostEndpoint.GET_HISTORY]: (r) =>
    okReply(HostReply.HISTORY, r.requestId, { entries: [], cursor: 0, dropped: false }),
  [HostEndpoint.EXPORT_LINES]: (r) => errReply(r.requestId, '未实现', 'NOT_IMPLEMENTED'),
  [HostEndpoint.SCAN_PROFILE]: (r) => errReply(r.requestId, '未实现', 'NOT_IMPLEMENTED'),
  [HostEndpoint.BACKUP_STATUS]: (r) => errReply(r.requestId, '未实现', 'NOT_IMPLEMENTED'),
  [HostEndpoint.RECOVER_BACKUP]: (r) => errReply(r.requestId, '未实现', 'NOT_IMPLEMENTED'),
  [HostEndpoint.UNDO_EDIT]: (r) =>
    okReply(HostReply.HISTORY_RESULT, r.requestId, { ok: true, steps: 1, cursor: 0, total: 1 }),
  [HostEndpoint.REDO_EDIT]: (r) =>
    okReply(HostReply.HISTORY_RESULT, r.requestId, { ok: true, steps: 1, cursor: 1, total: 1 }),
  [HostEndpoint.REVERT_TO]: (r) =>
    okReply(HostReply.HISTORY_RESULT, r.requestId, { ok: true, steps: 1, cursor: 0, total: 1 }),
  [HostEndpoint.GET_BAD_LINES]: (r) =>
    okReply(HostReply.BAD_LINES, r.requestId, {
      lines: [],
      partial: true,
      scanned: 0,
      totalLines: 0,
      truncated: false,
    }),
  [HostEndpoint.SCAN_BAD_LINES]: (r) =>
    okReply(HostReply.BAD_LINES, r.requestId, {
      lines: [],
      partial: false,
      scanned: 0,
      totalLines: 0,
      truncated: false,
    }),
  [HostEndpoint.CANCEL]: () => undefined,
};

/** 以注册表形式分发一条消息（覆盖单端点时用 spread 覆写一个 handler）。 */
async function call(msg: unknown, handlers: HostHandlerMap) {
  return dispatchMessage(msg, handlers);
}

test('isHostRequest 识别所有 HostEndpoint 值（键大写、值是小写端点名）', () => {
  for (const key of Object.keys(HostEndpoint)) {
    const value = (HostEndpoint as Record<string, string>)[key];
    assert.equal(isHostRequest(req(value)), true, `should accept ${value}`);
  }
  // 未知端点 / 非对象全局拒绝
  assert.equal(isHostRequest(req('nope')), false);
  assert.equal(isHostRequest({ nope: 1 }), false);
  assert.equal(isHostRequest(null), false);
});

test('READY 握手能返回 init 回执（此前 isHostRequest 误杀导致宿主永不回包）', async () => {
  const overview: OverviewPayload = {
    uri: 'file:///x.jsonl',
    protocolVersion: PROTOCOL_VERSION,
    totalLines: 3,
    totalRecords: 3,
    totalBytes: 9,
    buildMs: 1,
    eof: true,
  };
  const { response } = await call(req(HostEndpoint.READY), {
    ...baseHandlers,
    [HostEndpoint.READY]: () => initReply(overview),
  });
  assert.ok(response, 'READY 必须产生回执');
  assert.equal(response.type, HostReply.INIT);
  if (response.type === HostReply.INIT) {
    assert.equal((response.payload as { totalLines: number }).totalLines, 3);
  }
});

test('GET_OVERVIEW 带 requestId 关联返回', async () => {
  const { response } = await call(
    { type: HostEndpoint.GET_OVERVIEW, requestId: 'rid-1' },
    baseHandlers
  );
  assert.ok(response);
  assert.equal(response.type, HostReply.OVERVIEW);
  assert.equal((response as unknown as { requestId: string }).requestId, 'rid-1');
});

/** dispatchMessage 其余端点参数化覆盖（M15：此前仅测 READY/GET_OVERVIEW 两个）。 */
test('READ_RECORDS 分发到 handler 并回 RECORDS', async () => {
  let got: [number, number] | undefined;
  const { response } = await call(
    { type: HostEndpoint.READ_RECORDS, requestId: 'r1', startLine: 3, count: 5 },
    {
      ...baseHandlers,
      [HostEndpoint.READ_RECORDS]: (r) => (
        (got = [r.startLine, r.count]),
        okReply(HostReply.RECORDS, r.requestId, {
          startLine: r.startLine,
          items: [],
          hasMore: false,
        })
      ),
    }
  );
  assert.deepEqual(got, [3, 5]);
  assert.equal(response?.type, HostReply.RECORDS);
  assert.equal((response as unknown as { requestId: string }).requestId, 'r1');
});

test('READ_RECORD 分发并回 RESULT', async () => {
  let gotLine: number | undefined;
  const { response } = await call(
    { type: HostEndpoint.READ_RECORD, requestId: 'r2', line: 42 },
    {
      ...baseHandlers,
      [HostEndpoint.READ_RECORD]: (r) => (
        (gotLine = r.line),
        okReply(HostReply.RESULT, r.requestId, { ok: true, value: 1 })
      ),
    }
  );
  assert.equal(gotLine, 42);
  assert.equal(response?.type, HostReply.RESULT);
  assert.deepEqual((response as unknown as { payload: unknown }).payload, { ok: true, value: 1 });
});

test('GET_SAMPLE_FIELDS 传 count 并回 SAMPLE_FIELDS', async () => {
  let gotCount: number | undefined;
  const { response } = await call(
    { type: HostEndpoint.GET_SAMPLE_FIELDS, requestId: 'r3', count: 77 },
    {
      ...baseHandlers,
      [HostEndpoint.GET_SAMPLE_FIELDS]: (r) => (
        (gotCount = r.count),
        okReply(HostReply.SAMPLE_FIELDS, r.requestId, { fields: [], total: 0, scanned: 0 })
      ),
    }
  );
  assert.equal(gotCount, 77);
  assert.equal(response?.type, HostReply.SAMPLE_FIELDS);
});

test('SEARCH 传 query/field/scope 并回 SEARCH_RESULTS', async () => {
  let got: [string, string | undefined, string | undefined] | undefined;
  const { response } = await call(
    { type: HostEndpoint.SEARCH, requestId: 'r4', query: 'abc', field: 'name', scope: '0:5' },
    {
      ...baseHandlers,
      [HostEndpoint.SEARCH]: (r) => (
        (got = [r.query, r.field, r.scope]),
        okReply(HostReply.SEARCH_RESULTS, r.requestId, { matches: [], total: 0, truncated: false })
      ),
    }
  );
  assert.deepEqual(got, ['abc', 'name', '0:5']);
  assert.equal(response?.type, HostReply.SEARCH_RESULTS);
});

test('FILTER 分发并回 FILTER_RESULTS', async () => {
  let got: [string | undefined, string | undefined, string | undefined] | undefined;
  const { response } = await call(
    { type: HostEndpoint.FILTER, requestId: 'r5', field: 'ok', op: 'eq', value: 'true' },
    {
      ...baseHandlers,
      [HostEndpoint.FILTER]: (r) => (
        (got = [r.field, r.op, r.value]),
        okReply(HostReply.FILTER_RESULTS, r.requestId, { matches: [1, 2], total: 2 })
      ),
    }
  );
  assert.deepEqual(got, ['ok', 'eq', 'true']);
  assert.equal(response?.type, HostReply.FILTER_RESULTS);
  assert.deepEqual(
    (response as unknown as { payload: { matches: number[] } }).payload.matches,
    [1, 2]
  );
});

test('JUMP_TO_SOURCE 传行号并回 RESULT', async () => {
  let gotLine: number | undefined;
  const { response } = await call(
    { type: HostEndpoint.JUMP_TO_SOURCE, requestId: 'r6', line: 9 },
    {
      ...baseHandlers,
      [HostEndpoint.JUMP_TO_SOURCE]: (r) => (
        void (gotLine = r.line),
        okReply(HostReply.RESULT, r.requestId, { jumped: true })
      ),
    }
  );
  assert.equal(gotLine, 9);
  assert.equal(response?.type, HostReply.RESULT);
});

test('PERSIST_STATE / LOAD_STATE 转发 key 与 value', async () => {
  let persisted: [string, unknown] | undefined;
  const save = await call(
    { type: HostEndpoint.PERSIST_STATE, requestId: 'r7', key: 'k', value: { a: 1 } },
    {
      ...baseHandlers,
      [HostEndpoint.PERSIST_STATE]: (r) => (
        void (persisted = [r.key, r.value]),
        okReply(HostReply.RESULT, r.requestId, { ok: true })
      ),
    }
  );
  assert.deepEqual(persisted, ['k', { a: 1 }]);
  assert.equal(save.response?.type, HostReply.RESULT);

  const load = await call(
    { type: HostEndpoint.LOAD_STATE, requestId: 'r8', key: 'k2' },
    {
      ...baseHandlers,
      [HostEndpoint.LOAD_STATE]: (r) =>
        okReply(HostReply.RESULT, r.requestId, r.key === 'k2' ? 'v2' : undefined),
    }
  );
  assert.deepEqual((load.response as unknown as { payload: unknown }).payload, 'v2');
});

test('RELOAD 回新概览；CANCEL 无回执', async () => {
  const reload = await call(
    { type: HostEndpoint.RELOAD, requestId: 'r9' },
    {
      ...baseHandlers,
      [HostEndpoint.RELOAD]: (r) =>
        okReply(HostReply.OVERVIEW, r.requestId, {
          uri: 'u',
          totalLines: 5,
          totalBytes: 50,
          buildMs: 1,
          eof: true,
        }),
    }
  );
  assert.equal(reload.response?.type, HostReply.OVERVIEW);
  assert.equal(
    (reload.response as unknown as { payload: { totalLines: number } }).payload.totalLines,
    5
  );

  let cancelled: string | undefined;
  const cancel = await call(
    { type: HostEndpoint.CANCEL, requestId: 'r10' },
    {
      ...baseHandlers,
      [HostEndpoint.CANCEL]: (r) => (void (cancelled = r.requestId), undefined),
    }
  );
  assert.equal(cancelled, 'r10');
  assert.equal(cancel.response, undefined);
});

test('未知端点被 isHostRequest 过滤（无回执，不进 handler）', async () => {
  const { response } = await call({ type: 'nope', requestId: 'x' }, baseHandlers);
  assert.equal(response, undefined);
});

/* -------- T7：异常回执保留 requestId（避免全局横幅 + 在途请求永不 settle） -------- */

test('requestIdOf：字符串取回；缺失 / 非字符串 / 非对象一律 undefined', () => {
  assert.equal(requestIdOf({ type: 'x', requestId: 'rid-9' }), 'rid-9');
  assert.equal(requestIdOf({ type: 'x' }), undefined, '缺失字段');
  assert.equal(requestIdOf({ requestId: 123 }), undefined, '非字符串');
  assert.equal(requestIdOf(null), undefined, 'null');
  assert.equal(requestIdOf('nope'), undefined, '非对象');
});

test('handler 抛异常：回执为 ERROR 且保留 requestId', async () => {
  const { response } = await call(
    { type: HostEndpoint.GET_OVERVIEW, requestId: 'rid-err' },
    {
      ...baseHandlers,
      [HostEndpoint.GET_OVERVIEW]: () => {
        throw new Error('boom');
      },
    }
  );
  assert.ok(response, '异常也须回执');
  assert.equal(response.type, HostReply.ERROR);
  assert.equal(
    (response as unknown as { requestId?: string }).requestId,
    'rid-err',
    'requestId 被保留，webview 可精确 reject 该请求'
  );
  assert.equal((response as unknown as { message: string }).message, 'boom');
});

test('handler 异步 reject：回执为 ERROR 且保留 requestId', async () => {
  const { response } = await call(
    { type: HostEndpoint.SEARCH, requestId: 'rid-async' },
    {
      ...baseHandlers,
      [HostEndpoint.SEARCH]: async () => {
        throw new Error('async boom');
      },
    }
  );
  assert.equal(response?.type, HostReply.ERROR);
  assert.equal((response as unknown as { requestId?: string }).requestId, 'rid-async');
});

test('无 requestId 的端点（READY）抛异常：回执 requestId 为 undefined', async () => {
  const { response } = await call(req(HostEndpoint.READY), {
    ...baseHandlers,
    [HostEndpoint.READY]: () => {
      throw new Error('ready boom');
    },
  });
  assert.equal(response?.type, HostReply.ERROR);
  assert.equal((response as unknown as { requestId?: string }).requestId, undefined);
});

/* ---------------------- 错误码（机器可读分类） ---------------------- */

test('errReply 携带错误码，缺省时不写该字段', () => {
  const withCode = errReply('rid', '文件已被外部修改', 'CONFLICT');
  assert.equal((withCode as { code?: string }).code, 'CONFLICT');

  const noCode = errReply('rid', '普通失败');
  assert.equal('code' in noCode, false, '无码时不写字段（保持载荷稀疏）');
});

test('未实现的端点回 NOT_IMPLEMENTED（版本不匹配的典型症状必须可区分）', async () => {
  const { response } = await call(req(HostEndpoint.SEARCH), {} as HostHandlerMap);
  assert.equal(response?.type, HostReply.ERROR);
  assert.equal((response as unknown as { code?: string }).code, 'NOT_IMPLEMENTED');
});

test('handler 抛异常统一归类为 INTERNAL', async () => {
  const { response } = await call(req(HostEndpoint.SEARCH), {
    ...baseHandlers,
    [HostEndpoint.SEARCH]: () => {
      throw new Error('boom');
    },
  });
  assert.equal((response as unknown as { code?: string }).code, 'INTERNAL');
});

/* ---------------------- 入参校验（不可信输入） ---------------------- */

test('isAllowedPersistKey：只放行本扩展命名空间内的安全键', () => {
  // 真实键形如 `jsonlViewer.state.file:///a.jsonl`（键里带 URI，故必须放行 `/` 与 `:`）
  assert.equal(isAllowedPersistKey('jsonlViewer.state.file:///a.jsonl'), true);
  assert.equal(isAllowedPersistKey('jsonlViewer.ui.layout'), true);
  // 越出命名空间 / 含危险字符 → 一律拒绝
  assert.equal(isAllowedPersistKey('otherExtension.evil'), false);
  assert.equal(isAllowedPersistKey('jsonlViewer.a\\b'), false, '反斜杠（Windows 路径分隔）拒绝');
  assert.equal(isAllowedPersistKey('jsonlViewer.a\u0000b'), false, '控制字符拒绝');
  assert.equal(isAllowedPersistKey('jsonlViewer.a b'), false, '空格拒绝');
  assert.equal(isAllowedPersistKey(''), false);
  assert.equal(isAllowedPersistKey('x'.repeat(500)), false, '超长键拒绝');
  assert.equal(isAllowedPersistKey(42 as unknown as string), false, '非字符串拒绝');
});

test('isWithinPersistBudget：超预算与不可序列化的值都拒绝', () => {
  assert.equal(isWithinPersistBudget({ a: 1 }), true);
  assert.equal(isWithinPersistBudget('x'.repeat(MAX_PERSIST_VALUE_BYTES + 1)), false, '超预算');
  assert.equal(isWithinPersistBudget(undefined), true, 'undefined 归一为 null，可存');
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(isWithinPersistBudget(cyclic), false, '循环引用不可持久化');
});

test('isWithinTextBudget：按 UTF-8 字节计数（中文不漏算）', () => {
  assert.equal(isWithinTextBudget('abc', 8), true);
  // 4 个中文字符 = 12 字节 UTF-8：按字符数算会误判为「8 以内」，按字节算则正确拒绝。
  assert.equal(isWithinTextBudget('中文中文', 8), false);
  assert.equal(isWithinTextBudget('中文中文', 12), true);
});
