# CRM documents (EstatePrime · Twig)

Server-side **Twig + HTML** templates that EstatePrime renders to PDF. Unlike the
[`forms/`](../forms/) PWA (client-side, `html2pdf`), these run inside the CRM and
receive their data as Twig variables (`valuation.*`, `user.*`, `office.*`,
`company.*`, `system.*`).

## Templates

| File | Document | Data root |
|------|----------|-----------|
| [`valuation-report.twig.html`](valuation-report.twig.html) | Αναφορά Εκτίμησης Ακινήτου | `valuation.*` |

## Shared document header — keep ALL documents consistent

Every Four Walls document (these CRM templates **and** the `forms/` έντυπα) opens
with the **same header**: the pink brand cube + `FOUR WALLS` / `REAL ESTATE`
wordmark on the left, office contact block on the right, a **navy `#1C3457`
bottom rule with a 150px pink `#FF0062` accent** under it. Source of truth is the
forms' `.doc .hd` block; this folder mirrors it as `.hd` (see the header CSS in
`valuation-report.twig.html`). When you add a new document, **copy that header
verbatim** — do not redesign it.

## Conventions (same spirit as the site)

- **Colours are stamped via Twig, not CSS variables.** PDF engines (dompdf /
  mpdf / wkhtmltopdf) don't reliably support `var(--x)`, so we `{% set brand =
  company.main_color|default('#1C3457') %}` and interpolate the literal hex into
  the `<style>` block. Pink accent stays the Four Walls constant `#FF0062`.
- **Greek capitals take no τόνος.** PDF engines do **not** strip accents on CSS
  `text-transform:uppercase` the way an `lang="el"` browser does. So never rely
  on it for Greek — type any all-caps label **already accent-free** in the
  markup (`ΕΚΤΙΜΩΜΕΝΗ ΤΙΜΗ`, not lowercase + transform). Lowercase/sentence-case
  keeps its accents normally.
- **Numbers:** `{{ n|number_format(0, ',', '.') }}` → `€185.000`. Currency `€`
  prefix, `.` thousands separator.
- **Null-safe:** every field goes through `|default(...)`; array sections are
  wrapped in `{% if x is not empty %}`.

## Preview

The CRM renders these; there's no local Twig runtime here. To eyeball the design,
use the sample-data preview (static HTML, no Twig) kept alongside during
development.
