# Architecture

Two independent static front-ends. No backend, no build step, no `package.json`.

| Part | Path | Template / brand | Notes |
|------|------|------------------|-------|
| Marketing site | repo root (`index.html`, `listing_*`, `agent*`, `blog_*`, …) | "Homy" HTML template · pink `#ff0062` | Greek, with a full English twin under [`en/`](../en/) |
| Έντυπα PWA | [`forms/`](../forms/) | custom · navy `#1C3457` | Internal paperwork **and office tools** — see below |
| Office handbook | [`manual/`](../manual/) | custom, standalone CSS | Non-technical instructions for the secretary, served on `docs.four-walls.gr` — see [manual-site.md](manual-site.md) |

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
| `en/` | The English twin of the marketing site (`/en/…`) — see [localization.md](localization.md) |
| `partials/` | Shared header/footer, stamped into pages by `tools/sync-partials.js` — see [partials.md](partials.md) |
| `forms/` | The Έντυπα PWA (separate app) |
| `manual/` | The office handbook served on `docs.four-walls.gr` — see [manual-site.md](manual-site.md) |
| `assets/` | Public CDN on `assets.four-walls.gr` (email signatures, CRM templates) — see [assets-host.md](assets-host.md) |
| `make/` | Every Make scenario as a blueprint JSON + [`make/INDEX.md`](../make/INDEX.md) — see [make-scenarios.md](make-scenarios.md) |
| `tools/preview-server.js` | Local preview server |
| `worker/`, `wrangler.toml` | Cloudflare Worker: hosts every hostname above, plus the listings feed and every API route (`worker/lib/`, one file per feature) |
| `tools/build-listings.mjs` | Generates `data/listings.json` locally |
| `docs/` | This documentation |

## The `forms/` PWA

A standalone installable app ("Four Walls Έντυπα", `manifest.webmanifest`, navy
`#1C3457`), behind Cloudflare Access on `forms.four-walls.gr`. It is
**separate** from the marketing site — different brand color, own
icons/manifest. Its home screen is an icon grid in two groups:

| Group | Page | What it is |
|---|---|---|
| **ΕΝΤΥΠΑ** | `katachorisi.html` | Καταχώριση: the full property record for the CRM ([forms-katachorisi-crm.md](forms-katachorisi-crm.md)) |
| | `anathesi.html` | Εντολή ανάθεσης, signed on screen |
| | `ypodeixi.html` | Σύμβαση υπόδειξης, signed on screen |
| | `apodeixi.html` | Απόδειξη είσπραξης, signed on screen |
| **ΕΡΓΑΛΕΙΑ** | `pinakida.html` | Photograph a street sign, AI reads the phone off it ([pinakides.md](pinakides.md)) |
| | `ektimisi.html` | AI property valuation ([valuation.md](valuation.md)) |
| | `enhance.html` | AI photo enhancement ([photo-enhance.md](photo-enhance.md)) |
| | `prosfora.html` | A client's offer, the one page with no document ([forms-prosfora.md](forms-prosfora.md)) |

The έντυπα use signature pads and client-side PDF export; the tools do not
produce paperwork at all. Everything shares four `.fw` modules: `_crm.fw.js`
(CRM pickers), `_outbox.fw.js` (offline queue, [forms-submit.md](forms-submit.md)),
`_drafts.fw.js` (autosave, [forms-drafts.md](forms-drafts.md)) and
`_errors.fw.js` (Bugsnag, [error-monitoring.md](error-monitoring.md)), with
`sw.js` caching the app shell so the whole thing opens without signal.
`forms/_autofill.dev.js` is a dev-only test helper (fills every field); its
header explains how to remove it.
