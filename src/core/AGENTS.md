# core

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

Zero-dependency pure logic that both the extension host and the webview need to agree on. Each module exists to be the single source of truth for a rule that would otherwise drift between two sides (filter evaluation, search/replace matching, field-level JSON edit location). No imports from `host/`, `webview/`, `node:*`, `vscode` or the DOM, so it can be bundled into the webview IIFE and unit-tested directly.

## Key Files

| File              | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query.ts`        | Field filter model and evaluation. Types: `FieldCondition` (`eq`/`contains`/`exists`/`type`, `negate`, `caseInsensitive`), `ConditionGroup` (`and`/`or`/`not` over `items`), `Condition` union. Functions: `matchesFilter`, `matchesCondition` (whole-record evaluation; empty leaf = no constraint, empty `and` = true, empty `or` = false, `not` = none of items), `hasAnyRealCondition`, `normalizeCondition` (sanitises untrusted/legacy input, drops invalid branches, depth cap `MAX_CONDITION_DEPTH` = 8), `conditionSummary` (Chinese `且/或/非` summary), `recordFieldValue`, `fieldTypeOf`, `stringifyValue`, and `findRanges` (non-overlapping literal hit ranges, ASCII-only case fold, used for highlighting). Exports pseudo-field keys `ARRAY_RECORD_KEY` (`$array`) and `SCALAR_RECORD_KEY` (`$value`). `webview/queryLogic.ts` re-exports these symbols. |
| `replaceLogic.ts` | Find/replace planning. `foldAscii` (folds only A–Z, length never changes), `countLiteralMatches`, `planLineReplace(raw, query, replacement, {caseInsensitive, validate})` returning `{text?, count, skip?: 'unchanged'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 'invalid-json'}`, `describeReplaceOutcome`(user-facing result text that always surfaces skipped lines). JSON validity is an injected`validate`callback (host passes`parseJsonLine(t).ok`). |
| `jsonSpan.ts`     | Field-level surgical edit support. `locateValue(text, path)` finds the `[start, end)` span of the value at a key/index path using a recursive-descent scanner that builds no values; `replaceValueAtPath(text, path, next)` splices `JSON.stringify(next)` into only that span (key order and whitespace preserved); `jsonValueEquals` (deep equality, key-order independent, `1` equals `1.0`). Returns `undefined` / `{ok:false}` on any doubt, never an approximate span. Depth cap `MAX_DEPTH` = 1000.                                                                                                                                                                                                                                                                                                                                                                |

## Subdirectories

| Directory    | Purpose                                                      |
| ------------ | ------------------------------------------------------------ |
| `__tests__/` | Unit tests for the three modules (see `__tests__/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- Keep this directory dependency-free. Adding an import from `host/`, `node:*` or `webview/` breaks webview bundling or reintroduces the layering violation these modules were extracted to fix (`docs/ARCHITECTURE_REVIEW.md`, debt T3).
- Matching rules are shared contracts: literal (never regex), non-overlapping, case folding only ASCII A–Z. `host/searchEngine.ts` (`foldAsciiLower` on Buffers), `replaceLogic.foldAscii` and `query.findRanges` must behave identically, otherwise users see "search found 5, replace says no match". Change all together.
- `jsonSpan.ts` rules: failure returns `undefined`, never a guess; object keys are compared after decoding (via `JSON.parse` of the key token); trailing garbage after the value makes the whole text invalid. The scanner's `scanString` skips two chars after a backslash without validating escapes on purpose.
- `JsonScanner` in `jsonSpan.ts` currently uses constructor parameter properties (`private readonly text`), which the root conventions forbid (non-erasable syntax). It only works because tests run with `--experimental-transform-types`; prefer fixing it to explicit field assignment when touching the file.
- `normalizeCondition` is the trust boundary for filter input from the webview and from persisted `workspaceState`. Run untrusted conditions through it before `matchesCondition`.
- `fieldTypeOf` and the `$array` / `$value` keys also exist in `infer/inferFields.ts`; keep both in sync.

### Testing Requirements

- Each module has a test file in `__tests__/`; extend it for any behavior change. Run `node --experimental-transform-types --test src/core/__tests__/<file>.test.ts`.
- These files carry high coverage weight in the CI gate (pure logic, cheap to cover); do not add untested branches.

### Common Patterns

- Result objects over exceptions: `{ ok: true, ... } | { ok: false, error }`, `skip` reasons enumerated as string unions.
- Messages shown to users are Chinese and live next to the logic that produces them (`describeReplaceOutcome`, `conditionSummary`).
- Defensive defaults toward "don't shrink the user's view": invalid group kind or empty leaf evaluates to `true`.

## Dependencies

### Internal

- None (leaf layer). Consumed by: `host/dataService.ts` (`planLineReplace`, `jsonValueEquals`, `locateValue`, `replaceValueAtPath`, `Condition`), `host/searchEngine.ts` and `host/indexHost.ts` / `host/workerProtocol.ts` (`Condition`, matching), `host/profileEngine.ts` (`fieldTypeOf`, pseudo-keys), `protocol/rpc.ts` (type `Condition`), `extension.ts` (`normalizeCondition`), `webview/queryLogic.ts`, `webview/detailTree.ts`, `webview/virtualScroll.ts` (`findRanges`), `webview/editOps.ts` and `webview/fieldEdit.ts` (`describeReplaceOutcome`, `replaceValueAtPath`), `webview/profileOps.ts` (`Condition`).

### External

- None.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
