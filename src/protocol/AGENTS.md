# protocol

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

The message contract between the extension host and the webview. `rpc.ts` is bundled into both sides, so it contains only types, constants, pure validators and a small table-driven dispatcher. The host handlers (in `extension.ts`) and the webview RPC client (`webview/rpc.ts` and the `webview/*Ops.ts` callers) both compile against these types.

## Key Files

| File     | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rpc.ts` | **Versioning:** `PROTOCOL_VERSION` (bump only for breaking changes; the host reports it in `OverviewPayload.protocolVersion` so a stale retained webview can be detected). **Endpoints:** `HostEndpoint` (webview→host, about 30 values from `READY`/`GET_OVERVIEW`/`READ_RECORDS` through edit, history, bad-line, export, backup, `SCAN_PROFILE`) and `HostReply` (host→webview, including push messages `FILE_STALE`, `TAIL_APPENDED`, `DOCUMENT_RESET`, `EDIT_PROGRESS`). **Types:** `HostRequest` / `HostResponse` unions and per-endpoint payloads (`OverviewPayload`, `RecordsPayload(Item)`, `Search/FilterResultsPayload`, `EditResultPayload`, `ReplaceResultPayload`, `DeleteManyResultPayload` + `DeletedRange`, `HistoryPayload`, `BadLinesPayload`, `ExportResultPayload`, `BackupStatusPayload`, `ProfilePayload`, `EditProgressPayload`), `RpcErrorCode` (`INVALID_ARG`, `TOO_LARGE`, `NOT_FOUND`, `CONFLICT`, `CANCELLED`, `TIMEOUT`, `NOT_IMPLEMENTED`, `INTERNAL`). **Utilities:** `makeRequestId`, `isRpcMessage`, `isHostRequest` (O(1) Set lookup), `requestIdOf`, `isAllowedPersistKey`, `isWithinPersistBudget`, `isWithinTextBudget` (UTF-8 bytes via `TextEncoder`), `buildRecordsPayload`, replies `okReply` / `errReply` / `initReply`. **Dispatch:** `HostHandlerMap` (one handler per endpoint, each builds its own full `HostResponse`) and `dispatchMessage(msg, handlers)` (filters unknown types, `NOT_IMPLEMENTED` for missing handler, converts thrown errors into `INTERNAL` replies keeping `requestId`). Re-exports types `FieldProfile`, `ProfileResult` from `host/profileEngine.ts`. |

## Subdirectories

| Directory    | Purpose                                   |
| ------------ | ----------------------------------------- |
| `__tests__/` | `rpc.test.ts` (see `__tests__/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- Everything here must run in a browser bundle: no `node:*`, no `Buffer`, no runtime import from `host/`. Existing cross-layer imports are `import type` / `export type` only; keep them so (the `ProfileResult` re-export is the reason `webview` never imports `host/profileEngine.ts`).
- Adding an endpoint: add the `HostEndpoint` value; add a `HostRequest` union member (with `requestId` for anything that expects a reply); add the `HostReply` value and a `HostResponse` member for its payload; add a key to `HostHandlerMap`; implement the handler in `extension.ts`; extend `baseHandlers` in `__tests__/rpc.test.ts`. `dispatchMessage` itself needs no change.
- Treat all request fields as untrusted. Size/shape validation lives in the host handlers (using the helpers here and the limits in `constants.ts`), not in the types.
- Failure vs. cancel: cancellation is its own flag (`cancelled`) or `CANCELLED` code, never an error message. Truncation must be explicit (`truncated`). Keep this when adding payloads.
- The `FILTER` request has a legacy flat channel (`field`/`op`/`value`, marked deprecated) alongside `condition`; the host normalises both. Do not remove the flat fields without a `PROTOCOL_VERSION` bump.
- `HostHandlerMap[JUMP_TO_SOURCE]` may return `undefined` and `CANCEL` returns no promise; the others return `HostResponse`.
- Webview request timeouts use `RPC_TIMEOUT_MS` / `RPC_HEAVY_TIMEOUT_MS` from `constants.ts`; decide which class a new endpoint belongs to on the webview side (see `../webview/AGENTS.md`).

### Testing Requirements

- `node --experimental-transform-types --test src/protocol/__tests__/rpc.test.ts`, plus `pnpm typecheck` (exhaustive `HostHandlerMap` and union changes surface there first).
- Webview tests that stub the bus (`src/webview/__tests__/rpcBus.test.ts`) and host handler tests (`src/host/__tests__/hostHandlerRegistry.test.ts`) also depend on these shapes.

### Common Patterns

- Replies carry the originating `requestId`; the webview drops stale ones.
- `okReply(type, requestId, payload)` for success; business failures still use the endpoint's result payload with `ok:false`, reserving `errReply` for protocol-level problems.
- Chinese doc comments explain why each flag exists (for example why `cancelled` differs from `truncated`).

## Dependencies

### Internal

- Type imports: `../core/query.ts` (`Condition`), `../host/profileEngine.ts` (`ProfileResult`, `FieldProfile`), `../infer/inferFields.ts` (`FieldInfo`). Runtime imports: `../constants.ts` (`MAX_PERSIST_KEY_LEN`, `MAX_PERSIST_VALUE_BYTES`, `PERSIST_KEY_PREFIX`).
- Consumed by `extension.ts`, `host/dataService.ts` (`buildRecordsPayload`, `PROTOCOL_VERSION`, payload types), `host/editHistory.ts` (types), and most of `webview/` (`HostEndpoint`, payload types, `webview/rpc.ts`).

### External

- None.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
