# Έντυπα — υποβολή φόρμας (PWA → Worker → Make)

How a filled, signed form leaves the tablet and becomes an email with the PDF
attached. The CRM side of the same app (the «Από το CRM» pickers) is in
[forms-crm.md](forms-crm.md).

```
forms.four-walls.gr            Cloudflare Access
  form (browser)  ──POST──►  /api/forms/submit  ──►  Make hook  ──►  router  ──►  email + PDF
                              worker/lib/forms.mjs        (secret URL)      on {{1.form}}
```

## Why it goes through the Worker

A Make hook URL is a bearer credential: anyone holding it can inject a fake
signed contract. Client-side it lives in the page source **and in git** — which
is exactly how `katachorisi.html`'s old hook (`m67qifz4…`) and API key
(`fw_live_hoFdCU6…`) leaked. Both are burned; treat them as public.

Routing through the Worker also means Access has already proved **who** is
submitting, so the payload can be stamped with the consultant's identity — the
browser gets no say in it.

## The envelope

Every form posts the same shape. The Make router branches on `form`, so that
string is a contract between each form's `CONFIG.id` and the scenario's filters.

```jsonc
{
  "form": "anathesi",              // anathesi | ypodeixi | apodeixi | katachorisi
  "title": "Εντολή Ανάθεσης",
  "submitted_at": "…",             // the tablet's clock — can be wrong
  "data":       { /* every data-k field */ },
  "signatures": { "sig_entoleas": "data:image/png;base64,…", … },
  "pdf_filename": "anathesi_….pdf",
  "pdf_base64": "…",
  // added server-side, overwriting anything the client sent:
  "submitted_by": "someone@four-walls.gr",   // from the Access JWT; null on local dev
  "received_at": "…"                          // our clock, for audit
}
```

`katachorisi` also sends `summary` and `ref`; it has no `CONFIG`, so it sets
`form` by hand in `buildPayload()`.

**Adding a form** means adding its id to `FORM_IDS` in
[../worker/lib/forms.mjs](../worker/lib/forms.mjs) **and** a router branch in
Make. An id with no branch is dropped silently by Make; a branch with no id is
refused with `unknown_form`. Neither failure is visible to the consultant, so
do both or neither.

## Offline: the outbox (iPad with no signal)

Inside a property the iPad is often offline, so «Αποστολή» never talks to the
network directly — every form calls `FWOutbox.submit()`
([../forms/_outbox.fw.js](../forms/_outbox.fw.js)). If the POST fails for any
reason, the **whole payload** (data + signatures + generated PDF) is parked in
IndexedDB and retried automatically: on the `online` event, when the tablet is
unlocked (`visibilitychange` — the app is never swiped away, only locked), and
on a 3-minute timer while visible. A tap-to-send pill at the top shows how many
έντυπα are queued; `submitted_at` stays the tap-time, `received_at` the upload
time, so a queued form can legitimately show hours between the two.

[../forms/sw.js](../forms/sw.js) makes the app itself work offline: it
precaches the pages + **self-hosted** `html2pdf.bundle.min.js` (the cdnjs tag
is gone — offline PDF generation needs the library locally) and runtime-caches
the Google Fonts files. `/api/*` is never cached (CRM responses carry client
PII, and the outbox owns submit retries). **Bump `VERSION` in sw.js** when the
shell list changes.

iOS notes: Safari has no Background Sync, so queued forms send only while the
app is open — which is exactly the unlock/reopen moment hooked above. Use the
**installed Home-Screen app**, not the site in Safari: the two have separate
storage, and only the installed app is exempt from Safari's 7-day storage
eviction. The old `fw_last_failed` localStorage dead-drop in katachorisi was
removed — the outbox supersedes it.

## Make

| | |
|---|---|
| Scenario | **Έντυπα — υποβολή φόρμας** (`6600035`) |
| Hook | `Έντυπα PWA — υποβολή φόρμας` (`3407683`) |
| Secret | `MAKE_FORMS_WEBHOOK` — the URL itself is the credential |
| Optional | `MAKE_FORMS_APIKEY` — only if API-key auth gets enabled on the hook |

One scenario, one router, one branch per έντυπο. The branches share the
expensive parts (mail the PDF out, and later the CRM write-back), so five
scenarios would mean maintaining that five times.

**Incomplete executions (DLQ) must stay ON.** Without it a single bad bundle
deactivates the whole scenario after `maxErrors`, taking every form down with
it — this happened during development. With it, the bad bundle parks and is
replayable while the rest keep flowing.

The known bad bundle: `katachorisi` deliberately submits **without a PDF** if
jsPDF fails to load, but the email module's attachment mapping requires
`pdf_base64`. Those land in incomplete executions rather than being lost.

### Recipients (as wired in the scenario)

| branch | to | copies |
|---|---|---|
| anathesi / ypodeixi | `entoleas_email`, falling back to `info@` when blank | cc `manos@` + `panos@` |
| apodeixi | `katavallon_email`, same fallback | cc `manos@` + `panos@` |
| katachorisi (always) | `info@` — internal «ΓΙΑ ΚΑΤΑΧΩΡΙΣΗ» reminder to enter listing+contact | cc `panos@` + `manos@` |
| katachorisi (ΝΑΙ on the form) | `owner_email` — client-facing confirmation | bcc `panos@` + `manos@` |

Only katachorisi has a send-to-client choice (the ΝΑΙ/ΟΧΙ on the form; the
submit button announces it). The other three always mail the client — there
is no second flow. The client copy and the internal reminder are different
emails; katachorisi is the only branch that can send both.

### Greek grammar in the templates

The client's name is deliberately **not** in the greeting. `entoleas_onomatepwnymo`
is nominative, so «Αγαπητέ {{name}}» would render «Αγαπητέ Γιώργος Παπαδόπουλος»
(nominative where Greek wants vocative), and the απόδειξη's name fields are in
**γενική** («Γεωργίου Παπαδοπούλου»), which reads worse still. Names appear only
in table rows, where the nominative is correct.

That same γενική quirk affects the CRM picker on the απόδειξη: it fills what the
CRM holds (nominative) into a genitive slot, and the consultant fixes the ending.
The ΑΦΜ/πατρώνυμο are the parts that save the typing.

## Local testing

`CRM_DEV_BYPASS=1` in `.dev.vars` opens the Access gate for `wrangler dev` — and
because it makes `isLocalDev()` true for **any** hostname, the `forms.*` host
guard cannot be exercised locally.

```bash
npx wrangler dev --port 8793 --local
curl -X POST localhost:8793/api/forms/submit -H 'Content-Type: application/json' \
     -d '{"form":"bogus"}'          # -> 400 unknown_form
```

A real submission reaches the live Make scenario and sends a real email, so put
something obviously fake in the fields. A PDF built with no content stream
arrives as a **blank page** — that is the test file, not a broken pipeline.
