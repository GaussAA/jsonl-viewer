#!/usr/bin/env node
/**
 * release.mjs — 一键发布脚本（统一版本发布规范）。
 *
 * 用法（在项目根目录）：
 *   node scripts/release.mjs             # 发布 package.json 当前 version
 *   node scripts/release.mjs 1.0.5       # 显式指定版本（须与 package.json version 一致）
 *
 * 流程：
 *   typecheck → build → vsce package → 产物入 releases/ → 生成 .sha256 → 更新 LATEST → git tag v<version>
 *
 * 约定：
 *   - 单一事实来源 = package.json 的 version；
 *   - 发布产物统一落在 releases/（不入 git，可用本脚本重建）；
 *   - 每个发布版本对应一个 git tag `v<version>`；
 *   - 产物可追溯（每个 vsix 附带 SHA-256 校验和）。
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 带重试的命令执行。
 *
 * Windows 下偶发 `spawnSync cmd.exe EBUSY`（杀软/索引服务恰好占用刚生成的产物或
 * cmd.exe 本身）—— 三次发布有两次因此死在最后一步，产物完整却缺 tag，只能手工续尾。
 * 短暂等待后重试即可自愈；非 EBUSY 错误照常抛出。
 */
const execWithRetry = (cmd, opts) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return execSync(cmd, { cwd: root, ...opts });
    } catch (e) {
      const busy = String(e?.message ?? '').includes('EBUSY') || (e && e.code === 'EBUSY');
      if (attempt >= 3 || !busy) throw e;
      console.warn(`[release] 命令被占用（EBUSY），1 秒后重试（${attempt}/2）…`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
  }
};
const sh = (cmd) => execWithRetry(cmd, { stdio: 'inherit' });
const shOut = (cmd) => execWithRetry(cmd, { encoding: 'utf8' });
const rel = join(root, 'releases');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = String(process.argv[2] || pkg.version).replace(/^v/, '');
const out = join(rel, `jsonl-viewer-${version}.vsix`);

if (pkg.version !== version) {
  console.error(`[release] 版本不一致：package.json=${pkg.version}，请求=${version}。`);
  console.error('[release] 请先修改 package.json 的 version，再运行本脚本（版本单一事实来源）。');
  process.exit(1);
}

// 清单一致性预检（**放在最前面，代价最低时失败**）。
//
// 为何要它：@types/vscode 一旦越出 `engines.vscode`，vsce 会在**最后一步**（打包时）拒绝，
// 而且抛的是 `Error: Command failed: npx vsce package ...` 的 Node 异常堆栈 —— 看起来像
// 脚本 bug，实际是依赖声明问题。2026-09 因此连续踩过两次（详见 docs/error_ledger.md）。
//
// 为何**不**用 `npx vsce ls` 来查（第一版如此实现，已废弃）：它要起子进程，在 Windows 上
// 可能撞 EBUSY（文件被扫描/占用）而失败 —— 于是把"命令被占用"误报成"清单不一致"，
// 把人引向错误方向。纯读 manifest 比对**零子进程、零误报**。
//
// 判据与 vsce 一致：@types/vscode 的基准版本不得高于 engines.vscode 的基准版本
// （类型包不能声明比所支持的最低引擎版本更新的 API）。
const parseMinVersion = (range) =>
  String(range)
    .replace(/^[\s^~>=<]*/, '')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
const compareVersions = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const typesRange = pkg.devDependencies?.['@types/vscode'];
const enginesRange = pkg.engines?.vscode;
if (typesRange && enginesRange) {
  const typesMin = parseMinVersion(typesRange);
  const enginesMin = parseMinVersion(enginesRange);
  if (compareVersions(typesMin, enginesMin) > 0) {
    console.error('[release] 预检未通过：@types/vscode 高于 engines.vscode，vsce 会拒绝打包。');
    console.error(`  engines.vscode = ${enginesRange}（基准 ${enginesMin.join('.')}）`);
    console.error(`  @types/vscode  = ${typesRange}（基准 ${typesMin.join('.')}）`);
    console.error('[release] 修复路径：');
    console.error('  git checkout -- package.json pnpm-lock.yaml   # 还原被误改的声明与 lock');
    console.error(
      '  pnpm run typecheck                            # 顺带把 node_modules 校正回 lock 版本'
    );
    console.error(
      `  约定：engines.vscode ${enginesRange} ⇒ @types/vscode 应为 ~${enginesMin.join('.')}`
    );
    process.exit(1);
  }
}

mkdirSync(rel, { recursive: true });
if (existsSync(out)) {
  console.error(`[release] 已存在 ${out}；如需重发请先删除该文件后再运行。`);
  process.exit(1);
}

console.log(`[release] v${version}  typecheck+test+build ...`);
// dist 产物守卫测试依赖此开关（默认跳过 —— 与并行 jsdom 测试存在 globalThis 竞态）
process.env.JLV_DIST_PRODUCT = '1';
sh('pnpm typecheck && pnpm test && pnpm build');

console.log(`[release] vsce package -> releases/ ...`);
sh(`npx vsce package --out "${out}"`);

const buf = readFileSync(out);
const sha = createHash('sha256').update(buf).digest('hex');
// 标准 sha256sum 格式：<hash>  <filename>（可被 sha256sum -c 校验）
writeFileSync(`${out}.sha256`, `${sha}  jsonl-viewer-${version}.vsix\n`);
writeFileSync(join(rel, 'LATEST'), `${version}\n`);
console.log(`[release] SHA-256 = ${sha}`);
console.log(`[release] LATEST  -> ${version}`);

const dirty = shOut('git status --porcelain').trim();
if (dirty) {
  console.warn(
    '[release] 提示：工作区有未提交改动，建议先 commit 再继续，否则 tag 不会指向本次代码。'
  );
}
// tag 可追溯性：已存在则必须指向当前 HEAD，否则退出（防止产物不可溯源）。
const tag = `v${version}`;
let tagSha = '';
try {
  // rev-parse 对不存在的 tag 返回非零退出码（execSync 会抛），用 try 容错表示「tag 不存在」。
  tagSha = shOut(`git rev-parse -q --verify ${tag}`).trim();
} catch {
  tagSha = '';
}
if (tagSha) {
  const head = shOut('git rev-parse HEAD').trim();
  if (tagSha !== head) {
    console.error(`[release] 错误：tag ${tag} 已存在但指向 ${tagSha}，而非当前 HEAD ${head}。`);
    console.error('[release] 请先提交本次代码并重跑，或手动删除/更新该 tag 后再发布。');
    process.exit(1);
  }
  console.log(`[release] tag ${tag} 已存在且指向当前 HEAD（幂等跳过）。`);
} else {
  sh(`git tag ${tag}`);
  console.log(`[release] git tag ${tag}`);
}

console.log(`[release] 完成：${out}`);
