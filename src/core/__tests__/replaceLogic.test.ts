import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countLiteralMatches,
  describeReplaceOutcome,
  foldAscii,
  planLineReplace,
} from '../replaceLogic.ts';

/* ------------------------- foldAscii ------------------------- */

test('foldAscii：只折 ASCII A-Z，长度严格不变', () => {
  assert.equal(foldAscii('AbC'), 'abc');
  assert.equal(foldAscii('中文ABC'), '中文abc');
  // 已小写 / 非字母不动
  assert.equal(foldAscii('abc123-_.'), 'abc123-_.');
  // 长度恒等是正确性的前提：长度变了，用它算出的索引去原串切片就会错位。
  for (const s of ['İstanbul', 'ÅNGSTRÖM', '😂ABC', 'A\u0300b']) {
    assert.equal(foldAscii(s).length, s.length, `长度必须不变：${s}`);
  }
});

/* --------------------- countLiteralMatches --------------------- */

test('countLiteralMatches：不重叠计数', () => {
  assert.equal(countLiteralMatches('aaaa', 'aa'), 2, 'aaaa 中的 aa 不重叠为 2 处');
  assert.equal(countLiteralMatches('abcabc', 'abc'), 2);
  assert.equal(countLiteralMatches('abc', 'zzz'), 0);
  assert.equal(countLiteralMatches('abc', ''), 0, '空查询不计数');
});

test('countLiteralMatches：大小写开关', () => {
  assert.equal(countLiteralMatches('Name name NAME', 'name', true), 3);
  assert.equal(countLiteralMatches('Name name NAME', 'name', false), 1);
});

/* ------------------------ planLineReplace ------------------------ */

test('planLineReplace：单处替换', () => {
  const plan = planLineReplace('{"name":"bob"}', 'bob', 'alice');
  assert.equal(plan.count, 1);
  assert.equal(plan.text, '{"name":"alice"}');
  assert.equal(plan.skip, undefined);
});

test('planLineReplace：行内多处替换', () => {
  const plan = planLineReplace('{"a":"x","b":"x"}', 'x', 'y');
  assert.equal(plan.count, 2);
  assert.equal(plan.text, '{"a":"y","b":"y"}');
});

test('planLineReplace：大小写不敏感时用原串切片，不污染其它字符', () => {
  // 命中 "Name" 这一段（大小写不敏感），替换后只该动这一段，键名大小写不被折叠。
  const plan = planLineReplace('{"Name":"bob","AGE":3}', 'name', 'title', {
    caseInsensitive: true,
  });
  assert.equal(plan.text, '{"title":"bob","AGE":3}');
  assert.equal(plan.count, 1);
});

test('planLineReplace：查询被当作字面量，而非正则', () => {
  // 这是最容易酿成大祸的一条：'.*' 当正则会吞掉整行内容。
  const plan = planLineReplace('{"a":".*"}', '.*', 'X');
  assert.equal(plan.count, 1);
  assert.equal(plan.text, '{"a":"X"}');

  const bracket = planLineReplace('{"a":"[1]"}', '[1]', 'Z');
  assert.equal(bracket.text, '{"a":"Z"}');
});

test('planLineReplace：替换文本含 $& 等替换语义符号时按字面量拼接', () => {
  // 若误用 String.replace，'$&' 会被解释为「整个匹配」。
  const plan = planLineReplace('{"a":"bob"}', 'bob', '$&$1');
  assert.equal(plan.text, '{"a":"$&$1"}');
});

test('planLineReplace：替换后 JSON 非法则跳过（不动这一行）', () => {
  const plan = planLineReplace('{"a":"bob"}', '"bob"', 'bob', {
    validate: (t) => {
      try {
        JSON.parse(t);
        return true;
      } catch {
        return false;
      }
    },
  });
  assert.equal(plan.skip, 'invalid-json');
  assert.equal(plan.text, undefined, '跳过时不得给出新文本');
  assert.equal(plan.count, 1, '仍如实报告命中处数，便于 UI 说明跳过了什么');
});

test('planLineReplace：替换成相同内容视为无变化', () => {
  const plan = planLineReplace('{"a":"bob"}', 'bob', 'bob');
  assert.equal(plan.skip, 'unchanged');
  assert.equal(plan.text, undefined);
  assert.equal(plan.count, 1);
});

test('planLineReplace：无匹配 / 空查询均为无变化', () => {
  assert.equal(planLineReplace('{"a":1}', 'zzz', 'y').skip, 'unchanged');
  assert.equal(planLineReplace('{"a":1}', '', 'y').skip, 'unchanged');
  assert.equal(planLineReplace('{"a":1}', 'zzz', 'y').count, 0);
});

test('planLineReplace：多字节 Unicode 内容与查询', () => {
  const plan = planLineReplace('{"city":"合肥市"}', '合肥', '北京');
  assert.equal(plan.count, 1);
  assert.equal(plan.text, '{"city":"北京市"}');
});

test('planLineReplace：替换为空串（删除片段）', () => {
  const plan = planLineReplace('{"a":"bob"}', 'bob', '');
  assert.equal(plan.text, '{"a":""}');
});

/* ---------------------- describeReplaceOutcome ---------------------- */

test('describeReplaceOutcome：跳过的行必须出现在文案里', () => {
  assert.equal(
    describeReplaceOutcome({ replaced: 3, skippedInvalid: 0, unchanged: 0, total: 3 }),
    '已替换 3 行'
  );
  const withSkip = describeReplaceOutcome({
    replaced: 3,
    skippedInvalid: 2,
    unchanged: 1,
    total: 6,
  });
  assert.match(withSkip, /已替换 3 行/);
  assert.match(withSkip, /2 行因替换后 JSON 非法已跳过/);
  assert.match(withSkip, /1 行内容无变化/);
});

test('describeReplaceOutcome：全无命中', () => {
  assert.equal(
    describeReplaceOutcome({ replaced: 0, skippedInvalid: 0, unchanged: 0, total: 0 }),
    '没有匹配的内容'
  );
});
