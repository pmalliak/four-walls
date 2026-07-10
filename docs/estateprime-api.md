# EstatePrime API — condensed reference (what the feed needs)

Distilled from `estateprime-api-doc.yaml` (OpenAPI spec generated from
<https://developers.estateprime.gr>, 2026-07-09) plus **live verification
against the fourwalls account** the same day. The yaml is truncated at the
`ExternalListing` schema, but the real `Listing` shape below was captured
from the live API, which beats the spec anyway.

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

- `GET /listings` — paginated; **`?page=N` as a query param works**
  (verified live 2026-07-09; the spec documents `page` in a JSON body on
  GET, which `fetch()` in Workers/Node cannot send — curl can). Paginate
  until `total_pages`. `Content-Type: application/json` is required even
  on GET (415 otherwise); auth errors use the documented envelope (401).
- Filters (body per spec): `search`, `availability`, `category`,
  `subcategory`, `subtype`, `status`, `date_created`. We fetch everything
  and filter `status === "active"` client-side.
- **`?search=` query param** (undocumented, confirmed by EstatePrime
  support 2026-07-10): works at least on `GET /api/contacts?search=…` —
  matches contact details (phone/email) and full name. E.g.
  `GET /api/contacts?search=6985478`. Used by the Make Spitogatos scenario
  for contact dedupe. Likely works on other list endpoints too (untested).
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

## Real `Listing` fields (captured from the live API 2026-07-09)

Key scalars: `id, store_id, code, category, subcategory, subtype,
availability, price, price_per_sqm, size, floor (number), levels, rooms,
bathrooms, wcs, living_rooms, kitchens, year_built, year_renovated,
energy_class, heating_type, heating_source, status, deal_status,
date_created, date_updated, has_hidden_price, is_negotiable, is_rented,
available_from, monthly_maintenance, orientation, youtube_url,
virtual_tour_url, …` and arrays `features` / `view` / `flooring` /
`positioning` (slug strings, e.g. `has_security_door`).

- **`translations`**: `[{ language_id, title, description }]` —
  `language_id` **1 = Greek, 2 = English**.
- **`location`**: nested `area_level1..3` objects (`{id, name_el, name_en,
  full_name_el, full_name_en}`), `postal_code`, `address_el`,
  `latitude/longitude`, **`display_address` ("fake"|…), `fake_address_el`,
  `fake_latitude/fake_longitude`, `show_circle_on_map`** — when
  `display_address` is `"fake"`, only the fake coordinates/address may be
  published (the feed enforces this).
- **`photos`**: `[{ original_image, watermark_image, is_public }]` —
  absolute URLs on `files.estateprime.gr`; publish `watermark_image ||
  original_image`, only where `is_public`.
- **`has_hidden_price`**: when true the feed publishes `price: null`.

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
