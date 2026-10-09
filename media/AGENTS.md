# media

**Parent context:** `../AGENTS.md`
**Generated:** 2026-10-09 · **Updated:** 2026-10-09

## Purpose

Extension branding assets. Only these files ship in the VSIX alongside `dist/*.js` (`media/*` is allowed by `.vscodeignore`).

## Key Files

| File       | Description                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------- |
| `icon.png` | Marketplace/extension icon, referenced by `package.json` `"icon": "media/icon.png"` (~37KB) |
| `icon.svg` | Vector source for the icon (~6KB); not referenced by the manifest                           |

## For AI Agents

### Working In This Directory

- If you change `icon.svg`, re-export `icon.png` so the two stay in sync; keep the PNG at the size the Marketplace expects (square, 128px or larger).
- Keep the manifest `galleryBanner` colour (`#1a1f3a`, dark) in mind when changing the palette.
- Do not add large assets: the VSIX is deliberately tiny (~122KB per `docs/error_ledger.md`).

### Testing Requirements

- `pnpm exec vsce ls --no-dependencies` should still list `media/icon.png`.

## Manual Notes

Notes under this heading are written by humans and preserved on regeneration.
