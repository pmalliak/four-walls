# Contact-page map (branded, MapLibre GL)

The map on [contact.html](../../contact.html) is **not** a Google embed. It is
a [MapLibre GL](https://maplibre.org/) map on **OpenFreeMap** vector tiles —
free, no API key, no cookies — with a style written from scratch in brand
colors that renders **no labels except street names**.

## Pieces

| File | Role |
|------|------|
| [js/map.fw.js](../../js/map.fw.js) | Style definition (brand palette, road/water/building layers, street-name symbols) + map init + logo marker |
| [js/maplibre-gl.js](../../js/maplibre-gl.js), [css/maplibre-gl.css](../../css/maplibre-gl.css) | Vendored MapLibre GL **v5.24.0** (from unpkg `maplibre-gl@5/dist`) — third-party, don't edit |
| [images/icon/map-pin.fw.svg](../../images/icon/map-pin.fw.svg) | Icon-only crop of the brand lockup, shown inside the pin |
| `css/fourwalls.css` → "Branded contact map" section | Pin styling (white disc, pink ring, diamond tail), fallback link, control tweaks |

Only `contact.html` loads these assets (extra `<link>` in the head, two
`<script>` tags at the bottom).

## How it fits together

- The container `#fw-contact-map` carries `data-lat` / `data-lng` /
  `data-zoom` / `data-title` / `data-directions` — edit those to move the
  map, no JS changes needed. Coordinates are Φραγκίνη 9, 54624 Θεσσαλονίκη
  (40.63468, 22.94070; geocoded via Nominatim).
- The pin is an `<a>` wrapping the brand icon; clicking it opens Google Maps
  (the `data-directions` URL) for directions, since the branded map itself
  stays minimal. Its size and the `Marker` pixel offset in `map.fw.js` are
  coupled — change them together.
- A plain "Άνοιγμα του χάρτη στο Google Maps" link sits inside the container
  as a fallback: it shows if JS is off, and `map.fw.js` restores it if WebGL
  is unavailable.
- Scroll-zoom uses MapLibre's *cooperative gestures* (Ctrl/⌘ + scroll) so the
  map doesn't trap page scrolling; UI strings are localized to Greek via the
  `locale` option.

## External services

Tiles, glyph fonts (`Noto Sans Regular`, covers Greek) and the style's only
network dependencies come from `tiles.openfreemap.org`. OpenFreeMap requires
no key and no registration; attribution ("© OpenStreetMap contributors") is
injected automatically from the tile JSON.
