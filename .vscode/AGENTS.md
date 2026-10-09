# .vscode

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

Workspace config for developing the extension in VS Code: press F5 to open an Extension Development Host with the freshly compiled bundles. Both files are tracked in git; the directory is excluded from the VSIX via `.vscodeignore`.

## Key Files

| File          | Description                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launch.json` | One configuration, `Run Extension` (`type: extensionHost`, `request: launch`). Args: `--extensionDevelopmentPath=${workspaceFolder}`. `outFiles` is `dist/**/*.js` for source maps. `preLaunchTask` is `compile`, so F5 always rebuilds first                             |
| `tasks.json`  | One task: `type: npm`, `script: compile` (runs `node build.mjs`, the unminified esbuild build). Marked as the default build task (`Ctrl+Shift+B`). Its `problemMatcher` is a custom `typescript`-owner matcher with the regexp `^([^\s].*)\((\d+),(\d+)\): (error) (.*)$` |

## For AI Agents

### Working In This Directory

- The `preLaunchTask` label `compile` must match the npm script name `compile` in `package.json`. Rename both together.
- `compile` only bundles with esbuild; it does not type-check. Run `pnpm typecheck` separately.
- If you add a new `dist/` runtime bundle, F5 picks it up through `build.mjs`. Nothing here needs to change, but `.vscodeignore` does (see root `AGENTS.md`).
- The `problemMatcher` pattern has no `file`/`line`/`column`/`message` capture mappings. I did not verify whether it surfaces problems in the Problems panel; check before relying on it.

### Testing Requirements

- Manual: press F5, open a `.jsonl` file in the Development Host, and confirm the custom editor loads.
- Automated Extension Host coverage is `pnpm compile && pnpm test:integration` (see `../scripts/AGENTS.md`), which does not use this launch config.

## Dependencies

### Internal

- `package.json` script `compile` → `build.mjs` → `dist/*.js`.

### External

- VS Code `extensionHost` debugger.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
