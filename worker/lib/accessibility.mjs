/* =====================================================================
   Four Walls — area accessibility ratings from OpenStreetMap
   ---------------------------------------------------------------------
   An HONEST, Greek-market answer to Homy's "Walk Score" (walkscore.com is
   US/CA/AU/NZ only — no Greece coverage, so the template's numbers are
   placeholders). For a listing's coordinates we grade the walking distance
   to the nearest relevant POI in OpenStreetMap.

   WHICH categories depends on what the property IS (see PROFILES below).
   A school next door sells a family flat and is noise on an office listing:

     home       transit · errands · education · leisure
     workplace  transit · dining · errands · parking
     logistics  transit · roads · parking
     land       transit · errands · leisure

   Ratings are qualitative bands (excellent…limited) — NOT invented 0–100
   numbers — and AREA-LEVEL / approximate (published coords are fuzzed for
   privacy). The result per category is { band, type, m } where `type` is a
   POI slug the site localises and `m` is the straight-line metres.

   USAGE — precompute OFFLINE, read in the Worker.
     Overpass is NOT reachable from the Cloudflare Worker (its outbound
     requests to the public mirrors hang, which stalled the feed rebuild).
     So ratings are precomputed by tools/build-accessibility.mjs into the
     committed map worker/lib/accessibility-data.mjs, and estateprime.mjs
     merges that map into the feed by listing id (no network in the rebuild
     path). Run the tool when listings are added, moved or retyped:

       node tools/build-accessibility.mjs      (or ask Claude: /area-accessibility)

   Source: © OpenStreetMap contributors (ODbL).
   ===================================================================== */

/* Overpass mirrors, tried in order until one returns JSON. The main
   overpass-api.de goes first because it is by far the fastest and steadiest
   (measured 2026-07-29: ~2 s and always 200, while the small community
   mirrors took 15-110 s and returned 504 about half the time). It does
   throttle a burst, hence the pause the tool keeps between listings. */
const MIRRORS = [
	"https://overpass-api.de/api/interpreter",
	"https://maps.mail.ru/osm/tools/overpass/api/interpreter",
	"https://overpass.private.coffee/api/interpreter",
];
const UA = "four-walls-accessibility/1.0 (+https://four-walls.gr)";

/* Walking-distance bands (metres, straight-line — kept conservative since
   coords are fuzzed and real walking paths aren't straight). */
const BANDS = [[300, "excellent"], [600, "verygood"], [1000, "good"], [1600, "moderate"]];
function bandFor(m, bands) {
	if (m == null) return "limited";
	for (const [max, name] of (bands || BANDS)) if (m <= max) return name;
	return "limited";
}

/* Band ceiling — a bus-only area can't score "excellent transit" no matter
   how close the stop is. */
const BAND_ORDER = ["limited", "moderate", "good", "verygood", "excellent"];
function bandCeil(band, cap) {
	return BAND_ORDER.indexOf(band) > BAND_ORDER.indexOf(cap) ? cap : band;
}

/* Each category grades by walking distance to the nearest relevant POI, and
   carries the OSM selectors that find those POIs so the query only ever asks
   for what the listing's profile actually uses (see PROFILES). A category may
   define `tiers` tried in priority order: the first tier with any match wins
   (so rail beats bus — buses are everywhere and would other-
   wise always be the nearest "transit", hiding metro proximity). `match`
   returns a `type` slug the site localises; `cap` ceilings a tier's band.
   `bands` overrides the walking bands for a category measured by car. */
const CATEGORIES = {
	transit: {
		radius: 1600,
		selectors: ["[station=subway]", "[railway=station]", "[railway=subway_entrance]",
			"[railway=tram_stop]", "[railway=halt]", "[highway=bus_stop]"],
		tiers: [
			{ match: (t) =>
				(t.station === "subway" || t.railway === "station" || t.railway === "subway_entrance") ? "metro" :
				t.railway === "tram_stop" ? "tram" :
				t.railway === "halt" ? "train" : null },
			{ cap: "good", match: (t) => t.highway === "bus_stop" ? "bus" : null },
		],
	},
	errands: {
		radius: 1200,
		selectors: ["[shop=supermarket]", "[shop=bakery]", "[amenity=pharmacy]",
			"[shop=convenience]", "[shop=greengrocer]"],
		tiers: [{ match: (t) =>
			t.shop === "supermarket" ? "supermarket" :
			t.shop === "bakery" ? "bakery" :
			t.amenity === "pharmacy" ? "pharmacy" :
			(t.shop === "convenience" || t.shop === "greengrocer") ? "convenience" : null }],
	},
	education: {
		radius: 1400,
		selectors: ["[amenity=school]", "[amenity=kindergarten]", "[amenity=university]", "[amenity=college]"],
		tiers: [{ match: (t) =>
			t.amenity === "school" ? "school" :
			t.amenity === "kindergarten" ? "kindergarten" :
			t.amenity === "university" ? "university" :
			t.amenity === "college" ? "college" : null }],
	},
	leisure: {
		radius: 1200,
		selectors: ["[leisure=park]", "[leisure=garden]", "[place=square]", "[leisure=playground]",
			"[leisure=fitness_centre]", "[leisure=sports_centre]", "[amenity=cafe]", "[amenity=restaurant]"],
		tiers: [{ match: (t) =>
			(t.leisure === "park" || t.leisure === "garden") ? "park" :
			t.place === "square" ? "square" :
			t.leisure === "playground" ? "playground" :
			(t.leisure === "fitness_centre" || t.leisure === "sports_centre") ? "gym" :
			(t.amenity === "cafe" || t.amenity === "restaurant") ? "dining" : null }],
	},
	/* Where the staff go for lunch. Tighter than the leisure radius on
	   purpose: a lunch break is a short walk, not an outing. */
	dining: {
		radius: 700,
		selectors: ["[amenity=cafe]", "[amenity=restaurant]", "[amenity=fast_food]", "[shop=bakery]"],
		tiers: [{ match: (t) =>
			t.amenity === "restaurant" ? "restaurant" :
			t.amenity === "cafe" ? "cafe" :
			t.amenity === "fast_food" ? "fastfood" :
			t.shop === "bakery" ? "bakery" : null }],
	},
	/* Somewhere for customers and staff to leave the car. On-street parking
	   is not mapped consistently enough to count, so this is car parks only. */
	parking: {
		radius: 800,
		selectors: ["[amenity=parking]"],
		tiers: [{ match: (t) => t.amenity === "parking"
			? (t.parking === "multi-storey" || t.parking === "underground" ? "garage" : "carpark")
			: null }],
	},
	/* Lorry access, so measured by car, not on foot: what matters for a
	   warehouse is how fast it reaches the ring road or the motorway. */
	roads: {
		radius: 8000,
		bands: [[2000, "excellent"], [4000, "verygood"], [6000, "good"]],
		selectors: ["[highway=motorway_junction]"],
		tiers: [{ match: (t) => t.highway === "motorway_junction" ? "junction" : null }],
	},
};

/* Which categories a listing is graded on. A school next door sells a family
   flat and means nothing to an office; a warehouse cares about the motorway
   and not about playgrounds. Categories outside the profile are never even
   queried, which also keeps the Overpass answer small. */
const PROFILES = {
	home: ["transit", "errands", "education", "leisure"],
	workplace: ["transit", "dining", "errands", "parking"],
	logistics: ["transit", "roads", "parking"],
	land: ["transit", "errands", "leisure"],
};

/* subcategory (EstatePrime slug) -> profile. `category` is the fallback for
   anything the CRM adds later, so a new subcategory still gets sane cards
   instead of none. An empty plot is treated as a home: in town it is nearly
   always bought to build or live on, and «τι έχει γύρω» is the question. */
const PROFILE_BY_SUBCATEGORY = {
	office: "workplace", store: "workplace", hotel: "workplace",
	commercial_building: "workplace", hall: "workplace", business: "workplace",
	other_commercial: "workplace",
	warehouse: "logistics", industrial_space: "logistics",
	craft_space: "logistics", parking: "logistics",
	plot: "home",
	parcel: "land", island: "land", air: "land",
};
const PROFILE_BY_CATEGORY = { residential: "home", commercial: "workplace", land: "land" };

/* The profile name for one feed listing (see docs/listings-feed.md for the
   shape). Unknown or missing type falls back to the fullest set. */
export function profileFor(listing) {
	return PROFILE_BY_SUBCATEGORY[listing?.subcategory]
		|| PROFILE_BY_CATEGORY[listing?.category]
		|| "home";
}

export function categoriesFor(profile) {
	return PROFILES[profile] || PROFILES.home;
}

function haversine(aLat, aLng, bLat, bLng) {
	const R = 6371000, rad = (x) => (x * Math.PI) / 180;
	const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
	const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(s));
}

/* One `around` per selector at its own category's radius, so a profile that
   does not use schools never downloads any, and a small radius stays small. */
function overpassQuery(lat, lng, keys) {
	const parts = [];
	for (const key of keys) {
		const cat = CATEGORIES[key];
		for (const s of cat.selectors) parts.push(`nwr(around:${cat.radius},${lat},${lng})${s};`);
	}
	return `[out:json][timeout:30];(${parts.join("")});out center tags;`;
}

/* Give up on a mirror rather than hang on it. The query itself carries
   [timeout:30], so anything past this is the mirror being unreachable, and
   the next one in line is a better bet than waiting. Without it a bad night
   on the small mirrors turned a 27-listing run into half an hour. */
const MIRROR_TIMEOUT_MS = 45000;

async function fetchOverpass(lat, lng, keys) {
	const q = overpassQuery(lat, lng, keys);
	let lastErr = "no mirror responded";
	for (const ep of MIRRORS) {
		try {
			const res = await fetch(ep, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
				body: "data=" + encodeURIComponent(q),
				signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
			});
			const txt = await res.text();
			if (txt.trim().startsWith("{")) return JSON.parse(txt).elements || [];
			lastErr = `${ep} → ${txt.slice(0, 40).replace(/\s+/g, " ")}`;
		} catch (e) {
			lastErr = `${ep} → ${e.message}`;
		}
	}
	throw new Error(lastErr);
}

function scoreFromElements(lat, lng, elements, keys) {
	const out = {};
	for (const key of keys) {
		const cat = CATEGORIES[key];
		let result = { band: "limited", type: null, m: null };
		for (const tier of cat.tiers) {
			let best = null;
			for (const el of elements) {
				const type = tier.match(el.tags || {});
				if (!type) continue;
				const eLat = el.lat ?? el.center?.lat, eLng = el.lon ?? el.center?.lon;
				if (eLat == null) continue;
				const m = haversine(lat, lng, eLat, eLng);
				if (m > cat.radius) continue;
				if (!best || m < best.m) best = { type, m: Math.round(m) };
			}
			if (best) {
				const raw = bandFor(best.m, cat.bands);
				result = { band: tier.cap ? bandCeil(raw, tier.cap) : raw, type: best.type, m: best.m };
				break; // first (highest-priority) tier with a match wins
			}
		}
		out[key] = result;
	}
	return out;
}

/* Rate one coordinate on the categories its profile calls for (queries
   Overpass). Used only by the OFFLINE tool — never call this from the
   Worker. */
export async function computeAccessibility(lat, lng, profile = "home") {
	const keys = categoriesFor(profile);
	return scoreFromElements(lat, lng, await fetchOverpass(lat, lng, keys), keys);
}
