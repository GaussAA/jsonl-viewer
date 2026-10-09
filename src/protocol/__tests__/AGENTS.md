# **tests**

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

Tests for `protocol/rpc.ts`: endpoint recognition, per-endpoint dispatch through `dispatchMessage`, error mapping, and the input-budget helpers.

## Key Files

| File          | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rpc.test.ts` | Builds a full `baseHandlers: HostHandlerMap` (one stub per endpoint returning the right reply type via `okReply` / `initReply`) and a tiny `req(type)` helper. Cases: `isHostRequest` accepts every `HostEndpoint` value; `READY` returns an `init` reply (regression for a handshake that was filtered out); dispatch and `requestId` correlation for `GET_OVERVIEW`, `READ_RECORDS`, `READ_RECORD`, `GET_SAMPLE_FIELDS`, `SEARCH`, `FILTER`, `JUMP_TO_SOURCE`, `PERSIST_STATE` / `LOAD_STATE`, `RELOAD`; `CANCEL` produces no reply; unknown endpoint is dropped without reaching a handler; `requestIdOf` edge cases; thrown and rejected handlers produce `ERROR` with the original `requestId` (undefined for `READY`) and code `INTERNAL`; `errReply` omits `code` when not given; missing handler produces `NOT_IMPLEMENTED`; `isAllowedPersistKey`, `isWithinPersistBudget` (over budget and non-serialisable), `isWithinTextBudget` counts UTF-8 bytes (Chinese not under-counted). |

## For AI Agents

### Working In This Directory

- `baseHandlers` is typed as `HostHandlerMap`, so adding a handler key in `rpc.ts` breaks this file at typecheck time. Add a stub there and a dispatch case. Per-case overrides spread `baseHandlers` and replace a single key.
- Handlers are exercised with plain objects as messages (`{ type, requestId, ... }`); no vscode or webview objects are needed.
- Limits come from `../../constants.ts` (for example `MAX_PERSIST_VALUE_BYTES`), so tests follow constant changes automatically; do not hard-code the numbers.

### Testing Requirements

- Single file: `node --experimental-transform-types --test src/protocol/__tests__/rpc.test.ts`.
- Note the existing `GET_OVERVIEW` and `RELOAD` stubs omit fields such as `totalRecords`; `okReply` takes `unknown` payloads, so this compiles, but do not copy the shortcut into assertions about payload shape.

### Common Patterns

- Assert on `result.response` (type, `requestId`, payload) rather than on side effects.
- Error-path tests check both the reply `type` (`HostReply.ERROR`) and the machine-readable `code`.
- Test names and comments are Chinese.

## Dependencies

### Internal

- `../rpc.ts`, `../../constants.ts`.

### External

- `node:test`, `node:assert/strict`.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
