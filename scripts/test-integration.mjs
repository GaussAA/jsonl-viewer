// scripts/test-integration.mjs
// 外层 runner：Node 直接执行。
// 负责下载 VS Code（默认 stable，可通过 VSCODE_TEST_VERSION 环境变量覆盖）并启动 Extension Host，
// 然后由 Extension Host 进程加载 scripts/integration-runner.mjs 执行真正的断言。
//
// 用法：
//   pnpm test:integration                              # 默认 stable
//   VSCODE_TEST_VERSION=1.100.0 pnpm test:integration  # 指定具体版本
//   VSCODE_TEST_VERSION=insiders pnpm test:integration # insiders nightly
//
// 依赖：@vscode/test-electron（devDependency）
// VS Code 缓存位置：~/.vscode-test/vscode-<version>-<platform>/
// CI 中跑 Ubuntu 需要 xvfb-run 提供虚拟显示服务器。

import { runTests } from '@vscode/test-electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 扩展根目录（package.json 所在）
const extensionDevelopmentPath = path.resolve(__dirname, '..');

// 跑在 Extension Host 进程里的测试脚本（ESM，和 extension.js 同格式）
const extensionTestsPath = path.resolve(__dirname, 'integration-runner.mjs');

// 不传 workspaceFolder，让 VS Code 打开一个空窗口即可。
// 用 --disable-extensions 排除其他扩展干扰，确保我们的扩展是唯一被测试的。
const launchArgs = ['--disable-extensions'];

// VS Code 版本：默认 stable。CI 矩阵会注入不同值覆盖。
// 支持：具体版本号（如 '1.100.0'）| 'stable' | 'insiders'
const version = process.env.VSCODE_TEST_VERSION || 'stable';

try {
  console.log(`[test:integration] downloading VS Code ${version} + launching Extension Host...`);
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs,
    version,
  });
  console.log('[test:integration] all checks passed ✓');
} catch (err) {
  console.error('[test:integration] FAILED');
  console.error(err);
  process.exit(1);
}