// esbuild build script.
// Produces:
//   - dist/extension.js  -> extension host main entry (CommonJS, `vscode` external)
//   - dist/webview.js    -> webview front-end bundle (IIFE for the sandboxed webview)
//
// Usage:
//   node build.mjs                 # full non-minified build (used by `pnpm compile`)
//   node build.mjs --minify        # minified, tree-shaken (used by `pnpm build`)
//   node build.mjs --watch         # watch mode (used by `pnpm watch`)

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
};

// Extension host runs in Node; leave `vscode` and Node built-ins as externals.
const nodeExternals = { external: ['vscode', 'node:*'] };

async function main() {
  await mkdir('dist', { recursive: true });

  if (dev) {
    const ctx = await context({
      ...common,
      entryPoints: {
        extension: 'src/extension.ts',
        webview: 'src/webview/webviewEntry.ts',
      },
      outdir: 'dist',
      format: 'cjs',
      ...nodeExternals,
      // The host entry must be CommonJS: VS Code loads it via require().
      // webview.ts is bundled here too but is loaded through a <script> in an
      // IIFE form; to keep this watch build simple we emit both as CJS (the
      // webview file still works, though non-minified) on watch.
      plugins: [],
    });
    await ctx.watch();
    console.log('[build] watching for changes...');
    return;
  }

  // 1) Extension main entry -> CommonJS, never bundle the `vscode` module.
  await build({
    ...common,
    entryPoints: { extension: 'src/extension.ts' },
    outdir: 'dist',
    format: 'cjs',
    ...nodeExternals,
  });

  // 2) Webview front-end -> IIFE (runs inside the webview sandbox, no CommonJS).
  await build({
    ...common,
    entryPoints: { webview: 'src/webview/webviewEntry.ts' },
    outdir: 'dist',
    format: 'iife',
  });

  console.log('[build] done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});