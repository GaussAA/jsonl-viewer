# parser

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

Turns index ranges into parsed records on demand. Defines the `ByteReader` abstraction (random byte-range reads over a file handle or an in-memory Buffer), single-line JSON parsing with concise Chinese error messages, and the record readers built on `LineIndex.scan`. Cost is proportional to the rows requested, never to file size.

## Key Files

| File            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jsonParser.ts` | **Types:** `ByteReader` (`readBytes(start, length)`, optional `close`), `JsonParseResult`, `RecordResult` (`line` is actually the record number; `rawText` / `rawBytes` provided on `readRecord` and `readBatch`, used as the optimistic-lock basis for edits), `ReadRecordOpts`, `ReadBatchOpts` (`shouldCancel`), `LazyIndex`. **Parsing:** `parseJsonLine` (trims, rejects empty, extracts column from V8 message, strips the echoed source text via `friendlyJsonError`). **Reads:** `readLineAt`, `readLineBuffer` (no UTF-8 decode, `subarray` without copy, throws on range inversion or `maxLineBytes` overflow), `readRecord(recordNo, li, reader)` (aggregates physical lines of a multi-line record joined with `\n`), `readBatch(start, count, li, reader, opts)`, and the shared generator `scanRecords(from, to, li, reader, {maxLineBytes, shouldCancel})` yielding `{recordNo, text, buf, endOffset}` (the one place that groups lines into records; used by `readBatch`, `infer/inferFields`, `host/searchEngine`, `host/profileEngine`). `createLazyIndex` bundles index + reader. **Readers:** `MemoryReader` (Buffer-backed, throws `RangeError` out of bounds), `FileByteReader` (`fs.open` + positional read loop, `static open`), `openFileReader(path)`. |

## Subdirectories

| Directory    | Purpose                                          |
| ------------ | ------------------------------------------------ |
| `__tests__/` | `jsonParser.test.ts` (see `__tests__/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- Do not duplicate the line→record grouping elsewhere; extend `scanRecords` instead. `readRecord` has its own aggregation loop with the same join rule (`\n`), and `rawBytes` must stay consistent with `DataService.editRecord`'s aggregation for the optimistic lock to compare correctly.
- Over-long lines: `lineIndex.scan` yields an `error` item; `readRecord` converts it into `{ ok: false, error }`, while `scanRecords` drops the bytes for that line (a record that consisted only of an over-long line is yielded with empty text). Keep the `maxLineBytes` option flowing through.
- Keep parse error text short and free of source echo; webview shows it in narrow columns.
- `FileByteReader` keeps a single open `FileHandle`; callers (host) are responsible for `close()`. `readBytes` may return fewer bytes than asked at EOF.
- The module imports `LineIndex` as a value from `../indexer/lineIndex.ts` while the indexer imports only types from here; do not add a value import in the other direction.
- `readRecord` and `readBatch` each carry a stray doc comment above the real doc block (leftover from edits); harmless, but clean up if you reflow the file.

### Testing Requirements

- `node --experimental-transform-types --test src/parser/__tests__/jsonParser.test.ts`.
- Changes to `scanRecords` also affect `src/infer/__tests__`, `src/host/__tests__/searchEngine.test.ts`, `profileEngine.test.ts`, `multilineIndex.test.ts` and `multlineEdit.test.ts`; run them.

### Common Patterns

- Cancellation: `shouldCancel()` is checked per scanned line and returns early with the partial result, no exception.
- Invalid record number returns `{ ok: false, error: '无效记录号' }` instead of throwing.
- Buffers are sliced with `subarray` (zero copy) until text is needed.

## Dependencies

### Internal

- `../indexer/lineIndex.ts` (`LineIndex`), `../constants.ts` (`MAX_LINE_BYTES`).
- Imported by `infer/inferFields.ts`, `indexer/lineIndex.ts` (type), `host/dataService.ts`, `host/indexHost.ts`, `host/indexWorker.ts`, `host/searchEngine.ts`, `host/profileEngine.ts`, `host/exporter.ts`.

### External

- `node:fs/promises` (`FileHandle`, dynamic `open`), Node `Buffer`.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
