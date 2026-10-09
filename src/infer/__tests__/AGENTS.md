# **tests**

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

Tests for `inferFields`: sampling window, type statistics, ordering, pseudo-fields and sample truncation.

## Key Files

| File                  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inferFields.test.ts` | `fieldTypeOf` mapping for every type; first-N sampling (300 lines, `sampleLines: 100`, a late-only field must not appear, `scanned`/`total` equal 100); bad and blank lines excluded from fields and reported in `errorLines` (blank lines are not records under record grouping); mixed-type counts, dominant type and `alwaysObject` / `alwaysArray`; frequency-desc then name ordering; array and scalar records producing `$array` / `$value`; empty file; sample truncation for large objects and structure preserved for small ones; **O5** regression that sampling is one sequential scan with no repeated reads of the same range. |

## For AI Agents

### Working In This Directory

- Local helper `inferFromString(s, opts)`: `Buffer.from(s)` → `LineIndex.build([buf])` → `new MemoryReader(buf)` → `inferFields(reader, li, opts)`. Use it for new cases instead of touching the filesystem.
- For read-amplification style assertions, wrap the reader and count `readBytes` calls (see the O5 test for the pattern).

### Testing Requirements

- `node --experimental-transform-types --test src/infer/__tests__/inferFields.test.ts`.
- Tests depend on `LineIndex` and `MemoryReader`; a failure here may originate in `src/indexer` or `src/parser`, so run their suites too.

### Common Patterns

- Existence checks on field lists use a `Set` of keys (lint prefers it); lookups use `fields.find(f => f.key === ...)!`.
- Test names and comments are Chinese.

## Dependencies

### Internal

- `../inferFields.ts`, `../../indexer/lineIndex.ts`, `../../parser/jsonParser.ts` (`MemoryReader`).

### External

- `node:test`, `node:assert/strict`.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
