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
import { ACCESSIBILITY } from "./accessibility-data.mjs";

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

export function apiConfig(env) {
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

	// The feed only carries publicly visible stock. Since the CRM's
	// Spitogatos integration went live it pushes EVERY active listing to the
	// portal, so "active" already means "published on Spitogatos" — the site
	// mirrors the portal by publishing the same set. There is deliberately no
	// tag whitelist: the old `spitogatos` CRM tag was a hand-maintained label
	// that the integration made redundant (and it always lagged reality).
	//
	// Careful: `status` is the ONLY publication signal the API gives us. It
	// exposes nothing about portals — and `source_id` (1=xe.gr, 2=plot.gr,
	// 3=spitogatos.gr) is the LEAD SOURCE the listing came from, never a
	// publication target. Don't mistake it for one.
	const active = all.filter((raw) => (raw.status ?? "active") === "active");
	console.log(`estateprime: ${active.length} active of ${all.length} listings`);

	const tags = env.FEATURED_TAG ? await fetchTags(base, headers) : [];

	// «Ακίνητο του μήνα» (FEATURED_TAG var): the tagged listing is published
	// with featured:true and the home page shows it in the index banner.
	// Missing tag / nothing tagged -> the front-end falls back on its own.
	const featuredTagId = resolveTagId(tags, env.FEATURED_TAG);
	if (env.FEATURED_TAG && featuredTagId === null) {
		console.warn(`estateprime: tag "${env.FEATURED_TAG}" not found in CRM — no listing marked featured`);
	}

	return active.map((raw) => {
		const listing = mapListing(raw);
		if (featuredTagId !== null && hasTag(raw, featuredTagId)) listing.featured = true;
		return listing;
	});
}

/* The CRM's tag list: [{ id, name }, …]. */
async function fetchTags(base, headers) {
	const res = await fetch(`${base}/listings/tags`, { headers });
	if (!res.ok) throw new Error(`EstatePrime API ${res.status} on /listings/tags`);
	const body = await res.json();
	return body.data || [];
}

/* Resolve a tag name to its CRM tag id (case-insensitive), or null when
   unset / not (yet) created in EstatePrime. */
function resolveTagId(tags, name) {
	if (!name) return null;
	const want = name.trim().toLowerCase();
	const tag = tags.find((t) => (t.name || "").trim().toLowerCase() === want);
	return tag ? tag.id : null;
}

function hasTag(raw, tagId) {
	return (raw.tags || []).some((t) => (t?.id ?? t) === tagId);
}

const LANG_EL = 1; // translations[].language_id — 1 = Greek, 2 = English
const LANG_EN = 2;

/* Reshape one raw EstatePrime listing to the site's feed schema (see
   docs/listings-feed.md). Field names verified against the live API
   (2026-07-09). Keep the OUTPUT shape stable — the front-end depends on it.

   Privacy rules the CRM encodes and the PUBLIC feed must respect:
   - has_hidden_price  -> publish price as null
   - display_address "fake" -> publish the fake_* coordinates/address,
     never the real ones; mark the location as approximate.

   The *_en fields are additive and OPTIONAL — English coverage in the CRM
   is per-listing best-effort, so consumers must fall back to the Greek
   field when an _en counterpart is null. */
export function mapListing(raw) {
	const t = (raw.translations || []).find((x) => x.language_id === LANG_EL)
		|| (raw.translations || [])[0] || {};
	const tEn = (raw.translations || []).find((x) => x.language_id === LANG_EN) || {};
	const loc = raw.location || {};
	const useFake = loc.display_address === "fake";
	const desc = cleanDescription(t.description);
	const descEn = cleanDescription(fixHomoglyphs(tEn.description ?? null));
	return {
		id: String(raw.id),
		code: raw.code ?? null,
		title: t.title ?? null,
		description: desc.text || null,
		nearby: desc.nearby,
		title_en: fixHomoglyphs(tEn.title ?? null),
		description_en: descEn.text || null,
		nearby_en: descEn.nearby,
		accessibility: ACCESSIBILITY[String(raw.id)] ?? null, // OSM ratings (tools/build-accessibility.mjs)
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
			area_en: fixHomoglyphs(loc.area_level2?.name_en ?? null),
			neighbourhood_en: fixHomoglyphs(loc.area_level3?.name_en ?? null),
			city_en: fixHomoglyphs(loc.area_level1?.name_en ?? null),
			address: (useFake ? loc.fake_address_el : loc.address_el) ?? null,
			lat: numberOrNull(useFake ? loc.fake_latitude : loc.latitude),
			lng: numberOrNull(useFake ? loc.fake_longitude : loc.longitude),
			approximate: useFake || !!loc.show_circle_on_map,
		},
		images: (raw.photos || [])
			.filter((p) => p.is_public !== false)
			.map((p) => p.original_image || p.watermark_image)
			.filter(Boolean),
		features: Array.isArray(raw.features) ? raw.features : [],
		updatedAt: raw.date_updated ?? raw.date_created ?? null,
	};
}

function numberOrNull(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

/* Greek capitals that are visual twins of Latin letters. EstatePrime's
   auto-translated English text occasionally capitalises a word with the
   Greek homoglyph (seen live: "Εven"/"Βuildable" — Greek Ε/Β). It reads as
   perfect English but they are real Greek code points, which hurt search,
   screen readers and copy-paste on the /en/ site. */
const HOMOGLYPHS = {
	"Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K",
	"Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
};

/* Latinise Greek homoglyph capitals in an English field — but ONLY inside a
   token that already holds a Latin letter, so a genuinely Greek word (e.g. a
   street name that slipped into an _en field) is left untouched. Non-strings
   (null) pass straight through. */
function fixHomoglyphs(s) {
	if (typeof s !== "string" || !s) return s;
	return s.replace(/\S*[Α-Ω]\S*/g, (tok) =>
		/[A-Za-z]/.test(tok)
			? tok.replace(/[Α-Ω]/g, (ch) => HOMOGLYPHS[ch] || ch)
			: tok);
}

/* HTML entities the CRM's rich-text editor emits. */
const ENTITIES = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
	euro: "€", mdash: "—", ndash: "–", middot: "·", bull: "•",
	hellip: "…", laquo: "«", raquo: "»", deg: "°",
};
function decodeEntities(s) {
	return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
		if (code[0] === "#") {
			const n = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
			return Number.isFinite(n) ? String.fromCodePoint(n) : m;
		}
		const key = code.toLowerCase();
		return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
	});
}

/* EstatePrime stores manually-edited descriptions as rich-text HTML
   (<div>, <br>, &amp; …). The feed must be PLAIN TEXT: the site renders the
   description with textContent (CRM strings must never parse as HTML) and
   the SEO meta/JSON-LD in seo.mjs slice it raw. Convert block tags to
   newlines, drop the rest, decode entities, collapse whitespace. Auto-
   generated (already-plain) descriptions pass through essentially intact. */
function htmlToText(s) {
	if (typeof s !== "string" || !s) return "";
	const t = s
		.replace(/\r\n?/g, "\n")
		.replace(/<\s*br\s*\/?>/gi, "\n")
		.replace(/<\/\s*(?:div|p|li|h[1-6]|tr)\s*>/gi, "\n")
		.replace(/<\s*li[^>]*>/gi, "• ")
		.replace(/<[^>]+>/g, "");
	return decodeEntities(t)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

/* Drop the trailing contact block ("Four Walls, Τηλέφωνο Επικοινωνίας…" /
   "Four Walls, contact phone…"), plus a preceding "Τιμή: €…" / "Price: €…".
   It exists for portals (Spitogatos reads the CRM description directly) but
   is noise on our own site, where the sidebar already carries the NAP and
   the price sits in the header. */
function stripContactTail(s) {
	return s.replace(
		/\n*[ \t]*(?:(?:Τιμή|Price)\s*:\s*€[\d.,]+\.?[ \t]*)?Four Walls\s*,\s*(?:Τηλέφωνο|Tel\.?|τηλ\.?|contact phone|phone)[\s\S]*$/i,
		"",
	).trim();
}

/* Lift the "Κοντινά σημεία: …" / "Nearby: …" line into a structured list and
   remove it from the prose — the site renders it as the "What's Nearby" card.
   Items are "Label <distance>", separated by "·" / "•" / "|". */
const NEARBY_LABEL = /^\s*(?:Κοντιν[άα]\s+σημε[ίι]α|Nearby)\s*[:\-–]\s*/i;
const NEARBY_VALUE = /^(.*?)[ \t]+(\d+(?:[.,]\d+)?\s*(?:μ|m|km|χλμ|λεπτ[άό]|min|['’΄])\.?)\s*$/i;
function extractNearby(text) {
	if (!text) return { text: "", nearby: [] };
	const lines = text.split("\n");
	const idx = lines.findIndex((ln) => NEARBY_LABEL.test(ln));
	if (idx === -1) return { text, nearby: [] };
	const nearby = lines[idx].replace(NEARBY_LABEL, "").split(/\s*[·•|]\s*/)
		.map((chunk) => {
			const c = chunk.trim();
			if (!c) return null;
			const m = c.match(NEARBY_VALUE);
			return m ? { label: m[1].trim(), value: m[2].trim() } : { label: c, value: "" };
		})
		.filter(Boolean);
	lines.splice(idx, 1);
	return { text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), nearby };
}

/* Full pipeline for one description field: HTML → text, drop the contact
   tail, then split off the nearby list. Returns { text, nearby }. */
export function cleanDescription(raw) {
	return extractNearby(stripContactTail(htmlToText(raw)));
}
