# EstatePrime API — condensed reference (what the feed needs)

Distilled from `estateprime-api-doc.yaml` (OpenAPI spec generated from
<https://developers.estateprime.gr>, 2026-07-09) plus live observations.
⚠️ The yaml is truncated at the `ExternalListing` schema — the internal
**`Listing` schema is still missing** and the mapping in
`worker/lib/estateprime.mjs` stays provisional until we have it.

## Basics

- **Base URL:** `https://{subdomain}.estateprime.gr/api` — per-account
  subdomain (config var `ESTATEPRIME_SUBDOMAIN` in wrangler.toml).
- **Auth:** HTTP Basic — `Authorization: Basic base64(publicKey:secretKey)`.
  `Content-Type: application/json` required. Secrets: `ESTATEPRIME_API_KEY`
  (public) + `ESTATEPRIME_API_SECRET`.
- **Envelope:** every list response is
  `{ status, page, total_pages, results_per_page (50), total_results, data: [...] }`;
  single-object responses are `{ status, data: {...} }`;
  errors are `{ status, error_message }`.
- **Dates:** `YYYY-MM-DD HH:MM:SS`, Europe/Athens timezone.

## Listings (what we consume)

- `GET /listings` — paginated. ⚠️ The spec puts `page` and all filters in a
  **JSON request body on GET**, which `fetch()` in Workers/Node cannot send
  (spec-forbidden). curl can (`curl -X GET --data`). The adapter sends
  `?page=N` as a query param instead — **needs live verification**; it
  paginates via `total_pages` and has a repeated-page guard in case the
  param is ignored.
- Filters (body per spec): `search`, `availability`, `category`,
  `subcategory`, `subtype`, `status`, `date_created`. We filter for active
  client-side until body filtering is confirmed.
- `GET /listings/{id}` — full single listing.
- Lookups: `/listings/sources`, `/listings/tags`, `/listings/subtypes`
  (per-language `translations`), `/listings/custom-fields`.
- `GET /locations` — location tree (`level` 1|2|3, `parent_id`), for
  resolving `area_level1/2/3` ids to Greek names.

## Enums

- `Availability`: `sale | rent | auction | shortterm`
- `Category`: `residential | commercial | land | other`
- `Subcategory`: `apartment, maisonette, detached, villa, loft,
  residential_building, apartment_complex, farmhouse, houseboat,
  other_residential, office, store, warehouse, hotel, commercial_building,
  hall, industrial_space, craft_space, other_commercial, plot, parcel,
  island, parking, business, air, other`
- `ListingStatus`: `draft | pending | active | inactive | archived | deleted`
  → the feed keeps only **`active`**.

## Likely Listing fields (inferred from `ExternalListing` — VERIFY)

`id, store_id, status, availability, category, subcategory, price,
price_per_sqm, size, floor, levels, rooms, wcs, bathrooms, kitchens, …` plus
flattened/nested location (`address, area_level1..3, latitude, longitude`).
Unknown: listing code, title/description (possibly per-language
`translations` like subtypes), images. **Do not trust until the real
`Listing` schema lands.**

## Webhook (live-observed 2026-07-09, not in the yaml)

- Token arrives in an **`EstatePrime` request header** (handled in
  `worker/index.mjs` `tokenFrom()`).
- Payload: JSON `{ action, listing_ids }` — treated as a signal only; the
  Worker re-fetches everything.
- No `User-Agent`; sender is a datacenter IP — zone Bot Fight Mode blocks it
  on custom domains, hence the registered URL is the workers.dev one.

## Other resources (exist, unused by the feed)

Calendar, Communication, Contacts, Contracts, Expenses, External Listings,
Files, Incomes, Knowledge Base, Locations, Offers, Reminders (POST only),
Requests, Tasks, Users, Webmail. Support: tech@estateprime.gr.
