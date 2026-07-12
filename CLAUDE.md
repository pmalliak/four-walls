# Four Walls — project guide

Greek real-estate business in Thessaloniki. This repo holds **two static
front-ends** (no backend, no build step, no `package.json`):

1. **Marketing site** (repo root) — built on the purchased **"Homy"** HTML
   template. Entry: [index.html](index.html). Brand accent: **pink `#ff0062`**.
   Many template pages exist (`listing_*`, `agent*`, `blog_*`, `index-2..8`,
   etc.); we translate/adapt them to Greek as needed.
2. **Έντυπα PWA** ([forms/](forms/)) — a separate installable app for internal
   real-estate paperwork (αναθέσεις, αποδείξεις, καταχωρίσεις, υποδείξεις) with
   signature pads and client-side PDF export. Brand accent: **navy `#1C3457`**.
   `forms/_autofill.dev.js` is a dev-only test helper (see its header).

Live listings: **EstatePrime CRM → Cloudflare Worker → `/data/listings.json`**
(webhook-triggered + nightly cron; **live CRM data in prod** — the repo's
`data/listings.json` is still template sample data). The same Worker hosts the site. See [docs/listings-feed.md](docs/listings-feed.md).

## Local preview

Zero-dependency Node server (serves the repo root):

```bash
node tools/preview-server.js            # http://localhost:5173/
node tools/preview-server.js 8080       # custom port
```

- Site: `http://localhost:5173/` · Forms: `http://localhost:5173/forms/`
- No live-reload — **hard refresh (Ctrl+F5)** after edits.
- `node` may not be on PATH in a fresh shell here (installed via winget after
  the shell started). Fallback: `& "C:\Program Files\nodejs\node.exe" tools/preview-server.js`.
- VS Code **Live Server** extension works too (just serve the repo root).

Full docs are split by topic under [docs/](docs/) — start at
[docs/README.md](docs/README.md) (architecture, brand, preview, conventions,
localization, environment, and per-component notes).

## Conventions (do not break)

- **Customizations go in [css/fourwalls.css](css/fourwalls.css) +
  [js/fourwalls.js](js/fourwalls.js)**, which load *after* the theme so they
  always win. Do **not** edit the minified theme build (`css/style*.min.css`,
  `js/theme.js`) — override instead. The `.fw` suffix marks our custom assets.
- **Greek localization:**
  - `<html lang="el">` on every page — this makes CSS `text-transform:uppercase`
    strip accents. **Greek capitals take no accent** (τόνος): «Αναζήτηση» →
    «ΑΝΑΖΗΤΗΣΗ», never «ΑΝΑΖΉΤΗΣΗ». When hand-typing already-uppercase Greek,
    type it accent-free.
  - Currency is **€** (not `$`); use `.` as the thousands separator (€100.000).
- **Shared header/footer:** the site menu and footer are one source of truth in
  [partials/](partials/), stamped into pages between `<!-- FW:INCLUDE … -->`
  markers by `node tools/sync-partials.js`. Edit the **partial**, then re-run the
  sync — never hand-edit the marked block inside a page (see [docs/partials.md](docs/partials.md)).
- **SEO heads are generated too:** each page's title/description/canonical/OG
  block sits between `<!-- FW:HEAD … -->` markers, stamped by the same sync from
  [worker/lib/pages-meta.mjs](worker/lib/pages-meta.mjs) — edit **that registry**,
  not the markers. Listing detail pages get their head injected per-request by
  the Worker. Internal links use clean root-absolute URLs (`/properties`, never
  `properties.html`) and each page has exactly one `<h1>`. See [docs/seo.md](docs/seo.md).

## Windows / editing gotchas

- Shell is **PowerShell**; a Bash tool is also available. No `python`; `node`
  exists but often not on PATH (see above).
- HTML files are **UTF-8 (no BOM), LF line endings, TAB indentation**. Keep it.
- When scripting edits that contain **Greek text via PowerShell**, the `.ps1`
  must be saved **UTF-8 with BOM** or Windows PowerShell 5.1 mangles the Greek.
  Write files with `UTF8Encoding($false)` (no BOM) to match the repo.
