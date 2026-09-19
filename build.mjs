// esbuild build script.
// Produces:
//   - dist/extension.js  -> extension host main entry (ESM, `vscode` + `node:*` external)
//   - dist/webview.js    -> webview front-end bundle (IIFE for the sandboxed webview)
//
// Usage:
//   node build.mjs                 # full non-minified build (used by `pnpm compile`)
//   node build.mjs --minify        # minified, tree-shaken (used by `pnpm build`)
//   node build.mjs --watch         # watch mode (used by `pnpm watch`)
//
// Module system convention:
//   - Extension host (NodeJS 运行时)：ESM，对应 package.json 的 `"type": "module"`。
//     VS Code 从 1.100 (April 2025) 起正式支持 ESM 扩展入口，engines.vscode 已提升至 ^1.100.0。
//   - Webview (浏览器沙箱)：IIFE，通过 `<script>` 加载，不经过 Node 模块解析。
//     IIFE 是自包含的纯 JS 片段，与 Node ESM 是两个独立运行时，不属于"混用"。

import { build, context } from 'esbuild';
import { mkdir } from 'node:fs/promises';

const dev = process.argv.includes('--watch');
const minify = process.argv.includes('--minify') || false;

const common = {
  bundle: true,
  minify,
  sourcemap: !minify,
  target: ['es2022'],
  logLevel: 'info',
  legalComments: 'none',
  // 仅 minify 模式：标记 console.log/warn/info 为 pure，未用返回值则整体剔除；
  // 同时 drop debugger 语句。非 minify（开发）模式保留完整日志。
  ...(minify && {
    pure: ['console.log', 'console.warn', 'console.info'],
    drop: ['debugger'],
  }),
};

// Extension host：ESM，运行在 NodeJS 上，`vscode` 和 Node built-ins 由宿主提供。
const extensionExternals = { external: ['vscode', 'node:*'] };

// Webview：IIFE，运行在 webview 沙箱（浏览器），**没有** Node built-ins，
// 必须内联所有依赖（包括 esbuild 自身可能注入的 `node:*` shim）。
// 因此 webview bundle **不**设置 externals。

async function main() {
  await mkdir('dist', { recursive: true });

  if (dev) {
    // Watch 模式：extension 和 webview 必须拆成两个 context，
    // 因为 esbuild 不允许同一 context 的不同 entry 使用不同 format。
    const extCtx = await context({
      ...common,
      entryPoints: { extension: 'src/extension.ts' },
      outdir: 'dist',
      format: 'esm',
      platform: 'node',
      ...extensionExternals,
    });
    const webCtx = await context({
      ...common,
      entryPoints: { webview: 'src/webview/webviewEntry.ts' },
      outdir: 'dist',
      format: 'iife',
      platform: 'browser',
      globalName: 'JlvWebview',
    });
    await Promise.all([extCtx.watch(), webCtx.watch()]);
    console.log('[build] watching (extension ESM + webview IIFE)...');
    return;
  }

  // 1) Extension main entry -> ESM，never bundle the `vscode` module.
  await build({
    ...common,
    entryPoints: { extension: 'src/extension.ts' },
    outdir: 'dist',
    format: 'esm',
    platform: 'node',
    ...extensionExternals,
  });

  // 2) Webview front-end -> IIFE（runs inside the webview sandbox, no Node module system).
  await build({
    ...common,
    entryPoints: { webview: 'src/webview/webviewEntry.ts' },
    outdir: 'dist',
    format: 'iife',
    platform: 'browser',
    globalName: 'JlvWebview',
  });

  console.log('[build] done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});