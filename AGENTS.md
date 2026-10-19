# jsonl-viewer

**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

VS Code extension (`jsonl-viewer`, v1.10.x) that opens `.jsonl` / `.ndjson` / `.jsonlines` files as a paged record list plus a collapsible JSON tree detail view. Built for multi-GB files: a sparse checkpoint line index is built in one streaming pass, rows are read back by byte range on demand, and memory scales with the visible window rather than file size. It also supports in-place editing (single-line edit/insert/delete, batch delete, find/replace, field replace) with session undo history, export, bad-line diagnostics, full-file profiling, and tail-follow for growing files.

Most source comments and docs are written in Chinese; keep new comments in the same language as the surrounding code.

## Key Files

| File                              | Description                                                                                                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`                    | Manifest: commands, custom editor (`jsonlViewer.customEditor`, default for `*.jsonl`), settings (`jsonlViewer.sampleLines`, `jsonlViewer.debug`), scripts. `version` is the single source of truth for releases |
| `build.mjs`                       | esbuild script producing three bundles: `dist/extension.js` (ESM, node), `dist/webview.js` (IIFE, browser, global `JlvWebview`), `dist/indexWorker.js` (ESM, worker_threads)                                    |
| `tsconfig.json`                   | Type-check only (`noEmit`), strict, `allowImportingTsExtensions`, `lib: ES2023 + DOM`, `types: ["node"]` (TS 7 needs it explicit)                                                                               |
| `.oxlintrc.json`                  | oxlint config: correctness = error; `no-explicit-any` = error; unused vars allowed only with `_` prefix                                                                                                         |
| `.prettierrc.json`                | printWidth 100, single quotes, semicolons, trailingComma es5, LF                                                                                                                                                |
| `.vscodeignore`                   | VSIX allowlist. Only `dist/extension.js`, `dist/webview.js`, `dist/indexWorker.js` ship; any new runtime bundle must be un-ignored here                                                                         |
| `pnpm-workspace.yaml`             | pnpm settings (allowed build scripts for esbuild / vsce-sign)                                                                                                                                                   |
| `README.md`                       | User-facing overview, performance design, dev commands, release conventions (Chinese)                                                                                                                           |
| `RELEASE.md`                      | VSIX packaging and Marketplace publishing procedure                                                                                                                                                             |
| `harness.html` / `prototype.html` | Dev-time debug harness and UI prototype; not loaded at runtime, not formatted by Prettier, excluded from VSIX                                                                                                   |
| `.gitignore`                      | Note: `samples/`, `releases/`, `.scratch/` are ignored. Put temporary output in `.scratch/` (Prettier reads `.gitignore`; stray temp files break `format:check`)                                                |

## Subdirectories

| Directory  | Purpose                                                                                 |
| ---------- | --------------------------------------------------------------------------------------- |
| `src/`     | All TypeScript source and unit tests (see `src/AGENTS.md`)                              |
| `docs/`    | Design system, architecture/code reviews, audits, error ledger (see `docs/AGENTS.md`)   |
| `scripts/` | Release, install, integration-test and stability/perf scripts (see `scripts/AGENTS.md`) |
| `samples/` | Sample JSONL fixtures + generator; git-ignored (see `samples/AGENTS.md`)                |
| `media/`   | Extension icon (see `media/AGENTS.md`)                                                  |
| `.github/` | CI and release workflows (see `.github/AGENTS.md`)                                      |
| `.husky/`  | Git hooks: pre-commit lint/format, pre-push typecheck/test (see `.husky/AGENTS.md`)     |
| `.vscode/` | F5 launch config and compile task (see `.vscode/AGENTS.md`)                             |

## For AI Agents

### Working In This Directory

- Use pnpm only (`packageManager: pnpm@12.x`). Do not use npm/yarn or commit a `package-lock.json`.
- Requires Node >= 22.18 (tests run `.ts` directly via type stripping) and VS Code >= 1.100 (ESM extension entry).
- Import local modules with explicit `.ts` extensions (e.g. `./host/dataService.ts`).
- Do not use TypeScript constructor parameter properties (`constructor(private x)`) or other non-erasable syntax (enums, namespaces); assign fields in the constructor body instead.
- Never load a whole file into memory or go through `TextDocument`/`getText()`. All reads go through `DataService` → `LineIndex` byte-range reads.
- Tunable limits live in `src/constants.ts`. Add new magic numbers there with a comment explaining the bound, not inline.
- Every list/result has a hard cap (search/filter 50k, selection 5k, export 50k, history 50 entries/16MB). New features must be bounded too and must report truncation explicitly, never silently.
- Webview → host messages are untrusted input: validate size, shape and keys in the host before acting.
- Front-end changes must follow `docs/DESIGN_SYSTEM.md` (tokens, components, motion, checklist).
- `@types/vscode` must not exceed `engines.vscode`; CI runs `vsce ls` to catch this.
- Adding a new `dist/` runtime file requires an entry in both `build.mjs` and `.vscodeignore`.

### Testing Requirements

- `pnpm typecheck` — `tsc --noEmit`
- `pnpm test` — `node --experimental-transform-types --test "src/**/*.test.ts"`
- `pnpm test:coverage:gate` — CI gate: lines 96 / branches 86 / functions 88 (enforced on Node 22). New code needs tests to keep the gate green.
- `pnpm lint` and `pnpm format:check` — also run by the pre-commit hook.
- `pnpm compile && pnpm test:integration` — real VS Code Extension Host smoke test (CI runs 3 OS × {1.100.0, stable, insiders}).
- pre-push hook runs actionlint (if available), typecheck and unit tests.

### Common Patterns

- Long-running host operations accept `shouldCancel()` and `onProgress()` callbacks; the host strips cancel flags in `finally` so the cancel set stays bounded.
- Responses are correlated by `requestId`; stale/late responses are dropped on the webview side.
- Business failures return structured result objects (`{ ok: false, error }`); only unexpected exceptions become `ERROR` replies.
- Writes are immediate-to-disk and recorded in a host-side history cursor; VS Code undo/redo delegates to that same cursor.
- Comments explain _why_ a limit or guard exists, often referencing an incident in `docs/error_ledger.md`.

## Dependencies

### External

- `vscode` API (^1.100) — extension host, custom editor, webview
- `esbuild` — bundling
- `typescript` 7 — type checking only (no emit)
- `oxlint`, `prettier` — lint and format
- `jsdom` — DOM harness for webview unit tests
- `@vscode/test-electron` — integration tests; `@vscode/vsce` — packaging
- `husky` — git hooks
- No runtime npm dependencies: bundles contain only project code.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
