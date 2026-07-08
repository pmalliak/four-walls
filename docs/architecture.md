# Architecture

Two independent static front-ends. No backend, no build step, no `package.json`.

| Part | Path | Template / brand | Notes |
|------|------|------------------|-------|
| Marketing site | repo root (`index.html`, `listing_*`, `agent*`, `blog_*`, …) | "Homy" HTML template · pink `#ff0062` | Being translated/adapted to Greek |
| Έντυπα PWA | [`forms/`](../forms/) | custom · navy `#1C3457` | Internal paperwork app — see below |

Live-listings data source (API vs. feed) is still **TBD**. Brand colours, logo
files, and the brand-PDF vector workflow are in [brand.md](brand.md).

## Reference demos — keep them

The `index-2.html … index-8.html` files are the template's alternate homepage
demos, and the `listing_*` / `agent*` / `blog_*` / `pricing_*` files are its
component library. They're a **reference**, not dead code — e.g. the Buy/Rent
tab pattern was lifted from `index-5.html`. Look there before hand-building a
component; the theme usually already has it.

## Key files & folders

| Path | Purpose |
|------|---------|
| `index.html` | Marketing homepage (the page under active work) |
| `css/style*.min.css`, `js/theme.js` | Theme build — **do not edit** (override instead) |
| `css/fourwalls.css`, `js/fourwalls.js` | Our overrides (loaded after the theme) — put tweaks here |
| `vendor/` | Theme's JS libs (jQuery, bootstrap, `nice-select`, slick, wow, …) |
| `images/` | Assets; custom ones carry a `.fw` suffix |
| `forms/` | The Έντυπα PWA (separate app) |
| `tools/preview-server.js` | Local preview server |
| `docs/` | This documentation |

## The `forms/` PWA

A standalone installable app ("Four Walls Έντυπα", `manifest.webmanifest`, navy
`#1C3457`) for internal real-estate paperwork: αναθέσεις (assignments),
αποδείξεις (receipts), καταχωρίσεις (listings), υποδείξεις (property
indications). Uses signature pads and client-side PDF export. It is **separate**
from the marketing site — different brand color, own icons/manifest.
`forms/_autofill.dev.js` is a dev-only test helper (fills every field); its
header explains how to remove it.
