# workflows

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

CI merge gate and Marketplace release pipeline. Header comments in both files are the authoritative explanation of each pitfall; read them before editing.

## Key Files

| File          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`      | Name `CI`. Triggers: `push` to `main`, and every `pull_request`. Jobs: `verify` (ubuntu, Node 22 and 24 matrix: install `--frozen-lockfile` → `pnpm typecheck` → `pnpm test` → `pnpm build` → `pnpm exec vsce ls --no-dependencies`); `lint` (actionlint via pinned `docker://rhysd/actionlint:1.7.12`, then `pnpm lint`, `pnpm format:check`, Node 22); `coverage` (`needs: verify`, Node 22 only, `pnpm test:coverage:gate`); `integration-test` (`needs: verify`, `fail-fast: false`, 3 OS × VS Code `1.100.0` / `stable` / `insiders` = 9 jobs, `pnpm compile`, caches `.vscode-test`, installs xvfb on Linux and runs `xvfb-run -a pnpm test:integration`, passes `VSCODE_TEST_VERSION`) |
| `release.yml` | Name `Release`. Triggers: push of tags `v*`, and manual `workflow_dispatch` with boolean input `publish` (default false). Single job `publish` (ubuntu, Node 22): install → typecheck → test → `pnpm build` → `npx @vscode/vsce package` → upload `*.vsix` as artifact `vsix` → `npx @vscode/vsce publish` only when `env.VSCE_PAT != '' && (github.event_name == 'push'                                                                                                                                                                                                                                                                                                                      |     | inputs.publish)`. Needs repository secret `VSCE_PAT` (Azure DevOps PAT with Marketplace → Manage) |

## For AI Agents

### Working In This Directory

Documented pitfalls (each caused real failures; see the file headers, `docs/MAINTENANCE_AUDIT.md` §2.6 and `docs/error_ledger.md`):

- `pnpm/action-setup@v4`: the `cache` input is a **boolean**. Use `cache: true`; `cache: 'pnpm'` (v2/v3 style) throws in `getBooleanInput` and fails the "Setup pnpm" step. CI was red from 2026-09-19 until this was fixed.
- **Do not pin a pnpm `version`** in the workflow. `package.json` `packageManager` is the single source (`release.yml` once drifted at 12.4.2). Do not give `actions/setup-node` a pnpm `cache:` either; the two actions must not overlap ("Multiple versions of pnpm specified").
- The `secrets` context is **not allowed in `if:`** at step level. Map the secret to job-level `env` (`VSCE_PAT: ${{ secrets.VSCE_PAT }}`) and test `env.VSCE_PAT` instead. The original `if: secrets.X != ''` invalidated the whole workflow and produced a job-less failed run on every push.
- Coverage thresholds are enforced on **Node 22 only**: Node 24 changes the "all files" denominator, so shared thresholds misfire. Keep `coverage` pinned to 22 and keep thresholds in sync with `package.json` `test:coverage:gate`.
- Keep the actionlint image version pinned; do not curl a `main`-branch install script.
- Publishing is irreversible, so manual dispatch builds but does not publish unless `publish` is ticked. Keep that default.
- Keep matrix versions and `engines.vscode` aligned: the `1.100.0` entry is the engine floor.
- `integration-test` depends on `scripts/test-integration.mjs`; changing its env contract (`VSCODE_TEST_VERSION`) means editing `ci.yml` too.

### Testing Requirements

- Run actionlint locally before pushing (pre-push does it automatically if `actionlint` is on PATH or in `.scratch/bin/`). The install is the only practical test for workflows; real validation happens on GitHub.
- Never trigger a release by pushing a `v*` tag as a test; that attempts a Marketplace publish when `VSCE_PAT` is set.

### Common Patterns

- Steps are named, with Chinese comments giving the reason for each non-obvious choice. Every job runs `pnpm install --frozen-lockfile`.

## Dependencies

### Internal

- `../../package.json` (scripts, `packageManager`, `engines`), `../../scripts/test-integration.mjs`, `../../.husky/pre-push` (local actionlint).

### External

- `actions/checkout@v4`, `actions/setup-node@v4`, `pnpm/action-setup@v4`, `actions/cache@v4`, `actions/upload-artifact@v4`, `rhysd/actionlint:1.7.12`, `@vscode/vsce`.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
