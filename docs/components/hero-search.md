# Component: hero search

The homepage search bar in `index.html`
(`.search-wrapper-one.layout-one`) — one row of `.input-box-one` fields on a
12-column grid.

## Fields, ids, and responsive widths

| Field | id | Desktop (`xl` ≥1200) | Tablet (`md`/`lg` 768–1199) | Phone (<768) |
|-------|-----|------|------|------|
| Ενδιαφέρομαι για… (deal) | `#fw-deal` | `col-xl-2` | `col-12` (own row) | `col-12` |
| Τύπος ακινήτου | — | `col-xl-3` | `col-md-4` | `col-12` |
| Περιοχή | — | `col-xl-2` | `col-md-4` | `col-12` |
| Εύρος τιμής (price) | `#fw-price` | `col-xl-3` | `col-md-4` | `col-12` |
| Αναζήτηση (button) | — | `col-xl-2` | `col-12` (own row) | `col-12` |

So it reads as:

- **Desktop:** one row of five.
- **iPad:** three rows — `[ deal ]` / `[ type · area · price ]` / `[ button ]`.
- **Phone:** everything stacked.

`css/fourwalls.css` removes the first field's stray right-divider between
992–1199px (the theme only converts dividers to underlines below 992px).

## Deal → price swap (`js/fourwalls.js`)

Sale and rent use very different price scales, so the price dropdown is
transaction-aware:

- **Αγορά** → sale ranges (`Έως €100.000` … `€500.000+`).
- **Ενοικίαση** → monthly ranges (`Έως €400/μήνα` … `€1.500+/μήνα`).

On `#fw-deal` change we rebuild `#fw-price`'s options from a `RANGES` table and
call `niceSelect('update')`. The `RANGES` object in `fourwalls.js` is the source
of truth; the `<option>`s hard-coded in the HTML are just the pre-JS fallback
(they're overwritten on load), so keep the two in sync.

## Narrow-box fixes (`css/fourwalls.css`)

The fields sit in narrow columns, which exposed two `nice-select` issues, both
fixed in `fourwalls.css`:

- **Stray horizontal scrollbar** on the open list — the theme's
  `overflow-y:auto` promotes `overflow-x` to `auto`, and long labels are wider
  than the box. Fix: let the list grow to fit (`min-width:max-content`,
  `overflow:visible`, `max-height:none`).
- **Selected value overflowing** over the arrow / outside the box — clip
  `.current` with an ellipsis (the full label is still visible in the open
  list).

## History

The single "Ψάχνω για…" dropdown (which mixed deal + property type) was replaced
first with Buy/Rent tabs (from `template/index-5.html`), then — per preference — with the
current all-dropdown form: a deal selector + property type + area + price.
