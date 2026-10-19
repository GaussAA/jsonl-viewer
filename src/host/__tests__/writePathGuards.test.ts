/**
 * writePathGuards.test.ts — 写路径的防护分支与「写后自检 → 回滚」。
 *
 * 写路径从 dataService.ts 拆成 recordWriter / textReplacer / rangeWriter / historyReplay 之后，
 * 这些模块里有一批**安全分支**平时走不到，却恰恰是出事时唯一的兜底：
 *   - 写后自检失败 → 自动回滚（单行 / 多行两条路径）、回滚本身失败时如实告知；
 *   - 视图过期 / 外部改动 → 拒绝写入，绝不基于旧视图改错行；
 *   - 批量操作的入参拒绝与「半份搜索结果不可作为改写依据」。
 *
 * 触发自检失败需要「写入成功但读回是坏的」，真实磁盘很难稳定制造。这里经 `write`
 * （DataService 交给写路径的受控视图）替换 `reader()`，只在写盘之后返回一个翻转了 1 字节
 * 的读句柄：行边界不变（回滚仍能正确定位区间），内容却不再是合法 JSON。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataService } from '../dataService.ts';
import type { ByteReader } from '../../parser/types.ts';
import type { SearchLinesResult } from '../searchEngine.ts';
import type { WriteContext } from '../writeSupport.ts';
import { MAX_LINE_BYTES } from '../../constants.ts';

const PRETTY_3 = ['{', '  "a": 1', '}', '{', '  "a": 2', '}', '{', '  "a": 3', '}'];

async function withService<T>(
  lines: string[],
  fn: (ds: DataService, file: string) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-write-guards-'));
  const file = join(dir, 'data.jsonl');
  await writeFile(file, `${lines.join('\n')}\n`);
  const ds = new DataService('file:///test.jsonl', file, { sampleLines: 10 });
  try {
    return await fn(ds, file);
  } finally {
    await ds.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

/** 取得 DataService 交给写路径的受控视图（私有成员，仅测试经此接缝改写）。 */
function writeCtxOf(ds: DataService): { write: WriteContext } {
  return ds as unknown as { write: WriteContext };
}

/** 在写路径的受控视图上覆盖若干成员；返回还原函数。 */
function patchWrite(ds: DataService, patch: Partial<WriteContext>): () => void {
  const holder = writeCtxOf(ds);
  const original = holder.write;
  holder.write = { ...original, ...patch };
  return () => {
    holder.write = original;
  };
}

/**
 * 读回时把**每个** `"` 之后的一个字节翻转成控制字符：长度与换行位置不变（回滚仍能
 * 正确定位区间），但 JSON 字符串里出现裸控制字符，不再合法。
 *
 * 必须翻转全部而非第一个：一次读取的块可能从前面的行开始，只改第一处会改到别的行上。
 */
function corruptingReader(real: ByteReader): ByteReader {
  return {
    async readBytes(start: number, length: number): Promise<Buffer> {
      const buf = Buffer.from(await real.readBytes(start, length));
      for (let i = 0; i + 1 < buf.length; i++) {
        if (buf[i] === 0x22 && buf[i + 1] !== 0x0a && buf[i + 1] !== 0x0d) buf[i + 1] = 0x01;
      }
      return buf;
    },
  };
}

/**
 * 令第 `n` 次 `commitIndex` 之后（含）的 `reader()` 返回坏读句柄 ——
 * 即「写盘与索引同步都成功了，读回却是坏的」。
 */
function armCorruptionAfterCommit(ds: DataService, n: number): () => void {
  const original = writeCtxOf(ds).write;
  let commits = 0;
  let corrupt = false;
  return patchWrite(ds, {
    commitIndex: async (li, ops) => {
      await original.commitIndex(li, ops);
      if (++commits === n) corrupt = true;
      else corrupt = false;
    },
    reader: () => (corrupt ? corruptingReader(original.reader()) : original.reader()),
  });
}

const COMPACT = ['{"a":1}', '{"a":2}', '{"a":3}'];

/* --------------------------- 写后自检 → 回滚 --------------------------- */

test('单行编辑：写后读回不是合法 JSON → 自动回滚，文件与历史都保持编辑前状态', async () => {
  await withService(COMPACT, async (ds, file) => {
    await ds.getOverview();
    const before = await readFile(file, 'utf8');
    const restore = armCorruptionAfterCommit(ds, 1);

    const res = await ds.editRecord(1, '{"a":22222}');
    restore();

    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /自检未通过.*已自动回滚/);
    assert.equal(await readFile(file, 'utf8'), before, '磁盘字节必须与编辑前完全一致');
    assert.equal(ds.getHistory().entries.length, 0, '失败的编辑不得入历史');

    // 索引也已回到编辑前：再读一遍仍是原值，说明回滚时的索引补偿（-delta）是对的。
    const page = await ds.readRecords(0, 10);
    assert.deepEqual(
      page.items.map((it) => it.value),
      [{ a: 1 }, { a: 2 }, { a: 3 }]
    );
  });
});

test('单行编辑：读回时抛异常 → 同样判自检失败并回滚（异常文本带行号）', async () => {
  await withService(COMPACT, async (ds, file) => {
    await ds.getOverview();
    const before = await readFile(file, 'utf8');
    const original = writeCtxOf(ds).write;
    let armed = false;
    const restore = patchWrite(ds, {
      commitIndex: async (li, ops) => {
        await original.commitIndex(li, ops);
        armed = true;
      },
      reader: () => {
        const real = original.reader();
        if (!armed) return real;
        armed = false; // 只让「读回」这一次失败，回滚的定位读取要能成功
        return {
          readBytes: async () => {
            throw new Error('读盘炸了');
          },
        };
      },
    });

    const res = await ds.editRecord(2, '{"a":333}');
    restore();

    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /自检未通过（第 3 行：读盘炸了）/);
    assert.equal(await readFile(file, 'utf8'), before);
  });
});

test('单行编辑：回滚时索引回填也失败 → 如实告知「回滚失败」，且磁盘仍被写回原文', async () => {
  await withService(COMPACT, async (ds, file) => {
    await ds.getOverview();
    const before = await readFile(file, 'utf8');
    const original = writeCtxOf(ds).write;
    let commits = 0;
    let corrupt = false;
    const restore = patchWrite(ds, {
      commitIndex: async (li, ops) => {
        commits++;
        if (commits === 2) throw new Error('索引回填炸了');
        await original.commitIndex(li, ops);
        corrupt = true;
      },
      reader: () => (corrupt ? corruptingReader(original.reader()) : original.reader()),
    });

    const res = await ds.editRecord(0, '{"a":99999}');
    restore();

    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /自检未通过.*且自动回滚失败：索引回填炸了.*请先检查文件完整性/);
    // 字节层面的写回发生在索引回填之前，所以磁盘内容其实已恢复；但绝不能因此谎称「已回滚」。
    assert.equal(await readFile(file, 'utf8'), before);
  });
});

test('单行编辑：回滚时定位不到该行 → 报「定位不到该行」', async () => {
  await withService(COMPACT, async (ds) => {
    await ds.getOverview();
    const original = writeCtxOf(ds).write;
    let stage: 'normal' | 'verify' | 'rollback' = 'normal';
    const restore = patchWrite(ds, {
      commitIndex: async (li, ops) => {
        await original.commitIndex(li, ops);
        stage = 'verify';
      },
      reader: () => {
        if (stage === 'normal') return original.reader();
        if (stage === 'verify') {
          // 读回：返回坏数据 → 自检失败
          stage = 'rollback';
          return corruptingReader(original.reader());
        }
        // 回滚定位：读不到任何字节 → scan 不产出该行
        return { readBytes: async () => Buffer.alloc(0) };
      },
    });

    const res = await ds.editRecord(1, '{"a":4444}');
    restore();

    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /自检未通过.*且自动回滚失败：定位不到该行/);
  });
});

test('多行记录编辑：写后读回不合法 → 重建索引后回滚，三条 pretty 记录原样保留', async () => {
  await withService(PRETTY_3, async (ds, file) => {
    await ds.getOverview();
    const before = await readFile(file, 'utf8');
    const original = writeCtxOf(ds).write;
    let rebuilds = 0;
    let corrupt = false;
    const restore = patchWrite(ds, {
      rebuildIndex: async () => {
        await original.rebuildIndex();
        // 第 1 次重建发生在写盘后 → 之后的读回是坏的；第 2 次是回滚后的重建 → 恢复正常。
        corrupt = ++rebuilds === 1;
      },
      reader: () => (corrupt ? corruptingReader(original.reader()) : original.reader()),
    });

    const res = await ds.editRecord(1, '{"a":2222}');
    restore();

    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /自检未通过.*已自动回滚/);
    assert.equal(rebuilds, 2, '写盘后重建一次、回滚后再重建一次');
    assert.equal(await readFile(file, 'utf8'), before);

    const page = await ds.readRecords(0, 10);
    assert.deepEqual(
      page.items.map((it) => it.value),
      [{ a: 1 }, { a: 2 }, { a: 3 }]
    );
  });
});

test('多行记录编辑：回滚阶段重建索引失败 → 如实告知回滚失败', async () => {
  await withService(PRETTY_3, async (ds) => {
    await ds.getOverview();
    const original = writeCtxOf(ds).write;
    let rebuilds = 0;
    let corrupt = false;
    const restore = patchWrite(ds, {
      rebuildIndex: async () => {
        rebuilds++;
        if (rebuilds === 2) throw new Error('重建炸了');
        await original.rebuildIndex();
        corrupt = true;
      },
      reader: () => (corrupt ? corruptingReader(original.reader()) : original.reader()),
    });

    const res = await ds.editRecord(0, '{"a":1111}');
    restore();

    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /且自动回滚失败：重建炸了/);
  });
});

/* ------------------------- 冲突 / 入参拒绝 ------------------------- */

test('编辑 / 删除 / 插入：调用方视图过期（期望总行数对不上）→ conflict，磁盘不动', async () => {
  await withService(COMPACT, async (ds, file) => {
    await ds.getOverview();
    const before = await readFile(file, 'utf8');

    const e = await ds.editRecord(0, '{"a":9}', undefined, { expectedTotalLines: 99 });
    const d = await ds.deleteRecord(0, { expectedTotalLines: 99 });
    const i = await ds.insertRecord(0, '{"a":9}', { expectedTotalLines: 99 });

    for (const r of [e, d, i]) {
      assert.equal(r.ok, false);
      assert.equal(r.conflict, true);
      assert.match(r.error ?? '', /视图已过期/);
    }
    assert.equal(await readFile(file, 'utf8'), before);
  });
});

test('编辑：文件被外部程序改动 → 拒绝并提示重新加载', async () => {
  await withService(COMPACT, async (ds, file) => {
    await ds.getOverview();
    await appendFile(file, '{"a":4}\n');

    const res = await ds.editRecord(0, '{"a":9}');
    assert.equal(res.ok, false);
    assert.equal(res.conflict, true);
    assert.match(res.error ?? '', /已被外部修改/);
  });
});

test('编辑 / 删除 / 插入：记录号或插入位置非法 → 拒绝', async () => {
  await withService(COMPACT, async (ds) => {
    await ds.getOverview();
    for (const bad of [-1, 3, 1.5, Number.NaN]) {
      assert.match((await ds.editRecord(bad, '{"a":1}')).error ?? '', /无效记录号/);
      assert.match((await ds.deleteRecord(bad)).error ?? '', /无效记录号/);
    }
    // 插入允许 at === totalRecords（追加），越过它才非法
    for (const bad of [-1, 4, 0.5]) {
      assert.match((await ds.insertRecord(bad, '{"a":1}')).error ?? '', /无效插入位置/);
    }
  });
});

test('编辑：乐观锁字节数对不上 → conflict', async () => {
  await withService(COMPACT, async (ds) => {
    await ds.getOverview();
    const res = await ds.editRecord(0, '{"a":9}', 999);
    assert.equal(res.ok, false);
    assert.equal(res.conflict, true);
    assert.match(res.error ?? '', /已变化/);
  });
});

test('批量删除 / 区间插回：视图过期 → conflict；入参为空 / 越界 → 拒绝', async () => {
  await withService(COMPACT, async (ds, file) => {
    await ds.getOverview();
    const before = await readFile(file, 'utf8');

    const stale = await ds.deleteRecords([0], { expectedTotalLines: 99 });
    assert.equal(stale.ok, false);
    assert.equal(stale.conflict, true);

    assert.match((await ds.deleteRecords([])).error ?? '', /没有可删除的记录/);
    assert.match((await ds.deleteRecords([7, -3])).error ?? '', /没有可删除的记录/);

    assert.match((await ds.insertRanges([])).error ?? '', /没有需要恢复的内容/);
    const staleInsert = await ds.insertRanges(
      [{ start: 0, end: 7, content: '{"a":1}\n', lines: [0], lineBytes: [8] }],
      { expectedTotalLines: 99 }
    );
    assert.equal(staleInsert.conflict, true);

    // 偏移越界 = 撤销数据已失效（文件被别的编辑改过）：拒绝，绝不在错误位置插入
    const outOfRange = await ds.insertRanges([
      { start: 99999, end: 99999, content: '{"x":1}\n', lines: [0], lineBytes: [8] },
    ]);
    assert.equal(outOfRange.ok, false);
    assert.equal(outOfRange.conflict, true);
    assert.match(outOfRange.error ?? '', /撤销数据已失效/);

    // 区间全空 → 没有需要恢复的内容
    const empty = await ds.insertRanges([
      { start: 0, end: 0, content: '', lines: [], lineBytes: [] },
    ]);
    assert.match(empty.error ?? '', /没有需要恢复的内容/);

    assert.equal(await readFile(file, 'utf8'), before, '所有拒绝都不得动磁盘');
  });
});

test('批量删除：一次选中超过上限 → 拒绝并给出数量', async () => {
  const many = Array.from({ length: 5_001 }, (_, i) => `{"n":${i}}`);
  await withService(many, async (ds) => {
    await ds.getOverview();
    const res = await ds.deleteRecords(many.map((_, i) => i));
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /一次最多删除 5000 行，当前选中 5001 行/);
  });
});

/* ----------------------- 批量替换 / 字段替换 ----------------------- */

test('批量替换：空查询、多行文件、视图过期都被拒绝', async () => {
  await withService(COMPACT, async (ds) => {
    await ds.getOverview();
    assert.match((await ds.replaceText('', 'x')).error ?? '', /查找内容不能为空/);
    const stale = await ds.replaceText('a', 'b', { expectedTotalLines: 99 });
    assert.equal(stale.conflict, true);
  });
  await withService(PRETTY_3, async (ds) => {
    await ds.getOverview();
    assert.match((await ds.replaceText('a', 'b')).error ?? '', /多行.*不支持批量替换/);
    assert.match((await ds.replaceField(['a'], 1, 2)).error ?? '', /多行.*不支持批量字段替换/);
  });
});

test('批量替换：搜索被中断 / 命中被截断 → 拒绝（半份结果不能作为改写依据）', async () => {
  await withService(COMPACT, async (ds, file) => {
    await ds.getOverview();
    const before = await readFile(file, 'utf8');

    const fake = (r: Partial<SearchLinesResult>) =>
      patchWrite(ds, {
        search: async () => ({ matches: [0], total: 1, truncated: false, ...r }),
      });

    let restore = fake({ cancelled: true });
    const cancelled = await ds.replaceText('a', 'b');
    restore();
    assert.equal(cancelled.ok, false);
    assert.match(cancelled.error ?? '', /被中断/);

    restore = fake({ truncated: true });
    const truncated = await ds.replaceText('a', 'b');
    restore();
    assert.equal(truncated.ok, false);
    assert.match(truncated.error ?? '', /命中行超过 50000 行/);

    assert.equal(await readFile(file, 'utf8'), before);
  });
});

test('批量替换：无命中 → 成功但什么都没改；命中的行替换后非法 → 计入 skippedInvalid', async () => {
  await withService(['{"a":"x"}', '{"a":"y"}'], async (ds, file) => {
    await ds.getOverview();
    const none = await ds.replaceText('zzz', 'q');
    assert.equal(none.ok, true);
    assert.equal(none.replaced, 0);

    // 把 `"` 换成裸字符 → 替换结果不再是合法 JSON，该行必须被跳过并如实统计
    const bad = await ds.replaceText('"x"', 'x');
    assert.equal(bad.ok, true);
    assert.equal(bad.replaced, 0);
    assert.equal(bad.skippedInvalid, 1);
    assert.equal(await readFile(file, 'utf8'), '{"a":"x"}\n{"a":"y"}\n');
  });
});

test('按行号写回：没有合法行 / 视图过期 / 内容相同 / 内容非法', async () => {
  await withService(COMPACT, async (ds, file) => {
    await ds.getOverview();
    assert.match((await ds.applyLineTexts([])).error ?? '', /没有可写回的行/);
    assert.match(
      (await ds.applyLineTexts([{ line: 99, text: '{}' }])).error ?? '',
      /没有可写回的行/
    );

    const stale = await ds.applyLineTexts([{ line: 0, text: '{"a":5}' }], {
      expectedTotalLines: 99,
    });
    assert.equal(stale.conflict, true);

    // 与磁盘一致 → unchanged；不合法 → skippedInvalid；二者都不产生编辑
    const same = await ds.applyLineTexts([{ line: 0, text: '{"a":1}' }]);
    assert.equal(same.ok, true);
    assert.equal(same.replaced, 0);
    assert.equal(same.unchanged, 1);

    const invalid = await ds.applyLineTexts([{ line: 1, text: '{oops' }]);
    assert.equal(invalid.ok, true);
    assert.equal(invalid.replaced, 0);
    assert.equal(invalid.skippedInvalid, 1);

    assert.equal(await readFile(file, 'utf8'), `${COMPACT.join('\n')}\n`);
  });
});

test('字段替换：路径为空 / 值为 undefined / 值无法序列化 / 视图过期 → 拒绝', async () => {
  await withService(COMPACT, async (ds) => {
    await ds.getOverview();
    assert.match((await ds.replaceField([], 1, 2)).error ?? '', /字段路径不能为空/);
    assert.match((await ds.replaceField(['a'], undefined, 2)).error ?? '', /不能为 undefined/);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.match((await ds.replaceField(['a'], cyclic, 2)).error ?? '', /无法序列化/);

    const stale = await ds.replaceField(['a'], 1, 2, { expectedTotalLines: 99 });
    assert.equal(stale.conflict, true);
  });
});

test('字段替换：扫描阶段被取消 → cancelled，磁盘零改动', async () => {
  await withService(COMPACT, async (ds, file) => {
    await ds.getOverview();
    const before = await readFile(file, 'utf8');
    const res = await ds.replaceField(['a'], 1, 2, { shouldCancel: () => true });
    assert.equal(res.ok, false);
    assert.equal(res.cancelled, true);
    assert.equal(await readFile(file, 'utf8'), before);
  });
});

test('字段替换：非法行 / 路径缺失 / 值不等 都不动，且各自如实计数', async () => {
  // 坏行刻意不含括号：`{oops` 这类未闭合的花括号会让索引按深度把后续行并成一条多行记录，
  // 整个文件被判成 pretty，从而走「多行不支持批量字段替换」的拒绝分支 —— 那是另一条路径。
  await withService(['{"a":1}', 'not json', '{"b":2}', '{"a":5}'], async (ds, file) => {
    await ds.getOverview();
    const res = await ds.replaceField(['a'], 1, 9);
    assert.equal(res.ok, true, res.error ?? '');
    assert.equal(res.replaced, 1);
    assert.equal(res.skippedInvalid, 1, '非法行');
    assert.equal(res.unchanged, 2, '路径缺失 + 值不等');
    assert.equal(await readFile(file, 'utf8'), '{"a":9}\nnot json\n{"b":2}\n{"a":5}\n');
  });
});

/* ----------------------------- 历史回放 ----------------------------- */

test('撤销 / 重做：栈空时返回失败而非抛错，光标不动', async () => {
  await withService(COMPACT, async (ds) => {
    await ds.getOverview();
    const u = await ds.undoStep();
    assert.equal(u.ok, false);
    assert.equal(u.error, '没有可撤销的操作');
    assert.equal(u.steps, 0);

    const r = await ds.redoStep();
    assert.equal(r.ok, false);
    assert.equal(r.error, '没有可重做的操作');
  });
});

test('回退到某条历史：id 不存在 → 失败；光标目标越界会被夹紧', async () => {
  await withService(COMPACT, async (ds) => {
    await ds.getOverview();
    const missing = await ds.revertTo('h-does-not-exist');
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? '', /已不存在/);

    assert.equal((await ds.editRecord(0, '{"a":10}')).ok, true);
    const clamped = await ds.setHistoryCursor(99);
    assert.equal(clamped.ok, true, '夹紧到 total，本就在那里');
    assert.equal(clamped.cursor, 1);
  });
});

test('撤销中途失败（文件被外部改动）→ 光标退回，不假装成功；多步回退报告已走步数', async () => {
  await withService(COMPACT, async (ds, file) => {
    await ds.getOverview();
    assert.equal((await ds.editRecord(0, '{"a":10}')).ok, true);
    assert.equal((await ds.editRecord(1, '{"a":20}')).ok, true);

    // 外部程序追加一行：宿主基线失效，之后的回放写入会被冲突检测拒绝
    await appendFile(file, '{"a":4}\n');

    const undo = await ds.undoStep();
    assert.equal(undo.ok, false);
    assert.equal(undo.cursor, 2, '失败后光标必须退回，否则后续回退建立在错误位置上');

    const back = await ds.setHistoryCursor(0);
    assert.equal(back.ok, false);
    assert.equal(back.steps, 0);
    assert.match(back.error ?? '', /已撤销 0 步后中止/);
  });
});

/* ------------------------------ 超长行 ------------------------------ */

test('超长行：各批量写入口一律「计入跳过」，既不静默略过也不删 / 改一半', async () => {
  // 第 0 行超过 MAX_LINE_BYTES（scan 以 error 标记），第 1 行正常。
  const huge = `{"pad":"${'x'.repeat(MAX_LINE_BYTES + 1024)}"}`;
  await withService([huge, '{"a":1}'], async (ds, file) => {
    await ds.getOverview();

    // 按行号写回：目标是超长行 → 取不出原文，计入 skippedInvalid
    const applied = await ds.applyLineTexts([{ line: 0, text: '{"x":1}' }]);
    assert.equal(applied.ok, true);
    assert.equal(applied.replaced, 0);
    assert.equal(applied.skippedInvalid, 1);

    // 批量删除：只选中超长行 → 明确拒绝，而不是删出一个残缺区间
    const onlyHuge = await ds.deleteRecords([0]);
    assert.equal(onlyHuge.ok, false);
    assert.match(onlyHuge.error ?? '', /目标行过大/);

    // 批量替换：搜索结果指定命中 [0, 1]，超长行跳过、正常行照改
    const restoreSearch = patchWrite(ds, {
      search: async () => ({ matches: [0, 1], total: 2, truncated: false }),
    });
    const replaced = await ds.replaceText('"a"', '"b"');
    restoreSearch();
    assert.equal(replaced.ok, true, replaced.error ?? '');
    assert.equal(replaced.replaced, 1);
    assert.equal(replaced.skippedInvalid, 1);

    // 字段替换：同样跳过超长行，改正常行
    const field = await ds.replaceField(['b'], 1, 2);
    assert.equal(field.ok, true, field.error ?? '');
    assert.equal(field.replaced, 1);
    assert.equal(field.skippedInvalid, 1);

    // 批量删除：超长行 + 正常行 → 只删正常行，skipped 如实上报
    const both = await ds.deleteRecords([0, 1]);
    assert.equal(both.ok, true, both.error ?? '');
    assert.equal(both.deleted, 1);
    assert.equal(both.skipped, 1);

    assert.equal(await readFile(file, 'utf8'), `${huge}\n`, '超长行始终原样保留');
  });
});

/* ------------------- 写入途中异常 / 取消 → 结构化回执 ------------------- */

test('写入途中抛异常：各写入口都返回结构化失败，且编辑标志复位（不会卡死 checkStale）', async () => {
  // commitIndex 抛错 = 磁盘已写、索引同步失败，是写路径里最需要如实上报的异常。
  // 每个入口用独立实例：第一次失败后基线未刷新，复用同一实例会被后续操作判成「外部修改」。
  const entries: [
    string,
    (ds: DataService) => Promise<{ ok: boolean; error?: string; cancelled?: boolean }>,
  ][] = [
    ['editRecord', (ds) => ds.editRecord(0, '{"a":10}')],
    ['deleteRecord', (ds) => ds.deleteRecord(1)],
    ['insertRecord', (ds) => ds.insertRecord(0, '{"a":11}')],
    ['deleteRecords', (ds) => ds.deleteRecords([2])],
    ['replaceText', (ds) => ds.replaceText('"a"', '"b"')],
  ];
  for (const [name, run] of entries) {
    await withService(COMPACT, async (ds) => {
      await ds.getOverview();
      const restore = patchWrite(ds, { commitIndex: () => Promise.reject(new Error('索引炸了')) });
      try {
        const r = await run(ds);
        assert.equal(r.ok, false, name);
        assert.equal(r.error, '索引炸了', name);
        assert.equal(r.cancelled, undefined, `${name}：普通异常不能被报成「已取消」`);
      } finally {
        restore();
      }
      // 编辑标志已复位：checkStale 不再因「编辑中」而恒返回 null。
      // （磁盘已被改动，基线落后，故应能检测到变化。）
      const stale = await ds.checkStale();
      assert.notEqual(stale, null, `${name}：编辑标志必须在异常后复位`);
    });
  }
});

test('批量写入被取消：cancelled=true，文件原样（rename 之前中止零风险）', async () => {
  // 取消只在「复制未改动区间」的分块边界检查：编辑之间必须隔着一行不被改动的内容。
  await withService(['{"a":1}', '{"c":2}', '{"a":3}'], async (ds, file) => {
    await ds.getOverview();
    const before = await readFile(file, 'utf8');

    const del = await ds.deleteRecords([0, 2], { shouldCancel: () => true });
    assert.equal(del.ok, false);
    assert.equal(del.cancelled, true);

    const rep = await ds.replaceText('"a"', '"b"', { shouldCancel: () => true });
    assert.equal(rep.ok, false);
    assert.equal(rep.cancelled, true);

    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal(ds.getHistory().entries.length, 0, '取消的操作不得入历史');
  });
});
test('单条变长编辑被取消：cancelled=true，文件原样', async () => {
  // 需要搬移尾部才会检查取消：新文本比旧文本长，且后面还有行。
  await withService(COMPACT, async (ds, file) => {
    await ds.getOverview();
    const before = await readFile(file, 'utf8');
    const res = await ds.editRecord(0, '{"a":"这是一段明显更长的新内容"}', undefined, {
      shouldCancel: () => true,
    });
    assert.equal(res.ok, false);
    assert.equal(res.cancelled, true);
    assert.equal(await readFile(file, 'utf8'), before);
  });
});

/* ----------------- DataService 其余入口的错误分支 ----------------- */

test('导出：目标缺失 / 与源文件同名 / 无可导出记录 → 明确拒绝', async () => {
  await withService(COMPACT, async (ds, file) => {
    await ds.getOverview();
    assert.match((await ds.exportLines([0], '   ')).error ?? '', /未指定导出目标/);
    assert.match((await ds.exportLines([0], file)).error ?? '', /不能是当前文件本身/);
    assert.match((await ds.exportLines([], `${file}.out`)).error ?? '', /没有可导出的记录/);
    // 越界号会被归一化滤掉，剩下空集
    assert.match((await ds.exportLines([99, -1], `${file}.out`)).error ?? '', /没有可导出的记录/);
  });
});

test('导出：一次选中超过上限 → 拒绝并给出数量', async () => {
  const many = Array.from({ length: 50_001 }, (_, i) => `{"n":${i}}`);
  await withService(many, async (ds, file) => {
    await ds.getOverview();
    const res = await ds.exportLines(
      many.map((_, i) => i),
      `${file}.out`
    );
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /一次最多导出 50000 条记录，当前 50001 条/);
  });
});
test('导出：取消 → cancelled，目标文件不被创建', async () => {
  await withService(COMPACT, async (ds, file) => {
    await ds.getOverview();
    const target = `${file}.export`;
    const res = await ds.exportLines([0, 1], target, { shouldCancel: () => true });
    assert.equal(res.ok, false);
    assert.equal(res.cancelled, true);
    await assert.rejects(readFile(target), '取消后目标文件不应存在');
  });
});

test('画像扫描 / 遗留备份检测：无备份时 inspectBackup 返回 null，scanProfile 正常出结果', async () => {
  await withService(COMPACT, async (ds) => {
    await ds.getOverview();
    assert.equal(await ds.inspectBackup(), null);
    const profile = await ds.scanProfile({ onProgress: () => {} });
    assert.equal(profile.cancelled ?? false, false);
    assert.ok(profile.fields.length > 0);
  });
});

test('丢弃遗留备份：无备份时也安全返回 ok', async () => {
  await withService(COMPACT, async (ds) => {
    await ds.getOverview();
    const res = await ds.resolveBackup('discard');
    assert.equal(res.ok, true);
  });
});

/* ------------------- 收尾路径：句柄释放 / dispose 失败 ------------------- */

interface Internals {
  reader?: ByteReader & { close?: () => Promise<void> };
  host?: {
    releaseFile(): Promise<void>;
    reacquireFile(path: string): Promise<void>;
    dispose(): Promise<void>;
  };
  runExclusive<T>(run: () => Promise<T>): Promise<T>;
}

test('串行链：前一个写操作 reject 不会卡死后续写操作', async () => {
  await withService(COMPACT, async (ds) => {
    await ds.getOverview();
    const internals = ds as unknown as Internals;
    await assert.rejects(
      internals.runExclusive(() => Promise.reject(new Error('前一个失败'))),
      /前一个失败/
    );
    // 链上只挂「已吞掉异常」的 Promise：之后的写入仍能正常完成。
    assert.equal((await ds.editRecord(0, '{"a":10}')).ok, true);
  });
});

test('句柄释放 / 重新获取 / dispose 报错都被吞掉：写入照常成功，dispose 不抛', async () => {
  await withService(COMPACT, async (ds, file) => {
    await ds.getOverview();
    const internals = ds as unknown as Internals;

    // 先真正执行再抛错：既触发 .catch 吞错分支，又不泄漏真实句柄（Windows 下会挡住临时目录清理）。
    const realReader = internals.reader!;
    internals.reader = {
      readBytes: (s, l) => realReader.readBytes(s, l),
      close: async () => {
        await realReader.close?.();
        throw new Error('reader.close 炸了');
      },
    };
    const realHost = internals.host!;
    internals.host = {
      releaseFile: async () => {
        await realHost.releaseFile();
        throw new Error('releaseFile 炸了');
      },
      reacquireFile: async (path: string) => {
        await realHost.reacquireFile(path);
        throw new Error('reacquireFile 炸了');
      },
      dispose: async () => {
        await realHost.dispose();
        throw new Error('dispose 炸了');
      },
    } as unknown as Internals['host'];

    const res = await ds.deleteRecords([1]);
    assert.equal(res.ok, true, res.error ?? '');
    assert.equal(await readFile(file, 'utf8'), '{"a":1}\n{"a":3}\n');

    await ds.dispose(); // 内部 reader.close / host.dispose 再次报错：必须吞掉
  });
});

test('dispose 时索引仍在构建（且构建会失败）：等待并吞掉构建错误', async () => {
  await withService(COMPACT, async (ds, file) => {
    await rm(file); // 让构建失败
    const pending = ds.getOverview().catch(() => undefined);
    await ds.dispose();
    await pending;
  });
});

test('恢复遗留备份：没有备份时安全返回（不抛错、不改文件）', async () => {
  await withService(COMPACT, async (ds, file) => {
    await ds.getOverview();
    const before = await readFile(file, 'utf8');
    const res = await ds.resolveBackup('restore');
    assert.equal(res.ok, false);
    assert.equal(await readFile(file, 'utf8'), before);
  });
});

test('批量删除三段不相邻区间；区间表乱序且含越界偏移的撤销被整体拒绝，磁盘不动', async () => {
  await withService(['{"a":1}', '{"c":2}', '{"a":3}', '{"c":4}', '{"a":5}'], async (ds, file) => {
    await ds.getOverview();
    const del = await ds.deleteRecords([4, 0, 2]); // 乱序传入，且分成三段
    assert.equal(del.ok, true, del.error ?? '');
    assert.equal(del.ranges, 3);
    const afterDelete = await readFile(file, 'utf8');
    assert.equal(afterDelete, '{"c":2}\n{"c":4}\n');

    // 倒序传入、其中一段偏移越界：insertRanges 先按偏移排序再逐段校验，
    // 任何一段失效就整体拒绝（宁可不撤销，也不在错误位置插入）。
    const ranges = (del.changes ?? []).toReversed();
    ranges[0] = { ...ranges[0], start: 99999, end: 99999 };
    const back = await ds.insertRanges(ranges);
    assert.equal(back.ok, false);
    assert.equal(back.conflict, true);
    assert.equal(await readFile(file, 'utf8'), afterDelete);
  });
});
