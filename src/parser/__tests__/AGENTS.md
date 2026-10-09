# **tests**

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

Tests for `parser/jsonParser.ts`: line parsing and error text, line/record reading through the index, batch reading and cancellation, and both `ByteReader` implementations.

## Key Files

| File                 | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jsonParser.test.ts` | `parseJsonLine` (object/array/scalar/whitespace OK; invalid input yields `error`, `column >= 1`, `line === 1`; error text is short and does not echo the source such as `NaN`; empty line rejected). `readLineAt` (strips `\n` and `\r\n`, over-long line rejected by `maxLineBytes`). `createLazyIndex` + `readRecord` (single record on demand). `readBatch` (batch results, `count <= 0` or negative start returns `[]`, `shouldCancel` stops early including partial results). `FileByteReader` / `openFileReader` against a real temp file with CRLF. `readRecord` invalid numbers (negative / out of range) return `ok: false` without throwing. `MemoryReader` throws `RangeError` on out-of-range or negative arguments. |

## For AI Agents

### Working In This Directory

- Memory-backed cases: `Buffer.from(text)` → `LineIndex.build([buf])` → `new MemoryReader(buf)`.
- File-backed cases create a directory with `mkdtemp(join(tmpdir(), ...))`, `writeFile`, open via `openFileReader`, and always `close()` the reader and `rm(dir, { recursive: true, force: true })` in `finally`.
- Multi-line record behavior (pretty JSON) is mostly covered in `src/host/__tests__/multilineIndex.test.ts` and `src/indexer/__tests__/lineIndex.test.ts`, not here.

### Testing Requirements

- `node --experimental-transform-types --test src/parser/__tests__/jsonParser.test.ts`.
- Leaked temp directories or open handles make later runs flaky (and Windows cannot delete open files); keep cleanup in `finally`.

### Common Patterns

- Result unions are narrowed with `if (!r.ok)` inside the test body so TypeScript accepts field access.
- Test names and comments are Chinese.

## Dependencies

### Internal

- `../jsonParser.ts`, `../../indexer/lineIndex.ts`.

### External

- `node:test`, `node:assert/strict`, `node:fs/promises`, `node:os`, `node:path`.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
