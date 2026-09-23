import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locateValue, replaceValueAtPath, type PathPart } from '../jsonSpan.ts';

/**
 * 断言「定位到的区间切片恰好是路径所指的那个值」。
 *
 * 这比硬编码 start/end 更有表达力：它直接检验「span 精确指向该值」这一性质本身，
 * 而位置随文本格式变化是不该被测试钉死的。
 */
function assertSpan(text: string, path: PathPart[], expected: unknown): void {
  const span = locateValue(text, path);
  assert.ok(span, `应能定位 ${JSON.stringify(path)}`);
  const token = text.slice(span.start, span.end);
  assert.deepEqual(JSON.parse(token), expected, `${JSON.stringify(path)} 的切片应恰为该值`);
  assert.ok(!/\s/.test(token[0] ?? 'x'), 'span 起点不应含前导空白');
  assert.ok(!/\s/.test(token[token.length - 1] ?? 'x'), 'span 终点不应含尾随空白');
}

/* ============================ 定位：基本形态 ============================ */

test('locateValue：顶层对象的各类型字段', () => {
  const text = '{"s":"hi","n":42,"b":true,"z":null,"neg":-1.5e3}';
  assertSpan(text, ['s'], 'hi');
  assertSpan(text, ['n'], 42);
  assertSpan(text, ['b'], true);
  assertSpan(text, ['z'], null);
  assertSpan(text, ['neg'], -1500);
});

test('locateValue：嵌套对象路径', () => {
  const text = JSON.stringify({ a: { b: { c: 'deep' } }, x: 1 });
  assertSpan(text, ['a', 'b', 'c'], 'deep');
  assertSpan(text, ['a'], { b: { c: 'deep' } });
});

test('locateValue：数组下标与对象数组混合路径', () => {
  const text = JSON.stringify({ list: [10, 20, 30], rows: [{ name: 'a' }, { name: 'b' }] });
  assertSpan(text, ['list', 2], 30);
  assertSpan(text, ['rows', 1, 'name'], 'b');
  assertSpan(text, ['rows', 0], { name: 'a' });
});

test('locateValue：顶层数组与顶层标量', () => {
  assertSpan('[1,2,3]', [1], 2);
  assertSpan('123', [], 123);
  assertSpan('"abc"', [], 'abc');
  assertSpan('true', [], true);
  assertSpan('null', [], null);
});

test('locateValue：空路径即整个值', () => {
  const text = '{ "a" : 1 }';
  const span = locateValue(text, []);
  assert.ok(span);
  assert.equal(text.slice(span.start, span.end), '{ "a" : 1 }');
});

/* ============================ 定位：转义与空白 ============================ */

test('locateValue：键名含转义 —— 必须 decode 后比较（否则永远匹配不上）', () => {
  // 原文里键是 a\"b，路径里是 a"b
  const text = '{"a\\"b":1,"c":2}';
  assertSpan(text, ['a"b'], 1);
  // 未 decode 就比较会命中不了；反向确认错误写法确实拿不到
  assert.equal(locateValue(text, ['a\\"b']), undefined, '转义形态的键名不该匹配');
});

test('locateValue：键名含 Unicode 转义', () => {
  const text = '{"\\u4e2d":1}';
  assertSpan(text, ['中'], 1);
});

test('locateValue：字符串值含转义与结构字符（不得误判结构）', () => {
  const text = '{"a":"} ] { \\" x","b":2}';
  assertSpan(text, ['a'], '} ] { " x');
  assertSpan(text, ['b'], 2);
});

test('locateValue：美化后的 JSON（多行、缩进、任意空白）', () => {
  const text = [
    '{',
    '  "user": {',
    '    "name": "bob",',
    '    "tags": [',
    '      "x",',
    '      "y"',
    '    ]',
    '  },',
    '  "n": 7',
    '}',
  ].join('\n');
  assertSpan(text, ['user', 'name'], 'bob');
  assertSpan(text, ['user', 'tags', 1], 'y');
  assertSpan(text, ['n'], 7);
  assertSpan(text, ['user'], { name: 'bob', tags: ['x', 'y'] });
});

test('locateValue：Unicode 与 emoji 的键和值', () => {
  const text = JSON.stringify({ '🔑': '😀', 中文: '值' });
  assertSpan(text, ['🔑'], '😀');
  assertSpan(text, ['中文'], '值');
});

test('locateValue：空对象与空数组', () => {
  const text = '{"o":{},"a":[]}';
  assertSpan(text, ['o'], {});
  assertSpan(text, ['a'], []);
});

test('locateValue：深层嵌套', () => {
  let outer: unknown = 'bottom';
  let text = '"bottom"';
  for (let i = 0; i < 30; i++) {
    outer = { [`k${i}`]: outer };
    text = `{"k${i}":${text}}`;
  }
  // 最内层：路径要从最外层的键开始（k29 在最外）
  const innerPath: PathPart[] = [];
  for (let i = 29; i >= 0; i--) innerPath.push(`k${i}`);
  assertSpan(text, innerPath, 'bottom');
  // 反向：空路径即最外层对象
  assertSpan(text, [], outer);
});

/* ============================ 定位：必须失败的场景 ============================ */

test('locateValue：路径不存在 / 类型不符 / 下标越界 → undefined', () => {
  const text = '{"a":{"b":1},"s":"x","arr":[1]}';
  assert.equal(locateValue(text, ['nope']), undefined, '键不存在');
  assert.equal(locateValue(text, ['a', 'nope']), undefined, '深层键不存在');
  assert.equal(locateValue(text, ['s', 'b']), undefined, '对字符串取字段');
  assert.equal(locateValue(text, ['arr', 5]), undefined, '下标越界');
  assert.equal(locateValue(text, ['arr', 'b']), undefined, '对数组取字符串键');
  assert.equal(locateValue(text, ['a', 0]), undefined, '对对象取数字下标');
});

test('locateValue：文本非法 → undefined（绝不冒险给一个错的区间）', () => {
  assert.equal(locateValue('{"a":1', ['a']), undefined, '截断');
  assert.equal(locateValue('{"a":1}}', ['a']), undefined, '尾随垃圾');
  assert.equal(locateValue('{"a":1} extra', ['a']), undefined, '尾部有残留');
  assert.equal(locateValue('', ['a']), undefined, '空文本');
  assert.equal(locateValue('  ', ['a']), undefined, '只有空白');
  assert.equal(locateValue("{'a':1}", ['a']), undefined, '单引号不是 JSON');
  assert.equal(locateValue('{"a":1,}', ['a']), undefined, '尾随逗号');
  assert.equal(locateValue('{"a":01}', ['a']), undefined, '前导零非法');
  assert.equal(locateValue('{"a":+1}', ['a']), undefined, '正号非法');
  assert.equal(locateValue('{"a":tru}', ['a']), undefined, '字面量拼写错误');
});

test('locateValue：字符串未闭合或含裸控制字符 → undefined', () => {
  assert.equal(locateValue('{"a":"x}', ['a']), undefined, '未闭合');
  assert.equal(locateValue('{"a":"x\ny"}', ['a']), undefined, '裸换行（须转义）');
});

/* ============================ 替换 ============================ */

test('replaceValueAtPath：只改那一段字节，其余逐字节保持原样', () => {
  // 刻意用「键序固定 + 空格风格固定」的原文：替换后这些都不该变
  const text = '{"a" : 1, "b":2,   "c" : "x"}';
  const res = replaceValueAtPath(text, ['b'], 99);
  assert.ok(res.ok);
  assert.equal(res.text, '{"a" : 1, "b":99,   "c" : "x"}', '仅 b 的值变化');
  // 前缀与后缀逐字节不变（这是「外科式」的定义）
  assert.equal(res.text.slice(0, res.span.start), text.slice(0, res.span.start));
  assert.equal(res.text.slice(res.span.start + String(99).length), text.slice(res.span.end));
});

test('replaceValueAtPath：字符串按原类型序列化并正确转义', () => {
  const res = replaceValueAtPath('{"a":"old"}', ['a'], 'he said "hi"\n\\');
  assert.ok(res.ok);
  assert.equal(res.text, '{"a":"he said \\"hi\\"\\n\\\\"}');
  assert.deepEqual(JSON.parse(res.text), { a: 'he said "hi"\n\\' });
});

test('replaceValueAtPath：嵌套与数组元素', () => {
  const text = '{"user":{"tags":["a","b"]}}';
  const res = replaceValueAtPath(text, ['user', 'tags', 1], 'B');
  assert.ok(res.ok);
  assert.equal(res.text, '{"user":{"tags":["a","B"]}}');

  const res2 = replaceValueAtPath(text, ['user'], { tags: [] });
  assert.ok(res2.ok);
  assert.equal(res2.text, '{"user":{"tags":[]}}');
});

test('replaceValueAtPath：允许改变值的类型（结构与值类型是两回事）', () => {
  const text = '{"a":1}';
  const asStr = replaceValueAtPath(text, ['a'], 'one');
  assert.ok(asStr.ok);
  assert.equal(asStr.text, '{"a":"one"}');

  const asArr = replaceValueAtPath(text, ['a'], [1, 2]);
  assert.ok(asArr.ok);
  assert.equal(asArr.text, '{"a":[1,2]}');

  const asNull = replaceValueAtPath(text, ['a'], null);
  assert.ok(asNull.ok);
  assert.equal(asNull.text, '{"a":null}');
});

test('replaceValueAtPath：替换后仍是合法 JSON，且只有目标值变化', () => {
  const original = '{"keep":1,"nest":{"x":"a","y":[1,2,3]},"tail":true}';
  const before = JSON.parse(original) as Record<string, unknown>;
  const res = replaceValueAtPath(original, ['nest', 'y', 2], 30);
  assert.ok(res.ok);
  const after = JSON.parse(res.text) as Record<string, unknown>;
  // 除目标外逐一相等
  assert.deepEqual(after.keep, before.keep);
  assert.deepEqual(after.tail, before.tail);
  assert.deepEqual(after.nest, { x: 'a', y: [1, 2, 30] });
});

test('replaceValueAtPath：定位失败 → ok:false 且带可读原因（不返回半成品文本）', () => {
  const bad = replaceValueAtPath('{"a":1}', ['nope'], 2);
  assert.equal(bad.ok, false);
  assert.match(bad.ok === false ? bad.error : '', /未能|定位/);
  assert.ok(!('text' in bad), '失败时不得回传文本');

  const invalid = replaceValueAtPath('not json', [], 2);
  assert.equal(invalid.ok, false);
});

test('replaceValueAtPath：值无法序列化（undefined / 函数）→ ok:false', () => {
  const res = replaceValueAtPath('{"a":1}', ['a'], undefined);
  assert.equal(res.ok, false);
  assert.match(res.ok === false ? res.error : '', /无法序列化/);

  const fn = replaceValueAtPath('{"a":1}', ['a'], () => 1);
  assert.equal(fn.ok, false);
});

test('replaceValueAtPath：空路径即整体替换', () => {
  const res = replaceValueAtPath('  {"a":1}  ', [], { b: 2 });
  assert.ok(res.ok);
  assert.equal(res.text, '  {"b":2}  ', '前后空白仍保留（只换中间那段）');
});

test('replaceValueAtPath：对含结构字符的字符串值替换，不破坏结构', () => {
  const text = '{"a":"} ] { ","b":2}';
  const res = replaceValueAtPath(text, ['a'], 'ok');
  assert.ok(res.ok);
  assert.equal(res.text, '{"a":"ok","b":2}');
  assert.deepEqual(JSON.parse(res.text), { a: 'ok', b: 2 });
});
