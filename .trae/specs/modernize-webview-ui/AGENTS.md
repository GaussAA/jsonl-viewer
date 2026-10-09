# modernize-webview-ui

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose
Spec for the pure-visual modernisation of the webview ("JSONL Viewer 前端界面现代化重构"). No functional features were removed (REMOVED section: none). Status: complete; all 6 tasks and all 13 checklist items are checked.

## Key Files
| File | Description |
|------|-------------|
| `spec.md` | Why / What Changes / Impact, plus requirements: unified design-token layer (derived from `--vscode-*`, scenario: light/dark parity), layered top bar with grouped info, card-style record list, stronger JSON tree and breadcrumb; MODIFIED: theme following incl. narrow windows |
| `tasks.md` | Task 1 tokens and base styles, 2 top bar, 3 record cards, 4 JSON tree + breadcrumb, 5 layout integration, 6 verification |
| `checklist.md` | Acceptance items: tokens present with no hard-coded colours, scrollbar / `:focus-visible` / `prefers-reduced-motion`, chips and active states, `toolbar.ts` public signature unchanged, `max-width:700px` stacking breakpoint, `pnpm typecheck` and `pnpm test` green (91 tests at the time), theme adaptation |

## For AI Agents

### Working In This Directory
- Historical. The living design contract is `../../../docs/DESIGN_SYSTEM.md`; follow that for any webview work.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
