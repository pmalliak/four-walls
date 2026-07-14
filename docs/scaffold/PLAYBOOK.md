# Static template → production site on Cloudflare — a reusable playbook

A field guide for turning a **purchased HTML template** (or any no-build static
site) into a **production website hosted on a single Cloudflare Worker**, with
live data, real SEO, i18n, forms, maps, and a clean DNS cutover — **no backend
server, no build step, no `package.json` required**.

Distilled from the Four Walls project (a "Homy" real-estate template →
`four-walls.gr`). Written generically so you can lift it into the next project;
the **Reference implementation** table at the bottom maps each pattern to the
real file that proves it. Sections 1–4 + 11 are the sequential build; 5–10 are
the cross-cutting depth (URLs, i18n, forms, perf, features, Cloudflare usage).

---

## 0. The core idea

> **One Cloudflare Worker hosts the static assets *and* is the whole backend.**

Everything a small/medium content site needs — hosting, a data feed, per-page
SEO, redirects, a contact endpoint, anti-bot — fits in **one Worker + one KV
namespace**. No origin server, no container, no separate API app. The Worker sits
in front of the static assets (`run_worker_first`) so it can intercept any route
before falling through to the file on disk.

```
                        ┌───────────────────────────────────────────┐
   External data ──────▶│  Cloudflare Worker (worker/index.mjs)      │
   (CRM / API)          │                                            │
     ▲  │ webhook       │  • serves static assets (repo = the site)  │
     │  │               │  • POST /webhook  → refetch data → KV      │
     │  └── nightly cron │  • GET /data.json → serve feed from KV     │
     │                  │  • GET /item/<id> → inject per-item SEO     │
   visitors ───────────▶│  • /sitemap.xml, /robots.txt (generated)   │
                        │  • POST /api/contact → Turnstile + relay    │
                        └───────────────────────────────────────────┘
                                          │
                                   Workers KV (feed cache)
```

**Why this shape wins for this class of site:** zero cold starts, global edge,
free/cheap at low traffic, one deploy artifact, one place to reason about
routing, and the static template keeps working untouched because the Worker only
*adds* behaviour on specific paths. The last line of `fetch` is always
`return env.ASSETS.fetch(request)`; everything above it is the "backend."

---

## 1. Make the no-build template maintainable

A purchased template is dozens of near-identical HTML files with copy-pasted
headers, footers, and `<head>` blocks, plus a lot of demo cruft. Fix that
**without introducing a build step**.

### 1a. Marker-based code generation (includes + templated `<head>`s)

A tiny Node script stamps canonical fragments into every page between
HTML-comment markers — the two things a static template most badly lacks:

```html
<!-- FW:INCLUDE header — generated; edit partials/header.html -->
    …canonical header…
<!-- /FW:INCLUDE header -->

<!-- FW:HEAD — generated from pages-meta; edit there -->
    …title / description / canonical / OG / Twitter / hreflang…
<!-- /FW:HEAD -->
```

- **One source of truth per shared region.** Canonical header/footer in
  `partials/*.html`; a per-page metadata registry (`title`, `description`,
  canonical `path`) in one module. A script copies them into each page.
- **Markup stays physically in every page** (stamped, not runtime-injected) — so
  template JS keeps working and there's **no flash on load**.
- **Rule:** edit the *partial* or the *registry*, then re-run the sync. Never
  hand-edit inside the markers (a re-run overwrites them).
- The **same registry feeds `sitemap.xml`** (a Worker route), so SEO metadata
  never drifts between the page `<head>` and the sitemap.
- Per-page dynamic bits (nav "current page" highlight) are done at runtime in
  your own JS, so the shared fragment needs zero per-page edits.
- First run bootstraps the partials from a source page and self-installs the
  markers (removes the old hand-written head lines); never overwrites an existing
  partial. Adding a page = add its filename to the tool's `PAGES` list + a
  registry entry, then re-run.

### 1b. Override, never edit the theme + strict asset load order

- Keep customizations in **your own CSS/JS files that load *after* the theme** so
  they always win: `theme.min.css → yours.css`, `theme.js → yours.js →
  feature.js`. Never patch the minified theme build — override it.
- Mark your own assets with a consistent suffix (we used `.fw`) so they're
  obvious at a glance vs. stock template files.
- The custom stylesheet is one flat sheet of **targeted overrides of existing
  template classes** (recolor/re-layout), organized by UI region — *not* bespoke
  components. Adapt what the template already ships.

### 1c. Template dead-code / cruft removal

Purchased templates carry demo features and stale references. What we stripped
(each is a class of thing to look for):

- **Live external `<script>` dependencies** — the template loaded an html5shiv
  from a dead `http://` googlecode URL on every page. Remove or gate legacy
  polyfills inside `<!--[if lt IE 9]>` conditionals modern browsers never fetch.
- **Unused SaaS-demo features** — a fake "owner login" prompt on listing pages.
- **Accidentally-shipped scaffolding** — a full sitemap left inline on service
  pages; leftover `.orig` theme sources; temporary debug/CRM-lookup Worker routes
  (label temp routes `TEMPORARY` and delete them after use).
- Re-compress oversized template images (a doodle went 331 KB → 226 KB).

### 1d. Deploy-exclusion strategy (`.assetsignore`)

**Commit the whole purchased template** so every page stays raw material, but
gate the deploy with `.assetsignore` (gitignore syntax, read by Wrangler). Ship
only adapted pages + minified runtime; exclude, by category:

- **Unadapted demo pages** (`listing_*`, `index-2..8`, `agent*`, `blog_*`,
  `pricing_*`, preview scratch files) — kept as reference, never served/linked.
- **Theme sources & sourcemaps** (`scss/`, `css/*.map`, un-minified `style.css`).
- **Unused vendor CSS** (icon fonts that actually load via the minified bundle).
- **Dev helpers, tooling, docs, secrets** (`worker/`, `tools/`, `docs/`,
  `data/`, `partials/`, `.dev.vars`, dev-only autofill helper, brand PDF).

---

## 2. Host it on one Worker

`wrangler.toml` essentials:

```toml
name = "my-site"
main = "worker/index.mjs"
compatibility_date = "YYYY-MM-DD"

[assets]
directory = "./"              # the repo root IS the site
binding = "ASSETS"
run_worker_first = true       # Worker sees EVERY request, not just asset misses
not_found_handling = "404-page"   # unmatched path → your branded 404.html (real 404)

[[kv_namespaces]]
binding = "DATA_KV"
id = "…"                      # npx wrangler kv namespace create DATA_KV

[observability.logs]
enabled = true                # queryable logs in the dashboard — no live tail needed
persist = true
[observability.traces]
enabled = true

[triggers]
crons = ["15 3 * * *"]        # nightly reconciliation (§3)

[vars]
# non-secret config here; secrets via `npx wrangler secret put NAME`
```

- `run_worker_first = true` is what lets the Worker own routing (redirects, pretty
  URLs, host guards) for paths that *do* have a matching asset — without it you
  only get 404 handling.
- Keep the `*.workers.dev` URL alive (`workers_dev = true`) — it **bypasses the
  zone's WAF/bot rules**, a guaranteed path for inbound webhooks that a bot-fight
  rule might otherwise block.
- Multiple hostnames, one Worker: use `routes` custom-domains for apex, `www`,
  `dev.*`, and role-specific subdomains (`webhooks.*`, `forms.*`), then branch on
  `url.hostname` inside `fetch` to give each host a different job (see §5, §9).

---

## 3. Live data: external source → KV feed

Pull data from an external system (CRM, PIM, headless CMS, sheet API) into the
site **without the browser ever holding an API key**.

```
source API  ──webhook──▶ POST /webhook ─┐
                                        ├─▶ refetch ALL items ─▶ Workers KV
nightly cron ───────────────────────────┘                          │
                                                                    ▼
browser ── fetch ──▶ GET /data.json  (same origin, no CORS, no key) ┘
```

- **Ignore the webhook payload on purpose.** Treat it as a "something changed"
  *signal*, not data. On any webhook, **refetch the full set** from the source of
  truth. Regeneration is idempotent, so bursts and duplicate deliveries are safe.
- **A nightly cron is the safety net** for missed/failed webhook deliveries — and
  for state changes the source doesn't send events for (an item withdrawn).
  Without reconciliation, deleted items linger.
- **Ack fast, work after.** Return `200` immediately and do the refetch in
  `ctx.waitUntil(...)` so the source never times out and retries a call that
  actually succeeded.
- **Auth for an undocumented sender:** accept the shared secret from several
  places — a `?key=` query param (embed it in the URL you register — always
  works), `Authorization` (raw/Bearer), and custom headers. On a *rejected* call,
  log the header **names** only (never values); the first real delivery reveals
  the sender's actual mechanism, then tighten the check.
- **Adapter isolation:** put all source-specific field mapping in one module
  (`mapItem()`) with a stable *output* schema. Front-end and SEO depend on your
  schema, never the source's. Swapping data sources = rewrite one file. A
  `SAMPLE_DATA=1` var swaps in a sample module so the whole thing runs with no API
  keys; a `snapshot-feed` script can also mirror the live prod feed for realistic
  local work.
- **Feed status honesty:** `503 + Retry-After` until the first generation exists,
  `Cache-Control: max-age=60` after. A missing feed must degrade gracefully (plain
  page), never 5xx the site.
- **Config-driven behaviour via tags/flags in the source**, not deploys. We drove
  "publish this item" (a whitelist tag) and "feature on homepage" (a featured tag,
  most-recently-updated wins) off CRM tags read at feed-build time — so
  non-technical staff control the live site from the tool they already use.
- **Clean the source's content at build time.** CRM/CMS text arrives as messy
  HTML with embedded contact blocks and inline metadata. A `cleanDescription()`
  pipeline: `htmlToText` (block tags → newlines, `<li>` → bullets, decode
  entities) → strip a trailing contact/price block by regex → parse a structured
  "nearby points" line into `[{label, value}]` and remove it from the prose.
  Store clean, structured output; render with `textContent`.

---

## 4. SEO for a client-rendered site

Detail pages render client-side from the feed. **Social/messenger scrapers
(Facebook, WhatsApp, Viber, Slack, Discord) never run JS**, so a JS-built
`<head>` is invisible to them. Fix it at the edge.

### 4a. Per-item SEO injection (HTMLRewriter)

For `GET /item/<code>` the Worker looks the item up in the KV feed
(`kv.get(key, {type:"json", cacheTtl:300})` — 5-min edge cache) and rewrites the
static page shell with **HTMLRewriter**:

- Rewrite `<title>`, `meta[name=description]`, and `head.append(...)` a full SEO
  block: canonical, OG set (image = first item photo, up to 8), Twitter card,
  `og:locale`, and JSON-LD.
- Fetch the shell **without conditional headers** (a `304` has no body to
  rewrite); **delete the shell's `ETag`** (it identifies the un-rewritten file)
  and set your own `Cache-Control`.
- **Keep the injected `<title>` byte-identical to what the client JS sets** so the
  runtime overwrite is a no-op. Achieve it by duplicating the small label maps
  the title is built from on both sides (Worker + client) and keeping them in
  sync deliberately — when one format changes, change the other.

### 4b. JSON-LD `@graph` — the right schema, not `Product`

- Emit a `@graph` of `[RealEstateListing, (Offer|item), BreadcrumbList]` (adapt
  types to your domain). Pick the schema.org type from a small
  category→type map; fall back to a generic type.
- **Never mislabel as `Product`** if your domain isn't a product — Google's
  Product rich-result docs exclude real estate, and mislabeling risks a
  spammy-markup manual action. **"No rich result detected" can be the correct,
  expected outcome** — the goal is clean entity data, not a rich card.
- Conditionals matter: rentals add a `UnitPriceSpecification` (`unitCode:"MON"`);
  a **hidden/price-on-request** item omits the `Offer` node entirely (a price-less
  Offer only warns); fake/placeholder coordinates omit the `geo` node.
- Link the item's `seller`/`provider` to a site-wide `Organization`/business node
  (`@id …/#organization`) that lives in the footer JSON-LD with your exact NAP.
- Serialize JSON-LD with `</` escaped to `<` to be safe inside `<script>`.

### 4c. Discovery — sitemap & robots as Worker routes

- **`/sitemap.xml` is a route, not a file** (dynamic item URLs change every
  rebuild): static pages from the registry (`sitemap:false` opts out) + one `<url>`
  per feed item per language with `<lastmod>` + `xhtml:link` hreflang alternates.
- **`/robots.txt` is host-aware:** production hosts allow crawling (`Disallow:
  /forms/` only) and point at the sitemap; **every other host** (`dev.*`,
  `*.workers.dev`, role subdomains) answers `Disallow: /`. `robots.txt` blocks
  crawling but does **not** deindex an externally-linked page — so also add
  `X-Robots-Tag: noindex` to HTML responses on non-prod hosts.

### 4d. On-page hygiene

Exactly one `<h1>` per page; internal links use clean root-absolute URLs
(`/properties`, not `properties.html` — the latter costs a redirect hop);
descriptive `alt` on content images, empty `alt` on decorative; unknown item
code ⇒ branded **404 with a real 404 status** (fetch the 404 page body, return
status 404 — no soft-404s); feed missing ⇒ plain shell, never 5xx.

---

## 5. URL structure & redirects

Design clean, permanent URLs and **301 every legacy form** so bookmarks and prior
indexing survive the template→production rename. All redirects live in the
Worker's `fetch` as an ordered list, before the asset fallthrough.

- **Canonical origin is one host** (we chose the apex); `www` 301s to it,
  preserving path + query. Use that origin in every canonical/OG/sitemap URL.
- **Pretty resource URLs:** `/properties/<code>` (and the i18n twin
  `/en/properties/<code>`) instead of `detail.html?id=`.
- **301 map categories** (all → clean English paths):
  - old query-string forms: `/property?id=x`, `/en/property?id=x` → `/…/properties/x`;
  - legacy path variants: `/akinita/x`, `/akinito/x`, bare `/akinito`, `/property`;
  - **template file names**: `about_us_01.html` → `/about`, `service_01` → `/services`;
  - **transliterated localized paths** → English slugs: `/service_agora` →
    `/services/buying`, `/oroi_xrisis` → `/terms-of-use`,
    `/politiki_aporritou` → `/privacy-policy` (each with its `.html` twin).
- The preview server resolves extensionless paths to `.html` like production, so
  clean links work locally too.

---

## 6. Localization & internationalization

The site shipped Greek-first with a full English twin. The reusable machinery:

### 6a. One `LANG` bundle per module

Detect language **once** from `<html lang>` at module load, then index every map
by it so the rest of the code sees a flat lookup:

```js
var LANG = /^en\b/i.test(document.documentElement.lang || "") ? "en" : "el";
var STR  = ({ el: {…}, en: {…} })[LANG];        // UI strings
var CAT  = ({ el: {…}, en: {…} })[LANG];        // enum→label maps
```

Every enum from the feed (category, transaction type, features, heating,
condition, energy class, floor names) gets a `{el, en}` map indexed by `[LANG]`.
Lookups fall back gracefully (`CAT[slug] || slug.replace(/_/g," ")`).

### 6b. Numbers & currency via `Intl`, not hand-rolled

`new Intl.NumberFormat(LANG === "en" ? "en-GB" : "el-GR").format(n)` yields the
right thousands separator per locale automatically (`€100.000` for el vs
`€100,000` for en). The `€` symbol is hardcoded (never `$`); the area unit
(` τ.μ.` / ` m²`) and the rent suffix (`/μήνα` / `/month`) come from the `STR`
bundle. Distances swap the decimal mark the same way. **Store raw numbers in the
feed; format at render time by page language.**

### 6c. Additive, nullable `*_en` feed fields with per-field fallback

The feed carries Greek base fields **plus optional** `title_en`, `description_en`,
`location.area_en/city_en`, etc. — `null` wherever no translation exists.
Consumers fall back per field: `(LANG === "en" && l.x_en) || l.x`. Filters search
*both* languages so shared filter links work either way. Adding English is purely
additive — nothing breaks if a translation is missing.

### 6d. `<html lang>`-driven casing + Greek accent rule (locale gotcha)

Setting `<html lang="el">` makes CSS `text-transform: uppercase` apply
**Greek-aware casing, which strips accents** — because Greek capitals take no
τόνος (ΑΝΑΖΗΤΗΣΗ, never ΑΝΑΖΉΤΗΣΗ). When you hand-type already-uppercase Greek,
omit the accents yourself. Every target market has a casing/format quirk like
this — set `lang` correctly and let CSS/`Intl` do the work.

### 6e. Homoglyph normalization for machine-translated text

Auto-translation engines sometimes capitalize English words using **Greek
lookalike capitals** (real Ε/Β/Ο codepoints that *look* Latin) — which read fine
but break search, copy-paste, and screen readers. A `fixHomoglyphs()` step at
feed-map time maps the ~14 confusable capitals to Latin, but **only within a
token that already contains a Latin letter** (so genuinely-Greek words in an
`_en` field are left intact). Run it on every `_en` string.

### 6f. Language pairing derived from the filename, not stored

A page's language and its translation twin derive from the **registry key alone**:
`pageLang(key) = key.startsWith("en/") ? "en" : "el"` and
`alternateKey(key) = key.startsWith("en/") ? key.slice(3) : "en/"+key`. So
`en/about.html ⇄ about.html` can never drift. Every indexable page emits the same
**hreflang triple** (`el`, `en`, `x-default`→primary), and the sitemap mirrors it
as `xhtml:link` alternates. `og:locale` comes from a `{el:"el_GR", en:"en_GB"}`
map.

### 6g. Runtime nav helpers (no per-page edits)

- **`markCurrentPage`** normalizes the current path (strip `#`/`?`, drop `.html`
  and trailing slash, `/index`→`/`) and marks the matching top-level nav `<li>`
  (exact match, or section-parent match `here.startsWith(target + "/")`). EN pages
  need no special-casing because their header carries EN links.
- **Language switcher retarget:** the header ships a static `/ ↔ /en/` fallback
  pill; on DOM-ready, JS reads the head's `<link rel="alternate" hreflang>` and
  retargets the switch to the *exact* twin URL (falling back to a `/en/`
  prefix-toggle when no on-page alternate exists).

**Rule:** content changes are made in *both* languages (page + partial + registry
entry), then re-sync.

---

## 7. Forms & third-party relays

Never let the browser hold a secret or hit a third-party webhook directly.

- **Contact form → `POST /api/contact` on the Worker.** The client renders a
  **Cloudflare Turnstile** widget (`<div class="cf-turnstile" data-sitekey>` +
  the Turnstile `api.js`), reads the `cf-turnstile-response` token, and `fetch`-
  POSTs JSON to `/api/contact`. The Worker (a) verifies the token server-side via
  `challenges.cloudflare.com/turnstile/v0/siteverify`, then (b) relays the message
  to a no-code automation webhook (Make/Zapier/n8n) or email service. **Both the
  Turnstile secret and the relay URL are Worker secrets** — neither reaches the
  browser.
- **Honeypot field** (a hidden `name="website"` input real users never fill): if
  non-empty, return a fake `success` and drop the message silently.
- **Validate + clamp** every field (trim + length cap) before forwarding; match
  field names to whatever the downstream automation expects.
- **Replace the theme's own handler.** Purchased templates wire the form to a
  `contact.php`/jQuery-validate handler — destroy/unbind it before attaching yours.

---

## 8. Performance & optimization

Small, high-leverage wins — mostly *removing* template overhead, not adding
tooling:

- **Load heavy, page-specific deps only where used.** The map library (~1 MB) is
  loaded *only* on the contact page via two extra tags — never in the global
  bundle. Scope big dependencies to the one page that needs them.
- **Reuse the theme's lazy-image pattern** (`<img src=lazy.svg data-src=… class=lazy-img>`)
  so real artwork defers below the fold.
- **Audit template animations/transitions for dead time.** A mobile menu opened
  ~210 ms late because a Bootstrap `.collapsing` height transition ran *before*
  the theme's slide transform; zeroing the height-transition duration cut it to
  ~20 ms. A global `scroll-behavior:smooth` was fighting a JS scroll-to-top; use
  a rAF ease-out with a temporary `scroll-behavior:auto` instead.
- **Kill live external requests the template ships** (the dead-URL html5shiv, §1c)
  — each is a render-affecting round trip.
- **Re-compress oversized template imagery**; ship minified CSS/JS only (§1d).
- **CSS-only responsive fixes** beat JS: safe-area-aware scroll-to-top button,
  flexible desktop stat strips, mobile gallery layout.
- **Precompute slow third-party data offline** (§9a) so the edge does zero
  network for it.

---

## 9. Advanced / optional feature patterns

Reusable subsystems worth stealing wholesale.

### 9a. Offline-precompute for slow / rate-limited APIs

We wanted an OSM "area accessibility" score (walking distance to transit,
errands, schools, leisure) — but the OpenStreetMap **Overpass API is slow and
hangs from inside a Worker**, which would stall every feed rebuild. Pattern:

- **Move the third-party calls into a committed build step** (`tools/build-*.mjs`)
  run on a real machine (throttled, retries across mirrors). It writes a
  **committed data module** (`export const DATA = {…}` keyed by item id).
- **The Worker/edge only reads the keyed lookup table** — zero runtime network,
  no rate limits, instant. Rebuild-and-redeploy when the data changes.
- **Scoring/logic lives in one shared `.mjs`** imported by *both* the build tool
  and the Worker, so they can't diverge.
- Prefer **honest qualitative bands** (`excellent…limited` by metre thresholds)
  over invented 0–100 numbers; make the categories/labels localizable.

### 9b. Branded, keyless, cookie-free map

Instead of a Google Maps iframe (cookies, key, un-brandable): **MapLibre GL** +
**OpenFreeMap** vector tiles (`tiles.openfreemap.org` — no key, no registration,
no cookies) with a **hand-authored GL style spec** in brand colors that renders
**only street-name labels**. Data-attributes on the container (`data-lat/lng/
zoom`) drive it with no JS edits; a DOM-element `Marker` is your own styled SVG
logo pin linking to Google Maps directions; **cooperative gestures** (Ctrl/⌘ +
scroll) stop the map hijacking page scroll; the container's inner HTML *is* the
no-JS/no-WebGL fallback (a plain "open in Google Maps" link), restored on failure.

### 9c. Client-side document tooling as an installable PWA

A separate internal app (`forms/`) for paperwork, **100% client-side, no backend**:

- Installable **PWA** — `manifest.webmanifest` (`display:standalone`, own theme
  color + 192/512 icons, `start_url:/`) + Apple meta tags. Served at a subdomain
  root by rewriting `forms.<domain>/x → /forms/x` in the Worker.
- **Canvas signature capture** (hand-rolled `SignaturePad`: pointer/touch events,
  DPR-aware, `toDataURL('image/png')`).
- **In-browser PDF generation** via vendored **html2pdf.js** (html2canvas +
  jsPDF); a fonts module embeds the non-Latin (Greek) font so the PDF renders
  correctly. Optional submit POSTs `{data, signatures, pdf_base64}` to a webhook.
- **Double-gate dev-only helpers** so they can never ship: a test-autofill script
  is loaded only on `localhost/127.0.0.1/[::1]` **and** listed in `.assetsignore`.

---

## 10. Cloudflare features used (cheat-sheet)

Everything this one platform did, beyond "host the files":

| Feature | Used for |
|---|---|
| **Workers** (`run_worker_first`) | The entire backend: routing, redirects, webhook, feed, SEO, contact relay |
| **Static Assets** binding | Serve the repo as the site; `not_found_handling = 404-page` for a real branded 404 |
| **Workers KV** | Cache the generated data feed (source-of-truth is the CRM; KV is the read cache) |
| **Cron Triggers** | Nightly feed reconciliation (safety net for missed webhooks) |
| **`ctx.waitUntil`** | Ack the webhook in <50 ms, do the refetch after responding |
| **HTMLRewriter** | Inject per-item `<title>`/meta/OG/JSON-LD into the client-rendered shell for scrapers |
| **Turnstile** | Server-verified anti-bot on the contact form (secret never in browser) |
| **Custom Domains / Routes** | apex + `www` + `dev.*` + role subdomains (`webhooks.*`, `forms.*`), one Worker, host-branched |
| **`workers.dev` kept alive** | WAF/bot-fight-free path for the inbound CRM webhook |
| **Observability (Logs + Traces, `persist`)** | Queryable logs in the dashboard — diagnose the first real webhook without a live `wrangler tail` |
| **`.assetsignore`** | Exclude sources/demos/tooling/secrets from the asset upload |
| **DNS (zone on Cloudflare)** | Adding a custom-domain route creates the record; TXT verification for Search Console |

Secrets via `npx wrangler secret put`; non-secret config in `[vars]`; local
secrets in a gitignored `.dev.vars`.

---

## 11. Go-live (DNS cutover)

Do this in order, and **save the old DNS values first** for rollback.

1. **Custom domains → the Worker.** Add apex + `www` (and `dev.*`/`webhooks.*`/
   subdomains). In Cloudflare, adding a custom-domain route *creates* the DNS
   record — so the zone must **not** already hold conflicting `A`/`AAAA`/`CNAME`
   for `@`/`www`; delete the old-host records first.
2. **Canonicalize one origin** and 301 the other to it in the Worker.
3. **Search Console:** verify the domain (DNS TXT), submit the sitemap,
   URL-inspect the home page + one dynamic page, request indexing.
4. **Local business SEO (if applicable):** Google Business Profile with the exact
   NAP that matches your footer JSON-LD — often the single highest-impact action.
5. Bing Webmaster (import from GSC); set social profiles' website field to the
   canonical origin (closes the schema `sameAs` loop); confirm a branded 1200×630
   OG image exists.
6. **Weeks 1–2:** watch GSC Coverage for soft-404s/duplicates and Worker logs for
   dynamic-page 404 volume.

Verify *before* cutover on the `dev.*` / `workers.dev` host:

```bash
curl -s HOST/item/known-id | grep -E 'canonical|og:title|ld\+json'   # SEO injected?
curl -s -o /dev/null -w '%{http_code}' HOST/item/nope                # → 404
curl -s HOST/sitemap.xml | xmllint --noout -                         # valid XML?
```

Social scrapers ignore `robots.txt`, so the Facebook Sharing Debugger works on a
dev URL. Schema validators (validator.schema.org, Rich Results Test **code
mode** — paste curl output) work pre-cutover even while the host is `noindex`.

---

## Cross-cutting principles

- **Prefer overriding the template to editing it.** Your CSS/JS loads last and
  wins; the vendored theme build stays pristine and upgradeable.
- **One source of truth for everything repeated** — nav, footer, SEO metadata,
  the data schema, enum→label maps. Generate/derive the copies; never maintain
  them by hand. Where two sides must agree (Worker title vs client title),
  duplicate deliberately and note the coupling in a comment.
- **Config in the tools people already use.** Publishing/featuring driven by CRM
  tags beats a deploy; titles/descriptions in a registry beat editing 40 files.
- **Secrets live only in Worker secrets.** Never in the repo, never in the
  browser. Non-secret config in `[vars]`; local secrets in a gitignored
  `.dev.vars`.
- **Degrade, don't crash.** Missing feed → plain page. Unknown id → real 404.
  Missing translation → fall back per field. No WebGL → plain map link. No JS →
  the fallback markup is already in the DOM.
- **Push slow/flaky third-party work to a build step**; let the edge read a
  committed lookup table.
- **Keep raw template material, but wall it off** (`.assetsignore`) and never link
  to it.

---

## Gotchas (learned the hard way)

- `run_worker_first = true` is required for the Worker to intercept routes that
  *do* have a matching asset — without it you only get 404 handling.
- Adding a custom-domain route **fails** if the zone already has an `A`/`CNAME`
  for that name. Delete old-host records first; keep a copy for rollback.
- KV is **empty in local `wrangler dev`** and the feed route 503s until a
  webhook/cron/manual rebuild populates it — use sample data or a prod snapshot
  for front-end work.
- HTMLRewriter needs a body to rewrite: fetch the shell **without** conditional
  headers (a `304` is empty) and **strip the shell's `ETag`** from the response.
- Machine-translated text can contain **Greek homoglyph capitals** that look
  Latin — normalize them (§6e) or search/a11y/copy-paste breaks.
- Overpass/OSM and similar APIs **hang from inside a Worker** — precompute offline
  (§9a), don't call them at the edge.
- A raster logo with anti-aliased edges shows a **white fringe on dark
  backgrounds**; rebuild brand marks as vector SVG (extract from the source brand
  PDF with Inkscape `--query-all` for object bboxes — don't font-match).
- Headless Chrome does **not** rasterize PDF *content* via `--screenshot`; use
  Inkscape/poppler for PDFs (headless-browser screenshots are fine for HTML/SVG).
- Currency/number formatting is per-locale — use `Intl.NumberFormat`, store raw
  numbers, format at render time by page language.

---

## Reference implementation (Four Walls)

| Pattern | File(s) |
|---|---|
| One Worker, all routes + redirects | [`worker/index.mjs`](../../worker/index.mjs) |
| Worker + assets config | [`wrangler.toml`](../../wrangler.toml), [`.assetsignore`](../../.assetsignore) |
| Marker-based partial/head codegen | [`tools/sync-partials.js`](../../tools/sync-partials.js), [`partials/`](../../partials/) |
| SEO metadata registry (feeds sync + sitemap + pairing) | [`worker/lib/pages-meta.mjs`](../../worker/lib/pages-meta.mjs) |
| CRM → KV feed: adapter, description cleaning, homoglyph fix, `_en` fields | [`worker/lib/estateprime.mjs`](../../worker/lib/estateprime.mjs) |
| Per-item SEO injection, JSON-LD graph, sitemap, robots | [`worker/lib/seo.mjs`](../../worker/lib/seo.mjs) |
| Client rendering: `LANG` bundle, `Intl` formatting, label maps, filters | [`js/listings.fw.js`](../../js/listings.fw.js) |
| Nav highlight, language-switch retarget, contact-form handler | [`js/fourwalls.js`](../../js/fourwalls.js) |
| Contact relay (Turnstile + Make + honeypot) | `handleContact` in [`worker/index.mjs`](../../worker/index.mjs) |
| Offline OSM accessibility precompute | [`worker/lib/accessibility.mjs`](../../worker/lib/accessibility.mjs), [`tools/build-accessibility.mjs`](../../tools/build-accessibility.mjs) |
| Branded MapLibre map | [`js/map.fw.js`](../../js/map.fw.js), [`docs/components/contact-map.md`](../components/contact-map.md) |
| Client-side PDF forms PWA | [`forms/`](../../forms/) |
| Sample/dev data, local builders | [`worker/lib/sample-listings.mjs`](../../worker/lib/sample-listings.mjs), [`tools/build-listings.mjs`](../../tools/build-listings.mjs), [`tools/snapshot-feed.mjs`](../../tools/snapshot-feed.mjs) |
| Zero-dependency local preview | [`tools/preview-server.js`](../../tools/preview-server.js) |
| Topic docs this generalizes | [`docs/listings-feed.md`](../listings-feed.md), [`docs/seo.md`](../seo.md), [`docs/partials.md`](../partials.md), [`docs/localization.md`](../localization.md), [`docs/brand.md`](../brand.md) |

---

## Reusable checklist for the next project

- [ ] Vendor the whole template; custom CSS/JS load *after* it, `.fw`-suffixed.
- [ ] Strip template cruft (external `<script>`s, demo features, temp routes);
      `.assetsignore` for sources/demos/tooling/secrets.
- [ ] Marker-based sync for header/footer + a `<head>` metadata registry that also
      feeds the sitemap.
- [ ] `wrangler.toml`: assets = repo root, `run_worker_first`, 404 page, KV, cron,
      observability, `workers_dev = true`.
- [ ] Worker `fetch` = ordered route list (host guards → redirects → API/feed/SEO
      → `env.ASSETS.fetch`).
- [ ] Data: webhook (ignore payload, refetch all, ack-then-`waitUntil`) + nightly
      cron + KV cache + `SAMPLE_DATA` toggle + isolated `mapItem` adapter + content
      cleaning.
- [ ] SEO: per-item HTMLRewriter injection (ETag stripped), correct JSON-LD graph
      (not `Product`), sitemap/robots routes, host-aware noindex, one `<h1>`.
- [ ] URLs: pretty resource paths + a 301 map for every legacy/template/localized
      URL; canonical origin + www→apex.
- [ ] i18n: one `LANG` bundle per module, `Intl` formatting, additive `*_en`
      fields with fallback, homoglyph fix, filename-derived hreflang pairs.
- [ ] Forms: `POST /api/…` → Turnstile verify → relay; secrets server-side;
      honeypot; clamp inputs; unbind the theme handler.
- [ ] Perf: page-scope heavy deps, lazy images, audit template transition delays,
      precompute slow APIs offline.
- [ ] Cutover: save old DNS, custom domains, canonical 301, GSC + sitemap, business
      profile, watch logs two weeks.
