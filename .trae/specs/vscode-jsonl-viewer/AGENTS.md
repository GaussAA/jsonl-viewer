# vscode-jsonl-viewer

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose
The founding spec of the extension ("VSCode JSONL Viewer Spec"). Status: complete; all 7 tasks and all 13 checklist items are checked, with evidence notes against the code at the time (e.g. 87/87 tests passing).

## Key Files
| File | Description |
|------|-------------|
| `spec.md` | Why / What Changes / Impact, then requirements with scenarios: seconds-level opening and low memory for huge files (line-offset index, on-demand parsing), record list + collapsible JSON tree with summary cards, field filter and search with jump, JSON validation with bad-line location, column/field display customisation, build and dev docs |
| `tasks.md` | Task 1 project skeleton (TypeScript + esbuild + "Webview UI Toolkit" as then planned), 2 line-offset index and lazy parsing, 3 field inference sampling and validation, 4 webview list with virtual scroll, 5 JSON tree detail, 6 filter / search / field display, 7 perf and debugging; includes a task dependency list |
| `checklist.md` | Acceptance items tied to modules (`LineIndex`, `readBatch` / `readRecord`, `searchLines`, `filterLines`, `FieldLayout`, `protocol/rpc.ts`) |

## For AI Agents

### Working In This Directory
- Historical. Useful to learn why the sparse index plus byte-range reads exist. Details such as the planned UI toolkit were not kept: the shipped extension has no runtime npm dependencies.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
