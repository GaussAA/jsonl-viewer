// scripts/integration-runner.mjs
// 跑在 VS Code Extension Host 进程里的测试 runner。
// 由 @vscode/test-electron 通过 --extensionTestsPath 加载。
//
// 格式要求（VS Code 硬性格式，见官方文档 "The test runner script"）：
//   必须导出一个 run() 函数，返回 Promise<void>。
//   宿主会等待这个 Promise resolve（测试通过）或 reject（测试失败）。
//   不能自己 process.exit()，否则宿主无法判定结果。
//
// 这里不用 Mocha（简化依赖），只用 node:assert 做 3 个检查：
//   1. 扩展能被 getExtension 找到（contributes 注册正确）
//   2. activate() 不抛异常
//   3. activate 后 isActive === true

import * as vscode from 'vscode';
import assert from 'node:assert/strict';

// 完整扩展 ID = publisher.name（见 package.json）
const EXTENSION_ID = 'jsonl-viewer.jsonl-viewer';

// 必须命名导出 run，宿主才能 import { run }
export async function run() {
  console.log('[integration] Extension Host ready, starting checks...');

  // 1) 扩展能被宿主发现（package.json 的 contributes 都已正确注册）
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `Extension not found in host: ${EXTENSION_ID}`);
  console.log('[integration] ✓ extension registered');

  // 2) 执行 activate()——如果 activationEvents、customEditors、commands 有配置问题，
  //    这里会抛异常（Promise reject → 宿主判失败）。
  await ext.activate();
  console.log('[integration] ✓ extension activated');

  // 3) 扩展 activate() 应该完成且 deactivate 尚未调用，所以 active 状态为 true
  assert.equal(ext.isActive, true);
  console.log('[integration] ✓ extension isActive === true');

  console.log('[integration] all checks passed ✓');
}