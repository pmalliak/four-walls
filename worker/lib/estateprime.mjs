/* =====================================================================
   Four Walls — EstatePrime CRM feed builder
   ---------------------------------------------------------------------
   Builds the listings feed served at /data/listings.json. Shared by:
     - worker/index.mjs        (Cloudflare Worker: webhook + nightly cron)
     - tools/build-listings.mjs (local generation for development)

   MODES
     SAMPLE_DATA="1"  -> feed from worker/lib/sample-listings.mjs
     SAMPLE_DATA="0"  -> feed pulled live from the EstatePrime API

   API facts (docs/estateprime-api.md, from the OpenAPI spec):
     base   https://{ESTATEPRIME_SUBDOMAIN}.estateprime.gr/api
     auth   Basic base64(publicKey:secretKey), JSON content type
     lists  { status, page, total_pages, results_per_page, data: [...] }

   ⚠ The spec sends `page` + filters as a JSON body on GET, which fetch()
   cannot do (spec-forbidden). We send ?page=N as a query param instead —
   unverified against the live API; the loop is bounded by total_pages and
   guarded against the param being ignored (repeated first id).

   ⚠ The `Listing` schema is still missing from the truncated yaml —
   mapListing() uses field names inferred from `ExternalListing` and is
   marked TODO(listing-schema) until the real schema lands.
   ===================================================================== */

import { SAMPLE_LISTINGS } from "./sample-listings.mjs";

const MAX_PAGES = 200; // hard stop against pagination bugs

/* Build the complete feed object that gets stored in KV / data/listings.json. */
export async function buildFeed(env) {
	const sample = env.SAMPLE_DATA === "1";
	const listings = sample ? SAMPLE_LISTINGS : await fetchAllListings(env);
	return {
		generatedAt: new Date().toISOString(),
		source: sample ? "sample" : "estateprime",
		count: listings.length,
		listings,
	};
}

function apiConfig(env) {
	const missing = ["ESTATEPRIME_SUBDOMAIN", "ESTATEPRIME_API_KEY", "ESTATEPRIME_API_SECRET"]
		.filter((k) => !env[k]);
	if (missing.length) throw new Error(`Missing config: ${missing.join(", ")}`);
	return {
		base: `https://${env.ESTATEPRIME_SUBDOMAIN}.estateprime.gr/api`,
		headers: {
			"Authorization": "Basic " + btoa(`${env.ESTATEPRIME_API_KEY}:${env.ESTATEPRIME_API_SECRET}`),
			"Content-Type": "application/json",
			"Accept": "application/json",
		},
	};
}

/* Raw single page, unmapped — used by the /debug/estateprime-raw route to
   inspect the API's real field names. Remove once the mapping is verified. */
export async function fetchListingsPageRaw(env, page = 1) {
	const { base, headers } = apiConfig(env);
	const res = await fetch(`${base}/listings?page=${page}`, { headers });
	return { status: res.status, body: await res.text() };
}

/* Pull every listing from the EstatePrime API and keep the active ones.
   The webhook payload is deliberately ignored upstream — this full
   re-fetch is the source of truth, so regeneration is idempotent. */
async function fetchAllListings(env) {
	const { base, headers } = apiConfig(env);

	const all = [];
	let firstIdOfPrevPage = null;
	for (let page = 1; page <= MAX_PAGES; page++) {
		const res = await fetch(`${base}/listings?page=${page}`, { headers });
		if (!res.ok) throw new Error(`EstatePrime API ${res.status} on /listings?page=${page}`);
		const body = await res.json();
		const items = body.data ?? [];
		if (!items.length) break;

		// If the API ignores the ?page= query param (spec wants it in a GET
		// body), every request returns page 1 — detect and stop.
		if (items[0]?.id != null && items[0].id === firstIdOfPrevPage) {
			console.warn("estateprime: ?page= param seems ignored; got a repeated page — stopping");
			break;
		}
		firstIdOfPrevPage = items[0]?.id ?? null;

		all.push(...items);
		if (body.total_pages && page >= body.total_pages) break;
	}

	// The feed only carries publicly visible stock.
	return all
		.filter((raw) => (raw.status ?? "active") === "active")
		.map(mapListing);
}

/* Reshape one raw EstatePrime listing to the site's feed schema (see
   docs/listings-feed.md). Keep the OUTPUT shape stable — the front-end
   depends on it; adjust only the raw.* field names.
   TODO(listing-schema): verify every raw.* below against the real
   `Listing` schema (currently inferred from `ExternalListing`). */
function mapListing(raw) {
	return {
		id: String(raw.id),
		code: raw.code ?? raw.listing_code ?? null,
		title: raw.title ?? null,
		transaction: raw.availability ?? null, // sale | rent | auction | shortterm
		category: raw.subcategory ?? raw.category ?? null,
		price: numberOrNull(raw.price),
		area: numberOrNull(raw.size),
		bedrooms: numberOrNull(raw.rooms),
		bathrooms: numberOrNull(raw.bathrooms),
		floor: raw.floor ?? null,
		yearBuilt: numberOrNull(raw.construction_year ?? raw.year_built),
		location: {
			area: raw.area_level2_name ?? raw.area_name ?? null,
			city: raw.area_level1_name ?? "Θεσσαλονίκη",
			lat: numberOrNull(raw.latitude ?? raw.location?.latitude),
			lng: numberOrNull(raw.longitude ?? raw.location?.longitude),
		},
		images: Array.isArray(raw.images) ? raw.images.map((i) => i?.url ?? i) : [],
		features: Array.isArray(raw.features) ? raw.features : [],
		description: raw.description ?? null,
		updatedAt: raw.date_updated ?? raw.date_created ?? null,
	};
}

function numberOrNull(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}
