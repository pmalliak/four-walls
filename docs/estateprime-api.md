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
  absolute URLs on `files.estateprime.gr`; publish `original_image ||
  watermark_image` (clean photos on our own site), only where `is_public`.
- **`has_hidden_price`**: when true the feed publishes `price: null`.

## Portals / publication state (NOT exposed)

Probed live 2026-07-16, after the CRM's Spitogatos integration was switched
on. **The API tells you nothing about which portals a listing is published
to.** Don't go looking again — the findings:

- A full raw listing (`GET /listings` *and* `GET /listings/{id}` — the single
  endpoint adds only `price_history`) has **no** portal/publication field.
  Grepping the whole object for `portal|spitogat|publish|syndicat|ilist|export`
  returns nothing.
- **No portals endpoint exists.** `/listings/portals`, `/listings/{id}/portals`,
  `/listings/publications`, `/listings/integrations`, `/listings/channels`,
  `/listings/feeds` all answer `200` — but that is a **router artifact, not a
  real resource**: unknown trailing segments are ignored, so
  `/listings/{id}/bogus-xyz` returns the plain listing and `/listings/bogus`
  returns `data: []`. Verify any "new" endpoint against a nonsense path before
  believing it.
- **`source_id` is a trap.** `/listings/sources` is
  `1=xe.gr, 2=plot.gr, 3=spitogatos.gr`, but it is the **lead source** — where
  the listing came *from* — not a publication target. In the live account it is
  `null` on 114 of 115 active listings. It is **not** "published on Spitogatos".
- **`tags` are hand-maintained labels**, not integration state
  (`/listings/tags` → `2=ilist`, `3=spitogatos`, `7=website-featured`).

Consequence for the feed: the integration pushes **every active listing** to
Spitogatos, so `status === "active"` *is* the publication rule and the feed
publishes all active stock. See [listings-feed.md](listings-feed.md).

## Webhook (live-observed 2026-07-09, not in the yaml)

- Token arrives in an **`EstatePrime` request header** (handled in
  `worker/index.mjs` `tokenFrom()`).
- Payload: JSON `{ action, listing_ids }` — treated as a signal only; the
  Worker re-fetches everything.
- No `User-Agent`; sender is a datacenter IP — zone Bot Fight Mode blocks it
  on custom domains, hence the registered URL is the workers.dev one.

## Contacts (used by the Έντυπα pickers, not by the feed)

`GET /contacts` (paginated, `?search=` works) and `GET /contacts/{id}` back the
CRM pickers in forms/. The live `Contact` carries several fields the spec omits
— `vat_number`, `id_number`, `full_name`, `is_active`, `office_id` — while the
documented `notes` is not returned.

`POST /contacts` (verified by creating contact 72 live, 2026-07-23):

- **Required fields beyond the spec** — the API 400s with `Missing <field>` one
  at a time until all of these are present: `users` (array of user ids,
  `GET /users` → 1=Πάνος, 2=Μάνος), `created_by`, `office_id` (1=Κεντρικό),
  `language_id` (1=Greek), `country` (`"GR"`).
- **Phone `type` uses UI slugs** like `"mobile-personal"`, not the spec's bare
  `"mobile"`.
- **Email key mismatch:** live GET returns `email`, the spec's `ContactInput`
  says `email_address`. Sending both worked; which one the API actually reads
  is untested.
- **Include `is_active: true` in the payload** — a POST without it landed
  «Ανενεργό» (contact 72), and there is **no API way to fix it after the
  fact**: `PUT` → 403, `PATCH` → fake 200 (no effect), and
  `POST /contacts/{id}` is the router artifact — it routes to *create*
  (fails on phone uniqueness). The one-time fix is the CRM UI toggle
  (Επαφή → Βασικές πληροφορίες → pencil → Κατάσταση → Αποθήκευση).
- **Phone numbers are unique** — a duplicate number 400s
  (`Phone number … is already in use`). Useful as a dedupe backstop.
- **`DELETE /contacts/{id}` can answer `200` without deleting** — contact 72
  survived a `200` DELETE intact. Always re-GET to confirm a delete happened.
- `tags` are integer ids from `GET /contacts/tags` (live: 1=ilist, 4=make,
  9=spitogatos, 10=ΖΗΤΗΣΗ, 11=ΑΝΑΘΕΣΗ, 12=claude); there is no
  tag-creation endpoint — new tags are made in the CRM UI. For
  Claude-created Spitogatos leads, send them **in this order**:
  `[12, 9, 10]` (claude, spitogatos, ΖΗΤΗΣΗ) — Panos's preference.
- Claude-created Spitogatos leads are assigned to **Μάνος Χριστινάκης**
  (`users: [2]`, `created_by: 2`) — per Panos, 2026-07-23.
- **Greek names arriving romanized get written in Greek script** with proper
  accents («Christos Papadopoulos» → Χρήστος Παπαδόπουλος); the original
  Latin spelling stays in the notes. Foreign names stay in Latin script.
- Contact sources (`GET /contacts/sources`) are separate from listing sources:
  3=Spitogatos.gr.

Traps that cost real debugging time, all verified 2026-07-17:

- **An unknown id answers `200` with `data: []`**, not 404 — and `[]` is truthy.
- **`custom_fields` comes back as an object keyed by id** (`{"7": "Αντώνιος"}`),
  not the `[{custom_field_id, value}]` array the spec describes. Empty fields
  are omitted entirely.
- **The list endpoint omits `custom_fields`, `tags` and `users`**; only the
  single-contact endpoint returns them.
- **`date_updated` never changes** on edits, native or custom.
- **No update endpoint** — only `GET`, `POST` (create) and `DELETE`.
- **The API rate-limits (`429`)**, threshold undocumented.

Field map, custom-field ids, and the Cloudflare Access setup:
[forms-crm.md](forms-crm.md).

## Communications (used by the Spitogatos lead intake)

`POST /communication` works as documented (verified by creating comm 18 live,
2026-07-24). Required: `channel, user_id, contact_id, store_id, type
("incoming"|"outgoing"), communication_date`. Notes:

- Channels: `1=Κλήση, 2=Email, 3=SMS, 4=Δια ζώσης, 5=Άλλο`. `store_id` is 1.
- **Communications have their own tag namespace** (`GET /communication/tags`):
  live ids `5=make, 8=spitogatos, 15=claude` — different ids from contact tags.
- **Tag order is not preserved** — the API stores/returns tag ids sorted
  ascending regardless of submission order (sent `[15,8]`, got `[8,15]`).
  Same applies to contact tags. Display order in the UI follows tag id.
- **`GET /communication/{id}` answers an empty `500`** even for an existing
  id — read back via the list endpoint (`GET /communication?page=N`) instead.
- **To link a communication to a request, use the internal `POST
  /communication/form`, NOT the public API** (solved 2026-07-24). The public
  `POST /api/communication` with `request_id` → **`500`** (with `requests:[id]`
  → `200` but silently dropped) — broken, reported to EstatePrime. But the CRM's
  own **`POST /communication/form`** (web path, `x-www-form-urlencoded`,
  session-cookie auth, no CSRF) accepts `request_id` and creates a fully-linked
  comm headlessly → `{"success":true,"id":"N","custom_error":null}`. Verified:
  comm created that way read back `contact_id:72, request_id:18`.
  Fields: `create_communication=1`, `type` (incoming/outgoing), `channel`
  (1=Κλήση,2=Email,3=SMS,4=Δια ζώσης,5=Άλλο), `contact_id`, `request_id`,
  `user_id`, `tags[]`, `source_id`, `communication_date` (`DD/MM/YYYY HH:MM`),
  `comments`, `listing_ids[]`, and `create_auto_request=1` (a checkbox that
  auto-spawns a ζήτηση from the comm — leave OFF; we build the ζήτηση
  ourselves). So the whole intake (contact→ζήτηση→comm) is now headless via
  `/api/contacts` + `/requests/form` + `/communication/form`; no UI.
- Spitogatos lead intake convention: one **incoming** communication per lead
  on the contact, `channel: 2` (Email), `user_id: 2` (Μάνος),
  `communication_date` = the notification email's arrival time, tags
  claude + spitogatos, comments = lead summary + Live URL + ζήτηση id. Create
  it **after** the ζήτηση so its id can be named in the comment.

## Requests / ζητήσεις (used by the Spitogatos lead intake)

**Create ζητήσεις via the internal web endpoint, NOT the public API** (nailed
down 2026-07-24). Two facts:

- **The public `POST /api/requests` is broken** — a bare `POST {}` returns `200`
  but creates nothing, and a full body also `200`s without appearing. EstatePrime
  confirmed it's broken for now. Do not use it to create.
- **The CRM's own internal endpoint works headlessly**:
  **`POST /requests/form`** (note: web path, NOT `/api/...`), body =
  **`application/x-www-form-urlencoded`**, authenticated by the **logged-in
  session cookie** (not Basic auth — so call it via a same-origin `fetch` from a
  browser tab that's logged into the CRM, not from a Node/Basic-auth script).
  No CSRF token required. Returns `{"success":true,"id":"N"}`. Verified by
  creating request 19 with the full lead payload — all fields (areas, tags,
  subtype, extra_fields) landed correctly. **This removes the UI form entirely
  — ζητήσεις no longer need browser form-filling.**

Form-encoded field names (from `#request-form`, the complete set):
`save_request=1`, `source_id`, `contact_ids[]`, `user_ids[]`, `tags[]`,
`request_status` (1=Ενεργή), `availability`, `category`, `subcategory[]`,
`subtype[]` (studio=1, γκαρσονιέρα=2), `area_level1[]` `area_level2[]`
`area_level3[]` (**location is REQUIRED — omitting it fails with "missing
location"**), `price_min/max`, `size_min/max`, `has_elevator`, `floor_min/max`,
`elevator_min_floor`, `rooms_min/max`, `is_furnished` (`yes`/`no`),
`heating_type[]`, `heating_source[]`, and boolean feature flags sent as
`name=1` when checked (`has_balcony`, `suitable_for_students`,
`has_air_condition`, `has_storage_room`, `pets_allowed`, … 30+ of them).
`area_level2[]` takes the spitogatos `geographyIds` directly.

Field reference (from request 17/18):
- `source_id` (request sources: **1=Spitogatos.gr, 2=xe.gr** — a third
  namespace, distinct from listing and contact sources), `status`
  (**1=Ενεργή, 2=Ανενεργή**), `availability`, `category`, `subcategories`
  (array of listing subcategory slugs — Studio/Γκαρσονιέρα → `apartment`),
  `subtypes`, `price_min/max`, `size_min/max`, `floor_min/max`, `rooms_min/max`,
  `has_elevator` (bool), `contacts` (array of contact ids), `users`,
  `tags` (request tag ids: **6=make, 13=claude, 14=spitogatos** — a THIRD tag
  namespace), and `locations` (array of `{area_level1, area_level2,
  area_level3}` — resolve area names to ids via `GET /locations`; the 12
  Θεσσαλονίκη-Δήμος subareas live under `area_level1: 108`).
- **`extra_fields`** is where the richer criteria land (object, not array):
  `heating_type: ["individual"]`, `heating_source: ["natural_gas"]`,
  `is_furnished: "yes"`, `features: ["has_balcony",
  "suitable_for_students", …]`. The «Επιπλέον χαρακτηριστικά» checkboxes map
  to `features` slugs.
- Spitogatos lead intake: build the ζήτηση from the email/lead — availability,
  category, subtype, price_max, size, floor, elevator, furnished, heating, and
  features (βεράντα → `has_balcony`, φοιτητικό → `suitable_for_students`) all
  come straight from the lead's structured fields and free-text message. Source
  Spitogatos.gr, assigned to Μάνος, tags claude + spitogatos, contact linked.

## Other resources (exist, unused)

Calendar, Communication, Contracts, Expenses, External Listings, Files,
Incomes, Knowledge Base, Locations, Offers, Reminders (POST only), Requests,
Tasks, Users, Webmail. Support: tech@estateprime.gr.
