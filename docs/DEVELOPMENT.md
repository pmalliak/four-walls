# Development notes

Companion to [../CLAUDE.md](../CLAUDE.md). Read that first for the high-level
map; this file has the detailed workflow, gotchas, and component notes.

## What's in the repo

Two independent static front-ends, no backend / no build step / no `package.json`:

| Part | Path | Template / brand | Notes |
|------|------|------------------|-------|
| Marketing site | repo root (`index.html`, `listing_*`, `agent*`, `blog_*`, `index-2..8`, …) | "Homy" HTML template · pink `#ff0062` | Being translated/adapted to Greek |
| Έντυπα PWA | [`forms/`](../forms/) | custom · navy `#1C3457` | Internal paperwork app (assignments, receipts, listings, indications) with signature pads + client-side PDF |

The many `index-N.html` files are the template's alternate homepage demos — a
useful **reference library**. E.g. `index-5.html` is where the Buy/Rent tab
pattern came from. Keep them; don't assume they're dead code.

Brand colours, logo files, and the brand-PDF vector-extraction workflow live in
[BRAND.md](BRAND.md).

## Local preview

```bash
node tools/preview-server.js         # http://localhost:5173/   (repo root)
node tools/preview-server.js 8080    # custom port
```

- Zero dependencies (Node built-ins only). Serves the repo root:
  site at `/`, forms at `/forms/`.
- **No live-reload** — hard refresh (Ctrl+F5) after every edit.
- `node` is installed (winget: `OpenJS.NodeJS.LTS`) but is frequently **not on
  PATH** in a freshly-spawned shell. Fallback:
  `& "C:\Program Files\nodejs\node.exe" tools/preview-server.js`.
- Alternatives: VS Code **Live Server** extension, or `npx serve` (needs network
  for the first download).

## Customization convention

Never edit the minified theme build. Put every tweak in:

- [`css/fourwalls.css`](../css/fourwalls.css) — loaded after the theme CSS, so it wins.
- [`js/fourwalls.js`](../js/fourwalls.js) — loaded after `js/theme.js` and after
  jQuery + `vendor/nice-select/jquery.nice-select.min.js`, so both are available.

Custom assets carry a `.fw` suffix (e.g. `style.fw.min.css`, `shape_74.fw.svg`).

### Working with `nice-select`

The hero search dropdowns use the theme's jQuery `nice-select` plugin
(initialized by `theme.js` as `$('.nice-select').niceSelect()`). To change a
`<select>`'s options at runtime, rebuild its `<option>`s then call
`$(sel).niceSelect('update')` (the plugin supports `update` and `destroy`).
Example: `js/fourwalls.js` swaps the price ranges when the deal type changes.

## Greek localization rules

- `<html lang="el">` on every page. This makes CSS `text-transform:uppercase`
  drop accents. **Greek capitals take no τόνος:** «Αναζήτηση» → «ΑΝΑΖΗΤΗΣΗ»,
  never «ΑΝΑΖΉΤΗΣΗ». When typing already-uppercase Greek by hand, omit accents.
- Currency **€**, thousands separator `.` (e.g. `€100.000`, `€900-1.500/μήνα`).

## Hero search — layout & responsive

`index.html` hero search (`.search-wrapper-one.layout-one`) is one row of
`.input-box-one` fields inside a 12-col grid. Field order and widths:

| Field | id | Desktop (`xl`) | Tablet (`md`/`lg`) | Phone (`<md`) |
|-------|-----|----|----|----|
| Ενδιαφέρομαι για… (deal) | `#fw-deal` | `col-xl-2` | `col-12` (own row) | `col-12` |
| Τύπος ακινήτου | — | `col-xl-3` | `col-md-4` | `col-12` |
| Περιοχή | — | `col-xl-2` | `col-md-4` | `col-12` |
| Εύρος τιμής (price) | `#fw-price` | `col-xl-3` | `col-md-4` | `col-12` |
| Αναζήτηση (button) | — | `col-xl-2` | `col-12` (own row) | `col-12` |

So on iPad it reads as three rows: **deal / three dropdowns / button**.
`css/fourwalls.css` removes the first field's stray right-divider between
992–1199px (the theme only converts dividers to underlines below 992px).

The price dropdown is transaction-aware (see `js/fourwalls.js`): sale ranges for
Αγορά, `€…/μήνα` ranges for Ενοικίαση. `fourwalls.css` also stops the narrow
select from showing scrollbars / overflowing its box (ellipsis on the selected
value; the open list grows to fit).

## Windows / PowerShell editing gotchas

- Primary shell is **PowerShell 5.1**; a Bash tool is also available. There is
  **no `python`**.
- Source files are **UTF-8 without BOM, LF line endings, TAB-indented HTML**.
  Match this exactly.
- If you script an edit that contains **Greek text through PowerShell**, the
  `.ps1` itself must be **UTF-8 *with* BOM** or PS 5.1 reads the Greek as ANSI
  and corrupts it. But write the *target* file back as UTF-8 **without** BOM
  (`New-Object System.Text.UTF8Encoding($false)`) to match the repo.
- Because HTML indentation is tabs, exact-string edits are fragile; the reliable
  pattern used here is a small PS script that locates an anchor substring and
  splices, then writes back BOM-less UTF-8.
