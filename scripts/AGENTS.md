# scripts

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

Release packaging, local install, VS Code integration-test runner, and two one-off probe scripts used for audits. None of this ships in the VSIX (`scripts/**` is in `.vscodeignore`). `.ts` files are executed directly by Node >= 22.18 (type stripping) and are linted by `pnpm lint` (`oxlint src scripts build.mjs`) and formatted by Prettier.

## Key Files

| File                     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `release.mjs`            | One-command release (`pnpm release` / `pnpm vsix`, or `node scripts/release.mjs [version]`). Order: verify requested version equals `package.json` version → pre-check that `@types/vscode` base version is not above `engines.vscode` (pure manifest comparison, no subprocess) → refuse if `releases/jsonl-viewer-<v>.vsix` already exists → `pnpm typecheck && pnpm test && pnpm build` (with `JLV_DIST_PRODUCT=1` so dist-guard tests run) → `npx vsce package --out releases/...` → write `.sha256` (sha256sum format) and `releases/LATEST` → warn on dirty tree → `git tag v<version>`. Idempotent on tag if it already points at HEAD; exits if it points elsewhere. Shell commands retry up to 3x on `EBUSY`; git calls use `execFileSync` without a shell on purpose (see `docs/error_ledger.md`) |
| `test-integration.mjs`   | Outer runner for `pnpm test:integration` / `pnpm integration`. Calls `@vscode/test-electron` `runTests` with `--disable-extensions`, version from `VSCODE_TEST_VERSION` (`stable` default, `1.100.0`, `insiders`). Deletes `ELECTRON_RUN_AS_NODE` first, otherwise `Code.exe` behaves as Node and rejects every flag with `bad option` when run from a VS Code terminal                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `integration-runner.mjs` | Runs inside the Extension Host (loaded via `--extensionTestsPath`). Must export `run()`; must not call `process.exit`. Asserts: extension `jsonl-viewer.jsonl-viewer` is found, `activate()` succeeds, `isActive === true`. Requires `dist/` to be built (`pnpm compile`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `install.cmd`            | Windows-only. Installs `releases/jsonl-viewer-<ver>.vsix` (arg, or version in `releases/LATEST`) into TRAE SOLO CN via `%LOCALAPPDATA%\Programs\TRAE SOLO CN\bin\trae-solo-cn.cmd`, then patches the installed `package.json` under `%USERPROFILE%\.trae-cn\extensions\` replacing the invalid `"targetPlatform": "undefined"` with `win32-x64` (TRAE installer defect). Close TRAE before running                                                                                                                                                                                                                                                                                                                                                                                                          |
| `audit-stability.ts`     | One-off probe (`node scripts/audit-stability.ts`), not a delivered test. Builds temp files under the OS temp dir (`jlv-audit-*`) and checks graceful degradation for: missing worker script, empty/newline-only files, UTF-8 BOM, deeply nested JSON, out-of-range args, huge `readRecords` counts, use after dispose, file deleted after indexing, GBK encoding, unreadable file. Prints ✅/❌; exit 0/1 (2 on crash). Evidence source for `docs/STABILITY_AUDIT.md`                                                                                                                                                                                                                                                                                                                                       |
| `validate-300mb.ts`      | One-off large-file validation (`node scripts/validate-300mb.ts`). Requires `samples/big-300mb.jsonl` (~315MB), which is **not** produced by `samples/generate_samples.py` and is not in the repo, so the script fails with an fs error unless you supply that file. Checks index build time/memory, `readRecord`/`readBatch`/`searchLines` against brute-force results, and list-summary contract incl. oversized-line truncation. Writes and removes a temp file for the long-line case. Exit 0/1 (2 on crash)                                                                                                                                                                                                                                                                                             |

## For AI Agents

### Working In This Directory

- Releases: bump `package.json` `version` first (single source of truth), commit, then `pnpm release`. The script tags HEAD, so a dirty tree gives a tag that does not match the artifact. It does not push the tag and does not publish; pushing a `v*` tag triggers `.github/workflows/release.yml`.
- Side effects of `release.mjs`: creates `releases/` (git-ignored) with `.vsix`, `.vsix.sha256`, `LATEST`; creates a local git tag; runs a production build into `dist/`. To redo a release, delete the existing `.vsix` first.
- Side effects of `test-integration.mjs`: downloads VS Code into `<repo>/.vscode-test/` (git-ignored, cached; CI caches it) and launches a real Electron window (Linux CI needs `xvfb-run`).
- `install.cmd` only makes sense for the author's TRAE setup on Windows; do not generalise it.
- Keep scripts ESM (`type: module`), use explicit `.ts` import extensions for source imports, and keep git invocations shell-free.
- Probe scripts import from `../src/**`; if you rename host/parser modules, update them (they are covered by typecheck and lint, not by `pnpm test`).

### Testing Requirements

- `pnpm typecheck` and `pnpm lint` cover these files. There are no unit tests for the scripts themselves.
- After editing `test-integration.mjs` or `integration-runner.mjs`: `pnpm compile && pnpm test:integration` (needs network on first run).
- After editing `release.mjs`: dry-run reasoning only; a real run mutates `releases/` and git tags, so do not run it without the user asking.

### Common Patterns

- Comments are Chinese and explain the incident behind each guard (EBUSY retry, shell-free git, pre-check ordering), mostly referencing `docs/error_ledger.md`.
- Console output is prefixed (`[release]`, `[test:integration]`, `[integration]`, `[install]`, `[validate]`).

## Dependencies

### Internal

- `../package.json` (scripts, version, `engines`), `../src/host/*`, `../src/parser/jsonParser.ts`, `../src/indexer/lineIndex.ts` (probes), `../dist/extension.js` (integration), `../releases/` (output).

### External

- `@vscode/test-electron`, `@vscode/vsce` (via `npx`), `git`, Node built-ins; `powershell` and the TRAE CLI for `install.cmd`.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
