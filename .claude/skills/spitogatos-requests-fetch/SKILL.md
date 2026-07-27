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
- Headless mode: **Spark Desktop + the dedicated Edge running** — `ensure-apps.ps1` (step 0) starts
  both, so don't ask Panos to open anything by hand. Also needs the Bitwarden vault unlocked.
  Claude_Browser mode instead needs the browser already logged in at `live.spitogatos.gr`
  AND `fourwalls.estateprime.gr`.

## Headless mode (no Claude_Browser) — scripts/headless/
Everything runs from node + a **dedicated Edge** (own profile, NOT Panos's browser) driven over CDP.
Real Edge passes both Cloudflare (CRM) and Imperva/Reese84 (spitogatos); plain node fetch does NOT.

From the repo root (order matters; each is a no-op if already done/logged in):
0. `powershell -ExecutionPolicy Bypass -File .claude/skills/spitogatos-requests-fetch/scripts/ensure-apps.ps1`
   — starts Spark + Edge; see step 0 in the Procedure.
1. `node …/headless/enumerate.mjs 2026/07/10 <processed.json> enquiries.json` — Spark CLI email sweep (step 1).
2. `node …/headless/crm-login.mjs` + `node …/headless/sg-login.mjs` — log in via Bitwarden CLI creds
   (item ids pinned in `bw.mjs`). Spitogatos 2FA code is auto-read from Spark. Remember-me is ticked,
   so the profile keeps both sessions across runs.
3. `node …/headless/sg-fetch.mjs enquiries.json details.json` — paced detail GETs (step 2).
4. Steps 3–4 as below (leads.json by hand, then `prep.mjs`).
5. `node …/headless/crm-post.mjs worklist.json results.json` — the step-5 form POSTs.
6. `verify-log.mjs` as below.
7. `node tools/crm-request-matchings.mjs --send` — το digest της γραμματείας (step 7). **Τρέχει
   πάντα**, ακόμη κι αν το 1 δεν βρήκε leads.

Gotchas learned 2026-07-24:
- The **guru login form ignores synthetic fills** — sg-login uses real CDP mouse/keyboard input
  (`Input.insertText`). The CRM form accepts synthetic fills.
- Leads with `"status":"deleted"` come back **anonymized** (asterisks — visitor withdrew the
  enquiry, even same-day). Unprocessable: record them in `processed.json → skipped_duplicates`.
- ALL-CAPS Greek names must get explicit `greek_first/greek_last` (prep's titleCase would emit
  «…οσ» with a non-final sigma). Watch for swapped first/last (e.g. «ΘΩΜΑΚΟΣ ΧΑΡΑΛΑΜΠΟΣ» =
  Θωμάκος surname — the email address usually disambiguates).
- (2026-07-25) **Never run in-page `setTimeout` loops** in the long-lived tabs: a tab hidden >5min
  gets intensive timer throttling (timers fire ~1/min) and the eval hangs forever. sg-fetch and
  crm-post now do one `eval` per item and pace from **node** (`sleep`), plus `Page.bringToFront`.

Gotchas learned 2026-07-27:
- **Imperva now stalls eval-context `fetch()` on spitogatos**: a `fetch('/api/search-enquiries/N')`
  from `Runtime.evaluate` hangs FOREVER (even focused, un-minimized, un-throttled), while the
  page's own XHRs still work. If `sg-fetch.mjs` hangs on the first id, kill it and use
  **`sg-fetch-nav.mjs`** (same args): it navigates to `…?showDetailsId=N` per lead and captures
  the page's own detail XHR via CDP `Network.getResponseBody` — literally clicking the notification.
- **Spark Desktop dead ⇒ enumerate from the dashboard**: if Spark won't start (2026-07-27 it
  refused to launch from any shell — instant silent exit 0, no log/crash — yet opened fine when
  Panos clicked it), `ensure-apps.ps1` says so and exits 1. Ask Panos to click the icon; if that
  is not an option, re-run it with `-SkipSpark`, then
  open `live.spitogatos.gr/leads/searchEnquiries` in the CDP tab and capture the
  page's OWN `GET /api/search-enquiries?page=1&perPage=25&…` XHR via Network events (one page-load,
  human-identical — NOT a bulk sweep). Page 1 covers ~25 leads ≈ several days; confirm the oldest
  rows overlap `processed.json` so there is no gap, and cross-check with `enumerate.mjs` once Spark
  is back. The list rows lack `rooms/floorNumber/elevator` detail — still run sg-fetch(-nav) per id.
- **CRM eval fetches got slow, not stuck**: crm-post now takes ~30s per lead (Cloudflare), ~8min
  for 15 — let it finish. Before assuming a hang or re-posting, read back
  `GET /api/requests` (needs `Content-Type: application/json` even on GET, else 415) to see what
  actually landed — a re-run of an already-landed POST would duplicate the ζήτηση.

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

**Το βήμα 7 τρέχει ΠΑΝΤΑ** — ακόμη κι αν τα βήματα 1–6 δεν βρήκαν ούτε ένα νέο lead. Είναι ο
καθημερινός έλεγχος της γραμματείας για νέα ακίνητα σε ζητήσεις και δεν εξαρτάται από τα leads
(δες το ίδιο το βήμα για το γιατί). Μη σταματήσεις στο «κανένα νέο lead» — προχώρα στο 7.

**0. Open the apps this skill drives (always first).** Never ask Panos to launch anything — run:
```powershell
powershell -ExecutionPolicy Bypass -File .claude/skills/spitogatos-requests-fetch/scripts/ensure-apps.ps1
```
Idempotent: whatever already runs is left alone (and never re-minimized, so a window Panos is using
stays put). It starts **Spark minimized** — we only ever talk to it through its CLI — and the
dedicated **Edge :9222 in a normal window on purpose**: minimizing it makes every tab "hidden",
which triggers intensive timer throttling and hangs the eval steps (`-EdgeMinimized` exists, but
only take it knowing that). Exit 1 = an app is not ready: read the output and fix it, don't start
the pipeline blind. Flags: `-SkipSpark` (dashboard-enumeration fallback), `-SkipEdge`.

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

**7. Νέα ακίνητα σε ζητήσεις → email στη γραμματεία (node). ΥΠΟΧΡΕΩΤΙΚΟ ΒΗΜΑ, ΠΑΝΤΑ.**
```bash
node tools/crm-request-matchings.mjs --send
```
Σαρώνει **όλες** τις ενεργές ζητήσεις (~2 λεπτά) και στέλνει digest με ό,τι κάθεται ακόμη σε
κατάσταση «Νέο» στο tab «Ακίνητα». Χρειάζεται τον ίδιο συνδεδεμένο Edge (:9222).

**Τρέξ' το ακόμη κι αν δεν υπήρχε κανένα νέο lead σήμερα.** Δύο πράγματα γεννούν ματσαρίσματα:
νέα ζήτηση (βήματα 1–6) και **νέο ακίνητο που ματσάρει παλιές ζητήσεις** — το δεύτερο δεν έχει
καμία σχέση με τα Spitogatos leads και είναι ο βασικός όγκος, με 115 ενεργές ζητήσεις να
κάθονται. Επειδή το πρωινό run του skill είναι ο μοναδικός καθημερινός έλεγχος, ένα «σήμερα δεν
είχαμε leads → τέλος» αφήνει τη γραμματεία τυφλή. Αν δεν υπάρχει τίποτα «Νέο» το script δεν
στέλνει email και βγαίνει καθαρά — δεν πειράζει να τρέξει τζάμπα.

Δες [docs/request-matchings.md](../../../docs/request-matchings.md).

**8. Report** to Panos: created / reused / skipped / failed counts, and any FAILs to retry, **plus
το αποτέλεσμα του βήματος 7** (πόσες ζητήσεις / πόσα ακίνητα μπήκαν στο digest, ή «καμία
εκκρεμότητα»). Review a
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
