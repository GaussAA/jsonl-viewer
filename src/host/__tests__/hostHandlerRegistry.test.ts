/**
 * hostHandlerRegistry.test.ts — 宿主 handler 表的**纪律检查**（O14）。
 *
 * ## 它测什么、不测什么（先把边界说清楚）
 *
 * 「每个端点都有 handler」这一条，TypeScript 已经替我们保证了（`dispatchMessage` 的形参
 * 就是 `HostHandlerMap`，缺键即编译失败）。所以本文件**不**把它当作主要目标 ——
 * 它只是顺手钉住「别把那个参数类型放宽成 `Record<string, ...>`」。
 *
 * 这里真正检查的是**类型系统看不见的两条纪律**：
 *
 *   1. **用了取消标记，就必须摘除它**。`cancel.has(id)` 的 handler 若不配摘除点，
 *      集合会随会话无界增长（每个可取消请求漏一个 key）。这类泄漏没有报错、
 *      没有症状，只在长会话里慢慢吃掉内存。
 *      摘除有**两个合法落点**：handler 块内的 `cancel.delete(...)`，或经
 *      `runCancellableEdit()` 包装（它的 `finally` 统一摘除）。二者都认，
 *      但「包装确实摘除了」这一点本身另有断言钉住（见最后一条）。
 *   2. **不许留下 `NOT_IMPLEMENTED` 占位**。占位能编译通过、能跑到，直到用户点下去
 *      才报错 —— 而那时它看起来像「功能坏了」，不像「还没做」。
 *
 * 这是**静态检查**（读源码文本），不是运行时验证。它的定位是「提醒闸门」：
 * 一旦有人越过上述两条线，先在这里停下来看一眼。文本解析确实脆弱，
 * 但换来的是零运行时依赖、零重构风险 —— 对这两条规则而言是划算的。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HostEndpoint } from '../../protocol/rpc.ts';

const SRC_PATH = fileURLToPath(new URL('../../extension.ts', import.meta.url));
const SRC = readFileSync(SRC_PATH, 'utf8');

/** 把 `[HostEndpoint.X]: handler…` 切成一块块（到下一个条目前为止）。 */
function handlerBlocks(): Map<string, string> {
  const marks: Array<{ name: string; start: number }> = [];
  const re = /\[HostEndpoint\.([A-Z_0-9]+)\]:/g;
  for (let m = re.exec(SRC); m; m = re.exec(SRC)) {
    marks.push({ name: m[1], start: m.index });
  }
  const out = new Map<string, string>();
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : SRC.length;
    out.set(marks[i].name, SRC.slice(marks[i].start, end));
  }
  return out;
}

const BLOCKS = handlerBlocks();

test('O14：能解析出 handler 表（解析失败会让下面几条静默失效，故先自检）', () => {
  assert.ok(
    BLOCKS.size >= 20,
    `应解析出足量 handler（实得 ${BLOCKS.size}）—— 若解析规则与源码形态脱节，本文件会变成空转`
  );
});

test('O14：每个 HostEndpoint 都有对应 handler 条目（类型系统之外的兜底）', () => {
  // 注意用 **键名**（READY）而不是值（'ready'）：handler 表写的是 `[HostEndpoint.READY]`。
  const missing = Object.keys(HostEndpoint).filter(
    (name) => !SRC.includes(`[HostEndpoint.${name}]:`)
  );
  for (const name of missing) {
    assert.fail(
      `端点 ${name} 在 extension.ts 里找不到 handler —— 若 dispatchMessage 的类型被放宽，就会漏到运行时`
    );
  }
  assert.deepEqual(missing, []);
});

test('O14：用了取消标记的 handler 必须有摘除落点（否则 cancel 集合无界增长）', () => {
  const offenders: string[] = [];
  for (const [name, block] of BLOCKS) {
    if (!block.includes('cancel.has(')) continue;
    // 两个合法落点：块内自摘，或交给 runCancellableEdit 的 finally。
    const removes = block.includes('cancel.delete(') || block.includes('runCancellableEdit(');
    if (!removes) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `以下 handler 读取了取消标记却没有任何摘除落点：${offenders.join(', ')} —— 长会话下会持续堆积`
  );
});

test('O14：runCancellableEdit 确实在 finally 里摘除（「包装即摘除」这个前提本身要被钉住）', () => {
  const at = SRC.indexOf('const runCancellableEdit = async <T>');
  assert.ok(at > 0, '找不到 runCancellableEdit —— 若它被改名，上一条断言的豁免就失去了依据');
  const body = SRC.slice(at, SRC.indexOf('};', at));
  assert.match(body, /finally\s*{/, '必须有 finally：成功路径也要摘除');
  assert.match(body, /cancel\.delete\(requestId\)/, 'finally 里要真的摘除');
});

test('O14：不得留下 NOT_IMPLEMENTED 占位（占位能编译、能跑，直到用户点下去才报错）', () => {
  assert.ok(
    !SRC.includes('NOT_IMPLEMENTED'),
    'extension.ts 里出现了 NOT_IMPLEMENTED 占位：要么实现它，要么从端点表里去掉'
  );
});

test('O14：可取消端点覆盖了新增的 scanProfile / exportLines（防止「加了端点忘了可取消」）', () => {
  for (const name of ['SCAN_PROFILE', 'EXPORT_LINES', 'SCAN_BAD_LINES']) {
    const block = BLOCKS.get(name);
    assert.ok(block, `${name} 应有 handler`);
    assert.ok(
      block!.includes('cancel.has(') || block!.includes('shouldCancel'),
      `${name} 是长任务，应支持取消 —— 不能取消的长任务只能等它跑完`
    );
  }
});
