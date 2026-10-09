# docs

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose
Design contract, reviews, audits and the incident ledger for the extension. All documents are written in Chinese and are excluded from the VSIX (`docs/**` in `.vscodeignore`). They are the project's long-term memory: several source comments refer to them by section (e.g. `MAINTENANCE_AUDIT §2.6`, `ARCHITECTURE_REVIEW §七`), so avoid renumbering headings.

## Key Files
| File | Description |
|------|-------------|
| `DESIGN_SYSTEM.md` | The single design contract for the webview: tokens (§1), layout (§2), components (§3), motion (§4), interaction (§5), VS Code adaptation constraints (§6), new-feature design checklist (§7). Prototype reference is `../prototype.html`. **Read before any webview/CSS change** |
| `error_ledger.md` | Incident ledger in the format `[symptom] → [root cause] → [fix]`. Covers stubborn bugs (≥2 debug rounds) and one-off release/destructive-path accidents (vsix packaging leaks, `ELECTRON_RUN_AS_NODE`, `@types/vscode` drift, EBUSY at tag step, stale-view writes, index desync after edit, etc.). **Check before debugging; append after any incident** |
| `CODE_WIKI.md` | Code-level panorama: architecture, directory layout, performance design, per-module responsibilities, key class/function index, dependency graph, run/test/build/release, known limits and conventions. Note the 2026-09-28 banner: `webviewEntry.ts` was split by domain, so older module tables may be stale. Start here for orientation |
| `EDIT_FEATURE_PLAN.md` | Verified facts, route trade-offs, phased plan, key design and risk list for the editing feature set (decisions recorded 2026-09-22 in §6). Consult when touching write paths, history, backup/recovery |
| `ENHANCEMENT_PROPOSAL.md` | Evidence-based feature and improvement proposals at baseline v1.10.0 (new features, refinements, rollout order, §5 lists what was verified vs inferred). Consult when picking next work; avoid re-proposing items already recorded |
| `ARCHITECTURE_REVIEW.md` | Technical-debt and architecture review at v1.7.0 (dependency direction, SOLID status, §八 coverage gate history, §九 progress as of 2026-09-28) |
| `CODE_REVIEW.md` | Functional/security review (P0–P2) with a repair roadmap; per the root doc all items are fixed. Historical reference for why guards exist |
| `STABILITY_AUDIT.md` | Stability/availability audit at v1.5.1, backed by probes in `../scripts/audit-stability.ts`; §七 records that all fixes landed 2026-09-20 |
| `MAINTENANCE_AUDIT.md` | Repo hygiene (root cleanup) and structural quality baseline, plus commit log and follow-ups. §2.6 documents the silently broken `release.yml` that motivated actionlint |
| `UAT_CHECKLIST.md` | Manual acceptance checklist for editing features (written for v1.8.0, 11 sections: read-only baseline, edit, insert/delete, find/replace, multi-select, history, bad lines, field edit, batch field replace, concurrency, perf spot check, plus known boundaries). Run on a real VS Code with a ≥100MB file before a release that touches providers/editing |

## For AI Agents

### Working In This Directory
- Before a webview change: read `DESIGN_SYSTEM.md` (including the §7 checklist) first; update it in the same change if you add a token, component or motion rule.
- Before debugging a stubborn or release-related failure: grep `error_ledger.md`. After resolving one (≥2 rounds, or any release/destructive-path incident), add an entry in the same `现象 → 根因 → 正解` shape, with a date and a prevention note.
- The audits and reviews are dated snapshots. Prefer adding a dated "follow-up" section over rewriting history; if a claim is superseded, mark it rather than delete it.
- If a document moves a section, grep the repo for references (`MAINTENANCE_AUDIT §`, `ARCHITECTURE_REVIEW §`) in source comments and fix them.
- Keep the language Chinese to match the existing documents.
- To ship a doc inside the VSIX you must add a negated exception such as `!docs/DESIGN_SYSTEM.md` to `.vscodeignore` (see the first ledger entry).

### Testing Requirements
- No tests. Prettier checks Markdown here (`pnpm format:check`), so run `pnpm format` on edited files; the pre-commit hook enforces it.

### Common Patterns
- Documents open with a blockquote giving date, baseline version and method, then numbered Chinese sections (`一、二、…` or `0.`, `1.`).
- Evidence is cited as `file:line`; inferred (unverified) claims are labelled as such.

## Dependencies
### Internal
- `../src/**` (cited code), `../scripts/audit-stability.ts` (probe for `STABILITY_AUDIT.md`), `../prototype.html` (design reference), `../RELEASE.md` (install steps referenced by `UAT_CHECKLIST.md`).

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
