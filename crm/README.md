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

Data roots: documents get `valuation.*`; emails get `appointment.*`, `contact.*`,
`user.*`, `office.*`, `company.*`. Subject lines are set in the CRM notification
config, **not** in the template (`<title>` is ignored). Emails go to recipients'
Gmail/Outlook, so **no `data:` URI images** (host them or use text); the map uses
a hosted Mapbox static image.

## Two visual systems (don't mix them)

- **PDF documents** — the shared **document header**: pink brand cube +
  `FOUR WALLS` / `REAL ESTATE` wordmark, office contact right, navy `#1C3457`
  rule + 150px pink `#FF0062` accent. Same header the `forms/` έντυπα print.
- **Emails** — the house **Make/Zoho email style** (mirrors Make scenarios
  6530594 / 6604242): 520px card, Arial, bg `#f4f5f7`, navy `#16233A` band,
  pink `#FF1462` 3px accent + accents, label/value rows. Customer emails add the
  `FOUR WALLS REAL ESTATE` wordmark in the band; internal ones don't.

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
