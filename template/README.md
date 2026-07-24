# `template/` — Homy demo pages (reference only, never served)

The unadapted **"Homy"** HTML template as it shipped: the alternate homepages
(`index-2.html … index-8.html`), the `listing_*` / `agent*` / `blog_*` /
`pricing_*` / `project_*` component library, and the template-only images they
use under [`images/`](images/).

**This folder is never deployed.** It is listed in [`../.assetsignore`](../.assetsignore),
so the Cloudflare Worker never serves it — it's raw material we copy from when
building real pages at the repo root.

- Each page has `<base href="/">`, so opened through the local preview server it
  still pulls the shared `/css`, `/js`, `/vendor` and the live site's `/images`
  from the repo root. Images that are template-only resolve from
  `/template/images/…`.
- Cross-links between demo pages (e.g. `href="/listing_02"`) 404 locally — these
  pages are for reading markup/components, not click-through browsing.
- `service_details.html`, `listing_01.html`, `listing_03.html` and
  `listing_details_01.html` are kept in sync with the live header/footer by
  `tools/sync-partials.js`.

See [`../docs/architecture.md`](../docs/architecture.md) → "Reference demos".
