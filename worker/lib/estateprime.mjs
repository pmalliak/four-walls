/* =====================================================================
   Four Walls — EstatePrime CRM feed builder
   ---------------------------------------------------------------------
   Builds the listings feed served at /data/listings.json. Shared by:
     - worker/index.mjs        (Cloudflare Worker: webhook + nightly cron)
     - tools/build-listings.mjs (local generation for development)

   MODES
     SAMPLE_DATA="1"  -> feed from worker/lib/sample-listings.mjs
     SAMPLE_DATA="0"  -> feed pulled live from the EstatePrime API

   !! The EstatePrime-specific parts below (API_BASE, endpoint path,
   !! auth header, pagination, field mapping) are an UNVERIFIED adapter:
   !! the docs at https://developers.estateprime.gr require a login we
   !! don't have yet. Every guess is marked TODO(estateprime-docs).
   !! Flip SAMPLE_DATA to "0" only after confirming them.
   ===================================================================== */

import { SAMPLE_LISTINGS } from "./sample-listings.mjs";

// TODO(estateprime-docs): confirm base URL + version prefix.
const API_BASE = "https://api.estateprime.gr";
const PAGE_SIZE = 100;
const MAX_PAGES = 100; // safety valve against a pagination bug looping forever

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

/* Pull every ACTIVE listing from the EstatePrime API. The webhook payload
   is deliberately ignored upstream — this full re-fetch is the source of
   truth, which makes regeneration idempotent and burst-safe. */
async function fetchAllListings(env) {
	if (!env.ESTATEPRIME_API_KEY) {
		throw new Error("ESTATEPRIME_API_KEY is not set (wrangler secret put ESTATEPRIME_API_KEY)");
	}

	const all = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		// TODO(estateprime-docs): confirm endpoint path, pagination params
		// (page/limit vs offset vs cursor) and any status=active filter.
		const url = `${API_BASE}/listings?page=${page}&per_page=${PAGE_SIZE}`;
		const res = await fetch(url, {
			headers: {
				// TODO(estateprime-docs): confirm auth scheme (Bearer vs X-Api-Key).
				"Authorization": `Bearer ${env.ESTATEPRIME_API_KEY}`,
				"Accept": "application/json",
			},
		});
		if (!res.ok) {
			throw new Error(`EstatePrime API ${res.status} on ${url}`);
		}
		const body = await res.json();
		// TODO(estateprime-docs): confirm envelope — items may live at
		// body.data, body.listings, or be the top-level array itself.
		const items = Array.isArray(body) ? body : (body.data ?? body.listings ?? []);
		all.push(...items.map(mapListing));
		if (items.length < PAGE_SIZE) break; // last page
	}
	return all;
}

/* Reshape one raw EstatePrime record to the site's feed schema (see
   docs/listings-feed.md). Keep the OUTPUT shape stable — the front-end
   depends on it; adjust only the raw.* field names to match the API. */
function mapListing(raw) {
	// TODO(estateprime-docs): every raw.* access below is a guess.
	return {
		id: String(raw.id),
		code: raw.code ?? raw.reference ?? null,
		title: raw.title ?? null,
		transaction: raw.transaction ?? raw.purpose ?? null, // "sale" | "rent"
		category: raw.category ?? raw.type ?? null,
		price: numberOrNull(raw.price),
		area: numberOrNull(raw.area ?? raw.sqm),
		bedrooms: numberOrNull(raw.bedrooms),
		bathrooms: numberOrNull(raw.bathrooms),
		floor: raw.floor ?? null,
		yearBuilt: numberOrNull(raw.year_built ?? raw.construction_year),
		location: {
			area: raw.area_name ?? raw.neighborhood ?? null,
			city: raw.city ?? "Θεσσαλονίκη",
			lat: numberOrNull(raw.lat ?? raw.latitude),
			lng: numberOrNull(raw.lng ?? raw.longitude),
		},
		images: Array.isArray(raw.images) ? raw.images.map((i) => i.url ?? i) : [],
		features: Array.isArray(raw.features) ? raw.features : [],
		description: raw.description ?? null,
		updatedAt: raw.updated_at ?? null,
	};
}

function numberOrNull(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}
