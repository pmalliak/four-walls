# Architecture

Two independent static front-ends. No backend, no build step, no `package.json`.

| Part | Path | Template / brand | Notes |
|------|------|------------------|-------|
| Marketing site | repo root (`index.html`, `listing_*`, `agent*`, `blog_*`, …) | "Homy" HTML template · pink `#ff0062` | Being translated/adapted to Greek |
| Έντυπα PWA | [`forms/`](../forms/) | custom · navy `#1C3457` | Internal paperwork app — see below |

Live listings come from the **EstatePrime CRM** as a JSON feed served by the
Cloudflare Worker that also hosts the site (webhook-triggered regeneration +
nightly cron) — see [listings-feed.md](listings-feed.md). Brand colours, logo
files, and the brand-PDF vector workflow are in [brand.md](brand.md).

## Reference demos — keep them (`template/`)

The unadapted "Homy" demo pages live in **[`template/`](../template/)**: the
alternate homepages (`index-2.html … index-8.html`) plus the `listing_*` /
`agent*` / `blog_*` / `pricing_*` component library, alongside the
template-only images they need in **`template/images/`**. They're a
**reference**, not dead code — e.g. the Buy/Rent tab pattern was lifted from
`template/index-5.html`. Look there before hand-building a component; the theme
usually already has it.

The whole folder is `.assetsignore`d (never served). Each page carries a
`<base href="/">` so, previewed locally, it still resolves the shared `css/`,
`js/`, `vendor/` and the site's `images/` from the repo root. Four pages
(`service_details.html`, `listing_01.html`, `listing_03.html`,
`listing_details_01.html`) are kept in sync with the live header/footer by
`tools/sync-partials.js`, so they show the current chrome around raw template
markup.

## Key files & folders

| Path | Purpose |
|------|---------|
| `index.html` | Marketing homepage (the page under active work) |
| `css/style*.min.css`, `js/theme.js` | Theme build — **do not edit** (override instead) |
| `css/fourwalls.css`, `js/fourwalls.js` | Our overrides (loaded after the theme) — put tweaks here |
| `vendor/` | Theme's JS libs (jQuery, bootstrap, `nice-select`, slick, wow, …) |
| `images/` | Assets **the live site actually uses** (~118 files); custom ones carry a `.fw` suffix |
| `template/` | Unadapted Homy demo pages + their template-only images (`template/images/`) — reference, never served |
| `brand/` | Master brand source files (brand PDF + spare logo lockups) — see [brand.md](brand.md) |
| `forms/` | The Έντυπα PWA (separate app) |
| `tools/preview-server.js` | Local preview server |
| `worker/`, `wrangler.toml` | Cloudflare Worker: hosts the site + listings feed ([listings-feed.md](listings-feed.md)) |
| `tools/build-listings.mjs` | Generates `data/listings.json` locally |
| `docs/` | This documentation |

## The `forms/` PWA

A standalone installable app ("Four Walls Έντυπα", `manifest.webmanifest`, navy
`#1C3457`) for internal real-estate paperwork: αναθέσεις (assignments),
αποδείξεις (receipts), καταχωρίσεις (listings), υποδείξεις (property
indications). Uses signature pads and client-side PDF export. It is **separate**
from the marketing site — different brand color, own icons/manifest.
`forms/_autofill.dev.js` is a dev-only test helper (fills every field); its
header explains how to remove it.
