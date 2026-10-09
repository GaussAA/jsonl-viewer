# infer

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

Top-level field inference from a sample of the first N records (default `SAMPLE_SCAN_LINES` = 200, overridable by `jsonlViewer.sampleLines`). It never touches the rest of the file. Its output feeds the summary cards, column layout, and filter field pickers in the webview, and is exposed through `getSampleFields`.

## Key Files

| File             | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inferFields.ts` | `inferFields(reader, li, { sampleLines, sampleMaxLen = 120 })` → `{ fields, total, scanned, errorLines }`. Uses one sequential `scanRecords(0, scanned, li, reader)` pass (not per-line `readRecord`, which caused read amplification, see O5), parses each record with `parseJsonLine`, skips bad/empty records into `errorLines`. Object records contribute top-level keys; array records contribute the `$array` pseudo-field; scalar records the `$value` pseudo-field. Each `FieldInfo`: `key`, dominant `type` (ties resolved object > array > string > number > boolean > null > undefined), `freq`, truncated `sample`, `coverage` (`freq/total`), `alwaysObject`, `alwaysArray`, per-type `types` counts. Sorted by `freq` desc, then key asc. Also exports `fieldTypeOf`, `captureSample`, `ARRAY_RECORD_KEY`, `SCALAR_RECORD_KEY`, types `FieldType`, `FieldInfo`, `InferFieldsOpts`, `InferFieldsResult`. |

## Subdirectories

| Directory    | Purpose                                           |
| ------------ | ------------------------------------------------- |
| `__tests__/` | `inferFields.test.ts` (see `__tests__/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- Keep the work bounded by `sampleLines`; do not add full-file passes. Memory must stay proportional to the number of distinct top-level keys (one `Entry` per key with a single truncated sample).
- `errorLines` holds record numbers (`rec.recordNo`), and blank lines are not records in multi-line grouping, so they do not appear there.
- `fieldTypeOf` and the pseudo-field keys are duplicated in `core/query.ts` (type `LocalFieldType`). If you add a type or rename a key, change both. `protocol/rpc.ts` imports the type `FieldInfo` from here for `SampleFieldsPayload`.
- `captureSample` must always return something JSON-serialisable and bounded (it truncates with a trailing `…`).
- The file is imported by `host/dataService.ts`; `protocol/rpc.ts` imports it type-only, so do not add node-only runtime dependencies that would leak into the webview through that edge (the edge is erased at runtime, but keep it type-only).

### Testing Requirements

- `node --experimental-transform-types --test src/infer/__tests__/inferFields.test.ts`.
- Behavior changes to sorting, dominant type or coverage need updated expectations in the test file.

### Common Patterns

- Input is `(reader: ByteReader, li: LineIndex)` so tests can pass `MemoryReader` and a `LineIndex` built from a Buffer.
- Sorting uses `toSorted`; avoid in-place mutation of the map values.

## Dependencies

### Internal

- `../indexer/lineIndex.ts` (type), `../parser/jsonParser.ts` (`parseJsonLine`, `scanRecords`, type `ByteReader`), `../constants.ts` (`SAMPLE_SCAN_LINES`).
- Consumed by `host/dataService.ts` and, type-only, `protocol/rpc.ts`.

### External

- None.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
