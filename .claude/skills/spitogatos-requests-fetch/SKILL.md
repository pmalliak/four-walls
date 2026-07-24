---
name: spitogatos-requests-fetch
description: >-
  Turn Spitogatos «Αίτηση ζήτησης ακινήτου» (property-demand) leads into EstatePrime CRM
  records — a contact + a ζήτηση/request + an incoming communication, correctly tagged and
  assigned to Μάνος. Use when Panos wants to process/backfill Spitogatos demand leads into the
  CRM (e.g. "process the last 2 weeks of Spitogatos ζητήσεις"). ζήτηση = demand; NOT ανάθεση
  (assignment, which Make already handles).
---

# Spitogatos ζήτηση → EstatePrime intake

Fully **headless** pipeline (no CRM UI form-filling). Per lead: **contact → ζήτηση → communication**,
each communication linked to BOTH the contact and the request. Needs a browser session on
spitogatos + CRM — either the in-app `Claude_Browser`, or (preferred since 2026-07-24) the
**self-driven headless mode** below, which logs in on its own.

Deep field maps & the "why" live in [docs/estateprime-api.md](../../../docs/estateprime-api.md) and
[docs/estateprime-crm-ui.md](../../../docs/estateprime-crm-ui.md) — read them if anything below is unclear.

## Preconditions
- `.dev.vars` at repo root with `ESTATEPRIME_API_KEY` / `_SECRET` (+ `_SUBDOMAIN`), and — for
  headless mode — a fresh `BW_SESSION` (Panos runs `bw unlock --raw` and pastes it there).
- `node` on PATH (fallback `& "C:\Program Files\nodejs\node.exe"`).
- Headless mode: **Spark Desktop running** (its CLI reads the lead emails + 2FA codes) and the
  Bitwarden vault unlocked. Claude_Browser mode instead needs the browser already logged in at
  `live.spitogatos.gr` AND `fourwalls.estateprime.gr`.

## Headless mode (no Claude_Browser) — scripts/headless/
Everything runs from node + a **dedicated Edge** (own profile, NOT Panos's browser) driven over CDP.
Real Edge passes both Cloudflare (CRM) and Imperva/Reese84 (spitogatos); plain node fetch does NOT.

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\FourWalls\edge-claude-profile" `
  --no-first-run --no-default-browser-check --window-size=1280,900 about:blank
```

Then, from the repo root (order matters; each is a no-op if already done/logged in):
1. `node …/headless/enumerate.mjs 2026/07/10 <processed.json> enquiries.json` — Spark CLI email sweep (step 1).
2. `node …/headless/crm-login.mjs` + `node …/headless/sg-login.mjs` — log in via Bitwarden CLI creds
   (item ids pinned in `bw.mjs`). Spitogatos 2FA code is auto-read from Spark. Remember-me is ticked,
   so the profile keeps both sessions across runs.
3. `node …/headless/sg-fetch.mjs enquiries.json details.json` — paced detail GETs (step 2).
4. Steps 3–4 as below (leads.json by hand, then `prep.mjs`).
5. `node …/headless/crm-post.mjs worklist.json results.json` — the step-5 form POSTs.
6. `verify-log.mjs` as below.

Gotchas learned 2026-07-24:
- The **guru login form ignores synthetic fills** — sg-login uses real CDP mouse/keyboard input
  (`Input.insertText`). The CRM form accepts synthetic fills.
- Leads with `"status":"deleted"` come back **anonymized** (asterisks — visitor withdrew the
  enquiry, even same-day). Unprocessable: record them in `processed.json → skipped_duplicates`.
- ALL-CAPS Greek names must get explicit `greek_first/greek_last` (prep's titleCase would emit
  «…οσ» with a non-final sigma). Watch for swapped first/last (e.g. «ΘΩΜΑΚΟΣ ΧΑΡΑΛΑΜΠΟΣ» =
  Θωμάκος surname — the email address usually disambiguates).

## Auth split (important)
- **`/api/*`** (contacts, locations, requests-read, verification) = **HTTP Basic** → run from **node**.
- **`/requests/form` and `/communication/form`** (the create endpoints) = **session cookie** →
  run from a **browser same-origin `fetch`** on the CRM tab. The public `POST /api/requests` and
  `POST /api/communication` request-link are BROKEN — never use them to create.

## Anti-scraping rule
Enumerate leads from **emails** (Spark, `info@four-walls.gr`, pushed to inbox = zero risk). Fetch
each lead's detail with **one paced** `GET /api/search-enquiries/{id}` (mimics clicking a
notification). **Do NOT bulk-sweep** the `/api/search-enquiries` list endpoint. Emails and the
dashboard are verified 1:1 identical.

## Tags — always by ID (Panos may rename tags)
contact `tags:[12,9,10]` (claude,spitogatos,ΖΗΤΗΣΗ) · request `tags[]=13&tags[]=14` (claude,spitogatos)
· comm `tags[]=15&tags[]=8` (claude,spitogatos). If a tag is deleted+recreated its id changes —
re-fetch from `/contacts|requests|communication/tags`.

## Procedure

Work from the skill dir: `.claude/skills/spitogatos-requests-fetch/`. Scratch files go in the session scratchpad.

**1. Pick the window & enumerate (emails).** Ask Panos the window if unset (default: last 14 days).
Via Spark, list `from:notifications@spitogatos.gr` with subject «Αίτηση ζήτησης …» in-window; open
each thread and extract `showDetailsId` from the `live.spitogatos.gr/leads/searchEnquiries?showDetailsId=N`
link. (Skip anything already in `state/processed.json`.)

**2. Fetch details (browser, spitogatos tab, paced).** Navigate to `live.spitogatos.gr/leads/searchEnquiries`, then:
```js
// returns full structured detail for each id (paced ~0.7s apart)
(async () => { const ids = [/* showDetailsIds */]; const out=[];
  for (const id of ids){ const j = await (await fetch('/api/search-enquiries/'+id,{headers:{accept:'application/json'},credentials:'include'})).json();
    out.push(j); await new Promise(r=>setTimeout(r,700)); }
  return JSON.stringify(out); })()
```
Each object has: firstName,lastName,telephone,email,contactHours,listingType,propertyType(studio|unspecified|…),
price,livingArea,floorNumber(all|1_plus),rooms,elevator,description,dateSubmitted,**geographyIds**.

**3. Build the leads input JSON.** For each detail, add `greek_first`/`greek_last`: **transliterate
romanized Greek names to Greek script** with accents (Panagiota Vliali→Παναγιώτα Βλιάλη); leave already-Greek
names as-is; keep genuinely-foreign names Latin. Also set `latin_name` = original. Save as `leads.json`.
**Scoping** (Panos, 2026-07-24): process **rent AND sale**, **residential AND commercial AND land**
(επαγγελματικοί χώροι και γη ΜΑΣ ΕΝΔΙΑΦΕΡΟΥΝ), including `unspecified` type and broad searches.
**Μεσιτικά γραφεία (agencies) ΔΕΝ κρατιούνται** — `prep.mjs` τα φιλτράρει αυτόματα
(`AGENCY_RE` σε όνομα/email: real estate, realty, broker, μεσιτ…) και τα βγάζει στα `skipped`.
Έλεγξε τα skipped σε κάθε τρέξιμο μήπως κόπηκε κάποιος κατά λάθος.

**4. Prep (node).** Dedup + contacts + area resolve + body build:
```bash
node .claude/skills/spitogatos-requests-fetch/scripts/prep.mjs <leads.json> <worklist.json> .claude/skills/spitogatos-requests-fetch/state/processed.json
```
Creates contacts (or reuses on phone-dedupe), resolves geographyIds → `[area_level1,area_level2]`,
parses the description (accent-safe) into heating/furnished/feature flags, emits compact `worklist.json`.
Review the printed per-lead line + any `warnings` (esp. level-3 areas — encoding unverified).

**5. Post ζήτηση + communication (browser, CRM tab).** Navigate to `fourwalls.estateprime.gr/requests`,
then feed the worklist entries into this loop (build the request body from area pairs — **omit
`area_level3[]`**, empty values break pairing and silently store 0 locations):
```js
(async () => {
  const jobs = [/* worklist entries: {leadId, contactId, areas:[[l1,l2],..], fields, comm:{date,comments}} */];
  const H={'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest'};
  const results=[];
  for (const j of jobs){
    const p=['save_request=1','source_id=1','contact_ids[]='+j.contactId,'user_ids[]=2','tags[]=13','tags[]=14','request_status=1','rating='];
    for (const [l1,l2] of j.areas){ p.push('area_level1[]='+l1); p.push('area_level2[]='+l2); }
    p.push(j.fields,'shortterm_unit=per_day','polygons=%5B%5D');
    const rr=await (await fetch('/requests/form',{method:'POST',credentials:'include',headers:H,body:p.join('&')})).json().catch(()=>({parse:'fail'}));
    let commId=null;
    if (rr&&rr.id){ const cb=['create_communication=1','type=incoming','channel=2','contact_id='+j.contactId,'request_id='+rr.id,'user_id=2','tags[]=15','tags[]=8','communication_date='+encodeURIComponent(j.comm.date),'comments='+encodeURIComponent(j.comm.comments)].join('&');
      const cr=await (await fetch('/communication/form',{method:'POST',credentials:'include',headers:H,body:cb})).json().catch(()=>({parse:'fail'})); commId=cr&&cr.id; }
    results.push({leadId:j.leadId, contactId:j.contactId, requestId:rr&&rr.id, commId});
    await new Promise(r=>setTimeout(r,600)); // pace + stay under 429s
  }
  return JSON.stringify(results);
})()
```
Success looks like `{"success":true,"id":"N"}`. Save the returned array as `results.json`.

**6. Verify + log (node).**
```bash
node .claude/skills/spitogatos-requests-fetch/scripts/verify-log.mjs <results.json> .claude/skills/spitogatos-requests-fetch/state/processed.json
```
Reads each request+comm back, confirms request has locations + right contact and comm links both
contact_id & request_id, and appends only PASSing leadIds to `processed.json`. Commit
`processed.json` after a run so the dedupe survives.

**7. Report** to Panos: created / reused / skipped / failed counts, and any FAILs to retry. Review a
batch in the CRM by filtering the Επικοινωνίες list on the `claude` tag (comms sort by the lead's real
date, not creation time — they scatter, they don't cluster at top).

## Resume / idempotency
`processed.json` is stamped ONLY after full per-lead verification. On a re-run: prep skips ids already
in `processed.json`; a phone already in the CRM is reused (not duplicated) but still gets a fresh
ζήτηση+comm — so a half-done lead (contact made, posts failed) resumes cleanly without a duplicate contact.

## Known gotchas (all learned the hard way — see docs)
- **Area encoding**: parallel `area_level1[]`+`area_level2[]`, NO `area_level3[]` for level-2. Empty
  `area_level3[]` → 0 locations stored + non-JSON response. Location is REQUIRED.
- **Description parsing must be accent-insensitive** (prep.mjs strips diacritics).
- **`unspecified` propertyType** → no subcategory (accepted).
- **Always verify via API read-back** — a malformed body still returns 200 but drops data.
- `POST /requests` / `/communication` (public `/api`) are broken — use the `/*/form` endpoints.
- Contact create needs users/created_by/office_id/language_id/country + `is_active:true` (else Ανενεργό).
- Phone uniqueness 400s (a dedupe backstop). `DELETE` can 200 without deleting — re-GET to confirm.

## Upgrade trigger
If EstatePrime fixes `POST /api/requests` and the `/api/communication` `request_id` link, the browser
form-post step can move to fast node `/api` calls (fully parallelizable). Until then, `/*/form` via the
browser session is the path.
