# Four Walls — documentation

Start with [../CLAUDE.md](../CLAUDE.md) for the high-level map. These docs go
deeper, one topic per file:

| Doc | What's in it |
|-----|--------------|
| [architecture.md](architecture.md) | The two front-ends, the template's reference demos, key file/folder map |
| [brand.md](brand.md) | Brand colours, logo files, brand-PDF vector-extraction workflow |
| [preview.md](preview.md) | Run the site locally (zero-dependency preview server) |
| [conventions.md](conventions.md) | Where customizations go, the theme build is off-limits, working with `nice-select` |
| [partials.md](partials.md) | Shared header/footer: one source of truth stamped into pages by `tools/sync-partials.js` |
| [localization.md](localization.md) | Greek rules: `lang="el"`, capitals without accents, currency format |
| [environment.md](environment.md) | Windows / PowerShell / file-encoding gotchas |
| [listings-feed.md](listings-feed.md) | Live listings: EstatePrime webhook → Cloudflare Worker → `/data/listings.json` |
| [components/hero-search.md](components/hero-search.md) | Homepage search bar: fields, responsive layout, price swap |

New component write-ups go under [components/](components/).
