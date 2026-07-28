# CRM templates (EstatePrime · Twig)

Server-side **Twig + HTML** templates that live inside the EstatePrime CRM (you
paste them into the CRM editor). Two kinds, with **different** renderers, styles
and constraints:

| File | Kind | When | Style |
|------|------|------|-------|
| [`valuation-report.twig.html`](valuation-report.twig.html) | PDF document | Αναφορά Εκτίμησης | Document header, navy `#1C3457` / pink `#FF0062` |
| [`appointment-created.twig.html`](appointment-created.twig.html) | Email (GR) | ραντεβού δημιουργήθηκε | Make email, navy `#16233A` / pink `#FF1462` |
| [`appointment-reminder.twig.html`](appointment-reminder.twig.html) | Email (GR) | υπενθύμιση ραντεβού | ” |
| [`appointment-created.en.twig.html`](appointment-created.en.twig.html) | Email (EN) | appointment booked | ” |
| [`appointment-reminder.en.twig.html`](appointment-reminder.en.twig.html) | Email (EN) | appointment reminder | ” |
| [`request-matchings.twig.html`](request-matchings.twig.html) | Email (GR) | νέα διασταύρωση ζήτησης – ακινήτων | ” |
| [`request-matchings.en.twig.html`](request-matchings.en.twig.html) | Email (EN) | ” — English (UK) slot | ” |
| [`listing-recommendations.twig.html`](listing-recommendations.twig.html) | Email (GR) | «Προτάσεις Ακινήτων» — προτάσεις ακινήτων σε επαφή | ” |
| [`listing-recommendations.en.twig.html`](listing-recommendations.en.twig.html) | Email (EN) | ” — English (UK) slot | ” |
| [`appointment-created.sms.twig`](appointment-created.sms.twig) | SMS (GR) | ραντεβού δημιουργήθηκε | plain text, one line per detail |
| [`appointment-reminder.sms.twig`](appointment-reminder.sms.twig) | SMS (GR) | υπενθύμιση ραντεβού | ” |
| [`appointment-created.en.sms.twig`](appointment-created.en.sms.twig) | SMS (EN) | appointment booked | ” |
| [`appointment-reminder.en.sms.twig`](appointment-reminder.en.sms.twig) | SMS (EN) | appointment reminder | ” |

The matchings email ends with a **«σταματήστε τις προτάσεις»** link to
`/request-closed?r=…&c=…` — the client's opt-out, wired to Make; see
[../docs/request-closed.md](../docs/request-closed.md).

**Two different template families, two different editors** (learned 2026-07-27):

- **`/settings/email-templates/view/new_request_matchings/{1,2}`** — the ζήτηση
  διασταύρωση (request-matchings). Data roots: `contact`, `listings[]`,
  **`request`**, **`user`**, **`office`**, `company`, `system`. Editor POSTs
  `{preview:true,…}` to save/preview; save is `{save:true, content, subject}`.
- **`/settings/listings-email-templates/view/{2,3}`** — «Προτάσεις Ακινήτων»
  (listing-recommendations), sent **from listings** to a contact, **not** from a
  ζήτηση. Data roots: `contact`, `listings[]`, **`batch`** (`batch.url` = a
  hosted page with all the listings), `company`, `system` — **NO `request`, NO
  `user`, NO `office`**, so no agent signature and the phone is hardcoded. Newer
  editor: preview is `{preview_template:1,…}`, save is
  `{save_template:1, title, subject, language_id, content}` — different param
  names, same URL. Photos are read `{{ listing.photos[0] }}` (bracket).

Both families expose `listings` as an **array with `{% for %}`** — a ζήτηση or a
recommendation batch can carry several listings.

## The two hosted landing pages (where the email buttons go)

The recommendation/matching emails link to **EstatePrime-hosted** pages, not to
four-walls.gr: `listing.url` = `/l/…` (one property) and `batch.url` = `/b/…`
(all properties in the batch). They are configured under **Ρυθμίσεις Ακινήτων**:

| File (source copy) | CRM page | Slots |
|---|---|---|
| [`listing-public-page.twig.html`](listing-public-page.twig.html) / [`.en`](listing-public-page.en.twig.html) | Δημόσια Σελίδα Ακινήτου | `/settings/listings-public-page` (+`/2` = EN) |
| [`listing-public-404.twig.html`](listing-public-404.twig.html) / [`.en`](listing-public-404.en.twig.html) | ” — «ακίνητο μη διαθέσιμο» | same page, `field: content_404` |
| [`listing-batch-page.twig.html`](listing-batch-page.twig.html) / [`.en`](listing-batch-page.en.twig.html) | Σελίδα Πολλαπλών Ακινήτων | `/settings/listings-batch-page` (+`/2` = EN) |

These are **web pages, not emails** (Bootstrap, real CSS/JS, gallery, Leaflet
map). We **rethemed the EstatePrime stock templates in place** rather than
rewrite: the whole colour system hangs off `--brand`, which stock sets to
`{{ company.main_color }}`. Our version pins **`--brand: #ff0062`** (site pink,
overriding whatever the CRM company colour is) and prepends **Manrope** to the
font stack + a Google-Fonts `<link>` — everything else (structure, gallery JS,
map) is untouched. Navy `#1C3457` accents come through the existing dark footer.

**Logo:** the stock templates pull `{{ company.logo }}` (a bare cube in CRM
company settings) and `{{ office.logo }}` (an **Estate Prime** placeholder in
office settings). We hardcode our real wordmark logo in the brand bars/headers
— `src="https://four-walls.gr/images/logo/fourwalls_logo.svg"` (the same file
the site header uses, served from our own domain) — and **drop the office.logo
`<img>`** so the office card shows just «Four Walls / address / email», no Estate
Prime badge. The alternative root fix is uploading the proper logo in the CRM
company/office settings (then revert these to `{{ company.logo }}`); we chose the
in-template hardcode for immediate, guaranteed control on these pages.

**View tracking (why these pages beat linking to four-walls.gr):** the rendered
page carries **no** client-side pixel/beacon (checked the live HTML — only a
`referrerPolicy` on video embeds). Tracking is **server-side**: EstatePrime logs
the GET to the `/l/…` and `/b/…` URLs, and a real send uses a per-recipient
tokenised link (the `…/preview` URLs are the untracked preview variant), so the
CRM can attribute a view to the specific contact.

**Redirect-to-our-site (keeps the CRM view AND lands the client on four-walls.gr,
2026-07-27).** The emails still point at the EstatePrime `listing.url` / `batch.url`
— the client's browser hits `/l/…` / `/b/…` **top-level**, which is what solves
the Cloudflare bot-challenge (`fourwalls.estateprime.gr` is behind one — a
server-side/background ping just 403s, so we can't fake the view) and lets the
CRM log it. The **single-listing** page then **immediately bounces to our own
site**: `four-walls.gr/properties/{{ listing.code }}` (code matches our
`/properties/<code>` routing 1:1, verified). EN → `/en/properties/<code>`.

**The batch page deliberately does NOT redirect (2026-07-28).** If it bounced to
our own grid, the client's per-listing drill-downs would happen on four-walls.gr
and never re-hit EstatePrime — so the CRM would only log the batch *open*, not
*which* properties the client viewed. Instead the batch page stays as the
(branded) recommendations overview, and each card links to `{{ listing.url }}`
(`/l/…`) → EstatePrime logs that individual view → the single-listing redirect
then lands the client on our `/properties/<code>`. Net result: every view (batch
open + each listing) is tracked, and every actual property page is on our site.
The overview's «Δείτε όλα τα ακίνητά μας» CTA still links to `/properties` for
browsing the full catalogue. (Direct per-listing buttons in the *email* likewise
go through `/l/…`, so those are tracked too — the only untracked path was the
batch → our-grid drill-down we removed.)

`js/listings.fw.js` still supports a `?codes=` grid filter (scopes `/properties`
to a set of codes, with a «οι προτάσεις μας για εσάς» banner + «δείτε όλα»
escape) — currently unused by the redirect flow but kept as a building block for
a future «see these on our site» link.

The single-page view is logged when EstatePrime **serves** the page (before the
redirect runs), so it isn't lost. Two gotchas baked into the snippet:
- the listing code rides in a **`<meta name="fw-redirect">`**, NOT inline
  in the `<script>` — the save-WAF 403s a POST with `{{ }}` **inside** a
  `<script>` (SSTI signature); in a plain attribute it's fine.
- redirect is skipped in the CRM editor preview: an srcdoc iframe has no
  `location.hostname`, and the `.../preview` URLs are excluded by pathname
  (avoid `window.top !== window.self` — that frame-bust pattern + a redirect
  also trips the WAF).

Editors differ again (a third variant): **preview** `{preview_public_page|preview_batch_page:1, content, listing_id|batch_id, language_id}`,
**save** `{save_public_page:1, language_id, field:'content'|'content_404', content}`
for the public page / `{save_batch_page:1, language_id, content}` for the batch,
POSTed to `_postUrl` (read `window._postUrl` / `window._langId` off the page).
Public preview needs a real `listing_id` (grab one from `/listings`); the
`.select-listings` tomselect does not auto-populate.

**Re-applying after an EstatePrime update:** these files are the source of
truth, but they are a retheme of EstatePrime's own markup — if the CRM ships a
new stock template, re-run the retheme (swap `--brand` + font) rather than
force-pasting the old file, or the new features are lost. The whole flow was
driven headlessly through the dedicated CDP Edge (`.claude/skills/.../headless/cdp.mjs`).

Data roots: documents get `valuation.*`; emails get `appointment.*`, `contact.*`,
`user.*`, `office.*`, `company.*`; the matchings email also gets `request.*` and
the `listings` array (`listing.code/price/title/description/photos/url`).
Subject lines are set in the CRM notification
config, **not** in the template (`<title>` is ignored). Emails go to recipients'
Gmail/Outlook, so **no `data:` URI images** (host them or use text); the map uses
a hosted Mapbox static image.

**No client name in the greeting** — plain «Γεια σας,». The CRM stores names in
the **nominative**, so «Γεια σας {{ contact.first_name }}» renders «Γεια σας
Γιώργος» where Greek wants the vocative («Γιώργο»). Same call, same reason, as
the έντυπα emails (docs/forms-submit.md).

**The matchings template has its own subject field** (unlike the appointment
ones, whose subject lives in the notification config) and **the subject accepts
Twig** — verified live: `… · {{ request.category }}` renders `… · Κατοικία`.
Language slots are separate URLs: `…/new_request_matchings/1` = Ελληνικά,
`/2` = English (UK). **Navigating between them discards unsaved editor content**,
so save one before opening the other.

**`request.purpose` / `request.category` come through in Greek even on the
English template** (the sample data does; assume a real send does too). The
English copy therefore avoids them — its chip shows only `ref. {{ request.id }}`
and its subject is the plain wording. Revisit after a real English send.

## SMS templates (2026-07-25)

The `.sms.twig` files mirror the appointment emails as short plain-text
messages in «paragraphs» separated by blank lines: heading, details
(date/time, address, map link — one per line), and — **only on
appointment-created** — the change/cancel phone. The reminder goes out ~1 hour
before the appointment, so its change/cancel line was dropped (2026-07-27).
They live in **Ρυθμίσεις → SMS → Πρότυπα** (editor
`/settings/sms/view/{slug}/{lang}` — `new_appointment` / `appointment_reminder`,
lang `1` = Ελληνικά, `2` = English (UK)); endpoint details in
[../docs/estateprime-api.md](../docs/estateprime-api.md). Conventions:

- Same data roots as the appointment emails minus `office` extras:
  `contact.*`, `appointment.*` (incl. `is_remote`/`meeting_url`, unused — the
  emails ignore them too), `user.*`, `office.*`, `system.*`.
- **Same dead-simple conditional structure** as the appointment emails
  (`is_full_day` if/else, `address.latitude` guard) and the EN copy dodges the
  validator's Twig-keyword words (no `with/or/at/date`, no apostrophes) — all
  four saved without tripping it, so whether the SMS save runs the same
  validator is untested.
- **Twig eats exactly one newline right after a block tag** (`{% if %}`,
  `{% else %}`, `{% endif %}`) — verified live: a line break placed straight
  after a tag glues the lines together («12:00Φιλικής Εταιρείας»). So after a
  tag, write **n+1 newlines to get n** — that's why the created templates show
  *two* blank lines before the closing phone line (the `{% endif %}` swallows
  one) and why the no-address render still comes out with a single clean blank
  line. Newlines after text or `{{ … }}` outputs pass through untouched.
- **No `{# … #}` comments** — they'd inflate the editor char counter and risk
  the WAF; explanations stay here.
- Each message carries a **Google Maps στίγμα link**
  (`https://maps.google.com/?q={{ lat }},{{ lng }}`, inside the
  `address.latitude` guard) — on its own line so the URL stays clean for the
  phone's link detection. A variable straight after `?q=` passes the validator;
  only scheme-adjacent variables (`tel:{{ … }}`) fail.
- Greek renders as UCS-2 (67 chars/segment concatenated) — with the sample
  address the created messages preview at 194/197 chars ≈ 3 segments (kept
  under the 201-char / 3-segment boundary; real coordinates carry more
  decimals than the sample's four) and the reminders at 149/151 ≈ 3 segments. In practice the provider (easysms.gr, configured 2026-07-27)
  transliterates Greek to unaccented UPPERCASE GSM-7, which bills 160/153 per
  segment instead — see the uppercase note below.
- **Why received SMS arrive ALL-CAPS:** the easysms.gr API's `ucs` parameter
  defaults to GSM encoding (`ucs=true` = Unicode); lowercase Greek doesn't
  exist in GSM-7, so the gateway transliterates to unaccented uppercase —
  the CRM editor/preview shows proper πεζά, the conversion happens at the
  provider. Evidently EstatePrime doesn't pass `ucs=true`; getting lowercase
  delivery means asking EstatePrime (tech@estateprime.gr) to expose/enable it,
  or an easysms account-level default if one exists. Trade-off: uppercase GSM
  bills 160/153 chars per segment (these messages = 2 segments), Unicode bills
  70/67 (= 3 segments, +50% cost). Greek-only transliteration shouldn't touch
  the Latin maps URL — but verify on a received SMS that the link stayed
  lowercase and clickable before relying on it.
- «Αυτόματη αποστολή» (the list's Ρυθμίσεις modal) was **left Ανενεργή** by us;
  the SMS provider became configured on 2026-07-27 (`#tab-settings`: easysms.gr,
  api_key, sender «FourWalls»), so flipping a template Ενεργή makes it really
  send.

## Two visual systems (don't mix them)

- **PDF documents** — the shared **document header**: pink brand cube +
  `FOUR WALLS` / `REAL ESTATE` wordmark, office contact right, navy `#1C3457`
  rule + 150px pink `#FF0062` accent. Same header the `forms/` έντυπα print.
- **Emails** — the house **Make/Zoho email style** (mirrors Make scenarios
  6530594 / 6604242): 520px card, Arial, bg `#f4f5f7`, navy `#16233A` band,
  pink `#FF1462` 3px accent + accents, label/value rows. Customer emails add the
  `FOUR WALLS REAL ESTATE` wordmark in the band; internal ones don't.

## ⚠️ «Δεν δείχνει preview» = Cloudflare 403, not Twig (2026-07-24)

The `new_request_matchings` editor previews live: every keystroke POSTs
`{preview, subject, html, variables}` back to the same URL and paints
`data.html` into a shadow root. Paste a full email template and **nothing
appears at all** — no error, no growl.

The cause is **not** the template. Cloudflare's WAF in front of
`fourwalls.estateprime.gr` answers that POST with **HTTP 403 + the «Just a
moment…» challenge page**. The page's own JS then dies silently: `data.success`
is undefined on an HTML body, and its `.fail()` handler references a `data`
variable that does not exist in that scope — so the growl never renders either.
The symptom is a blank preview and no clue.

**Fix: ship the CRM copy without `{# … #}` comments.** Verified live by POSTing
the same template with and without them: 6 933 chars with comments → 403;
6 374 chars, identical apart from comments → `success: true`, both sample
listings rendered. It is not a plain size limit (11 937 bytes of `<div style>`
filler sailed through) — the scoring just tips over with the comments present.
Bisecting the payload flips exactly on a comment. So: **keep the explanations
here in the README, not inside the twig.**

Everything else about this renderer is generous — it is **real Twig**. All of
these were confirmed working live through the preview endpoint:
`{% for listing in listings %}`, nested `{% if %}` inside the loop,
`{{ listings[0].title }}`, `{{ listing.photos.0 }}` **and** `{{ listing.photos[0] }}`.
The «keep conditionals dead simple» rule below is about the **appointment**
templates' save-time validator, a different beast — do not carry it over here.

Debug recipe if a preview goes blank again: open the page, then from the
console POST the payload yourself and look at the raw response —
`fetch(location.pathname, {method:'POST', body:new URLSearchParams({preview:'true', subject:'x', html, variables})})`
→ `.text()`. A `Just a moment` body means WAF, not Twig. Bisect by prefix to
find what tips it.

## ⚠️ The EstatePrime template validator (emails — learned the hard way)

Saving an email template runs a **strict, naive validator** that throws
«Οι μεταβλητές που δηλώσατε είναι λάθος». It rejects far more than bad variables:

1. **Only variables in that template's documented field list.** `appointment`
   has no `custom_field_11` (that's `contact.*`); no free-text notes field.
2. **Only plain `{% if variable %}` / `{% else %}` / `{% endif %}` and `{{ var }}`.**
   NO operators or tests inside tags: `==`, `!=`, `is defined`, `is not null`,
   `and`, `or`. (So an id→label map like `{% if category_id == 1 %}` is
   impossible — do such mapping in Make, or show the raw value / drop it.)
3. **No variable straight after a URL scheme:** `href="tel:{{ user.phone }}"`
   fails; plain `{{ user.phone }}` text and `href="https://…/{{ x }}"` are fine.
4. **It scans inside `{# … #}` comments** for `{% %}`/`{{ }}` — never put example
   Twig tags in a comment (plain prose in a comment is OK, even English keywords).
5. **English body text must dodge words that are Twig keywords/tests/functions.**
   Confirmed culprits: **`with`**, **`date`**, and the **apostrophe** (`I'm` — `'`
   opens a Twig string). Also avoid `is, and, or, not, in, as, from, do, set, use,
   range, empty, defined, block, apply, starts, ends`. Greek prose is naturally
   safe. Fixes used: label **"When"** not "Date"; "of your … appointment" not
   "… with"; ", " not " at "; "reach us on" not "at/by phone"; "We are" not "I'm".
   If a template needs rich English copy, **send it via Make/Zoho** — no validator.

These five rules come from the **appointment** templates. They do **not** apply
to `new_request_matchings`, which runs real Twig (see the section above) — check
per template type before assuming a restriction.

Full history: memory `estateprime-template-validator`. The **PDF document**
renderer is likely a real Twig engine (the valuation report uses `|default`,
`|number_format`, `is not empty`, `max/min`) — if it ever rejects those, the same
rules apply.

## Other conventions

- **Colours stamped via Twig, not CSS `var()`** (PDF engines don't support it):
  `{% set brand = company.main_color|default('#1C3457') %}` → literal hex in
  `<style>`. Emails hardcode the Make palette (`#16233A` / `#FF1462`).
- **Greek capitals take no τόνος** — type all-caps labels accent-free
  (`ΕΚΤΙΜΩΜΕΝΗ ΤΙΜΗ`), never rely on `text-transform:uppercase` (PDF engines keep
  the accent).
- **Numbers** (documents): `{{ n|number_format(0, ',', '.') }}` → `€185.000`.

## Preview

The CRM renders these; there's no local Twig runtime here. Eyeball the design
with a sample-data preview (static HTML, no Twig) built during development.
