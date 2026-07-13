#!/usr/bin/env node
/* =====================================================================
   Four Walls — accessibility ratings, LOCAL PREVIEW helper
   ---------------------------------------------------------------------
   In production the Worker computes these ratings automatically during the
   feed rebuild and caches them in KV (worker/lib/accessibility.mjs,
   `enrichAccessibility`) — there is NOTHING to run when a listing is added.

   This tool exists only for LOCAL development: `wrangler dev`'s KV starts
   empty, and the plain preview server serves a static data/listings.json,
   so neither shows ratings without help. It fetches the live feed, runs the
   SAME scoring over each listing's coordinates (querying OpenStreetMap), and
   writes the enriched feed to data/listings.json for the preview server.

   Run:  node tools/build-accessibility.mjs                 # from prod feed
         node tools/build-accessibility.mjs http://localhost:5173
   The file is gitignored — a dev convenience, never committed.
   ===================================================================== */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeAccessibility } from "../worker/lib/accessibility.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = (process.env.FW_SITE || process.argv[2] || "https://four-walls.gr").replace(/\/+$/, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`Feed: ${SITE}/data/listings.json`);
const feed = await (await fetch(`${SITE}/data/listings.json`, { cache: "no-store" })).json();
const withCoords = feed.listings.filter((l) => l.location?.lat != null && l.location?.lng != null);
console.log(`${feed.count} listings, ${withCoords.length} with coordinates\n`);

for (let i = 0; i < withCoords.length; i++) {
	const l = withCoords[i];
	process.stdout.write(`[${i + 1}/${withCoords.length}] ${l.code} … `);
	try {
		l.accessibility = await computeAccessibility(l.location.lat, l.location.lng);
		console.log(Object.entries(l.accessibility).map(([k, v]) => `${k}:${v.band}`).join(" "));
	} catch (e) {
		console.log(`SKIP (${e.message})`);
	}
	if (i < withCoords.length - 1) await sleep(1100); // be gentle on the Overpass mirror
}

mkdirSync(path.join(ROOT, "data"), { recursive: true });
writeFileSync(path.join(ROOT, "data", "listings.json"), JSON.stringify(feed, null, "\t") + "\n");
console.log(`\n✓ wrote enriched feed → data/listings.json (${withCoords.length} rated)`);
