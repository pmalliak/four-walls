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

- **Amenity vocabulary.** There is no lookup endpoint for these slugs
  (`/listings/custom-fields` returns `[]`), so the only way to enumerate them
  is to sweep the listings. Across all 130 listings on 2026-07-29 the account
  used **57** distinct slugs: 43 `features`, 4 `view` (`city, mountain,
  openspace, sea`), 5 `positioning` (`is_corner, is_front_facing, is_interior,
  is_three_sided, is_through`), 5 `flooring` (`ceramic_tile, marble, mosaic,
  tile, wood` — note `tile` and `ceramic_tile` are separate options). The
  Greek/English labels for all 57 live in the `FEATURES` map in
  `js/listings.fw.js`, which **drops anything it cannot translate** rather
  than printing the raw slug. Re-run the sweep if the office adds a checkbox:

  ```bash
  curl -s -H "Authorization: Basic <base64 key:secret>" \
    -H "Content-Type: application/json" \
    "https://<subdomain>.estateprime.gr/api/listings?page=1"   # …2, 3
  ```

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
  (`/listings/tags` → `2=ilist`, `3=spitogatos`, `7=property-of-the-month`
  — tag 7 was renamed from `website-featured` in the CRM UI 2026-07-31;
  ids are stable across renames, names are not, so anything matching by
  **name** (the Worker's `FEATURED_TAG` var) must follow a rename).

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
- **A status-only change fires NO webhook** (verified live 2026-07-30:
  Ενεργό → Ανενεργό and back, the API showed the new `status` within
  seconds but nothing called the Worker). Deactivated listings therefore
  leave the site only via the 15-minute reconciliation cron. Which actions
  DO fire the webhook is still unmapped (one arrived 2026-07-29 23:50 EEST,
  likely from a field edit).

## Contacts (used by the Έντυπα pickers, not by the feed)

`GET /contacts` (paginated, `?search=` works) and `GET /contacts/{id}` back the
CRM pickers in forms/. The live `Contact` carries several fields the spec omits
— `vat_number`, `id_number`, `full_name`, `is_active`, `office_id` — while the
documented `notes` is not returned.

`POST /contacts` (verified by creating contact 72 live, 2026-07-23):

- **Required fields beyond the spec** — the API 400s with `Missing <field>` one
  at a time until all of these are present: `users` (array of user ids,
  `GET /users` → **1=Αφεντούλα Στεφάνογλου** (`info@four-walls.gr`, η
  γραμματεία — το seat ήταν του Πάνου μέχρι τον 8/2026 και άλλαξε πρόσωπο
  αντί να αγοραστεί τρίτο· ο user id είναι ο ίδιος, οπότε **παλιές εγγραφές
  με `created_by: 1` εμφανίζονται πλέον ως Αφεντούλα**), 2=Μάνος
  Χριστινάκης), `created_by`, `office_id` (1=Κεντρικό),
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
  9=spitogatos, 10=ΖΗΤΗΣΗ, 11=ΑΝΑΘΕΣΗ, 12=ai, 16=ΥΠΟΔΕΙΞΗ, 17=website,
  19=ΠΙΝΑΚΙΔΑ — the last one new 2026-08-02);
  there is no tag-creation endpoint — new tags are made in the CRM UI.
  Tag 12 was named `claude` until 2026-07-31 (renamed to `ai`, same id);
  17=website is new the same day. For AI-created Spitogatos leads, send
  them **in this order**: `[12, 9, 10]` (ai, spitogatos, ΖΗΤΗΣΗ) —
  Panos's preference.
  Make-created leads always carry `spitogatos` too, see
  [spitogatos-leads.md](spitogatos-leads.md).
- Claude-created Spitogatos leads are assigned to **Μάνος Χριστινάκης**
  (`users: [2]`, `created_by: 2`) — per Panos, 2026-07-23.
- **Greek names arriving romanized get written in Greek script** with proper
  accents («Christos Papadopoulos» → Χρήστος Παπαδόπουλος); the original
  Latin spelling stays in the notes. Foreign names stay in Latin script.
- Contact sources (`GET /contacts/sources`) are separate from listing sources:
  3=Spitogatos.gr, 4=Ενοικιαστήριο/Πωλητήριο (the one street-sign leads use).
- **Street-sign leads are a contact convention, not a contact type.** They are
  created surnamed **«ΠΙΝΑΚΙΔΑ»** with the address as the given name, owned by
  user 1, tags `[12, 4, 19]`, source 4 — see
  [pinakides.md](pinakides.md) for the body and the five brakes, and
  [forms-crm.md](forms-crm.md) for why they are filtered out of the Έντυπα
  pickers. `is_lead: true` is set but is **not** what hides them: the API
  ignores it as a filter (see below), so the surname is the marker.

Traps that cost real debugging time, all verified 2026-07-17:

- **An unknown id answers `200` with `data: []`**, not 404 — and `[]` is truthy.
- **`custom_fields` comes back as an object keyed by id** (`{"7": "Αντώνιος"}`),
  not the `[{custom_field_id, value}]` array the spec describes. Empty fields
  are omitted entirely.
- **The list endpoint omits `custom_fields`, `tags` and `users`**; only the
  single-contact endpoint returns them.
- **`GET /contacts` ignores every query param except `?search=`** (probed live
  2026-08-02: `?is_lead=1` returns exactly the same 221 rows as
  `?bogus_param=1`). Any filtering happens on our side, after the fetch.
- **`date_updated` never changes** on edits, native or custom.
- **No update endpoint in the public API**: only `GET`, `POST` (create) and
  `DELETE`. Edits go through the CRM's own page endpoint, see below.
- **The API rate-limits (`429`)**, threshold undocumented.
- **POSTs from a Cloudflare Worker get `403 {"error_message":"Access
  denied."}`** (2026-07-30) — every write attempt from the four-walls
  Worker was refused regardless of User-Agent (none, custom, and
  browser-shaped all tried), while **GETs from the same Worker pass**
  (the feed and the Έντυπα pickers run on them daily) and the identical
  POST from node or Make succeeds. Whatever their edge keys on
  (`cf-worker` subrequest header / Workers egress), it is not something
  the Worker controls: **route CRM writes through Make** (the site lead
  forms do) or any non-Worker runtime.

### Editing a contact: `POST /contacts/view/{id}` (internal, mapped 2026-07-29)

The public API cannot update a contact, but the detail page saves through a
same-origin POST **to its own URL** (session cookie, urlencoded, no CSRF, the
same family as `/requests/form`). One section per request, keyed by
`edit_contact`:

- `edit_contact=basics` → `type` (1=person, 2=company), `is_client`/`is_active`
  (checkboxes, send `on` or omit), `company_name`, `company_details`,
  `first_name`, `last_name`, `vat_number`, `id_number`, `country`,
  `language_id`, `store`, `source_id`, `referral_id`, `tags[]`.
  **Send the whole section**: omitted fields are cleared, not kept.
- `edit_contact=phones` → existing rows are keyed by phone id
  (`phone_type[86]`, `phone[86]`, `phone_notes[86]`), new ones use the
  `new_phone_type[]` / `new_phone[]` / `new_phone_notes[]` arrays;
  `deleted_phones` is a comma-separated id list. `emails` mirrors this.
- Other sections: `notes`, `members`.
- Reading the current values first: `POST /contacts/view/{id}` with
  `show_edit=<section>` returns `{success, html}`, the modal's markup, which
  serializes to exactly the body the save expects.
- Answers `{"success":true,"type":"<section>"}`. Verified on contacts 214 + 64.
- **Deleting a contact headlessly**: the UI's «type this random number»
  modal is client-side theatre — the real delete is a bare same-origin
  `POST /contacts/view/{id}` with `delete_contact=true` (session cookie,
  no CSRF), answering `{"success":true}`. Soft-delete: a «Deleted contact»
  stub remains but searches stop matching it. Verified on contacts 215/216
  (2026-07-30). This is the working alternative to the public
  `DELETE /api/contacts/{id}`, which 200s without deleting.

### ⚠️ Default (κύριο) email/κινητό: the API never sets it (2026-07-30)

`POST /api/contacts` creates the phone/email rows **without** the default flag —
whoever the client (Make, prep.mjs, site-requests.mjs). Only UI-created contacts
get it. The flag is invisible in every API read; it only shows on the contact
page as the star per row (`.star-email/.star-phone`, `fa-star` filled = default,
`fa-star-o` outline = none — the CSS classes also appear in scripts/styles, so
grep the DOM, not the HTML).

Why it matters: the listings mass action «Αποστολή με Email» (`POST /listings`,
`mass_actions=send_listing_email` — `simulate: 1` for the dry check the modal
runs) answers **HTTP 500** for any recipient contact without a default email, so
the modal's «Αποστολή» button never enables. That was the «τα πρότυπα φταίνε»
scare of 2026-07-30 — the templates were fine.

Setting it: the star's own endpoint, same-origin session POST (no CSRF):
`POST /contacts/view/{id}` with `star_email=<address>` or `star_phone=<number>`
(the row's exact stored value) → `{"success":true}`. There is **no way through
the public API**, and no default control inside the `edit_contact=phones/emails`
modal — though re-saving those sections also happens to star the first row.

**A Make scenario can never do this** (probed 2026-08-04). The `/contacts/view/`
path sits behind Cloudflare bot protection: a POST from node answers
`403 «Just a moment…»` both with Basic auth and without, so it is not a matter
of finding the right credentials. Only a real logged-in browser gets through,
which is why the fix stays a local CDP script and why every Make-created contact
keeps arriving default-less. `fix-contact-defaults.mjs` takes `--ids` / `--last N`
for a quick pass over just the newest contacts after a lead batch.

All 211 existing contacts were audited + fixed on 2026-07-30 (134 needed it).
New skill-created contacts are starred by `crm-post.mjs` (the worklist carries
`star:{email,phone}` for created contacts); **Make-created contacts keep arriving
default-less** — re-run
`.claude/skills/spitogatos-requests-fetch/scripts/headless/fix-contact-defaults.mjs`
(supports `--dry`) after busy lead periods, until EstatePrime makes the API set
the flag (ticket asked 2026-07-30).

Field map, custom-field ids, and the Cloudflare Access setup:
[forms-crm.md](forms-crm.md).

## Communications (used by the Spitogatos lead intake)

`POST /communication` works as documented (verified by creating comm 18 live,
2026-07-24). Required: `channel, user_id, contact_id, store_id, type
("incoming"|"outgoing"), communication_date`. Notes:

- Channels: `1=Κλήση, 2=Email, 3=SMS, 4=Δια ζώσης, 5=Άλλο`. `store_id` is 1.
- **Communications have their own tag namespace** (`GET /communication/tags`):
  live ids `5=make, 8=spitogatos, 15=ai (πρώην claude), 18=website,
  20=ΠΙΝΑΚΙΔΑ` — different ids from contact tags, and ΠΙΝΑΚΙΔΑ is the clearest
  example: **19** as a contact tag, **20** as a communication tag.
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
- **Editing an existing communication: `POST /communication`** (internal, mapped
  2026-07-29). `generate_edit_modal={id}` returns `{success, html, users_data,
  tags_data, contact_id}` with the populated form; saving posts the same fields
  back with **`edit_communication={id}`**: `type`, `channel`,
  `communication_date` (`DD/MM/YYYY HH:MM`), `user_id`, `comments`,
  `contact_id`, `request_id`, `listing_ids[]`, `tags[]`. Returns
  `{"success":true,"id":N}`. Note the date loses its seconds (the field is
  minute-precision). Verified on comm 155.
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
  `tags` (request tag ids: **6=make, 13=ai (πρώην claude), 14=spitogatos** —
  a THIRD tag namespace), and `locations` (array of `{area_level1, area_level2,
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
  Spitogatos.gr, assigned to Μάνος, tags ai + spitogatos, contact linked.

### Κατάσταση & στάδιο ζήτησης: `POST /requests/view/{id}` (mapped 2026-08-06)

Δύο **ξεχωριστά** πράγματα, δύο badges στη σελίδα της ζήτησης, δύο κλήσεις
same-origin στο ίδιο URL (session cookie, no CSRF, urlencoded, απαντούν
`{"success":true}`). Τίποτα από τα δύο δεν υπάρχει στο public API (`PUT` 403,
`PATCH` ψεύτικο 200) και **το `GET /api/requests/{id}` δεν επιστρέφει καν το
στάδιο** — επαλήθευσέ το από τη σελίδα (`.deal-status-btn`, `currentDealStatus`).

- **Κατάσταση** (`.request-status-btn`): `change_status=1|2` — 1=Ενεργή,
  2=Ανενεργή. Αυτή είναι που τη βγάζει από τις ενεργές ζητήσεις.
- **Στάδιο** (`.deal-status-btn`): `change_deal_status=<key>`, και για τα κλειστά
  στάδια (`lost`, `withdrawn`) **υποχρεωτικό** `close_reason=<id>`.
  Στάδια: `open` Ανοιχτό · `under_offer` Σε προσφορά · `negotiation` Σε
  διαπραγμάτευση · `under_contract` Σε συμβόλαιο · `won` Κερδισμένο ·
  `lost` Χαμμένο · `withdrawn` Αποσύρθηκε.
  Λόγοι `withdrawn`: 1 σταμάτησε την αναζήτηση · 2 δεν απαντά · 3 οικονομικοί ·
  4 μη έγκυρη καταχώρηση · **5 διπλή καταχώρηση** · 6 άλλος.
  Λόγοι `lost`: 7 βρήκε μόνος του · 8 βρήκε μέσω άλλου γραφείου · 9 ανατέθηκε
  αποκλειστικά αλλού.

Το `crm-post.mjs` στέλνει **και τα δύο** όταν μια ζήτηση αντικαθίσταται από
νεότερη του ίδιου πελάτη: ανενεργή + «Αποσύρθηκε / Διπλή καταχώρηση», γιατί μια
ανενεργή ζήτηση που έμεινε «Ανοιχτό» μοιάζει με δουλειά που ξεχάστηκε.
Επαληθεύτηκε στις ζητήσεις 188/147/41/37.

### Γλώσσα επαφής: το `language_id: 2` δουλεύει, απλώς δεν φαίνεται (2026-08-06)

Το `<select name="language_id">` του modal «Βασικές πληροφορίες» έχει **μόνο**
`1=Ελληνικά`, αλλά και το `POST /api/contacts` και το `edit_contact=basics`
δέχονται `2` και η επαφή εμφανίζει «English (UK)» (ίδια αρίθμηση με τα
`translations` των listings). Το βάζουμε αυτόματα σε κάθε επαφή με **ξένο
τηλέφωνο**, εκτός Κύπρου (+357, ελληνόφωνη).

### Ματσαρίσματα ζήτησης — το tab «Ακίνητα» (mapped 2026-07-27)

The matchings the CRM shows under a ζήτηση live at `/requests/listings/{id}`
(«Ακίνητα(N)» tab). **The public API exposes none of this** — `GET /api/requests`
returns criteria only (130 requests / 115 Ενεργές on 2026-07-27). The tab's data
comes from the **listings datatable endpoint** and works headlessly with the
session cookie (same auth family as `/requests/form`):

- **`POST /listings`** (web path, `application/x-www-form-urlencoded`,
  `X-Requested-With: XMLHttpRequest`). Minimal verified body:
  `draw=1&start=0&length=50&tableData[show-table]=1&
  tableData[listing_status]=active&tableData[request_id]={id}&
  tableData[request_listing_filter]=new`.
- `request_listing_filter` values (the tab pills' `data-filter`):
  **`all | new | proposed | rejected`**. An unrecognized value (tried
  `suggested`) did not error — don't trust unknown values, they behave like
  no filter.
- Response is datatable JSON: `recordsTotal`, `data[]` of **HTML cell
  snippets**. Each row carries **`request_status`** (text «Νέο» /
  «Προτεινόμενο» / …) — this is the per-request matching status — plus the
  usual cells (`code` links to `/listings/view/{id}`, `price`, `size`,
  `location`, `deal_status` badge…). Strip tags to read values.
- `count_per_status` in the response counts **listing** statuses
  (active/draft/…), NOT matching statuses.
- «Σήμανση ως Προτεινόμενα» on the tab calls `proposeWithoutEmail()` — flips
  Νέο → Προτεινόμενο without emailing the client (not yet driven headlessly).

## Document templates / Ψηφιακά Έντυπα (internal web endpoints, mapped 2026-07-25)

`/settings/document-templates` lists the templates (1 = Υπόδειξη ακινήτου,
2 = Ανάθεση ακινήτου); the editor lives at
`/settings/document-templates/view/{id}/{lang}` (lang **1 = Greek, 2 = English**).
Not part of the public API — same-origin POSTs with the session cookie, no CSRF
(like `/requests/form`). All three actions POST **to the view URL itself**,
`application/x-www-form-urlencoded`:

- `load_template=true` → `{success, html, email_html, sms_content, variables,
  fields, sections_listings, sections_contacts, signature_not_required}`.
  **No subject in the response** — the email subject only exists as the
  `#email-subject-input` value in the page HTML.
- `preview=true&subject=…&html=…&variables=<json>` → server-side Twig render,
  `{success, html, subject}` or `{success:false, error}` — good for validating a
  template before saving.
- `save=true&content=…&subject=…&email_content=…&sms_content=…&fields=<json>&
  sections_listings=0|1|2&sections_contacts=0|1|2&signature_not_required=0|1`.

Templates are **Twig** extending `document-sign-base.twig` (`{% block styles %}`
+ `{% block body %}`); the base appends the signature footer + sign-pad UI, and
the final PDF is **browser-rendered** (flexbox, CSS counters, `::marker`,
data-URI images all work). Variables: `document.{id,name,created_at,
data.{contacts[],listings[],<field-id>…}}`, `contact.{full_name,vat_number,
id_number,mobile,area,street,postal_code}`, `listing.{id,code,price,address,
type,size,floor_label,energy_class_label,availability,availability_label}`,
`user`, `office.{name,logo,vatno,gemi,doy,phone}`, `company`, `system.
current_time`, `sign_url`, helper `formatNumber(x, withEuro)`. Data fields land
in `document.data.<id>` (per-listing: keyed by listing id, e.g.
`document.data.commission[listing.id]`).

Traps:

- **The UI's save drops field metadata.** `load_template` returns fields with
  `source` (auto-fill, e.g. `listing.assignment_fee`), `type`, `required`,
  `editable` — but the page's `getFieldsData()` serializes only
  `id/label/per_listing/hidden_on_unsigned`, so any UI save (or a faithful
  replica of it) silently strips the auto-fill wiring. Pass the full field
  objects through in `fields` to preserve them.
- **`office.*` is placeholder data** unless a logo/details are set in CRM
  settings — the fourwalls account has none, so our templates hardcode the
  brand block and embed the logo as a data URI.
- **CDP gotchas driving this from the dedicated Edge** ([[edge-cdp-automation]]):
  a single big `Runtime.evaluate` (≳40 KB expression) hangs Edge's CDP — upload
  payloads into a `window` var in ~6 KB chunks, then `fetch(body: window.__P)`.
  And a killed Node script does **not** abort the page's in-flight fetch; a few
  stuck POSTs wedge the renderer's whole connection pool for that origin (every
  later same-origin fetch times out, even tiny ones). Fix: close the origin's
  tabs (kills the renderer) and reopen.

2026-07-25: both Greek templates were replaced 1:1 with the Έντυπα PWA
documents/emails (see [forms-submit.md](forms-submit.md)); the stock EstatePrime
originals are backed up in `%LOCALAPPDATA%\FourWalls\estateprime-template-backups\`.
The English (lang 2) variants still hold the stock EstatePrime content.

## Calendar / ραντεβού (probed 2026-08-06, POST verified 2026-08-07)

- `GET /calendar?page=N` + `GET /calendar/{id}` — τα ραντεβού του ημερολογίου
  (το `/appointments` ΔΕΝ υπάρχει). Πεδία: `id, store_id, full_day,
  date_starting, date_ending, status_id, category_id, contacts[], users[],
  title, description, is_online, remote_meeting`. **Χωρίς** διεύθυνση/
  συντεταγμένες και χωρίς σύνδεση με ακίνητο — γι' αυτό η σελίδα ραντεβού
  ([rantevou.md](rantevou.md)) διαβάζει τον κωδικό ακινήτου από τον τίτλο.
- `POST /calendar` **δουλεύει** (αχαρτογράφητο στο spec): JSON με `title,
  description, date_starting, date_ending, category_id, contacts[], users[]`
  **συν τα υποχρεωτικά `status_id, created_by, store_id`** (τα ζητάει ένα-ένα
  με 400). Επιστρέφει `{status:200, created_id}`. Χρήσιμο για μελλοντικό
  flow υπενθυμίσεων εκτός CRM (π.χ. Viber μέσω Make).
- `DELETE /calendar/{id}` δουλεύει επίσης: `{status:200, deleted_id}`
  (επαληθεύτηκε 2026-08-07 στο δοκιμαστικό ραντεβού #21).

## SMS templates (internal web endpoints, mapped 2026-07-25)

`/settings/sms#tab-templates` lists the system SMS templates by **slug** (not
numeric id): `new_appointment`, `appointment_reminder`, `new_contact`, … The
editor lives at `/settings/sms/view/{slug}/{lang}` (lang **1 = Greek,
2 = English (UK)**). Same mechanics as the document templates — same-origin
POSTs with the session cookie, no CSRF, all three actions POST **to the view
URL itself**, `application/x-www-form-urlencoded`:

- `load_template=true` → `{success, content, variables}` — `content` is the
  raw plain-text Twig (empty string when unset), `variables` the sample data.
- `preview=true&content=…&variables=<json>` → server-side Twig render,
  `{success, content, chars}` — `chars` is the rendered SMS length.
- `save=true&content=…` → `{success}` — saves that language slot only.

Variables (per `load_template`): `contact.{id,first_name,last_name,full_name,
email}`, `appointment.{id,title,is_remote,meeting_url,address.{address,
latitude,longitude},date_starts,date_ends,time_starts,time_ends,duration,
is_full_day,category_id}`, `user.{id,first_name,last_name,email,phone}`,
`office.{name,address,email,phone}`, `system.{current_time,current_date,
current_date_formatted}`.

Notes:

- **«Αυτόματη αποστολή» (Ενεργή/Ανενεργή) is separate from content** — it's the
  list page's Ρυθμίσεις modal (`editTemplate('slug')`), not the editor. Filling
  content does not enable sending.
- The SMS **provider is unconfigured** (`#tab-settings`: `provider`, `api_key`,
  `sender` ≤11 chars) — no SMS goes out until it's set up.
- 2026-07-25: both appointment SMS (`new_appointment`, `appointment_reminder`)
  were written EL+EN mirroring the appointment emails; sources in
  [../crm/](../crm/README.md) (`*.sms.twig`). 2026-08-06: both carry the
  `/r/<id>` appointment-page link ([rantevou.md](rantevou.md)) and the
  reminder's auto-send is Ενεργή, «1 ημέρα πριν»; `new_appointment` stays
  manual (the SMS button).

## Offers / προσφορές (read-only, and currently EMPTY — probed 2026-07-31)

`GET /offers` works and is **read-only**: the spec exposes only `get` on
`/offers` and `/offers/{id}`, no create. Filters (spec body): `page`, `status`,
`is_active`, `listing_id`, `request_id`, `store_id`. `OfferStatus` enum:
`draft | submitted | under_negotiation | accepted | rejected | withdrawn`.
Single-offer responses carry a **`rounds` array** (the negotiation history);
the list response omits it. `/offers/statuses` does not exist (404 «Offer not
found» — the path is parsed as an id).

It was **empty** when probed (`total_results: 0`), because nothing had ever
written an offer: the Έντυπα «προσφορά» form only emails info@ (see
[forms-prosfora.md](forms-prosfora.md)). **From 2026-08-03 the secretary
enters them in the CRM by hand**, so the read side is what matters, and the
valuation now consumes it (`fetchOffers` in
[../worker/lib/valuation.mjs](../worker/lib/valuation.mjs), see
[valuation.md](valuation.md)). Automating the write from the form is deferred
until the volume justifies it; it would need the internal web endpoint with a
session cookie, the same pattern as ζητήσεις (`POST /requests/form`).

Two cautions for whoever reads offers next. The **`Offer` schema is not in the
yaml** (truncated before it), so field names are unverified — normalize
defensively and check the `valuation: offers …` logs against the first real
records. And `listing_id` is documented as a **body** param: it is accepted in
the query string and returns `200`, but with an empty table there is no proof
it actually filters, so **re-filter client-side** rather than trusting it.

## Tasks / υποχρεώσεις (probed 2026-08-07, POST verified)

Το `TaskInput` schema **δεν είναι στο yaml** (κομμένο), αλλά το endpoint
απαντά καθαρά. Live shape ενός task:

```
id, title, description (HTML), created_by, date_created, date_updated,
due_date (YYYY-MM-DD ή null), status_id, category_id, priority
("low"|"normal"|"high"), project_id, is_star, users[], contacts[], tags[]
```

- `POST /tasks` → `{status:200, created_id:"8"}`. **Υποχρεωτικά (τα ζητάει
  ένα-ένα με 400, με αυτή τη σειρά): `title`, `created_by`, `users[]`,
  `priority`, `status_id`.** Το `store_id` **δεν** χρειάζεται εδώ (αντίθετα
  με το `/calendar`). Προαιρετικά: `description, category_id, due_date,
  contacts[], tags[]`.
- **Συνημμένο σε task δεν υπάρχει.** Δοκιμάστηκαν `files`, `file_ids`,
  `attachments`, `listing_id`, `listing_ids` στο POST: γίνονται δεκτά με 200
  και **αγνοούνται σιωπηλά** (το GET του task δεν τα επιστρέφει). Το μόνο
  που κρατά ένα task είναι `users[]`, `contacts[]`, `tags[]`. Ένα PDF
  μπαίνει στο task μόνο ως **link μέσα στο `description`** (δέχεται HTML).
- `GET /tasks?page=N`, `GET /tasks/{id}`, `DELETE /tasks/{id}` (soft-delete,
  μετά 404). **Δεν υπάρχει PUT/PATCH**: ένα task το κλείνει άνθρωπος μέσα
  στο CRM, δεν το κλείνει αυτοματισμός (εκτός αν χαρτογραφηθεί το internal
  `/tasks/view/{id}`, ίδιο pattern με τις επαφές και τις ζητήσεις παραπάνω).
- Καμία σύνδεση με **ακίνητο** (μόνο `contacts[]`), όπως και στο ημερολόγιο,
  άρα ο κωδικός ακινήτου μπαίνει στον τίτλο.
- `GET /tasks/statuses` → `1 Σε εκκρεμότητα · 2 Σε εξέλιξη · 3 Σε παύση ·
  4 Ολοκληρωμένο · 5 Ακυρώθηκε`.
- `GET /tasks/categories` → `1 Συμβόλαια · 2 Αναθέσεις · 3 Ζητήσεις ·
  4 Διάφορα`. `tags` και `custom-fields` είναι άδεια.
- Χρήστες (`GET /users`): **1 = Αφεντούλα** (info@), **2 = Μάνος** (manos@).
- Προσοχή: το `priority` γυρίζει **string** στο GET, ενώ το spec το
  τεκμηριώνει ως `1|2|3` στα φίλτρα του GET. Στο POST περνάει string.

## Files / αρχεία (probed 2026-08-07, read-only in practice)

`GET /files?page=N` επιστρέφει `id, file_name, url, size, date_created,
user_id, contact_id, listing_id, folder_id`. Το `url` δείχνει σε
`https://files.estateprime.gr/<account-hash>/files/<opaque>.pdf`.

- **Δεν γράφεται από το API.** `POST /files` απαντά **`200` με άδειο σώμα**
  και **δεν δημιουργεί τίποτα** (επαληθεύτηκε: το πλήθος έμεινε 3). Μην το
  εκλάβεις ως επιτυχία. Το spec εκθέτει μόνο `get`.
- Τα paths `/files/categories` και `/files/types` **δεν υπάρχουν**: γυρίζουν
  αυτούσια τη λίστα αρχείων (το suffix αγνοείται), οπότε ένα `200` εκεί δεν
  σημαίνει ότι το endpoint είναι πραγματικό. `GET /files/folders` υπάρχει
  και είναι άδειο.
- Τα 3 αρχεία μέσα (2026-08-07) είναι υπογεγραμμένα PDF εντύπων που ανέβασε
  **με το χέρι** η γραμματεία (`user_id: 1`) από τα «ΓΙΑ ΑΡΧΕΙΟ CRM» email
  του σεναρίου εντύπων, βλ. [forms-submit.md](forms-submit.md).
- Για upload χωρίς άνθρωπο θα χρειαστεί το **internal web endpoint με
  session cookie** (ίδιο pattern με τα document templates), αχαρτογράφητο.

## Other resources (exist, unused)

Communication, Contracts, Expenses, External Listings, Incomes,
Knowledge Base, Locations, Reminders (POST only), Webmail.
Support: tech@estateprime.gr.
