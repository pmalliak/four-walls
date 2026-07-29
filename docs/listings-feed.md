# Listings feed (EstatePrime → Cloudflare Worker → site)

Live listings come from the **EstatePrime CRM** and are served to the site as
a JSON feed. One Cloudflare Worker (`worker/index.mjs`) does everything —
there is **no separate app** for the webhook:

```
EstatePrime CRM ──webhook──▶ POST /listings (WEBHOOK_PATH) ─┐
                                                         │ re-fetch ALL listings
15-minute reconcile cron ────────────────────────────────┤ from the CRM API
                                                         ▼
                                              Workers KV: listings.json
                                                         ▲
site JS ────fetch────▶ GET /data/listings.json ──────────┘
every other path ────▶ static assets (repo root)
```

Design rules:

- **The webhook payload is ignored on purpose.** It is a "something changed"
  signal; the Worker re-fetches the full listing set from the API (source of
  truth). Regeneration is idempotent, so webhook bursts are harmless.
- **The 15-minute cron is the main removal path, not just a safety net.**
  EstatePrime fires no webhook on a status-only change (Ενεργό → Ανενεργό,
  verified live 2026-07-30), so a deactivated listing leaves the site on the
  next quarter-hour tick. The cron also covers missed webhook deliveries.
- **Every active listing is published — no whitelist.** The CRM's Spitogatos
  integration pushes all `status: active` stock to the portal, so the site
  mirrors the portal by publishing the same set. (Until 2026-07-16 a
  `FILTER_TAG="spitogatos"` tag whitelist gated the feed; the integration made
  that hand-maintained label redundant and it was removed.) `status` is the
  only publication signal the API offers — see
  [estateprime-api.md](estateprime-api.md#portals--publication-state-not-exposed).
- **«Ακίνητο του μήνα» tag:** the listing carrying the EstatePrime tag named
  by the `FEATURED_TAG` var (currently `website-featured`) is published with
  `featured: true` and fills the home-page banner — so the pick is made in
  the CRM, no deploy needed. If several listings carry the tag, the most
  recently updated wins. Tag missing or nothing tagged → the front-end
  falls back to the hardcoded `FEATURED_ID` in `js/listings.fw.js`, then
  to the newest listing.
- The front-end fetches `/data/listings.json` — same origin, no CORS, no API
  key in the browser.

## Files

| Path | Purpose |
|------|---------|
| `worker/index.mjs` | Worker: routes, webhook auth, feed serving, cron |
| `worker/lib/estateprime.mjs` | CRM API client + field mapping + feed builder |
| `worker/lib/sample-listings.mjs` | Dev data used while `SAMPLE_DATA=1` |
| `tools/build-listings.mjs` | Writes `data/listings.json` locally (same module) |
| `wrangler.toml` | Worker config: assets, KV binding, cron, vars |
| `.assetsignore` | Repo files excluded from the static-asset upload |
| `.dev.vars` | Local-only secrets for `wrangler dev` (gitignored) |

## Feed schema

`GET /data/listings.json` →

```json
{
	"generatedAt": "2026-07-09T12:00:00Z",
	"source": "estateprime | sample",
	"count": 6,
	"listings": [{
		"id": "…", "code": "4W-101", "title": "Διαμέρισμα 85 τ.μ., Καλαμαριά",
		"title_en": "85 m² apartment, Kalamaria",
		"transaction": "sale | rent", "category": "apartment | house | …",
		"price": 185000, "area": 85, "bedrooms": 2, "bathrooms": 1,
		"floor": "2ος", "yearBuilt": 1998,
		"location": { "area": "Καλαμαριά", "city": "Θεσσαλονίκη",
			"area_en": "Kalamaria", "city_en": "Thessaloniki", "lat": 0, "lng": 0 },
		"images": ["…"], "features": ["…"], "description": "…", "description_en": "…",
		"featured": true,
		"updatedAt": "2026-07-01T09:00:00Z"
	}]
}
```

`featured` appears only on the listing(s) tagged `FEATURED_TAG` in the CRM
(home-page banner); all other listings omit the key.

The `*_en` fields (`title_en`, `description_en`, `location.area_en`,
`location.neighbourhood_en`, `location.city_en`) are **optional and additive**:
they carry the CRM's English translation (`translations[].language_id 2`,
`name_en` area fields) and are `null` wherever no English exists. Consumers
must fall back to the Greek field — the English site does this per field.

Prices are raw numbers — € formatting with `.` thousands separators happens at
render time (see [localization.md](localization.md)).

`features` / `view` / `positioning` / `flooring` pass through as **raw CRM
slugs** (`has_balcony`, `is_through`, `ceramic_tile`, …). The front-end turns
them into the «Παροχές & χαρακτηριστικά» list through the `FEATURES` map in
`js/listings.fw.js`, which carries all 57 slugs the account uses in both
languages. **A slug missing from that map is not rendered** — the earlier
fallback (strip the `has_`/`is_` prefix, underscores to spaces) leaked raw
English onto Greek pages («air condition», «through», «luxurious»). If an
amenity stops showing up, add it to both maps; see
[estateprime-api.md](estateprime-api.md#real-listing-fields-captured-from-the-live-api-2026-07-09)
for the sweep that enumerates the vocabulary.

## Deploy & setup (one-time)

```bash
# 1. Create the KV namespace, then paste the returned id into wrangler.toml
npx wrangler kv namespace create LISTINGS_KV

# 2. Secrets (interactive prompts — values never live in the repo)
npx wrangler secret put WEBHOOK_KEY          # e.g. output of: openssl rand -hex 32
npx wrangler secret put ESTATEPRIME_API_KEY  # needed only when SAMPLE_DATA=0

# 3. Deploy (site + webhook + feed, all one Worker) — first time only;
#    afterwards a git push to main deploys (Workers Builds, see README.md)
npx wrangler deploy
```

Then in the Cloudflare dashboard (Workers & Pages → fourwalls-site →
Settings → Domains & Routes) attach the custom domain(s) — e.g.
`four-walls.gr` and/or `webhooks.four-walls.gr`. Until then the Worker
answers at `fourwalls-site.<account>.workers.dev`.

Finally register the webhook in EstatePrime (suggested name
`fourwalls-site-listings-sync`):

```
https://<domain-or-workers.dev>/listings?key=<WEBHOOK_KEY value>
```

The path comes from the `WEBHOOK_PATH` var in `wrangler.toml` (currently
`/listings`); the registered production URL is
`https://webhooks.four-walls.gr/listings`.

The `?key=` in the URL is the guaranteed auth path. The Worker *also* accepts
the token via `Authorization` (raw or Bearer), `X-Webhook-Token`, or
`X-Api-Key` headers — EstatePrime's own token field is undocumented, so if it
sends one of those with the same secret, that works too.

## Operations

- **Live logs:** `npx wrangler tail`. A rejected webhook call logs the header
  *names* it carried (never values) — use this on the first real EstatePrime
  delivery to discover their token mechanism, then tighten `tokenFrom()` in
  `worker/index.mjs` to just that one spot.
- **Force a rebuild:** `curl -X POST "https://…/listings?key=…"` (the
  production `WEBHOOK_KEY` — the value in `.dev.vars` is a dev placeholder).
- **Feed status:** `GET /data/listings.json` returns 503 until the first
  generation (webhook, cron, or manual curl above).

## Switching from sample data to the live API

`worker/lib/estateprime.mjs` is an **unverified adapter** — the API docs at
<https://developers.estateprime.gr> need a login. Once readable:

1. Confirm/fix everything marked `TODO(estateprime-docs)`: base URL, listings
   endpoint + pagination, auth header, response envelope, field names in
   `mapListing()`. Keep the *output* schema unchanged.
2. Test locally: `ESTATEPRIME_API_KEY=… node tools/build-listings.mjs`, then
   eyeball `data/listings.json`.
3. Set `SAMPLE_DATA = "0"` in `wrangler.toml`, push to `main` (that deploys),
   and trigger a rebuild (curl above).
4. Verify EstatePrime fires events for **create, update AND sell/withdraw** —
   verified 2026-07-30: a status-only change (Ενεργό → Ανενεργό) fires **no
   webhook**, which is why the cron runs every 15 minutes (see
   [estateprime-api.md](estateprime-api.md#webhook-live-observed-2026-07-09-not-in-the-yaml)).

## Local development

```bash
node tools/build-listings.mjs      # writes data/listings.json (sample data)
node tools/snapshot-feed.mjs       # mirrors the LIVE prod feed (real listings, no API keys)
npx wrangler dev                   # full Worker at http://localhost:8787
```

The plain preview server (`node tools/preview-server.js`) serves
`data/listings.json` as a static file once one of the tools above has written
it — enough for front-end work without wrangler. Use `build-listings.mjs` for
sample data or `snapshot-feed.mjs` to develop against the real production
stock. (`data/listings.json` is gitignored — local only.)

Note `npx wrangler dev` serves the feed from KV, which starts **empty** locally
and 503s until a webhook/cron/manual rebuild populates it; the preview server +
a snapshot is the friction-free path for front-end work.
