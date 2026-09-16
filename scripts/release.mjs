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
const sh = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });
const rel = join(root, 'releases');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = String(process.argv[2] || pkg.version).replace(/^v/, '');
const out = join(rel, `jsonl-viewer-${version}.vsix`);

if (pkg.version !== version) {
  console.error(`[release] 版本不一致：package.json=${pkg.version}，请求=${version}。`);
  console.error('[release] 请先修改 package.json 的 version，再运行本脚本（版本单一事实来源）。');
  process.exit(1);
}

mkdirSync(rel, { recursive: true });
if (existsSync(out)) {
  console.error(`[release] 已存在 ${out}；如需重发请先删除该文件后再运行。`);
  process.exit(1);
}

console.log(`[release] v${version}  typecheck+build ...`);
sh('pnpm typecheck && pnpm build');

console.log(`[release] vsce package -> releases/ ...`);
sh(`npx vsce package --out "${out}"`);

const buf = readFileSync(out);
const sha = createHash('sha256').update(buf).digest('hex');
writeFileSync(`${out}.sha256`, `${sha}  ${buf.length} bytes  jsonl-viewer-${version}.vsix\n`);
writeFileSync(join(rel, 'LATEST'), `${version}\n`);
console.log(`[release] SHA-256 = ${sha}`);
console.log(`[release] LATEST  -> ${version}`);

const dirty = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' }).trim();
if (dirty) {
  console.warn('[release] 提示：工作区有未提交改动，建议先 commit 再继续，否则 tag 不会指向本次代码。');
}
try {
  sh(`git tag v${version}`);
  console.log(`[release] git tag v${version}`);
} catch {
  console.log('[release] tag 创建失败或已存在（忽略）。');
}

console.log(`[release] 完成：${out}`);