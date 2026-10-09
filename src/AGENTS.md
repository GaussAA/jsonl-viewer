# src

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

All TypeScript source for the extension, with unit tests co-located in `__tests__/` folders. The code is split by runtime boundary: `extension.ts` is the VS Code extension-host entry; `host/` is the data/edit services running in the extension host (plus the index worker thread); `webview/` is the browser-side UI; `protocol/rpc.ts` is the only contract shared by both sides; `core/`, `indexer/`, `parser/`, `infer/` are low-level, mostly pure modules that implement the sparse line index, record parsing and shared query/replace logic. Nothing here loads a whole file into memory: reads always go `DataService` → `LineIndex` → `ByteReader` byte ranges.

## Key Files

| File           | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `constants.ts` | Single home for every tunable limit, grouped by comment banners: host IO/parsing (`INDEX_CHECKPOINT_INTERVAL` 1024, `MAX_LINE_BYTES` 16MB, `RECORD_INLINE_MAX_BYTES` 256KB), in-place writes (`WRITE_BLOCK_SIZE`, `MAX_TAIL_BACKUP_BYTES`, `MAX_BATCH_REWRITE_BYTES` 1GB, sidecar suffixes `.jlv-tail-bak` / `.jlv-tail-bak.json` / `.jlv-rewrite-tmp`), selection/export/bad-line caps (`MAX_SELECTION_LINES` 5k, `MAX_EXPORT_LINES` 50k, `MAX_BAD_LINES` 20k), history (`MAX_HISTORY_ENTRIES` 50, `MAX_HISTORY_BYTES` 16MB, `MAX_REPLACE_UNDO_*`), protocol/search (`MAX_PERSIST_*`, `PERSIST_KEY_PREFIX`, `MAX_QUERY_LEN`, `RPC_TIMEOUT_MS` 15s, `RPC_HEAVY_TIMEOUT_MS` 120s, `SEARCH_MAX_RESULTS`/`FILTER_MAX_RESULTS` 50k, `QUERY_CACHE_MAX`, `RECORDS_MAX_COUNT` 2000), tail-follow (`TAIL_APPEND_MAX_BYTES`, `TAIL_ANCHOR_BYTES`), webview (`PAGE_SIZE`, `SAMPLE_SCAN_LINES`, `NARROW_BREAKPOINT_PX`). Every constant has a Chinese comment explaining _why_ the bound exists.                                  |
| `extension.ts` | Extension entry (`activate` / `deactivate`, ~1170 lines). Exports `VIEW_TYPE`, `CUSTOM_EDITOR_VIEW_TYPE` (`jsonlViewer.customEditor`), `OPEN_COMMAND` (`jsonlViewer.open`), `openJsonlViewer`. Internals: `HostRuntime` (explicit shared state: `panels` map + ref-counted `ServiceRegistry<DataService>`, created once in `activate`), `mountViewer` (builds HTML with CSP + nonce, acquires the `DataService` by URI, starts `startStaleWatch`, tears down on dispose), `registerHostHandlers` (the full `HostHandlerMap`: validates untrusted webview input with `isWithinTextBudget` / `isAllowedPersistKey` / `isWithinPersistBudget` / `normalizeCondition`, wires `cancel` set, calls `reportEdit` after successful writes), `JsonlCustomEditorProvider` (own document model holding only a URI, not `CustomTextEditorProvider`; save is a no-op because writes are immediate; undo/redo delegate to `DataService.undoStep/redoStep`; Save As is rejected). Only `file` and `vscode-remote` URIs are supported. |

## Subdirectories

| Directory   | Purpose                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/`     | Zero-dependency pure logic shared by host and webview: filter condition evaluation, literal replace planning, JSON value span location (see `core/AGENTS.md`) |
| `host/`     | Extension-host services: `DataService`, index host/worker, search/profile/export engines, edit history, file writer, backup recovery (see `host/AGENTS.md`)   |
| `indexer/`  | `LineIndex`: sparse checkpoint line/record index, `scan` generator, incremental edit/tail updates (see `indexer/AGENTS.md`)                                   |
| `infer/`    | Top-level field inference by sampling the first N records (see `infer/AGENTS.md`)                                                                             |
| `parser/`   | `ByteReader` abstraction, single-line JSON parsing, `readRecord` / `readBatch` / `scanRecords` (see `parser/AGENTS.md`)                                       |
| `perf/`     | Container for the big-file benchmark test only (see `perf/AGENTS.md`)                                                                                         |
| `protocol/` | `rpc.ts`: message types, endpoints, validators and dispatcher shared by host and webview (see `protocol/AGENTS.md`)                                           |
| `webview/`  | Browser-side UI, bundled as IIFE `dist/webview.js` (see `webview/AGENTS.md`)                                                                                  |

## For AI Agents

### Working In This Directory

- Dependency direction matters because of bundling. `core/`, `protocol/` and `constants.ts` are bundled into the webview IIFE, so they must not import `node:*`, `vscode` or runtime code from `host/`. `protocol/rpc.ts` only uses `import type` from `host/profileEngine.ts`, `core/query.ts`, `infer/inferFields.ts`; keep it that way.
- `indexer/lineIndex.ts` and `parser/jsonParser.ts` reference each other, but the indexer side is `import type` only, so there is no runtime cycle. Do not turn it into a value import.
- `core/query.ts` and `infer/inferFields.ts` each define `fieldTypeOf`, `ARRAY_RECORD_KEY` (`$array`) and `SCALAR_RECORD_KEY` (`$value`) with identical meaning (and identical `FieldType` / `LocalFieldType` unions). `host/profileEngine.ts` uses the `core/query.ts` copies; `host/dataService.ts` uses `inferFields` from `infer/`. They can drift, so change both if you change one. Likewise `foldAscii` (`core/replaceLogic.ts`) and `foldAsciiLowerStr` (`core/query.ts`) implement the same ASCII case folding.
- New limits go into `constants.ts` with a comment saying why the bound exists; user-visible truncation must be reported (`truncated` / `cancelled` flags), never silent.
- Adding an RPC endpoint touches `protocol/rpc.ts` (endpoint, request/response types, `HostHandlerMap`), a handler in `extension.ts` `registerHostHandlers`, and the webview caller. `HostHandlerMap` is exhaustive, so `tsc` and `protocol/__tests__/rpc.test.ts` `baseHandlers` fail until every endpoint is covered.
- `extension.ts` is large (over 45KB). Read it by range or via symbol outline rather than in one shot.
- Never route file reads through `TextDocument.getText()`. The only `openTextDocument` use is the best-effort `jumpToSource`, which catches failure for huge files.

### Testing Requirements

- Tests live in `<dir>/__tests__/*.test.ts`, run with `node:test` + `node:assert/strict`. Whole suite: `pnpm test`; single file: `node --experimental-transform-types --test src/<dir>/__tests__/<file>.test.ts`.
- `extension.ts` has no unit tests here (it imports `vscode`); it is covered by `pnpm compile && pnpm test:integration` in the real Extension Host.
- Coverage gate (`pnpm test:coverage:gate`) applies to everything under `src/`.

### Common Patterns

- Imports use explicit `.ts` extensions; `import type` for type-only imports.
- Long operations take `shouldCancel?: () => boolean` and optional progress callbacks; the host `cancel` Set is cleaned in `finally` / after use.
- Business failures return structured results (`{ ok: false, error }`, `cancelled`, `conflict`); only unexpected exceptions become `ERROR` replies via `dispatchMessage`.
- Errors are never thrown across the postMessage boundary: `post()` in `mountViewer` swallows rejections for disposed panels because an unhandled rejection can take down the shared extension host.
- Comments are Chinese and explain the incident or invariant behind a guard (often tagged `O16`, `F6`, `T4` etc. referring to `docs/` ledgers).

## Dependencies

### Internal

- `host/` imports `indexer`, `parser`, `infer`, `core`, `protocol`, `constants`; `webview/` imports `protocol`, `core`, `constants`; `protocol` imports types from `core`, `infer`, `host`.
- `extension.ts` imports `host/dataService`, `host/serviceRegistry`, `host/logging`, `host/staleWatch`, `protocol/rpc`, `core/query`, `constants`.

### External

- `vscode` (only `extension.ts` and `host/` modules that need it), Node built-ins (`node:fs`, `node:crypto`, `node:path`, `worker_threads` in host). No runtime npm packages.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
