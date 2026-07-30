# Brand & logo assets

Source of truth: [`../brand/fourwalls-brand.pdf`](../brand/fourwalls-brand.pdf)
— an Adobe Illustrator vector brand sheet (icon + "FOURWALLS" wordmark + "REAL
ESTATE" tagline + hex-labelled colour swatches). When anything about the brand
is unclear, that file wins.

## Colours

| Role | Hex | Used by |
|------|-----|---------|
| Pink (primary / accent) | `#FF0062` | logo icon, marketing-site accents (hover `#d1004f`) |
| Navy (dark) | `#1C3457` | logo wordmark alt, Έντυπα PWA ([`../forms/`](../forms/)) |

Both are labelled with their hex right in the brand sheet. The PDF also contains
a near-duplicate pink `#E62065` on one icon copy — ignore it; `#FF0062` is the
documented pink.

## Logo files

The logo the site actually serves stays in `images/logo/`; the master brand
sheet and the spare lockups (not referenced by any page) live in `brand/`, so
`images/` only holds live-site assets.

| File | Where | What |
|------|-------|------|
| `fourwalls-brand.pdf` | `brand/` | Authoritative vector brand sheet |
| `fourwalls_logo.svg` | `images/logo/` | **Header logo** — horizontal lockup, pink `#FF0062` icon ("cube") + black `#000000` "FOURWALLS", `viewBox="-23.08 -24.5 1048.06 189"` (~5.5:1) |
| `fourwalls_logo_vertical.svg` | `brand/` | Stacked lockup (icon + wordmark + "REAL ESTATE" tagline) extracted from the brand PDF — the source for the favicons; wire it into the footer's optional `.footer-logo-vertical` if needed |
| `fourwalls_logo_light.png` | `brand/` | Old light variant (white wordmark) — unreferenced, and **do not reuse it**: the export carries two stray 8–9 px white specks above the wordmark (`x265-275, y33-35`), an artifact of the original PDF→PNG conversion |
| `fourwalls_watermark.png` | `images/logo/` | **Photo watermark** — 600×131 white wordmark + pink cube on transparency, with a soft drop shadow baked in so it reads on both bright floors and dark furniture. Drawn bottom-right on AI-enhanced listing photos (docs/photo-enhance.md) |

### Regenerating the photo watermark

Never hand-edit the PNG — rebuild it from the vector so no export artifact
creeps back in. From `images/logo/fourwalls_logo.svg`: recolour the wordmark
`#000000` → `#ffffff`, pad the `viewBox` by ~26 units (otherwise the shadow is
clipped at the export edge), wrap the content in a group carrying a shadow
filter, then render at 600 px wide:

```
inkscape wm-shadow.svg --export-type=png --export-width=600 \
  --export-filename=images/logo/fourwalls_watermark.png
```

**Inkscape does not implement `feDropShadow`** (it warns `unknown type` and
silently drops the content — you get a ~1 KB empty PNG). Use the classic
chain instead: `feGaussianBlur(SourceAlpha)` → `feOffset` →
`feComponentTransfer` (alpha slope ≈ 0.6) → `feMerge` with `SourceGraphic`.

The header logo is a **vector SVG**. It was rebuilt from the brand PDF to replace
a raster PNG whose anti-aliased edges were white at low opacity — invisible on
white, but a visible white fringe around every letter on dark/coloured
backgrounds. It's referenced from the header (desktop + mobile logo) and footer on
`index.html`, `about.html`, `contact.html`, `services.html`, and
`service_details.html`.

### Lockup proportions & sizing
At header size the raw lockup let the wordmark tower over the icon and the full
~10:1 width ran off a phone's right edge. The SVG now wraps the two brand groups
in outer `<g>` transforms to tune them independently (edit these, don't re-derive
the inner path geometry):
- **cube** — `scale(1.15)` about its centre `(63.5, 70)`;
- **wordmark** — `scale(0.66)`, placed 40u right of the cube with its centre
  pinned to `y=70` so both sit on one middle line.

**Measure, don't guess.** Both brand groups are natively centred on `y=70`, and
the cube's bbox is `y[0,140]` — its solid walls sit at `y[39,140]` but a thin
lid/chevron reaches up to `y≈0`, so a viewBox cropped to the walls *clips the
cube's top*. Get the real boxes with `inkscape --query-all` (give the groups
`id`s first) and set the viewBox to their measured union + ~14u padding.

Because the aspect changed from the old `1434×140`, CSS sizes it explicitly in
[`../css/fourwalls.css`](../css/fourwalls.css) rather than the theme's `38px`:
`.theme-main-menu .logo img { height: 40px }` (header + mobile menu) and
`.footer-one .logo img { height: 50px }` (footer). Keep the ~5.5:1 aspect; if you
re-tune the cube/text scales, re-measure the viewBox and re-check those heights.

### Recolouring
- Wordmark to brand navy: change the wordmark group `fill="#000000"` → `#1C3457`.
- Dark-background variant: wordmark `fill="#fff"`, icon stays `#FF0062`.

## Favicons (`images/fav-icon/`)

White brand cube on a pink `#FF0062` disc, generated from the cube paths in
`fourwalls_logo_vertical.svg`:

| File | What |
|------|------|
| `icon.fw.svg` | Vector favicon (64 viewBox) — pink disc + white cube |
| `icon.fw.png` | 64×64 raster fallback (transparent outside the disc); also used as an avatar image on `property.html` |
| `apple-touch-icon.fw.png` | 180×180 full-bleed pink square (iOS rounds the corners itself) |

Every site page carries the same three `<link>` lines in `<head>` (SVG first,
PNG fallback, apple-touch-icon). The Έντυπα PWA (`forms/`) has its own separate
icon set (`forms/icon-*.png`, navy background) — don't mix the two.

## Listing stat icons (`images/icon/*.fw.svg`)

The stat glyphs on the listing cards and on the «Με μια ματιά» strip of a
property page are our own set, drawn to one spec so they read as a family:
**24 viewBox, `stroke="#1C3457"`, `stroke-width` 1.5, round caps/joins, no
fill** (same recipe as `icon_mail/phone/clock.fw.svg`). `js/listings.fw.js`
builds the `<img>` src as `images/icon/<name>.fw.svg`.

| Name | Stands for |
|------|------------|
| `area` | Εμβαδόν (τ.μ.) |
| `bed` | Υπνοδωμάτια |
| `bath` | Μπάνια |
| `door` | Χώροι (επαγγελματικά· το `rooms` του CRM) |
| `wc` | WC (επαγγελματικά) |
| `stairs` | Όροφος |
| `home` | Type: any residential category |
| `building` | Type: office/store/warehouse/… (commercial) |
| `land` | Type: plot/parcel/island/air |
| `parking` | Type: parking space |

The type glyph is picked by `TYPE_ICON` / `typeIcon()` in `js/listings.fw.js`;
a category missing from that map falls back to `home`. Which stats appear at
all follows the sibling `TYPE_BUCKET` map (see
[listings-feed.md](listings-feed.md#type-dependent-fields)): `bed`/`bath` show
only on residential listings, `door`/`wc` only on commercial ones.

The Homy template's own equivalents (`template/images/icon/icon_04-06`,
`icon_47-51`) were **never copied into `images/`** — the pages referenced them
for months and silently rendered broken images, which is why the strip looked
like bare text with a gap above it. Anything under `template/` is reference
only; if a page needs a template icon, copy it in and rename it `*.fw.svg`.

Keep them legible at **30 px** (the size the overview strip renders at): thin
dashes and small inner detail disappear at that scale — check a screenshot
before committing a new glyph, not just the 90 px preview.

## Working with the brand PDF (vector extraction)

**Inkscape** (installed at `C:\Program Files\Inkscape\bin\inkscape.com`, v1.4.4)
is the tool for turning the PDF into usable vector/raster:

```bash
# PDF -> SVG, keeping real vectors and outlining fonts to paths
inkscape file.pdf --export-type=svg --export-filename=out.svg --export-text-to-path
# PDF -> PNG preview
inkscape file.pdf --export-type=png --export-filename=out.png --export-dpi=192 --export-background=white
# List every object's id + bounding box (x, y, w, h) — great for locating art
inkscape --query-all file.svg
```

**Gotcha:** headless Chrome/Edge do **not** rasterize PDF *content* via
`--screenshot` — you only get the viewer's dark background. Use Inkscape (or
poppler) for PDFs. Headless-browser screenshots are fine for HTML and SVG (that's
how site pages and the logo were previewed).

Other constraints on this machine: no poppler / imagemagick / potrace; no
geometric web fonts installed (Poppins, Montserrat, …), so you can't font-match a
wordmark — pull the vectors from the source PDF instead. For low-level PDF
poking, PowerShell + .NET `System.IO.Compression.DeflateStream` inflates raw
FlateDecode streams (skip the 2-byte zlib header) and `System.Drawing.Bitmap`
does pixel/alpha analysis.
