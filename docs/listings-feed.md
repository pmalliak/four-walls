# Listings feed (EstatePrime → Cloudflare Worker → site)

Live listings come from the **EstatePrime CRM** and are served to the site as
a JSON feed. One Cloudflare Worker (`worker/index.mjs`) does everything —
there is **no separate app** for the webhook:

```
EstatePrime CRM ──webhook──▶ POST /webhooks/estateprime ─┐
                                                         │ re-fetch ALL listings
nightly cron (03:15 UTC) ────────────────────────────────┤ from the CRM API
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
- **The nightly cron is the safety net** for missed webhook deliveries.
- **Tag whitelist:** only listings carrying the EstatePrime tag named by the
  `FILTER_TAG` var (currently `spitogatos`) are published. While that tag
  does not exist in the CRM, all active listings are published (graceful
  rollout — the filter arms itself the moment the tag is created).
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

## Deploy & setup (one-time)

```bash
# 1. Create the KV namespace, then paste the returned id into wrangler.toml
npx wrangler kv namespace create LISTINGS_KV

# 2. Secrets (interactive prompts — values never live in the repo)
npx wrangler secret put WEBHOOK_KEY          # e.g. output of: openssl rand -hex 32
npx wrangler secret put ESTATEPRIME_API_KEY  # needed only when SAMPLE_DATA=0

# 3. Deploy (site + webhook + feed, all one Worker)
npx wrangler deploy
```

Then in the Cloudflare dashboard (Workers & Pages → fourwalls-site →
Settings → Domains & Routes) attach the custom domain(s) — e.g.
`four-walls.gr` and/or `webhooks.four-walls.gr`. Until then the Worker
answers at `fourwalls-site.<account>.workers.dev`.

Finally register the webhook in EstatePrime (suggested name
`fourwalls-site-listings-sync`):

```
https://<domain-or-workers.dev>/webhooks/estateprime?key=<WEBHOOK_KEY value>
```

The `?key=` in the URL is the guaranteed auth path. The Worker *also* accepts
the token via `Authorization` (raw or Bearer), `X-Webhook-Token`, or
`X-Api-Key` headers — EstatePrime's own token field is undocumented, so if it
sends one of those with the same secret, that works too.

## Operations

- **Live logs:** `npx wrangler tail`. A rejected webhook call logs the header
  *names* it carried (never values) — use this on the first real EstatePrime
  delivery to discover their token mechanism, then tighten `tokenFrom()` in
  `worker/index.mjs` to just that one spot.
- **Force a rebuild:** `curl -X POST "https://…/webhooks/estateprime?key=…"`.
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
3. Set `SAMPLE_DATA = "0"` in `wrangler.toml`, `npx wrangler deploy`, and
   trigger a rebuild (curl above).
4. Verify EstatePrime fires events for **create, update AND sell/withdraw** —
   without a withdraw event, sold listings linger until the nightly cron.

## Local development

```bash
node tools/build-listings.mjs      # writes data/listings.json (sample data)
npx wrangler dev                   # full Worker at http://localhost:8787
```

The plain preview server (`node tools/preview-server.js`) also serves
`data/listings.json` as a static file once the tool has generated it — enough
for front-end work without wrangler.
