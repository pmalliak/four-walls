# Four Walls — documentation

Start with [../CLAUDE.md](../CLAUDE.md) for the high-level map. These docs go
deeper, one topic per file:

> **Deploy = `git push` to `main`.** The Worker is wired to the GitHub repo
> (Cloudflare **Workers Builds**), so pushing builds and deploys on its own —
> live in under a minute, verified 2026-07-24. **Do not run `npx wrangler
> deploy`**; the `wrangler deploy` lines further down are the manual fallback
> for a machine that is logged in, and for first-time setup. Secrets are the
> exception: they are **not** in the repo, so they go in via the Cloudflare
> dashboard (Workers → Settings → Variables and Secrets) or `wrangler secret
> put`, and a **deploy is not needed** for a secret to take effect.

| Doc | What's in it |
|-----|--------------|
| [architecture.md](architecture.md) | The two front-ends, the template's reference demos, key file/folder map |
| [brand.md](brand.md) | Brand colours, logo files, brand-PDF vector-extraction workflow |
| [preview.md](preview.md) | Run the site locally (zero-dependency preview server) |
| [conventions.md](conventions.md) | Where customizations go, the theme build is off-limits, working with `nice-select` |
| [partials.md](partials.md) | Shared header/footer: one source of truth stamped into pages by `tools/sync-partials.js` |
| [localization.md](localization.md) | Greek rules: `lang="el"`, capitals without accents, currency format |
| [environment.md](environment.md) | Windows / PowerShell / file-encoding gotchas |
| [listings-feed.md](listings-feed.md) | Live listings: EstatePrime webhook → Cloudflare Worker → `/data/listings.json` |
| [seo.md](seo.md) | SEO: FW:HEAD blocks, per-listing Worker injection, JSON-LD, sitemap/robots, go-live checklist |
| [estateprime-api.md](estateprime-api.md) | EstatePrime CRM API: auth, listings endpoint, enums, webhook behaviour, contact/communication/request creation |
| [estateprime-crm-ui.md](estateprime-crm-ui.md) | EstatePrime CRM **UI map** for browser automation: when the API can't do it, the «Νέα ζήτηση» form field map, navigation quirks |
| [forms-crm.md](forms-crm.md) | Έντυπα CRM pickers: Access setup, key split, contact field map, upstream limits |
| [forms-submit.md](forms-submit.md) | Έντυπα submit: PWA → Worker → Make router → client email + PDF; the PDF-capture trap |
| [request-closed.md](request-closed.md) | «Ολοκλήρωσα την αναζήτηση»: matchings email → `/request-closed` → Worker → Make → email to info@ |
| [photo-enhance.md](photo-enhance.md) | AI photo enhancement: enhance.html → Worker/R2 → Make (Gemini "Nano Banana") → Google Drive + email; the edit toggles and Make build recipe |
| [components/hero-search.md](components/hero-search.md) | Homepage search bar: fields, responsive layout, price swap |
| [components/contact-map.md](components/contact-map.md) | Contact-page map: branded MapLibre GL style, street-name-only labels, logo pin |

New component write-ups go under [components/](components/).

## Reusable playbook

[scaffold/PLAYBOOK.md](scaffold/PLAYBOOK.md) distills this whole project into a
**generic, portable blueprint** — "static template → production site on one
Cloudflare Worker" (hosting, live data feed, per-item SEO, i18n, forms, DNS
cutover). Copy it into the next project as a starting scaffold; it points back
to the files here as the reference implementation.
