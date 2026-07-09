/* =====================================================================
   Four Walls — EstatePrime CRM feed builder
   ---------------------------------------------------------------------
   Builds the listings feed served at /data/listings.json. Shared by:
     - worker/index.mjs        (Cloudflare Worker: webhook + nightly cron)
     - tools/build-listings.mjs (local generation for development)

   MODES
     SAMPLE_DATA="1"  -> feed from worker/lib/sample-listings.mjs
     SAMPLE_DATA="0"  -> feed pulled live from the EstatePrime API

   API facts (docs/estateprime-api.md, verified against the live API):
     base   https://{ESTATEPRIME_SUBDOMAIN}.estateprime.gr/api
     auth   Basic base64(publicKey:secretKey), JSON content type
     lists  { status, page, total_pages, results_per_page, data: [...] }
     pages  ?page=N query param works (verified live 2026-07-09), even
            though the spec documents `page` in a JSON body on GET, which
            fetch() cannot send; the loop is still guarded against a
            repeated page just in case.
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
	let active = all.filter((raw) => (raw.status ?? "active") === "active");

	// Whitelist by CRM tag (FILTER_TAG var, e.g. "spitogatos"): only tagged
	// listings are published. Until the tag exists in EstatePrime, publish
	// all active listings so the site never goes empty mid-rollout.
	const tagId = await resolveFilterTagId(env, base, headers);
	if (env.FILTER_TAG && tagId === null) {
		console.warn(`estateprime: tag "${env.FILTER_TAG}" not found in CRM — publishing ALL active listings until it exists`);
	} else if (tagId !== null) {
		active = active.filter((raw) =>
			(raw.tags || []).some((t) => (t?.id ?? t) === tagId));
		console.log(`estateprime: tag "${env.FILTER_TAG}" (id ${tagId}) matched ${active.length} listings`);
	}

	return active.map(mapListing);
}

/* Resolve the FILTER_TAG name to its CRM tag id (case-insensitive), or
   null when unset / not (yet) created in EstatePrime. */
async function resolveFilterTagId(env, base, headers) {
	if (!env.FILTER_TAG) return null;
	const res = await fetch(`${base}/listings/tags`, { headers });
	if (!res.ok) throw new Error(`EstatePrime API ${res.status} on /listings/tags`);
	const body = await res.json();
	const want = env.FILTER_TAG.trim().toLowerCase();
	const tag = (body.data || []).find((t) => (t.name || "").trim().toLowerCase() === want);
	return tag ? tag.id : null;
}

const LANG_EL = 1; // translations[].language_id — 1 = Greek, 2 = English

/* Reshape one raw EstatePrime listing to the site's feed schema (see
   docs/listings-feed.md). Field names verified against the live API
   (2026-07-09). Keep the OUTPUT shape stable — the front-end depends on it.

   Privacy rules the CRM encodes and the PUBLIC feed must respect:
   - has_hidden_price  -> publish price as null
   - display_address "fake" -> publish the fake_* coordinates/address,
     never the real ones; mark the location as approximate. */
export function mapListing(raw) {
	const t = (raw.translations || []).find((x) => x.language_id === LANG_EL)
		|| (raw.translations || [])[0] || {};
	const loc = raw.location || {};
	const useFake = loc.display_address === "fake";
	return {
		id: String(raw.id),
		code: raw.code ?? null,
		title: t.title ?? null,
		description: t.description ?? null,
		transaction: raw.availability ?? null, // sale | rent | auction | shortterm
		category: raw.category ?? null,        // residential | commercial | land | other
		subcategory: raw.subcategory ?? null,  // apartment, maisonette, …
		price: raw.has_hidden_price ? null : numberOrNull(raw.price),
		area: numberOrNull(raw.size),
		bedrooms: numberOrNull(raw.rooms),
		bathrooms: numberOrNull(raw.bathrooms),
		floor: raw.floor ?? null,
		yearBuilt: numberOrNull(raw.year_built),
		yearRenovated: numberOrNull(raw.year_renovated),
		energyClass: raw.energy_class || null,
		condition: raw.property_condition || null,
		heating: raw.heating_type || null,
		wc: numberOrNull(raw.wcs),
		kitchens: numberOrNull(raw.kitchens),
		livingRooms: numberOrNull(raw.living_rooms),
		parking: numberOrNull(raw.parking_total),
		monthlyMaintenance: numberOrNull(raw.monthly_maintenance),
		youtubeUrl: raw.youtube_url || null,
		virtualTourUrl: raw.virtual_tour_url || null,
		view: Array.isArray(raw.view) ? raw.view : [],
		flooring: Array.isArray(raw.flooring) ? raw.flooring : [],
		positioning: Array.isArray(raw.positioning) ? raw.positioning : [],
		location: {
			area: loc.area_level2?.name_el ?? null,
			neighbourhood: loc.area_level3?.name_el ?? null,
			city: loc.area_level1?.name_el ?? null,
			address: (useFake ? loc.fake_address_el : loc.address_el) ?? null,
			lat: numberOrNull(useFake ? loc.fake_latitude : loc.latitude),
			lng: numberOrNull(useFake ? loc.fake_longitude : loc.longitude),
			approximate: useFake || !!loc.show_circle_on_map,
		},
		images: (raw.photos || [])
			.filter((p) => p.is_public !== false)
			.map((p) => p.watermark_image || p.original_image)
			.filter(Boolean),
		features: Array.isArray(raw.features) ? raw.features : [],
		updatedAt: raw.date_updated ?? raw.date_created ?? null,
	};
}

function numberOrNull(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}
