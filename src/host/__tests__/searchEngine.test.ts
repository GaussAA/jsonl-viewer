import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineIndex } from '../../indexer/lineIndex.ts';
import { MemoryReader } from '../../parser/jsonParser.ts';
import { filterLines, searchLines } from '../searchEngine.ts';

/**
 * 构造一个带坏行的 JSONL 内存样本：
 *   L0 {"a":1,"b":"hello world"}
 *   L1 {"a":2,"b":"foo"}
 *   L2 not-json         （坏行，应被过滤/字段搜索跳过）
 *   L3 {"a":3,"b":"hello again"}
 */
const CONTENT = `{"a":1,"b":"hello world"}\n{"a":2,"b":"foo"}\nnot-json\n{"a":3,"b":"hello again"}`;

async function makeCtx(): Promise<{ reader: MemoryReader; li: LineIndex }> {
  const buf = Buffer.from(CONTENT, 'utf8');
  const li = await LineIndex.build([buf], {});
  const reader = new MemoryReader(buf);
  return { reader, li };
}

test('LineIndex 样本正确切 4 行', async () => {
  const { li } = await makeCtx();
  assert.equal(li.totalLines, 4);
});

/* ------------------------- 全文搜索（纯文本，不 parse） ------------------------- */

test('searchLines: 全文包含匹配（大小写不敏感）返回匹配行', async () => {
  const { reader, li } = await makeCtx();
  const r = await searchLines(reader, li, { query: 'hello' });
  assert.deepEqual(r.matches, [0, 3]);
  assert.equal(r.total, 2);
  assert.equal(r.truncated, false);
});

test('searchLines: 空查询不扫描、直接空结果', async () => {
  const { reader, li } = await makeCtx();
  const r = await searchLines(reader, li, { query: '' });
  assert.deepEqual(r.matches, []);
});

test('searchLines: maxResults 提前终止并标记 truncated', async () => {
  const { reader, li } = await makeCtx();
  const r = await searchLines(reader, li, { query: 'a', maxResults: 1 });
  assert.equal(r.matches.length, 1);
  assert.equal(r.truncated, true);
});

test('searchLines: 全文匹配会命中坏行（原始文本也参与匹配）', async () => {
  const { reader, li } = await makeCtx();
  const r = await searchLines(reader, li, { query: 'not' });
  assert.deepEqual(r.matches, [2]);
});

/* -------- 大小写折叠语义回归（P2-4 性能优化不得改变匹配结果） -------- */

test('searchLines: 大小写不敏感 —— query 全大写也要命中小写文本', async () => {
  const { reader, li } = await makeCtx();
  const r = await searchLines(reader, li, { query: 'HELLO' });
  assert.deepEqual(r.matches, [0, 3]);
});

test('searchLines: 中文（多字节 UTF-8）查询可命中', async () => {
  const buf = Buffer.from('{"msg":"中文字符"}\n{"msg":"other"}', 'utf8');
  const li = await LineIndex.build([buf], {});
  const reader = new MemoryReader(buf);
  const r = await searchLines(reader, li, { query: '中文' });
  assert.deepEqual(r.matches, [0]);
});

test('searchLines: 折叠只作用于 ASCII，不误匹配多字节字节序列', async () => {
  // 行内字节为 E3 A9。若实现用 latin1 + toLowerCase 折叠整行，'Ã'(C3) 会被折成 'ã'(E3)，
  // 从而把查询 "é"(UTF-8 = C3 A9) 误判为命中；仅折叠 ASCII A-Z 的实现不会。
  const buf = Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xe3, 0xa9]), Buffer.from('"}')]);
  const li = await LineIndex.build([buf], {});
  const reader = new MemoryReader(buf);
  const r = await searchLines(reader, li, { query: 'é' });
  assert.deepEqual(r.matches, []);
});

test('searchLines: 纯非字母 query 走快速否定路径仍正确', async () => {
  const { reader, li } = await makeCtx();
  assert.deepEqual((await searchLines(reader, li, { query: '"a":1' })).matches, [0]);
  assert.deepEqual((await searchLines(reader, li, { query: '999' })).matches, []);
});

/* ------------------------- 字段级搜索 / 过滤（需 parse） ------------------------- */

test('searchLines: 限定字段时只匹配该字段值，且跳过坏行', async () => {
  const { reader, li } = await makeCtx();
  const r = await searchLines(reader, li, { query: 'foo', field: 'b' });
  assert.deepEqual(r.matches, [1]);
  // 字段级纯文本不命中坏行
  const m = await searchLines(reader, li, { query: 'not', field: 'b' });
  assert.deepEqual(m.matches, []);
});

test('filterLines: exists 只含合法行，排除坏行', async () => {
  const { reader, li } = await makeCtx();
  const r = await filterLines(reader, li, { field: 'a', op: 'exists', value: '' });
  assert.deepEqual(r.matches, [0, 1, 3]);
  assert.equal(r.total, 3);
});

test('filterLines: eq 数值按字符串比较', async () => {
  const { reader, li } = await makeCtx();
  const r = await filterLines(reader, li, { field: 'a', op: 'eq', value: '1' });
  assert.deepEqual(r.matches, [0]);
});

test('filterLines: contains + 大小写敏感', async () => {
  const { reader, li } = await makeCtx();
  const r = await filterLines(reader, li, { field: 'b', op: 'contains', value: 'HELLO' });
  assert.deepEqual(r.matches, [0, 3]); // 默认忽略大小写
  const sensitive = await filterLines(reader, li, {
    field: 'b',
    op: 'contains',
    value: 'HELLO',
    caseInsensitive: false,
  });
  assert.deepEqual(sensitive.matches, []);
});

test('filterLines: 空条件/无字段 → 全量视图（matches=null）', async () => {
  const { reader, li } = await makeCtx();
  const none = await filterLines(reader, li, null, {});
  assert.equal(none.matches, null);
  assert.equal(none.total, li.totalLines);
});
