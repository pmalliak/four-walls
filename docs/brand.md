# Brand & logo assets

Source of truth: [`../images/logo/fourwalls-brand.pdf`](../images/logo/fourwalls-brand.pdf)
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

## Logo files (`images/logo/`)

| File | What |
|------|------|
| `fourwalls-brand.pdf` | Authoritative vector brand sheet |
| `fourwalls_logo.svg` | **Header logo** — horizontal lockup, pink `#FF0062` icon + black `#000000` "FOURWALLS", `viewBox="0 0 1434 140"` |
| `fourwalls_logo_light.png` | Old light variant (white wordmark) — currently unreferenced |

The header logo is a **vector SVG**. It was rebuilt from the brand PDF to replace
a raster PNG whose anti-aliased edges were white at low opacity — invisible on
white, but a visible white fringe around every letter on dark/coloured
backgrounds. It's referenced from the header (desktop + mobile logo) on
`index.html`, `about_us_01.html`, `contact.html`, `service_01.html`, and
`service_details.html`. CSS sizes it by height only
(`.logo img { height: 38px; width: auto }`), so keep the SVG's 1434×140 aspect
ratio for a drop-in fit.

### Recolouring
- Wordmark to brand navy: change the wordmark group `fill="#000000"` → `#1C3457`.
- Dark-background variant: wordmark `fill="#fff"`, icon stays `#FF0062`.

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
