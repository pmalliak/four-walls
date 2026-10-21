---
name: spitogatos-requests-fetch
description: >-
  Turn property-demand leads into EstatePrime CRM records — a contact + a ζήτηση/request + an
  incoming communication, correctly tagged and assigned to Μάνος. Covers both Spitogatos
  «Αίτηση ζήτησης ακινήτου» emails and the ζητήσεις from our own form at four-walls.gr/request
  (step 7β). Use when Panos wants to process/backfill demand leads into the CRM (e.g. "process
  the last 2 weeks of Spitogatos ζητήσεις"). ζήτηση = demand; NOT ανάθεση (assignment, which
  Make already handles).
---

# Spitogatos ζήτηση → EstatePrime intake

Fully **headless** pipeline (no CRM UI form-filling). Per lead: **contact → ζήτηση → communication**,
each communication linked to BOTH the contact and the request. Needs a browser session on
spitogatos + CRM — either the in-app `Claude_Browser`, or (preferred since 2026-07-24) the
**self-driven headless mode** below, which logs in on its own.

Deep field maps & the "why" live in [docs/estateprime-api.md](../../../docs/estateprime-api.md) and
[docs/estateprime-crm-ui.md](../../../docs/estateprime-crm-ui.md) — read them if anything below is unclear.

## Cloud + PC split (default since 2026-10-20, no secrets on the PC)
Panos's rule: **no `.dev.vars`, no Bitwarden, no Spark**. The cloud session holds every secret
in its environment (`ESTATEPRIME_*`, `ZOHO_*`) and does everything that talks to `/api`, Zoho
or Make. The PC (Remote Control, folder four-walls, dedicated Edge :9222) only does what bot
protection forbids from a cloud IP: the Spitogatos detail pages and the CRM `/*/form` posts.
Files move between the two through the Remote Control session (the PC writes JSON, the cloud
reads it back, and the other way round). Scripts read secrets via `scripts/lib/env.mjs`:
environment first, `.dev.vars` only as a fallback, so the all-on-PC mode below still works.

| step | where | command |
|---|---|---|
| 1 enumerate | cloud | `node scripts/enumerate-zoho.mjs <yyyy/MM/dd> state/processed.json enquiries.json` (Zoho, whole account: the mail moved to **Archive** by 2026-10) |
| 2 login | PC, by hand | `node scripts/headless/start-edge.mjs` (node twin of ensure-apps for the Edge), then `node scripts/headless/login-status.mjs` (read-only) says which site needs it; Panos logs in to Spitogatos in the Edge :9222 (remember me). At the 2FA step the cloud runs `node scripts/zoho-2fa.mjs` and hands him the code. The CRM session usually survives; if not, he logs in there too. |
| 3 details | PC | `node scripts/headless/sg-fetch-nav.mjs enquiries.json details.json` |
| 4 leads + prep | cloud | `leads.json` by hand, then `prep.mjs` (creates contacts over `/api`) |
| — approval | cloud | **show Panos the worklist (name, ζήτηση, area) and get a yes before step 5** |
| 5 post | PC | `node scripts/headless/crm-post.mjs worklist.json results.json`. With no key on the PC a hung eval cannot be checked there, so it **stops with exit 2** and marks the lead «unknown»: read `/api/requests` from the cloud, adopt or drop it, re-run the rest. |
| 6 verify | cloud | `verify-log.mjs`, then commit `processed.json` (from the cloud) |
| 7 digest | cloud → PC → cloud | `node tools/crm-request-matchings.mjs --requests-out req.json` · PC: `--requests-in req.json --matches-out m.json` · cloud: `--requests-in req.json --matches-in m.json --send`. The webhook URL is not in the env: read it from Make (hook 3457244, MCP `hooks_get`) and pass it inline as `MAKE_MATCHINGS_WEBHOOK=… node …`. |
| 7β site | cloud, then PC | `site-requests.mjs` now reads info@ over Zoho too; its worklist goes through step 5 on the PC |

Network: the cloud needs `fourwalls.estateprime.gr`, `mail.zoho.com`, `accounts.zoho.com` and
`hook.eu1.make.com`. **Never add a proxy-injected secret for `fourwalls.estateprime.gr`**: it
overrides our Basic header and every `/api` call returns 401 (2026-10-20).

## Preconditions (all-on-PC mode)
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
   No Spark? `node …/headless/enumerate-dash.mjs fresh.json` reads the same leads off the dashboard.
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
  is not an option, re-run it with `-SkipSpark`, then run **`headless/enumerate-dash.mjs`**
  (see the 2026-08-20 entry below). It captures the page's OWN
  `GET /api/search-enquiries?page=N&perPage=25&…` XHRs via Network events (human-identical page
  loads, NOT a bulk sweep). Page 1 covers ~25 leads ≈ several days; the script keeps clicking
  «next» until the rows overlap `processed.json` so there is no gap. Cross-check with
  `enumerate.mjs` once Spark is back. The list rows lack `rooms/floorNumber/elevator` detail and
  carry area *names* rather than `geographyIds`, so still run sg-fetch(-nav) per id.
- **CRM eval fetches got slow, not stuck**: crm-post now takes ~30s per lead (Cloudflare), ~8min
  for 15 — let it finish. Before assuming a hang or re-posting, read back
  `GET /api/requests` (needs `Content-Type: application/json` even on GET, else 415) to see what
  actually landed — a re-run of an already-landed POST would duplicate the ζήτηση.

Gotchas learned 2026-08-20:
- **Spark refuses a shell launch, but starts fine from explorer.exe.** `Start-Process` on
  `Spark Desktop.exe` left no process at all (the 2026-07-27 symptom again), yet
  `Start-Process explorer.exe -ArgumentList '<path>'` brought it up and the CLI answered
  immediately. explorer is what a desktop double-click goes through, which is exactly the launch
  Panos does by hand. `ensure-apps.ps1` now retries that way on its own, so **do not ask Panos to
  click the icon before the retry has failed too**.
- **The dashboard SPA ignores `?page=N` on the page URL.** It re-requests page=1 every time, so
  navigating per page silently gives you the same 25 rows over and over (looks like 5 pages of
  data, is really one). Walk back in time by clicking the real arrow,
  `button.pagination--next:not(.is--disabled)`. `headless/enumerate-dash.mjs` does this and stops
  at the first overlap with `processed.json`.
- **The list rows key the lead as `searchEnquiryId`, not `id`.** An overlap check against
  `processed.json` on `r.id` silently never matches and walks the pager to its limit.
- **Same person, same ζήτηση, twice in one window ⇒ drop the older one before prep.** `prep.mjs`
  fills `supersedes` from the CRM's *existing* active requests, so two resubmits inside the SAME
  batch both come through as new (the first one is not in the CRM yet when the second is prepped).
  Check the fetched details for duplicate `telephone` values first and keep only the newest,
  recording the older in `skipped_duplicates` (2026-08-20: Αθανασιάδου 509990 → 510275).

Gotchas learned 2026-08-24:
- **Dedupe now checks phone THEN email.** The CRM enforces uniqueness on both, but prep only
  looked up the phone, so a customer who changed mobile came back as a NEW contact and the create
  died with `400 Phone number <their email> is already in use` (the message names the email even
  though it says "phone"). The lead then lands in `skipped` and is silently lost. `dedupeContact`
  falls back to an email search and, when it matches that way, emits a **warning** that the stored
  contact still carries the old number, so the office rings the number the lead actually used.
  Seen with Βασίλης Καστάνης (contact 148, lead 511239). Fix the stale number with
  **`headless/add-contact-phone.mjs --id 148 --phone +30… --star`** (`--dry` first): it reads the
  `show_edit=phones` modal, re-sends the whole section with a `new_phone[]` row appended, then
  stars the new number so the CRM calls the one the lead actually used. Careful if you edit it:
  the in-page code lives in a template literal, so node eats backslashes before the browser sees
  them, which is why that file uses string methods instead of regexes inside the eval.
- **A dead Edge kills crm-post at the first eval** (`ECONNREFUSED 127.0.0.1:9222`), which is the
  *safe* failure: nothing was posted. Re-run `ensure-apps.ps1` and, before re-posting, read
  `/api/requests` back and compare the highest id against the last one you know landed. Only
  re-post when none of the batch's contacts already carry a new ζήτηση.

## Auth split (important)
- **`/api/*`** (contacts, locations, requests-read, verification) = **HTTP Basic** → run from **node**.
- **`/requests/form` and `/communication/form`** (the create endpoints) = **session cookie** →
  run from a **browser same-origin `fetch`** on the CRM tab. The public `POST /api/requests` and
  `POST /api/communication` request-link are BROKEN — never use them to create.

Gotchas learned 2026-07-29:
- **Spitogatos mail no longer lands in the Inbox.** The Zoho filter «Remove from Inbox Spitogatos
  Notifications» (`From contains notifications@spitogatos.gr` → move to `Inbox/Spitogatos`) files
  every notification, ζητήσεις **and** the 2FA «Κωδικός επαλήθευσης», into that folder. Read mail
  with `spark search` (covers all folders when `--in` is omitted, or all folders of one account
  with `--in info@four-walls.gr`), **never** `spark emails <account>`, which lists the Inbox only.
  `enumerate.mjs` was already fine; `sg-login.mjs` was switched over. Spark's `subject:` filter
  matches Latin only (Greek subjects return zero rows), so scope by sender plus a big `--page-size`.

Gotchas learned 2026-07-30:
- **`POST /api/contacts` never sets the default (κύριο) email/κινητό** — and the CRM's
  «Αποστολή με Email» from listings 500s on contacts without one (send button stays disabled).
  prep.mjs/site-requests.mjs now put `star:{email,phone}` on created-contact worklist entries and
  `crm-post.mjs` POSTs `star_email`/`star_phone` to `/contacts/view/{id}` (the UI star-click call).
  Backfill for older/Make-created contacts: `headless/fix-contact-defaults.mjs`
  (`--dry`, `--ids 257,258`, `--last N` for just the newest); details in
  [docs/estateprime-api.md](../../../docs/estateprime-api.md). Make can never do it
  itself — `/contacts/view/` is behind Cloudflare bot protection and 403s any
  non-browser client (2026-08-04).

Gotchas learned 2026-08-05:
- **Edge FREEZES a background tab, and a frozen tab hangs the whole run.** Its timers stop
  and `fetch`/`XHR` never settle, so `Runtime.evaluate({awaitPromise:true})` waits forever —
  the `timeout` param does not apply to the awaited promise, so nothing rescues you. Symptom:
  one lead lands, then silence (a 40-minute stall here). A `document.readyState` eval still
  answers instantly, which makes the tab look healthy; the tell is that even an **in-page**
  `setTimeout` fails to fire. This bites whenever a second session drives the same Edge and
  brings its own tab to the front. Cure: `Tab.openActive()` (new tab + `bringToFront` +
  `Page.setWebLifecycleState:active`) — a fresh tab answers in 0s. `crm-post.mjs` now bounds
  every eval from node, reopens the tab on a timeout, and **reads `/api` back to adopt a POST
  that landed** instead of re-posting it (a blind retry = a duplicate ζήτηση); it also writes
  `results.json` after each lead, so a kill mid-run keeps what finished.
  `tools/crm-request-matchings.mjs` uses `openActive` for the same reason.
- **Resume after a stall**: read `/api/requests` (newest first) and `/api/communication` to see
  what actually landed, drop those leads from the worklist, and seed `results.json` with them
  by hand — then `verify-log.mjs` closes the run normally.
- **Επανυποβολή ⇒ η παλιά ζήτηση γίνεται Ανενεργή, όχι δεύτερη εγγραφή** (Πάνος, 2026-08-06).
  Ο ίδιος άνθρωπος ξαναστέλνει σχεδόν την ίδια ζήτηση με άλλη τιμή ή τ.μ. (ο Milan Bos δύο φορές
  σε δύο μέρες, €650 → €600). Δύο ενεργές εγγραφές σημαίνουν διπλά ματσαρίσματα στο digest της
  γραμματείας. `prep.mjs`: όταν η επαφή βρεθεί με dedupe, γεμίζει `supersedes` με τις **ενεργές**
  ζητήσεις της που έχουν **ίδιο `availability` + `category`** (όχι όλες: ένας που ζητά και
  κατάστημα δεν πρέπει να χάσει τη ζήτηση κατοικίας). `crm-post.mjs`: **αφού** περάσει η νέα,
  `POST /requests/view/{id}` σε κάθε παλιά — ποτέ πριν, αλλιώς μια αποτυχία αφήνει τον πελάτη
  χωρίς καμία ενεργή ζήτηση. **Δύο ενέργειες, και οι δύο απαραίτητες**: `change_status=2`
  (κατάσταση «Ανενεργή») **και** `change_deal_status=withdrawn&close_reason=5` (στάδιο
  «Αποσύρθηκε», λόγος «Διπλή καταχώρηση»). Χωρίς το δεύτερο το στάδιο μένει «Ανοιχτό» και η
  ζήτηση μοιάζει με δουλειά που ξεχάστηκε. Ίδια λογική και στο `site-requests.mjs` (7β).
- **Τηλέφωνο 8 ψηφίων από 9 = Κύπρος**, όχι Ελλάδα: χωρίς πρόθεμα το CRM κολλάει μόνο του «+30»
  και το κινητό γίνεται άκυρο (η επαφή 277 αποθηκεύτηκε `+3099567251` και το `star_phone`
  απέτυχε, γιατί έψαχνε τον αριθμό όπως τον έστειλε το lead). Το `normPhone` βάζει πλέον `+357`.
- **Γλώσσα επαφής**: ξένο τηλέφωνο ⇒ `language_id: 2` (Αγγλικά). Το select της φόρμας δείχνει
  **μόνο** «Ελληνικά», αλλά το backend δέχεται κανονικά το 2 και η επαφή γράφει «English (UK)».
  Backfill σε παλιές επαφές: `headless/fix-contact-locale.mjs --ids 227,187 [--name "First Last"]
  [--dry]` (διαβάζει το modal `show_edit=basics` και ξαναστέλνει ΟΛΟ το section, γιατί ό,τι λείπει
  καθαρίζεται).
- Commercial/land ζητήσεις now get a subcategory too: `prep.mjs`'s `PROP_TYPE` maps
  `office/store/warehouse/hotel/commercial_building/hall/industrial_space/craft_space/plot/parcel`
  (slug-identical to the CRM). Before that a warehouse lead stored category only, which the
  matching sweep cannot use.

## Anti-scraping rule
Enumerate leads from **emails** (Spark, `info@four-walls.gr`, folder `Inbox/Spitogatos`, pushed by
the portal = zero risk). Fetch
each lead's detail with **one paced** `GET /api/search-enquiries/{id}` (mimics clicking a
notification). **Do NOT bulk-sweep** the `/api/search-enquiries` list endpoint. Emails and the
dashboard are verified 1:1 identical.

## Tags — always by ID (Panos may rename tags)
contact `tags:[12,9,10]` (ai,spitogatos,ΖΗΤΗΣΗ) · request `tags[]=13&tags[]=14` (ai,spitogatos)
· comm `tags[]=15&tags[]=8` (ai,spitogatos). The «ai» tag was named «claude» until 2026-07-31 —
same ids, proving the by-ID rule right. If a tag is deleted+recreated its id changes —
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
names as-is; keep genuinely-foreign names Latin. **Εξαίρεση: ξένο τηλέφωνο ⇒ άσε το όνομα ΛΑΤΙΝΙΚΑ**
όπως το έγραψε ο ίδιος (Πάνος, 2026-08-06) — ένα «Eleni Mpaltatzides» με γερμανικό κινητό ζει στο
εξωτερικό και το μεταγραμμένο «Ελένη Μπαλτατζίδου» δεν είναι το όνομα που ξέρει. Το `prep.mjs` βάζει
μόνο του `language_id: 2` (Αγγλικά) σε ξένο τηλέφωνο· η **Κύπρος (+357) μένει στα Ελληνικά**.
Also set `latin_name` = original. Save as `leads.json`.
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

**7β. Ζητήσεις από τη ΔΙΚΗ ΜΑΣ φόρμα (four-walls.gr/request). Τρέξ' το κι αυτό πάντα.**
```bash
node .claude/skills/spitogatos-requests-fetch/scripts/site-requests.mjs 2026/07/29 \
     .claude/skills/spitogatos-requests-fetch/state/processed.json <scratch>/site-worklist.json
node .claude/skills/spitogatos-requests-fetch/scripts/headless/crm-post.mjs <scratch>/site-worklist.json <scratch>/site-results.json
```
Διαβάζει τα «ΝΕΑ ΖΗΤΗΣΗ» email του `info@` (τα στέλνει το σενάριο «Site - Φόρμα επικοινωνίας»,
κλάδος ζήτησης) και βγάζει worklist **στο ίδιο σχήμα με το prep.mjs**, οπότε το `crm-post.mjs` και
το `verify-log.mjs` δουλεύουν αυτούσια. Το email λέει στη γραμματεία να την καταχωρίσει με το χέρι·
αυτό το βήμα υπάρχει για να μη μείνει μια ζήτηση του Σαββάτου ως τη Δευτέρα. Είναι idempotent
(`processed.json`, leadId `site-<ημερομηνία>-<τηλέφωνο>` — ΟΧΙ emailId, το γραφείο στέλνει στον
εαυτό του και το Spark βλέπει το ίδιο μήνυμα σε Εισερχόμενα ΚΑΙ Απεσταλμένα), άρα αν την πρόλαβε
η γραμματεία απλώς θα τη δεις ως «already processed» — αλλά **αν την καταχώρισε χειροκίνητα χωρίς
να περάσει από εδώ, το script δεν το ξέρει**: κοίτα τη λίστα ζητήσεων για διπλή εγγραφή πριν το
τρέξεις σε παλιά emails.

**Από 2026-07-30 η επαφή + η εισερχόμενη επικοινωνία γράφονται ΑΥΤΟΜΑΤΑ στη ροή της φόρμας**,
από τους κλάδους zitisi/anathesi του Make scenario 6530594 (το email γράφει «Επαφή #id» — ΟΧΙ από
τον Worker: το EstatePrime απαντά 403 σε κάθε Worker-originated POST, δες docs/estateprime-api.md).
Το 7β άρα: βρίσκει την επαφή με dedupe (τη ΞΑΝΑχρησιμοποιεί, δεν διπλογράφει), δημιουργεί ΜΟΝΟ τη
ζήτηση, και ΔΕΝ γράφει δεύτερη επικοινωνία (το worklist entry δεν έχει `comm`· το crm-post.mjs το
προσπερνά). Η δική του δημιουργία επαφής είναι fallback για την περίπτωση που το CRM write του
Make απέτυχε (το email τότε γράφει «ΔΕΝ καταχωρήθηκε» με κόκκινο).

Διαφορές από τα leads του Spitogatos, όλες σκόπιμες:
- **Περιοχές από ελεύθερο κείμενο.** Ο επισκέπτης γράφει «Τριανδρία, Χαριλάου», όχι ids. Το script
  κατεβάζει μια φορά όλο το `/locations` (~15.100 γραμμές· το `?search=` **αγνοείται** εκεί) και το
  cache-άρει δίπλα στο `processed.json`. Αν δεν αναγνωρίσει καμία περιοχή, **δεν** μαντεύει: βγάζει
  το lead στα skipped για να το δει άνθρωπος (η ζήτηση χωρίς τοποθεσία απορρίπτεται ούτως ή άλλως).
- **Tags χωρίς spitogatos**: επαφή `[12,10]`, ζήτηση `[13]`, comm `[15]`.
- **Χωρίς `source_id`**: το CRM έχει μόνο Spitogatos.gr και xe.gr στις πηγές ζήτησης, και το να
  περάσει δικό μας lead ως Spitogatos χαλάει ακριβώς τον αριθμό που κοιτάει ο Πάνος για την πύλη.
  Αν προστεθεί πηγή «four-walls.gr» στο CRM UI, βάλε το id στο `requestSource` του script.

**8. Report** to Panos: created / reused / skipped / failed counts, and any FAILs to retry, **plus
το αποτέλεσμα του βήματος 7** (πόσες ζητήσεις / πόσα ακίνητα μπήκαν στο digest, ή «καμία
εκκρεμότητα») **και του 7β** (πόσες ζητήσεις του site μπήκαν). Review a
batch in the CRM by filtering the Επικοινωνίες list on the `ai` tag (comms sort by the lead's real
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
