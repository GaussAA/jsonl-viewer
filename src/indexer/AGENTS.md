# indexer

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

Owns `LineIndex`, the sparse checkpoint index that makes multi-GB files openable. One streaming pass records a `{line, offset}` checkpoint every `INDEX_CHECKPOINT_INTERVAL` (1024) lines, plus bracket-aware record grouping for pretty-printed/multi-line files. Reads then seek to the nearest checkpoint and scan forward. The class is immutable: edits and tail-follow produce new instances through incremental update methods, so the main-thread index and the worker-thread index can be kept on identical checkpoints by replaying the same op list.

## Key Files

| File           | Description                                                       |
| -------------- | ----------------------------------------------------------------- |
| `lineIndex.ts` | `LineIndex` class and helpers. **Build:** `LineIndex.build(stream | async/sync iterable of Buffer | string, opts)`(not a path), tracks`depth`/`inString`/`escaped`across chunks to derive record boundaries; compact files (one record per line, no blank lines) store no grouping arrays and`multiline`is false (record number == line number). **Read:**`totalRecords`, `recordRange(no)`, `recordNoByStartLine`, `offsetAtLine`(returns the checkpoint anchor, not the exact offset), async generator`scan(reader, fromLine, toLine, {maxLineBytes})`yielding`ScannedLine` (`bytes`with line ending stripped; over-long lines yield`error`with empty`bytes`but still consume exactly one line number),`resolveRange`. **Incremental updates (all return new instances):** `applyLineReplace`, `applyLineInsert`, `applyLineDelete`, `applyLineDeltas`(batch replace in one pass),`appendTail(tail: Buffer)`(tail-follow; rejects with`incomplete-index`/`multiline`/`open-tail`/`not-compact`, only absorbs up to the last `\n`). **Cross-thread op model:** `IndexDeltaOp` (`replace`/`insert`/`delete`/`append`), `applyIndexOps(li, ops)` (order-sensitive; all-`replace`batches take the`applyLineDeltas`fast path),`tailAppendOp(prev, next)`. Also exports `LineRange`, `RecordRange`, `ScannedLine`, `LineIndexStats`, `TailAppendResult`. |

## Subdirectories

| Directory    | Purpose                                         |
| ------------ | ----------------------------------------------- |
| `__tests__/` | `lineIndex.test.ts` (see `__tests__/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- Build and scan must count lines identically. `build` counts real `\n`; `scan` therefore must never split an over-long line into several line numbers (incident O16). If you touch the skip-state logic in `scan`, re-run the O16 tests.
- Edits that change line count/bytes must update both `checkpoints` and, where relevant, `totalBytes`/`totalLines`. Insert/delete drop `recordEndLines`/`recordEndOffsets` (derived instances are always treated as non-multiline); the callers in `host/` only mutate compact files in this way.
- `applyLineInsert(0)` must re-add the `{line:0, offset:0}` anchor, and insert into an empty file must create one. Missing anchors make `scan` silently return nothing.
- The index is mirrored in `host/indexHost.ts` / `host/indexWorker.ts` and `host/dataService.ts`. Any new mutation must be expressed as an `IndexDeltaOp` handled by `applyIndexOps`, not as separate loops on each side. `host/workerProtocol.ts` imports `IndexDeltaOp` for the worker messages.
- `LineIndexOpts.chunkSize` is declared and passed by callers but `build` does not read it (chunking is decided by the input stream), and the `reportInterval` default is a literal 4MB rather than `INDEX_REPORT_INTERVAL`. Treat both as cosmetic until fixed.
- `import type { ByteReader }` from `../parser/jsonParser.ts` must stay type-only (the parser imports `LineIndex` as a value).
- Hot loop in `build` is byte-level over Buffers; avoid allocations per byte or per line.

### Testing Requirements

- Every mutation method must be proven equivalent to rebuilding the index from the edited text (see "与重建索引完全一致" tests). Add the same style of test for new ops.
- `node --experimental-transform-types --test src/indexer/__tests__/lineIndex.test.ts`.
- Perf sanity: `src/perf/__tests__/bigFilePerf.test.ts` (scale with `JSONL_PERF_LINES`).

### Common Patterns

- Immutability: methods return `this` when nothing changes (delta 0, empty ops) so callers can compare identity.
- Out-of-range and non-integer arguments throw `RangeError` / `TypeError` rather than clamping.
- Multi-line state is represented as `recordEndLines` / `recordEndOffsets`; consumers use `totalRecords` / `recordRange`, not `totalLines`, for record-level work.

## Dependencies

### Internal

- `../constants.ts` (`INDEX_CHECKPOINT_INTERVAL`, `SCAN_CHUNK_SIZE`, `MAX_LINE_BYTES`), `../parser/jsonParser.ts` (type `ByteReader`).
- Imported by: `parser/jsonParser.ts` (value), `infer/inferFields.ts`, `host/dataService.ts`, `host/indexHost.ts`, `host/indexWorker.ts`, `host/workerProtocol.ts`, `host/searchEngine.ts`, `host/profileEngine.ts`, `host/exporter.ts`.

### External

- Node `Buffer`, `performance`; no packages.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
