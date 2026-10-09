# **tests**

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

Unit tests for the pure modules in `src/core/`. No I/O, no fixtures on disk: every test passes literal strings or small objects, so the suite is fast and deterministic.

## Key Files

| File                   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jsonSpan.test.ts`     | `locateValue` / `replaceValueAtPath`. Local helper `assertSpan(text, path, expected)` checks that the slice at the returned span `JSON.parse`s to the expected value and has no leading/trailing whitespace. Covers scalar/nested/array paths, escaped and `\uXXXX` keys (must match after decode), strings containing structural chars, pretty-printed text, emoji, empty containers, deep nesting, missing/mismatched paths and invalid text returning `undefined`, unterminated strings or raw control chars, byte-for-byte preservation outside the span, type-changing replacement, unserialisable values, empty path (whole value). |
| `query.test.ts`        | `findRanges` (non-overlapping, ASCII-only folding with ranges still valid against the original text, empty needle, multi-byte text), `matchesFilter` / `recordFieldValue`, `matchesCondition` (and/or/not, empty group quantifier semantics, empty leaf = no constraint, negate vs group negation), `hasAnyRealCondition`, `normalizeCondition` (invalid nodes dropped, non-array `items`, depth cap), `isConditionGroup`, `conditionSummary` (Chinese connectors).                                                                                                                                                                       |
| `replaceLogic.test.ts` | `foldAscii` (length invariant on `İstanbul`, `😂ABC`, combining marks), `countLiteralMatches` (non-overlap, case switch), `planLineReplace` (single/multi hit, original-text slicing under case-insensitive match, regex metacharacters and `$&` treated literally, invalid-JSON skip via injected `validate`, no-change detection, empty query, multi-byte, empty replacement), `describeReplaceOutcome` (skipped lines must appear in the message).                                                                                                                                                                                     |

## For AI Agents

### Working In This Directory

- Test names and comments are Chinese; match that. Each test states the invariant it protects (often an incident), so keep the rationale when renaming.
- Imports use relative `../<module>.ts` and `node:test` + `node:assert/strict`; no mocking or shared helpers beyond file-local functions.

### Testing Requirements

- Run one file: `node --experimental-transform-types --test src/core/__tests__/jsonSpan.test.ts` (likewise `query.test.ts`, `replaceLogic.test.ts`).
- Run the directory: `node --experimental-transform-types --test "src/core/__tests__/*.test.ts"`.
- Behavior changes to the matching rules (fold, non-overlap, literal) need matching cases here and a check against `src/host/__tests__/searchEngine.test.ts`.

### Common Patterns

- Property-style assertions over hard-coded offsets (slice the span and re-parse, rather than asserting `start`/`end` numbers).
- Failure cases assert `undefined` / `ok:false` explicitly, never "doesn't throw".
- Validators are injected as lambdas (`validate: (t) => { try { JSON.parse(t); return true } catch { return false } }`-style) instead of importing the parser.

## Dependencies

### Internal

- `../jsonSpan.ts`, `../query.ts`, `../replaceLogic.ts` only.

### External

- `node:test`, `node:assert/strict`.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
