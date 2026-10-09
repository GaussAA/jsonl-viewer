# **tests**

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

Tests for `LineIndex` (build, scan, record grouping, incremental updates, tail-follow). All in-memory: inputs are strings fed through tiny chunks into `LineIndex.build` and read back through `MemoryReader`.

## Key Files

| File                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lineIndex.test.ts` | Single large suite, ordered roughly as: build/scan basics (counts, no trailing newline, blank lines, empty file, `\r\n`, bad JSON lines, chunk-boundary `\n`, checkpoint sparsity and the `{0,0}` first anchor, `offsetAtLine` anchor semantics, `resolveRange`, scan vs naive split, per-call `maxLineBytes`, stats) → `applyLineReplace` / `applyLineInsert` / `applyLineDelete` (each checked against a rebuilt index; first/last line, empty file, line 0 anchor, multi-checkpoint cases, bounds errors) → `recordRange` / `recordNoByStartLine` (pretty multi-line records, compact fast path, braces/newlines inside strings, blank lines, dangling record at EOF, extra `}` clamping, scalar records) → `applyIndexOps` (empty ops identity, ordered replace/insert/delete, order sensitivity, two instances staying aligned) → `applyLineDeltas` (equivalent to repeated `applyLineReplace`, fast-path parity) → **O16** over-long line occupies exactly one line number (also at EOF, and `readRecord` after it) → **F6** `appendTail` (equals full rebuild at many split points, incremental log growth, partial last line not absorbed, completion of a partial line, rejection reasons, replay through `applyIndexOps` / `tailAppendOp`). |

## For AI Agents

### Working In This Directory

- Helpers defined at the top of the file; reuse them: `chunks(s, size)` generator (default chunk of 3 bytes forces `\n` onto chunk boundaries), `buildFromString(s, size = 3, { checkpointInterval })`, `scanAll(li, reader)` (turns `error` lines into `__ERR__:` strings), `expectedLines(s)` (naive split without a phantom trailing blank line).
- Use a small `checkpointInterval` (e.g. 2–4) so checkpoint shifting logic is exercised with a handful of lines.
- Imports `MemoryReader`, `readLineBuffer`, `readRecord` from `../../parser/jsonParser.ts`.
- Verification strategy for any new mutation: apply it, rebuild from the edited text, then compare checkpoints and `scanAll` output.

### Testing Requirements

- Run only this suite: `node --experimental-transform-types --test src/indexer/__tests__/lineIndex.test.ts`.
- Add a regression test whenever a new boundary bug is found; tests are tagged with ledger IDs (`O16`, `F6`) in their names.

### Common Patterns

- Large-input cases are synthesised in code (repeat strings, `maxLineBytes` lowered to a few bytes) rather than stored as files.
- Error cases use `assert.throws` with `RangeError` / `TypeError`.

## Dependencies

### Internal

- `../lineIndex.ts` (`LineIndex`, `applyIndexOps`, `tailAppendOp`, `IndexDeltaOp`), `../../parser/jsonParser.ts`.

### External

- `node:test`, `node:assert/strict`.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
