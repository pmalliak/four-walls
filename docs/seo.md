# SEO

How the site is made crawlable and shareable, and what still has to happen
off-repo at go-live. Canonical origin everywhere: **`https://four-walls.gr`**
(apex; `www` will redirect to it).

## The three layers

### 1. Static heads — `FW:HEAD` blocks (sync-managed)

Every real page's `<head>` SEO block (title, meta description, canonical,
Open Graph, Twitter card) is **generated**, not hand-written. The single
source of truth is [worker/lib/pages-meta.mjs](../worker/lib/pages-meta.mjs)
(`PAGES_META`: one entry per page with `path`, `title`, `description`).
`node tools/sync-partials.js` stamps each page between
`<!-- FW:HEAD … --> … <!-- /FW:HEAD -->` markers, exactly like the
header/footer partials.

- **Edit titles/descriptions in `pages-meta.mjs`, then re-run the sync** —
  never inside the markers.
- New page? Add it to `PAGES` in the sync tool *and* to `PAGES_META`; the
  markers self-install on first run (the old hand-written head lines are
  removed automatically).
- `akinito.html` is `workerManaged: true`: its static block carries only
  title + description because the Worker injects the rest per listing
  (layer 2) — this is what prevents duplicated OG tags.
- The obsolete `meta keywords` was dropped site-wide on purpose.

The footer partial carries the site-wide `RealEstateAgent` JSON-LD
(`@id: https://four-walls.gr/#organization` — NAP, geo, opening hours,
social profiles). Keep it in sync with the visible footer/contact NAP.

### 2. Per-listing SEO — Worker injection ([worker/lib/seo.mjs](../worker/lib/seo.mjs))

Listing pages are client-rendered, and social/messenger scrapers
(Facebook, Instagram, Viber, WhatsApp) never execute JS. So for
`GET /akinita/<code>` the Worker looks the listing up in the KV feed
(edge-cached 5 min) and rewrites the `akinito.html` shell via
HTMLRewriter:

- `<title>` — **byte-identical** to the client's `document.title` format
  (`js/listings.fw.js` → `initDetail`), so the runtime overwrite is a no-op.
  If one format changes, change the other (`listingTitle` in seo.mjs).
- meta description (CRM description trimmed ~155 chars, or composed),
  canonical, full OG/Twitter set (image = first listing photo),
- JSON-LD `@graph`: `RealEstateListing` + `Offer` (+ `UnitPriceSpecification`
  MON for rentals; hidden price ⇒ no Offer node at all) + `BreadcrumbList`.
  Never `Product` — Google's Product rich-result docs exclude real estate,
  and mislabeling risks a spammy-markup manual action. "No rich results
  detected" in the Rich Results Test is the *expected* outcome; the goal is
  clean entity data.
- Unknown code ⇒ the branded 404 page with a **real 404 status** (no
  soft-404s). Feed missing ⇒ plain shell, never a 5xx.
- Legacy URLs 301 to the canonical form: `/akinito/<x>` and
  `/akinito?id=<x>` → `/akinita/<x>`; bare `/akinito` → `/akinita`.

### 3. Discovery — sitemap.xml + robots.txt (Worker routes)

- `/sitemap.xml` — static pages from `PAGES_META` (+`sitemap: false` opts
  out) plus one URL per feed listing with `<lastmod>`. A Worker route, not
  a file, because listing URLs change on every webhook/cron rebuild.
- `/robots.txt` — host-aware: the production hosts allow crawling
  (`Disallow: /forms/` only) and point at the sitemap; **every other host**
  (`dev.*`, `*.workers.dev`, `forms.*`) answers `Disallow: /`, and their
  HTML responses additionally carry `X-Robots-Tag: noindex`.

## On-page rules the pages follow

- **Exactly one `<h1>` per page** — the banner title (was a theme `<h3>`;
  `css/fourwalls.css` "SEO headings" section reproduces the h3 scale so it
  renders identically). Keep new pages to one h1.
- **Internal links use clean root-absolute URLs** (`/akinita`, `/contact`,
  `/` for home) — never `x.html`, which costs a redirect hop. The preview
  server resolves extensionless paths to `.html` like production does.
- Listing images get descriptive Greek `alt` text at render time
  (card/gallery builders in `js/listings.fw.js`); decorative icons keep
  `alt=""`.
- ~50 unadapted Homy template pages stay in the repo as raw material but
  are excluded from deployment via `.assetsignore` — never link to them
  from real pages.

## Verifying changes

```bash
npx wrangler dev --var SAMPLE_DATA:1          # then seed the feed:
curl -X POST "localhost:8787/listings?key=dev-local-key"

curl -s localhost:8787/akinita/4W-101 | grep -E 'canonical|og:title|ld\+json'
curl -s -o /dev/null -w '%{http_code}' localhost:8787/akinita/nope   # 404
curl -s localhost:8787/sitemap.xml | xmllint --noout -
```

External validators (work pre-cutover): [validator.schema.org](https://validator.schema.org)
and Google's Rich Results Test in **code mode** (paste the curl output —
URL mode is blocked by the dev host's robots until cutover), and the
Facebook Sharing Debugger on a dev listing URL (FB ignores robots.txt).

## Go-live checklist (off-repo, in order)

1. **Apex cutover** — add `four-walls.gr` + `www.four-walls.gr` custom
   domains to the Worker, move DNS off the old host, redirect www → apex.
2. **Google Search Console** — verify the domain property (DNS TXT),
   submit `https://four-walls.gr/sitemap.xml`, URL-inspect `/` and one
   `/akinita/<code>` and request indexing.
3. Re-run the Rich Results Test in URL mode against the apex.
4. **Google Business Profile** with the exact footer NAP (Φραγκίνη 9,
   54624 Θεσσαλονίκη, +30 6907 483 463) — the single highest-impact
   local-SEO action for the agency. Link the site both ways.
5. Bing Webmaster Tools (one-click import from GSC).
6. Set the Facebook/Instagram profile website fields to
   `https://four-walls.gr/` (closes the schema `sameAs` loop).
7. Confirm `images/assets/ogg.fw.png` is a branded 1200×630 social image.
8. Weeks 1–2: watch GSC Coverage (soft-404s, duplicates) and Worker logs
   for `/akinita/*` 404 volume.
