# Conventions

## Never edit the theme build

The minified theme (`css/style*.min.css`, `js/theme.js`, `vendor/*`) is a
purchased build. **Don't patch it.** Put every change in our override files,
which load *after* the theme so they win:

- [`css/fourwalls.css`](../css/fourwalls.css) — loaded after the theme CSS.
- [`js/fourwalls.js`](../js/fourwalls.js) — loaded after `js/theme.js` and after
  jQuery + `vendor/nice-select/jquery.nice-select.min.js`, so both are available
  to it.

Custom assets carry a **`.fw` suffix** (e.g. `style.fw.min.css`,
`shape_74.fw.svg`) so they're easy to tell apart from the stock template.

## Working with `nice-select`

The dropdowns use the theme's jQuery `nice-select` plugin, initialized by
`theme.js` as `$('.nice-select').niceSelect()`. To change a `<select>`'s options
at runtime:

1. Rebuild its `<option>`s.
2. Call `$(sel).niceSelect('update')` to refresh the custom UI.

The plugin supports `update` and `destroy`. Example: `js/fourwalls.js` swaps the
hero price ranges when the deal type changes — see
[components/hero-search.md](components/hero-search.md).

## Match the existing code

HTML is **TAB-indented**; `fourwalls.css`/`.js` use 2-space indentation. Keep
each file's own style. Encoding rules are in [environment.md](environment.md).
