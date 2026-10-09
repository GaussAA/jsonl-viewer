# **tests**

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

Benchmark-style tests for the large-file path: index build time and memory, random-access correctness, and stability guarantees (cancellation, over-long lines). Metrics are printed, not asserted, to avoid machine-dependent flakiness.

## Key Files

| File                  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bigFilePerf.test.ts` | Four tests. (1) Writes `JSONL_PERF_LINES` (default 60,000) lines of about 0.5KB to a temp file via a backpressure-aware `createWriteStream`, builds `LineIndex` from `createReadStream`, logs `[perf/JSONL]` line with build ms, checkpoint count, estimated index size (about 16B per checkpoint) and heap delta, then verifies `readBatch` windows at several offsets (`id` and `name` match). (2) `readBatch` stops when `shouldCancel` flips, and returns `[]` if cancelled from the start. (3) `readRecord` with `maxLineBytes: 1024` on a 4KB line returns `ok: false` with a "too large/exceeds" error. (4) `searchLines` from `host/searchEngine.ts` (dynamic import) stops scanning when `shouldCancel` trips. |

## For AI Agents

### Working In This Directory

- Scale up for real multi-GB runs: `JSONL_PERF_LINES=5000000 node --experimental-transform-types --test src/perf/__tests__/bigFilePerf.test.ts` (about 2.5GB; do not do this in CI).
- Temp data goes to `os.tmpdir()/jsonl-perf-*` and is removed in `finally`; keep that cleanup if you edit the test. Do not write into the repo.
- Generate data by streaming (`writeLines`), never by building one giant string.

### Testing Requirements

- Single file: `node --experimental-transform-types --test src/perf/__tests__/bigFilePerf.test.ts`.
- Only correctness is asserted (line counts, record contents, cancellation). Keep timing and memory as logged output only.

### Common Patterns

- In-memory cases use `LineIndex.build([buf])` with `MemoryReader`; file-backed case uses `openFileReader` and closes it in `finally`.
- The `searchLines` test imports `host/searchEngine.ts` lazily, which makes this one of the few places a `src/*/__tests__` file crosses into `host/`.

## Dependencies

### Internal

- `../../indexer/lineIndex.ts`, `../../parser/jsonParser.ts`, `../../host/searchEngine.ts` (dynamic).

### External

- `node:test`, `node:assert/strict`, `node:fs`, `node:fs/promises`, `node:os`, `node:path`.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
