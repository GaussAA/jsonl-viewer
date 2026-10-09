# .github

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

GitHub configuration container. It only holds the Actions workflows (no issue templates, CODEOWNERS or dependabot config). Excluded from the VSIX via `.vscodeignore`.

## Subdirectories

| Directory    | Purpose                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------- |
| `workflows/` | `ci.yml` (merge gate) and `release.yml` (Marketplace publish); see `workflows/AGENTS.md` |

## For AI Agents

### Working In This Directory

- Any change here must pass actionlint (CI `lint` job and the pre-push hook run it).

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
