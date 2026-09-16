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