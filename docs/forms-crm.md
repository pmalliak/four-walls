# CRM pickers for the Έντυπα PWA (contacts + property autofill)

The consultant opens a form on the iPad, taps **«Από το CRM»**, searches a
client, and the fields fill in from EstatePrime. Same for properties on the
υπόδειξη rows.

```
forms.four-walls.gr ──▶ Cloudflare Access ──▶ Worker (worker/index.mjs)
   (iPad, PWA)          login, 1-month session      │
                                                    ├─▶ /api/crm/contacts      2 API calls, KV-cached
                                                    ├─▶ /api/crm/contacts/{id} 1 API call, on tap
                                                    └─▶ /api/crm/listings      3 API calls, KV-cached
                                                              │
                                                     EstatePrime CRM API
```

Code: [worker/lib/crm.mjs](../worker/lib/crm.mjs) (server) +
[forms/_crm.fw.js](../forms/_crm.fw.js) (picker UI, loaded by
`ypodeixi.html` and `anathesi.html`).

## Design rules

- **Access is not optional.** These routes serve the client database — names,
  phones, ΑΦΜ, ΑΔΤ. The code **fails closed**: without `ACCESS_TEAM_DOMAIN` +
  `ACCESS_AUD` every route answers `503`, so an accidental deploy leaks
  nothing. The routes are also mounted **only** on `forms.*` and localhost —
  never on the `workers.dev` URL, which stays alive for the CRM webhook and
  **bypasses Access entirely**.
- **A light index, then one detail call.** The list endpoint does not return
  `custom_fields` (see [Known limits](#known-limits)), so fetching every
  contact's full record would be 58 requests. Instead the index carries only
  what the search box matches on (name/phone/email) and the tapped contact
  costs one call. The tablet downloads the index once and filters locally —
  instant, and it survives a bad signal at a viewing.
- **KV, not a database.** ~58 contacts and ~23 active listings, searched
  client-side: there is nothing to query server-side, and `date_updated` is
  broken upstream so incremental sync is impossible anyway — any mirror must
  be a full refresh, which is what KV does well. A D1 mirror would add schema,
  migrations, and a second source of truth that can silently drift from the
  CRM. On a document that gets signed, that drift is a hazard.
- **Serve stale rather than fail.** A cached index older than 15 min is
  refreshed, but if the CRM is down or rate-limiting, the last known copy is
  served with `stale: true`. A few-hours-old list still finds the right person;
  an error message in front of a client does not.
- **Fresh on demand (2026-07-24).** Two paths beat the 15-min window:
  the picker sheets carry an **«↻» button** that refetches with
  `?refresh=1` (skips the freshness check, still stale-on-error), and the
  EstatePrime **webhook/cron** rebuilds the listings index right after the
  public feed (`regenerate()` in worker/index.mjs) — so a listing added in
  the CRM appears in the pickers within seconds on its own.
- **Read-only.** EstatePrime exposes no contact update endpoint, so
  corrections the consultant makes in the form stay in the form. See
  [Known limits](#known-limits).
- **Real addresses.** The property picker publishes `address_el`, not the fake
  address the public feed uses for `display_address: "fake"` listings (14 of
  15 active ones). A σύμβαση υπόδειξης naming an approximate address would be
  worthless. This is the internal tool, behind Access — it gets the real data.

## Setup

### 1. Split the EstatePrime keys

Production keys must never sit on a laptop. Mint **two pairs** in the CRM:

| Pair | Lives in | If it leaks |
|------|----------|-------------|
| dev | `.dev.vars` (gitignored) | revoke it, nothing else happens |
| prod | `wrangler secret put` only | revoke + rotate under pressure |

```bash
npx wrangler secret put ESTATEPRIME_API_KEY
npx wrangler secret put ESTATEPRIME_API_SECRET
```

Secrets are encrypted at rest in Cloudflare and **cannot be read back** — not
even by you. That is the point: a key you can read is a key that can leak.

**Never pass a secret as a command-line argument** (`--var KEY:value`): any
process on the machine can read it out of `ps`, and it lands in shell history.
Files or env only.

### 2. Cloudflare Access

Dashboard → **Zero Trust** → **Access** → **Applications** → **Add** →
**Self-hosted**:

| Field | Value |
|-------|-------|
| Application name | Έντυπα |
| Domain | `forms.four-walls.gr` |
| Session Duration | **1 month** |
| Policy | Allow → Include → **Emails** → each consultant's email |
| Login methods | **Google** and **One-time PIN** (enable both) |

Notes:

- Protect the **whole hostname**, not just `/api/crm/*`. The forms are internal
  business documents; even blank they show the contract terms.
- **Session duration matters.** If it expires mid-viewing the picker answers
  «Χρειάζεται σύνδεση» at the worst moment. A month is the point.
- Both login methods can be on at once — Google is one tap for anyone with a
  Google account, One-time PIN works with any email and needs no setup.
- Free for up to 50 users.

### 3. Wire the Access identifiers into the Worker

From the application's page, copy the **Application Audience (AUD) tag** and
your **team domain** (e.g. `fourwalls.cloudflareaccess.com`). Neither is a
secret — they are identifiers — so they belong in `wrangler.toml [vars]`:

```toml
[vars]
ACCESS_TEAM_DOMAIN = "fourwalls.cloudflareaccess.com"
ACCESS_AUD = "<the AUD tag>"
```

The Worker verifies the Access JWT's signature against the team's public keys
on every request. It does **not** simply trust the header's presence — that
would be forgeable by anyone who reached the Worker around Access.

### 4. Deploy and verify

Deploying is just `git push` to `main` — Cloudflare Workers Builds picks it up
(see [README.md](README.md)). The command below is only for a machine that is
logged in to wrangler and needs to bypass git.

```bash
npx wrangler deploy
```

Then check all four, in this order — the first two are the ones that matter:

```bash
# 1. workers.dev must NOT serve client data -> 404
curl -s -o /dev/null -w "%{http_code}\n" https://four-walls.<sub>.workers.dev/api/crm/contacts

# 2. forms host without a login -> Access login page (302), never data
curl -sI https://forms.four-walls.gr/api/crm/contacts | head -1

# 3. in a browser, logged in: the index returns
#    {"generatedAt":…,"count":58,"contacts":[…]}

# 4. open a form -> «Από το CRM» -> search -> tap -> fields fill
```

## Local development

```bash
npx wrangler dev --port 8788 --local \
  --persist-to /tmp/fw-wrangler-state
```

Then `http://localhost:8788/forms/ypodeixi.html`.

Two things that will otherwise waste an hour:

- **`--persist-to` outside the repo is required.** `[assets] directory = "./"`
  makes wrangler watch the whole repo, local KV writes land in `.wrangler/`
  inside it, and every write triggers a reload that kills the in-flight
  request. Symptom: requests hang for 90s and time out. Moving the state out
  takes the cold index from a 90s timeout to 0.8s.
- **`CRM_DEV_BYPASS=1` in `.dev.vars` skips Access locally.** It is needed
  because `wrangler dev` reports the hostname from `[routes]` (`four-walls.gr`)
  rather than localhost, so the code cannot detect a local run on its own.
  **Never** put it in `wrangler.toml [vars]` or set it in production.

## Contact field map

Verified live against the fourwalls account, 2026-07-17.

| Form field (`data-k`) | CRM source |
|---|---|
| `entoleas_onomatepwnymo` | `first_name` + `last_name` |
| `entoleas_patronymo` | `custom_fields[7]` |
| `entoleas_katoikia` | `custom_fields[8]` |
| `entoleas_adt` | `id_number` (native) |
| `adt_imerominia_ekdosis` | `custom_fields[10]` — already ISO `YYYY-MM-DD` |
| `adt_arxi_ekdosis` | `custom_fields[11]` |
| `entoleas_afm` | `vat_number` (native) |

That is the complete «Στοιχεία εντολέα» block — 7 of 7. `ekprosopoumenos` and
`plirexousio_imerominia` stay manual on purpose: they describe the transaction,
not the person, and change per deal.

**Custom-field ids are positional.** Deleting and recreating a field in the CRM
gives it a new id and silently breaks the mapping — ΑΦΜ was 12, then 13, before
it moved back to the native field. If a field reads empty for every contact,
check `GET /api/contacts/custom-fields` before debugging anything else.

The native ΑΦΜ/ΑΔΤ pair is only editable in the CRM's contact **edit** form —
they are missing from the **create** form, which is why they look absent at
first. Fill them by creating the contact, then editing it.

The μεσιτική αμοιβή is deliberately **not** autofilled from `assignment_fee`:
that is what the owner agreed to pay on the ανάθεση, which is not necessarily
what this client is being asked for. A wrong number on a signed contract is
worse than a blank one.

## Known limits

All reported to EstatePrime (tech@estateprime.gr) on 2026-07-17.

- **No contact update endpoint.** `/contacts/{id}` documents only `GET` and
  `DELETE`; `POST /contacts` creates. So nothing writes back to the CRM, and
  the "update the client's record from the form" idea is blocked upstream.
  `DELETE` + re-`POST` is not a workaround — it loses the id, the history and
  the links to listings.
- **`date_updated` never moves.** Editing native fields *or* custom fields
  leaves it at the original value (contact 20 sat at `2023-01-18 10:33:19`
  through several edits). Incremental sync by date is therefore impossible.
- **The contact «Διεύθυνση» is invisible to the API.** It exists in the UI and
  can be filled there, but no endpoint returns it — hence custom field 8
  («Κατοικία») duplicating it.
- **The list endpoint omits `custom_fields`, `tags` and `users`.** Only
  `GET /contacts/{id}` returns them.
- **An unknown id does not 404.** `GET /contacts/999999` answers `200` with
  `data: []` — and `[]` is truthy, so a naive check maps every field to
  `undefined` and silently blanks the form. `contactDetail()` guards against
  this; keep the guard.
- **The API rate-limits (`429`), undocumented.** Hit during a day of heavy
  probing, not under normal load (~100 calls/day with the 15-min cache).
  `apiJson()` retries with backoff and the cache serves stale on failure.
- **Empty custom fields are omitted from the object entirely** — never assume
  a key exists.
