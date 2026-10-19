import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  countLessThan,
  cloneSearchResult,
  cloneFilterResult,
  describeProbeFailure,
  eolText,
  expandRecordLines,
  normalizeLines,
  probeLine,
  throttleProgress,
  toReplaceOpts,
} from '../dataServiceHelpers.ts';
import { BadLineTracker } from '../badLineTracker.ts';
import { LineIndex } from '../../indexer/lineIndex.ts';
import { MemoryReader } from '../../parser/jsonParser.ts';
import type { SearchLinesResult, FilterLinesResult } from '../searchEngine.ts';

describe('countLessThan', () => {
  it('统计升序数组里小于 x 的个数', () => {
    const a = [1, 3, 5, 7];
    assert.equal(countLessThan(a, 0), 0);
    assert.equal(countLessThan(a, 1), 0, '相等的不计');
    assert.equal(countLessThan(a, 4), 2);
    assert.equal(countLessThan(a, 8), 4);
    assert.equal(countLessThan([], 3), 0);
  });
});

describe('cloneSearchResult / cloneFilterResult', () => {
  it('复制 matches：改副本不污染缓存里的原对象', () => {
    const orig = { matches: [1, 2, 3], truncated: false } as unknown as SearchLinesResult;
    const copy = cloneSearchResult(orig);
    copy.matches.push(99);
    assert.deepEqual(orig.matches, [1, 2, 3]);
  });

  it('过滤结果 matches 为 null（=不过滤）时保持 null', () => {
    const orig = { matches: null } as unknown as FilterLinesResult;
    assert.equal(cloneFilterResult(orig).matches, null);
  });

  it('过滤结果 matches 为数组时同样是副本', () => {
    const orig = { matches: [4, 5] } as unknown as FilterLinesResult;
    const copy = cloneFilterResult(orig);
    copy.matches!.push(6);
    assert.deepEqual(orig.matches, [4, 5]);
  });
});

describe('describeProbeFailure', () => {
  it('三种失败原因给出不同的提示，且都带行号', () => {
    const a = describeProbeFailure(7, 'out-of-range');
    const b = describeProbeFailure(7, 'too-large');
    const c = describeProbeFailure(7, 'not-found');
    assert.equal(new Set([a, b, c]).size, 3);
    for (const m of [a, b, c]) assert.match(m, /7/);
  });
});

describe('throttleProgress', () => {
  it('未传回调时返回 undefined', () => {
    assert.equal(throttleProgress(undefined), undefined);
  });

  it('终态（已处理 ≥ 总量）必发，不被节流吞掉', () => {
    const got: number[] = [];
    const cb = throttleProgress((i) => got.push(i.processedBytes))!;
    cb({ processedBytes: 10, totalBytes: 100 });
    cb({ processedBytes: 20, totalBytes: 100 }); // 紧接着一次，会被节流
    cb({ processedBytes: 100, totalBytes: 100 }); // 终态
    assert.equal(got[got.length - 1], 100);
    assert.ok(got.length <= 2, `中间进度应被节流，实得 ${got.join(',')}`);
  });
});

describe('toReplaceOpts', () => {
  it('把 movedBytes 映射为 processedBytes', () => {
    const seen: { processedBytes: number; totalBytes: number }[] = [];
    const o = toReplaceOpts({ onProgress: (i) => seen.push(i) });
    o.onProgress!({ movedBytes: 5, totalBytes: 50 });
    assert.deepEqual(seen, [{ processedBytes: 5, totalBytes: 50 }]);
  });

  it('没有回调时不产生多余字段', () => {
    assert.deepEqual(toReplaceOpts({}), {});
  });

  it('透传 shouldCancel', () => {
    const f = () => true;
    assert.equal(toReplaceOpts({ shouldCancel: f }).shouldCancel, f);
  });
});

describe('probeLine', () => {
  async function setup(text: string) {
    const buf = Buffer.from(text, 'utf8');
    const reader = new MemoryReader(buf);
    const li = await LineIndex.build([buf], {});
    return { li, reader };
  }

  it('合法行：返回字节区间与行尾风格', async () => {
    const { li, reader } = await setup('{"a":1}\n{"b":2}\n');
    const r = await probeLine(li, reader, 1);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.start, 8);
      assert.equal(r.end, 16, '[start,end) 为不含右边界，包含换行符');
    }
  });

  it('越界行号（负数 / 小数 / 超出总行数）→ out-of-range', async () => {
    const { li, reader } = await setup('{"a":1}\n');
    for (const bad of [-1, 1.5, 99]) {
      const r = await probeLine(li, reader, bad);
      assert.deepEqual(r, { ok: false, reason: 'out-of-range' });
    }
  });
});

describe('BadLineTracker', () => {
  it('add / has / delete / size', () => {
    const t = new BadLineTracker();
    t.add(3);
    t.addMany([1, 2]);
    assert.equal(t.size, 3);
    assert.equal(t.has(2), true);
    t.delete(2);
    t.deleteMany([1]);
    assert.deepEqual(t.toSortedArray(), [3]);
  });

  it('replaceAll 置 complete，invalidate 只降级标记不清列表', () => {
    const t = new BadLineTracker();
    t.replaceAll([5, 1]);
    assert.equal(t.isComplete, true);
    assert.deepEqual(t.toSortedArray(), [1, 5]);
    t.invalidate();
    assert.equal(t.isComplete, false);
    assert.deepEqual(t.toSortedArray(), [1, 5]);
  });

  it('shiftAfterInsert：插入点及其后的坏行 +1', () => {
    const t = new BadLineTracker();
    t.addMany([1, 3, 5]);
    t.shiftAfterInsert(3);
    assert.deepEqual(t.toSortedArray(), [1, 4, 6]);
  });

  it('shiftAfterDelete：被删行移除，其后 -1', () => {
    const t = new BadLineTracker();
    t.addMany([1, 3, 5]);
    t.shiftAfterDelete(3);
    assert.deepEqual(t.toSortedArray(), [1, 4]);
  });

  it('remapAfterDeletes：按删前行号批量重映射', () => {
    const t = new BadLineTracker();
    t.addMany([0, 2, 4, 6]);
    t.remapAfterDeletes(new Set([1, 2]));
    // 2 被删；0 不变；4 前面删了 1,2 → 2；6 → 4
    assert.deepEqual(t.toSortedArray(), [0, 2, 4]);
  });

  it('toSortedArray 返回副本', () => {
    const t = new BadLineTracker();
    t.add(1);
    t.toSortedArray().push(99);
    assert.deepEqual(t.toSortedArray(), [1]);
  });

  it('reset 清空列表并复位 complete', () => {
    const t = new BadLineTracker();
    t.replaceAll([1]);
    t.reset();
    assert.equal(t.size, 0);
    assert.equal(t.isComplete, false);
  });
});

describe('normalizeLines', () => {
  it('去重、滤掉越界 / 非整数 / 负数，并升序', () => {
    assert.deepEqual(normalizeLines([5, 1, 3, 1, -1, 1.5, 9, Number.NaN], 6), [1, 3, 5]);
  });

  it('全部非法或为空 → 空数组（调用方据此报「没有可…的记录」）', () => {
    assert.deepEqual(normalizeLines([], 10), []);
    assert.deepEqual(normalizeLines([10, 11], 10), []);
  });
});

describe('expandRecordLines', () => {
  it('紧凑文件：记录号 == 物理行号，区间为首尾目标', async () => {
    const buf = Buffer.from('{"a":1}\n{"a":2}\n{"a":3}\n{"a":4}\n', 'utf8');
    const li = await LineIndex.build([buf], {});
    const r = expandRecordLines(li, [1, 3]);
    assert.deepEqual(
      [...r.wanted].toSorted((a, b) => a - b),
      [1, 3]
    );
    assert.equal(r.firstLine, 1);
    assert.equal(r.lastLine, 3);
  });

  it('多行（pretty）文件：一条记录展开为连续的多个物理行', async () => {
    const buf = Buffer.from('{\n  "a": 1\n}\n{\n  "a": 2\n}\n', 'utf8');
    const li = await LineIndex.build([buf], {});
    assert.equal(li.multiline, true, '前置：应被识别为多行文件');
    const r = expandRecordLines(li, [1]);
    assert.deepEqual(
      [...r.wanted].toSorted((a, b) => a - b),
      [3, 4, 5]
    );
    assert.equal(r.firstLine, 3);
    assert.equal(r.lastLine, 5);
  });
});

describe('eolText', () => {
  it('行尾风格 → 文本；none 为空串', () => {
    assert.equal(eolText('lf'), '\n');
    assert.equal(eolText('crlf'), '\r\n');
    assert.equal(eolText('none'), '');
  });
});
