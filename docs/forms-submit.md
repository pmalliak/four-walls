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
  "form": "anathesi",              // anathesi | ypodeixi | apodeixi | katachorisi | prosfora | ektimisi
  "title": "Εντολή Ανάθεσης",
  "submitted_at": "…",             // the tablet's clock — can be wrong
  "data":       { /* every data-k field */ },
  "signatures": { "sig_entoleas": "data:image/png;base64,…", … },
  "pdf_filename": "anathesi_….pdf",
  "pdf_base64": "…",
  // added server-side, overwriting anything the client sent:
  "submitted_by": "someone@four-walls.gr",   // from the Access JWT; null on local dev
  "received_at": "…",                         // our clock, for audit
  "pdf_url": "https://four-walls.gr/api/forms/file/…?exp=&sig="  // see below
}
```

Το **`pdf_url`** μπαίνει από τον Worker λίγο πριν την προώθηση: το ίδιο
PDF ακουμπάει στο R2 και παίρνει υπογεγραμμένο link 90 ημερών
([forms-archive.mjs](../worker/lib/forms-archive.mjs)). Υπάρχει επειδή η
υποχρέωση «αρχειοθέτησε αυτό το έντυπο» στο CRM **δεν μπορεί να κουβαλήσει
συνημμένο**, μόνο σύνδεσμο. Λείπει όταν το έντυπο δεν έχει PDF (προσφορά,
ή καταχώριση που έχασε το jsPDF) ή αν γκρινιάξει το R2, οπότε το task
δείχνει πίσω στο email. Ολη η ιστορία: [crm-tasks.md](crm-tasks.md).

`katachorisi` also sends `summary`, `ref`, `schema: "crm-v1"` and a `crm`
object — its fields mirror the EstatePrime listing schema 1:1 so property
creation can be automated later (see
[forms-katachorisi-crm.md](forms-katachorisi-crm.md)); it has no `CONFIG`, so
it sets `form` by hand in `buildPayload()`. Its `data` keeps the legacy keys
the Make templates read (`transaction_type`, `subtype`, `address`, `tk`,
`region`, `area`), and `data.send_to_client` stays **boolean** because the
client-email filter compares against the text `"true"`.

**One appointment, two envelopes (2026-08-06).** The CRM's own «Τύπος
ανάθεσης» drives it: Αποκλειστική or Απλή (the default) makes the
katachorisi page submit **twice** through `FWOutbox.submit` — its own
`form:"katachorisi"` payload and a second, fully-formed `form:"anathesi"`
one, same shape the standalone ανάθεση sends, built by
`buildAnathesiData()` + the shared `_anathesi-doc.fw.js` text. «Χωρίς»
means no document, no tab, no anathesi emails. Nothing downstream knows
the difference: each submission gets its own dedupe hash, its own sent-log
row and its own Make branch, which is why the Worker and the router needed
**zero** changes (precedent: the εκτίμηση already submits twice). The PDFs
are built strictly one after the other — two html2canvas runs in parallel
starve each other on the iPad.

`prosfora` and `ektimisi` are the two entries with **no document at all**: no
signatures, no `pdf_base64`, no `doc_html`. The προσφορά is an internal note
that a client made an offer on a listing (see
[forms-prosfora.md](forms-prosfora.md)); the εκτίμηση is a
property-details payload that the Worker parks in KV under a random
`valuation_ref` before forwarding, so Make can later fetch the finished AI
report from `/api/valuation?ref=…` (see [valuation.md](valuation.md)).
Everything else in the pipeline is shared: same POST, same Access stamp, same
outbox.

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
time, so a queued form can legitimately show hours between the two. Retrying
blindly would mail the same έντυπο twice, so the Worker de-duplicates on
content (next section).

While an έντυπο waits in the queue its send button stays **locked** as «Σε
αναμονή ⏳» instead of offering itself again. That is what actually happened on
2026-07-31: tapped with no signal, queued, and tapped again the moment the bars
came back — so the queue drained *and* the fresh tap went out. The queue lives
outside the form (IndexedDB, not the draft: the draft is discarded the moment
the payload is safely queued), so the consultant moves on to the next έντυπο
and it leaves on its own; «Πίσω» for edits unlocks the button, because changed
fields are a different document. `clearQueuedButtons()` in the outbox flips the
label to «Στάλθηκε ✓» when the queue empties, so no button is left claiming to
be waiting for something that already left. Queued for any other reason (Access
session, HTTP error) still unlocks it: those need a human.

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

## One έντυπο, one send

The outbox retries anything whose POST didn't come back, but a lost
**response** is not a lost **submission**. On 2026-07-31 an εκτίμηση reached
Make twice, 27 seconds apart: same `valuation_ref`, byte-identical report,
two «ΕΚΤΙΜΗΣΗ · …» emails in info@.

So the Worker refuses to forward the same έντυπο twice. It hashes the payload
(SHA-256) minus everything that changes without the document changing:
`submitted_at`, the PDF (html2pdf stamps a CreationDate, so the bytes differ
on every render), katachorisi's clock-based `ref`, and the server-side stamps.
The hash lives in KV as `forms:sent:<hash>` for **48 hours**; a second POST
carrying it gets `{ok:true, duplicate:true, sent_at:<iso>}` and Make never
hears about it.

- **Content, not a client id.** An id minted by the browser would be fresh on
  a second tap and sail through, and the second tap is one of the two ways
  this happens: when the outbox thinks a send failed, it re-enables the button
  and shows «ΔΕΝ στάλθηκε», so the consultant presses again.
- **Written before the forward, deleted if it fails**, so two near-simultaneous
  attempts can't both go out and a Make outage doesn't lock an έντυπο out of
  its own retry.
- **Not silent.** The form says «Είχε ήδη σταλεί. Δεν ξαναστάλθηκε.» instead of
  «Στάλθηκε» (`duplicate` flows back through `FWOutbox.submit`), because when a
  client is waiting for that email the two are different facts.
- **Fail-open.** If KV errors, the έντυπο is forwarded anyway: a duplicate
  beats a lost contract.
- **48 hours, and the window asks rather than blocks.** It started at six,
  which covered the retries, but on 2026-08-02 an εκτίμηση left a second time
  two days later from a screen that had stayed open since Friday: a send the
  consultant no longer remembers is not a deliberate re-send. Inside the
  window `FWOutbox.submit` shows **when** the first one went out («Το ίδιο
  έντυπο είχε ήδη σταλεί χθες στις 15:49. Να σταλεί ΞΑΝΑ;») and only a yes
  re-posts it with `force_resend: true`, which skips the check and refreshes
  the key. The flag is in `DEDUPE_SKIP`, so it cannot masquerade as a new
  document. Inside the window a genuinely new έντυπο differs anyway, if only
  in its signatures.
- **The queue never asks.** `flush()` drains unattended, often against a
  locked screen, so a duplicate there is just counted and reported.
- The question lives in `_outbox.fw.js` alone, which is why none of the six
  form pages needed changing.

The two εκτίμηση sends stay separate because their payloads differ: the office
one carries only the ref, the owner one adds `client_email` and the PDF.

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
| anathesi / ypodeixi (πρώτο email) | `info@`: internal «ΓΙΑ ΑΡΧΕΙΟ CRM», the signed PDF plus where to file it in the CRM | none |
| anathesi (δεύτερο, **υπό όρους** από 2026-08-06) | `entoleas_email` — μόνο όταν `data.send_to_client` δεν είναι ρητά `false` **και** υπάρχει διεύθυνση (το `exist` στο φίλτρο του module #3 κόβει και τα παλιά DLQ errors της κενής διεύθυνσης)· payload χωρίς το πεδίο περνάει, οπότε ουρές του outbox και παλιές cached σελίδες συνεχίζουν να στέλνουν | cc `submitted_by` |
| ypodeixi (δεύτερο) | `entoleas_email` (no fallback: a blank address errors the bundle into the DLQ) | cc `submitted_by` |
| apodeixi (πρώτο email) | `info@`: internal «ΓΙΑ ΑΡΧΕΙΟ CRM», same shape | none |
| apodeixi (δεύτερο) | `katavallon_email` (no fallback, same DLQ behaviour) | cc `submitted_by` |
| katachorisi (always) | `info@` — internal «ΓΙΑ ΚΑΤΑΧΩΡΙΣΗ» reminder to enter listing+contact | none |
| katachorisi (ΝΑΙ on the form) | `owner_email` — client-facing confirmation | cc `submitted_by` |
| prosfora | `info@` — internal «ΝΕΑ ΠΡΟΣΦΟΡΑ» notice to record the offer | none |
| ektimisi (office) | `info@` — the AI valuation report (subject «ΕΚΤΙΜΗΣΗ · …»), fetched from `/api/valuation` | cc `submitted_by` |
| ektimisi (owner, «Προς ιδιοκτήτη») | `client_email` — client-facing report | cc `submitted_by` |

`submitted_by` is the consultant's email that the Worker stamps from the
Access JWT, so the person who filled the form gets the copy; the mapping is
`{{ifempty(1.submitted_by; "info@four-walls.gr")}}` because local-dev
submissions carry `submitted_by: null`. The fixed personal copies to
`panos@` and `manos@` were dropped on 2026-07-31, and no bcc archive copy
is kept: every module sends through the info@ Zoho account with
`saveAfterSent: true`, so the client emails are already searchable in the
info@ Sent folder.

The internal «ΓΙΑ ΑΡΧΕΙΟ CRM» emails (modules 24/25/26, added 2026-07-31)
sit **first** in each branch, before the client email: the office copy with
its filing instructions goes out even when the client email later fails on
a blank address. Where each PDF gets filed is written in the email body
itself (ανάθεση: επαφή ιδιοκτήτη + ακίνητο μόλις καταχωριστεί· υπόδειξη:
επαφή πελάτη· απόδειξη: επαφή καταβάλλοντα + ακίνητο).

The προσφορά never mails the client: an offer is the office's information,
and the interested party already knows what they offered.

Two forms now carry a send-to-client choice: katachorisi's ΝΑΙ/ΟΧΙ (or, in
the combined flow, the «Αντίγραφα στον ιδιοκτήτη» τρίπτυχο «Όχι / Μόνο
ανάθεση / Και τα δύο», which sets `send_to_client` on **each** of the two
payloads: the ανάθεση gets `true` on «Μόνο ανάθεση» ή «Και τα δύο», η
καταχώριση μόνο στο «Και τα δύο») and the ανάθεση itself, whose standalone
page always sets `send_to_client:true` explicitly. Η επιλογή
επαναλαμβάνεται και στην **προεπισκόπηση** της καταχώρισης, ώστε να
αλλάζει την τελευταία στιγμή, μπροστά στον ιδιοκτήτη. Υπόδειξη and
απόδειξη always mail the client — there is no second flow. The client copy
and the internal reminder are different emails. Στο κοινό flow η
γραμματεία παίρνει **δύο** ξεχωριστά emails «ΓΙΑ ΑΡΧΕΙΟ CRM»/«ΓΙΑ
ΚΑΤΑΧΩΡΙΣΗ» (ένα ανά έντυπο), όπως αποφασίστηκε — όχι ένα με δύο
συνημμένα.

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
