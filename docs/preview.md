# Local preview

Zero-dependency Node server (Node built-ins only), serves the repo root:

```bash
node tools/preview-server.js         # http://localhost:5173/
node tools/preview-server.js 8080    # custom port
```

- Site: `http://localhost:5173/` · Forms: `http://localhost:5173/forms/`
- **No live-reload** — hard refresh (Ctrl+F5) after every edit.

## `node` not on PATH?

Node is installed (winget: `OpenJS.NodeJS.LTS`) but is often **not on PATH** in a
freshly-spawned shell. Call it by full path:

```powershell
& "C:\Program Files\nodejs\node.exe" tools\preview-server.js
```

## Alternatives

- VS Code **Live Server** extension — just serve the repo root.
- `npx serve` — needs network access for the first download.

## Testing responsive layouts

Open DevTools device toolbar (Ctrl+Shift+M) and check the key widths:
**768px** (iPad portrait), **1024px** (iPad landscape), **≥1200px** (desktop),
**<768px** (phone). See [components/hero-search.md](components/hero-search.md)
for what the search bar should look like at each.
