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

The matchings email ends with a **«σταματήστε τις προτάσεις»** link to
`/request-closed?r=…&c=…` — the client's opt-out, wired to Make; see
[../docs/request-closed.md](../docs/request-closed.md).

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
