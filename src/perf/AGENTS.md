# perf

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

Container directory with no source modules. It only holds `__tests__/bigFilePerf.test.ts`, a mid-size benchmark and stability test for the index/read path. Larger stress and stability scripts live under `scripts/`, not here.

## Subdirectories

| Directory    | Purpose                                                                |
| ------------ | ---------------------------------------------------------------------- |
| `__tests__/` | Big-file index and random-access benchmark (see `__tests__/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- Do not add production code here. New perf checks go in `__tests__/` and must not assert on wall-clock numbers (they are printed with `console.log`).

### Testing Requirements

- Included in `pnpm test` through the `src/**/*.test.ts` glob, so it must stay fast at default size (about 30MB).

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
