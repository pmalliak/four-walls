#!/usr/bin/env node
/* =====================================================================
   Four Walls — local listings-feed builder (zero dependencies)
   ---------------------------------------------------------------------
   Writes data/listings.json using the SAME module the Cloudflare
   Worker uses (worker/lib/estateprime.mjs), so the local file and the
   production feed can never drift in shape.

   Run:
     node tools/build-listings.mjs                    # sample data
     ESTATEPRIME_API_KEY=... node tools/build-listings.mjs   # live API

   Without an API key it falls back to sample data — enough to develop
   the front-end against http://localhost:5173/data/listings.json.
   ===================================================================== */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFeed } from "../worker/lib/estateprime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { ESTATEPRIME_SUBDOMAIN, ESTATEPRIME_API_KEY, ESTATEPRIME_API_SECRET } = process.env;
const live = ESTATEPRIME_SUBDOMAIN && ESTATEPRIME_API_KEY && ESTATEPRIME_API_SECRET;
const env = {
	SAMPLE_DATA: live ? "0" : "1",
	ESTATEPRIME_SUBDOMAIN,
	ESTATEPRIME_API_KEY,
	ESTATEPRIME_API_SECRET,
};
if (!live) {
	console.log("ESTATEPRIME_SUBDOMAIN / _API_KEY / _API_SECRET not all set — building from sample data.");
}

const feed = await buildFeed(env);
const outDir = path.join(ROOT, "data");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "listings.json");
writeFileSync(outFile, JSON.stringify(feed, null, "\t") + "\n");

console.log(`✓ data/listings.json — ${feed.count} listings (source: ${feed.source})`);
