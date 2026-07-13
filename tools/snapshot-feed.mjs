#!/usr/bin/env node
/* =====================================================================
   Four Walls — local feed snapshot (zero dependencies)
   ---------------------------------------------------------------------
   Mirrors the LIVE production feed into data/listings.json so localhost
   shows the real CRM listings without any API keys.

   Why this exists: prod runs SAMPLE_DATA=0 and the EstatePrime secrets
   live only in Cloudflare, so `tools/build-listings.mjs` can only build
   sample data locally. This tool instead copies whatever the deployed
   site is already serving at /data/listings.json (docs/listings-feed.md).

   Run:
     node tools/snapshot-feed.mjs                      # from four-walls.gr
     node tools/snapshot-feed.mjs https://staging.host # from another origin
     FW_SITE=https://… node tools/snapshot-feed.mjs    # origin via env

   The file is gitignored — a local dev convenience, never committed.
   Re-run it whenever you want fresh stock. Serve with:
     node tools/preview-server.js   ->  http://localhost:5173/
   ===================================================================== */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = (process.env.FW_SITE || process.argv[2] || "https://four-walls.gr").replace(/\/+$/, "");
const url = `${SITE}/data/listings.json`;

const res = await fetch(url);
if (!res.ok) {
	console.error(`✗ ${url} → HTTP ${res.status} (${res.statusText}). The feed 503s until first generation.`);
	process.exit(1);
}
const feed = await res.json();

const outDir = path.join(ROOT, "data");
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "listings.json"), JSON.stringify(feed, null, "\t") + "\n");

console.log(`✓ data/listings.json — ${feed.count} listings snapshotted from ${url} (source: ${feed.source})`);
