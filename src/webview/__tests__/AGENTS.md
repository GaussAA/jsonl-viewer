# **tests**

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

Unit and jsdom tests for the modules in `src/webview/` (all except `styles.ts`, which is a CSS string; `rpc.ts` is covered by `rpcBus.test.ts`). They run with Node's built-in runner and type stripping (no bundling, no browser). Pure-logic modules are tested directly; DOM modules and the assembly layer are tested inside a jsdom environment built by `domHarness.ts`.

## Key Files

| File                                                                                                                   | Description                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Shared helper**                                                                                                      |                                                                                                                                                                                                                      |
| `domHarness.ts`                                                                                                        | `setupWebviewDom()` — builds a jsdom page, installs browser globals, a fake `acquireVsCodeApi`, and returns a `FakeHost`. Not a test itself (no `.test.ts` suffix)                                                   |
| **Pure logic (no DOM, no harness)**                                                                                    |                                                                                                                                                                                                                      |
| `logic.test.ts`                                                                                                        | `LRUCache`, `ThrottleQueue`, fetch-window / segmenting, summary formatting                                                                                                                                           |
| `detailLogic.test.ts`                                                                                                  | Path model, `TreeState`, array segmenting, container preview                                                                                                                                                         |
| `editLogic.test.ts`                                                                                                    | Cost estimates, edit validation, confirm/progress texts, field-edit parsing                                                                                                                                          |
| `profileLogic.test.ts`                                                                                                 | Coverage, quality flags, sorting, headline text                                                                                                                                                                      |
| `queryLogic.test.ts`                                                                                                   | Field layout normalization, persisted-state merge, match navigation                                                                                                                                                  |
| `appState.test.ts`                                                                                                     | `createAppState`, `viewBaseline`, cache capacity                                                                                                                                                                     |
| `rpcBus.test.ts`                                                                                                       | `RpcBus` with a fake `VSCodeApi`: success, timeout, supersede, late-response drop, error replies, push events, dispose                                                                                               |
| `security.test.ts`                                                                                                     | `escapeHtml` and boundary / dispose-cleanup cases (XSS regression guard)                                                                                                                                             |
| **Deps-injected domain modules (fake deps, no DOM)**                                                                   |                                                                                                                                                                                                                      |
| `persistence.test.ts`                                                                                                  | Debounced write-back                                                                                                                                                                                                 |
| `persistRestore.test.ts`                                                                                               | Two-source merge ordering and failure paths                                                                                                                                                                          |
| `navigation.test.ts`                                                                                                   | Prev/next within filtered and unfiltered views                                                                                                                                                                       |
| `focusTarget.test.ts`                                                                                                  | Single write point for `selectedLine` and its side effects                                                                                                                                                           |
| `queryActions.test.ts`                                                                                                 | Search / filter / layout actions                                                                                                                                                                                     |
| `editOps.test.ts`                                                                                                      | Edit / delete / replace flow and post-write reset                                                                                                                                                                    |
| **DOM components (use `domHarness`)**                                                                                  |                                                                                                                                                                                                                      |
| `virtualScroll.test.ts`                                                                                                | Record list, paging, selection, context menu                                                                                                                                                                         |
| `detailTree.test.ts`                                                                                                   | Tree rendering, lazy expand, breadcrumb, field edit entry                                                                                                                                                            |
| `toolbar.test.ts`                                                                                                      | Toolbar, search, filter and field panels                                                                                                                                                                             |
| `columnLayout.test.ts`                                                                                                 | Collapse, drag resize, narrow-screen drawer                                                                                                                                                                          |
| `selection.test.ts`                                                                                                    | Multi-select state, action bar, batch copy/delete                                                                                                                                                                    |
| `utils.test.ts`                                                                                                        | `renderHighlight` and other helpers that need a DOM                                                                                                                                                                  |
| `editPanel.test.ts` / `fieldPanel.test.ts` / `historyPanel.test.ts` / `badLinesPanel.test.ts` / `profilePanel.test.ts` | Floating panel overlays                                                                                                                                                                                              |
| `fieldEdit.test.ts` / `badLinesOps.test.ts` / `profileOps.test.ts`                                                     | Domain modules that need a DOM (banner, panels)                                                                                                                                                                      |
| **Assembly layer (full `main()` in jsdom)**                                                                            |                                                                                                                                                                                                                      |
| `webviewEntry.test.ts`                                                                                                 | Smoke test: dynamic `import('../webviewEntry.ts')` after `setupWebviewDom()`; checks key components mounted, ready handshake, banner a11y (`role=status`, `aria-live=polite`)                                        |
| `webviewEntry.integration.test.ts`                                                                                     | Calls the exported `main()` per case on a fresh harness; drives init → derived requests → on-demand fetch (40 ms throttle window) → detail fetch / supersede → navigation → banners → persistence restore/write-back |
| **Release artifact guard**                                                                                             |                                                                                                                                                                                                                      |
| `dist-product.test.ts`                                                                                                 | Runs the real minified `dist/webview.js` in jsdom and checks that a field edit sends valid JSON. Opt-in; see below                                                                                                   |

## Subdirectories

None.

## For AI Agents

### Working In This Directory

- Imports use explicit `.ts` extensions and `node:test` + `node:assert`. Test names are mostly Chinese; match that.
- Name a new test `<module>.test.ts` next to the module's other tests. The `pnpm test` glob is `src/**/*.test.ts`, so anything else will not run. Helpers like `domHarness.ts` must not end in `.test.ts`.

### Testing Requirements

- Run one file:
  `node --experimental-transform-types --test src/webview/__tests__/<file>.test.ts`
- Run the whole directory: `node --experimental-transform-types --test "src/webview/__tests__/*.test.ts"`. Everything: `pnpm test`. Coverage gate: `pnpm test:coverage:gate`.
- `dist-product.test.ts` needs a build first **and** an env var:
  - It resolves `dist/webview.js` relative to the repo root and checks `existsSync`. If missing, it is skipped with "run `pnpm compile` first". Build with `pnpm compile` (non-minified) or `pnpm build` (minified, the real release artifact).
  - Even with a build, it is skipped unless `JLV_DIST_PRODUCT=1`. The file's own comment says this is because it can race on `globalThis` with other jsdom tests running in parallel.
  - Typical run: `pnpm build` then `JLV_DIST_PRODUCT=1 node --experimental-transform-types --test src/webview/__tests__/dist-product.test.ts` (bash; in PowerShell set `$env:JLV_DIST_PRODUCT=1` first). `scripts/release.mjs` sets the variable and runs `pnpm typecheck && pnpm test && pnpm build`.
  - Because `pnpm test` runs before `pnpm build` in that script, the guard sees whatever `dist/` already exists. It can be stale or absent, in which case it is skipped. Build first if you want the guard to test the current source.

### Common Patterns

- **Using `domHarness.ts`.** `setupWebviewDom()` creates a jsdom page (`<div id="app">`, URL `https://jsonl-viewer.example/`), assigns `window`, `document`, `localStorage`, `navigator`, `HTMLElement`, `Node`, `MessageEvent`, `Event`, `requestAnimationFrame` etc. onto `globalThis`, and stubs what jsdom lacks (`matchMedia` → never matches, `scrollIntoView` / `scrollTo` no-ops, `ResizeObserver`). It installs a fake `acquireVsCodeApi` and wraps `setTimeout` so timers are `unref`'d.
  `FakeHost` gives you:
  - `host.posted` — everything the webview sent, in order. `RpcBus.request` spreads the payload to the top level: `{ type, requestId, ...payload }`.
  - `host.receive(msg)` — push a host message to the webview. Reply to a request with `{ type: HostReply.RESULT, requestId: req.requestId, payload }`; send init with `{ type: HostReply.INIT, payload }`.
  - `host.state()` — the webview's `getState/setState` contents (assert UI preferences persisted). `host.setStateImpl(fn)` simulates `setState` failing.
  - `host.dom` — the JSDOM instance.
- **Component test recipe:**
  ```ts
  const host = setupWebviewDom(); // before touching the DOM or importing DOM-dependent code
  const root = document.createElement('div');
  document.body.appendChild(root);
  const panel = createEditPanel({/* fake deps */});
  root.appendChild(panel.root);
  ```
- **Whole-app recipe:** call `setupWebviewDom()` first, then either `await import('../webviewEntry.ts')` (smoke test; the module auto-mounts because `document` and `acquireVsCodeApi` now exist) or statically import `main` and call it per case on a fresh harness (integration test; the guard in the module prevents mount at import time in plain Node).
- **Waiting:** the harness replaces `globalThis.setTimeout` with an `unref` wrapper, so `await new Promise(r => setTimeout(r, n))` may not keep the process alive. Use `import { setTimeout as sleep } from 'node:timers/promises'` as the integration test does. The scheduler's `ThrottleQueue` window is 40 ms; wait about twice that for it to settle.
- The harness mutates `globalThis` and has no teardown; each `setupWebviewDom()` call overwrites the previous globals. Do not run two harness-based scenarios in the same file concurrently.
- Pure modules take fake deps (`Pick<AppState, …>` objects, recording callbacks); prefer this to jsdom whenever the module has no DOM.
- jsdom has no layout engine: tests can check classes, attributes, text and posted messages, but not geometry, scrolling or animation. State what was not verified.

## Dependencies

### Internal

- `../*.ts` — the modules under test
- `../../protocol/rpc.ts` — `HostEndpoint`, `HostReply`, `PROTOCOL_VERSION` for building host messages
- `../../constants.ts`, `../../core/*` — indirectly through the modules

### External

- `node:test`, `node:assert` (`node:assert/strict` in some files), `node:timers/promises`, `node:vm` (only `dist-product.test.ts`)
- `jsdom` (imported directly only by `domHarness.ts`)

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
