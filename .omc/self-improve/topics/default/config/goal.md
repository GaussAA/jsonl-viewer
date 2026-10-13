# Improvement Goal

## Objective
Increase `LineIndex.build` index-build throughput on large JSONL files in jsonl-viewer, without changing its observable behavior (checkpoints, totalLines, totalBytes, record grouping, endsWithNewline).

## Target Metric
- **Metric name**: index_build_throughput_mb_s (MB/s of `LineIndex.build` over a generated fixture)
- **Target value**: 2x baseline (absolute value is set in settings.json `target_value` once the benchmark records the baseline)
- **Direction**: higher_is_better

## Scope
- **In scope**: `src/indexer/lineIndex.ts` only (primarily the `LineIndex.build` hot loop).
- **Out of scope**: every other file, including `src/constants.ts`, `src/parser/jsonParser.ts`, `src/host/*`, existing tests, and the benchmark itself (sealed). The public API and the semantics of `build`, `appendTail`, `scan` and the `apply*` methods must stay unchanged.

## Constraints
- All existing tests under `src/indexer/__tests__/` and `src/perf/__tests__/` must keep passing.
- `tsc --noEmit` and `oxlint` must stay clean.
- Multiline/pretty record grouping, CRLF, empty lines, unterminated final line and chunk-boundary cases must produce identical results to the current implementation.

## Milestones (optional)
| Milestone | Target | Strategy Focus |
|-----------|--------|----------------|
| M1 | 1.3x baseline | Quick wins: cheaper per-byte work, fewer branches in the hot loop |
| M2 | 2x baseline | Bulk scanning (e.g. `indexOf` for `\n` / quote skipping) with the state machine only where needed |

## Experiment Ideas (optional)
- Fast path: when a chunk has no `{`, `[`, `"` state change pending, use `buf.indexOf(0x0a, i)` to jump between newlines.
- Skip string bodies with `indexOf(0x22)` / backslash handling instead of per-byte checks.
- Hoist per-chunk state into locals and avoid property or closure access in the loop.
- Avoid allocating one `{line, offset}` object per checkpoint where the structure allows it, without changing the public `checkpoints` shape.
