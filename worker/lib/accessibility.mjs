/* =====================================================================
   Four Walls — area accessibility ratings from OpenStreetMap
   ---------------------------------------------------------------------
   An HONEST, Greek-market answer to Homy's "Walk Score" (walkscore.com is
   US/CA/AU/NZ only — no Greece coverage, so the template's numbers are
   placeholders). For a listing's coordinates we grade the walking distance
   to the nearest relevant POI in OpenStreetMap.

   WHICH categories depends on what the property IS (see PROFILES below).
   A school next door sells a family flat and is noise on an office listing:

   A category's band weighs ALL of what it needs, not just the closest thing
   in it: a chemist downstairs does not buy the groceries, so «ψώνια» goes to
   "excellent" only when the food shop and the pharmacy are both close (see
   `combine` on CATEGORIES).

     home       transit · errands · education · leisure
     workplace  transit · dining · errands · parking
     logistics  transit · roads · parking
     land       transit · errands · leisure

   Ratings are qualitative bands (excellent…limited) — NOT invented 0–100
   numbers — and AREA-LEVEL / approximate (published coords are fuzzed for
   privacy). The result per category is { band, type, m } for the closest POI
   that earned it, where `type` is a slug the site localises and `m` is the
   straight-line metres, plus `also: [{ type, m }, …]` with the runners-up so
   the page can show what else is around (the pharmacy AND the supermarket,
   the bus stop AND the metro).

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

/* Each category is a list of `needs`, and each need is one errand you actually
   run: the food shop, the chemist, the school. A need carries the OSM
   selectors that find it (so the query only ever asks for what the listing's
   profile uses) and a `match` returning a `type` slug the site localises.

   HOW A CATEGORY'S BAND COMES OUT — `combine`:
     "all"  (default) the needs are COMPLEMENTARY and the band is the average
            of the `core` ones, because a chemist downstairs does not buy the
            groceries: «ψώνια» is only excellent when the food shop AND the
            pharmacy are both close. A core need with nothing in range counts
            as `limited`, which is real information about the area.
            Needs WITHOUT `core` never enter the sum and are only ever shown:
            a bonus must not punish (a university 1.2 km off is no reason to
            mark down a flat with a school at 200 m), and they are exactly the
            things Greek OSM maps patchily (greengrocers, squares, gyms,
            nurseries), so their absence must stay silent. Keep `core` for what
            everybody needs AND mappers reliably record.
     "best" the needs are ALTERNATIVES and the best one takes the band: metro
            OR bus both get you out of the neighbourhood, so a station at the
            edge of the radius must not drag down the stop round the corner.

   Either way the runner-up needs ride along in `also` so the page names them.
   `cap` ceilings a need's band (a bus-only area never reads "excellent" however
   close the stop). `bands` overrides the walking bands for a category measured
   by car. */
const CATEGORIES = {
	transit: {
		radius: 1600,
		combine: "best", // metro or bus: alternatives, not a shopping list
		needs: [
			{ key: "rail",
				selectors: ["[station=subway]", "[railway=station]", "[railway=subway_entrance]",
					"[railway=tram_stop]", "[railway=halt]"],
				match: (t) =>
					(t.station === "subway" || t.railway === "station" || t.railway === "subway_entrance") ? "metro" :
					t.railway === "tram_stop" ? "tram" :
					t.railway === "halt" ? "train" : null },
			{ key: "bus", cap: "good",
				selectors: ["[highway=bus_stop]"],
				match: (t) => t.highway === "bus_stop" ? "bus" : null },
		],
	},
	errands: {
		radius: 1200,
		needs: [
			/* The weekly shop. Supermarket first, but a mini market or a
			   greengrocer is what a lot of Greek blocks actually live off. */
			{ key: "food", core: true,
				selectors: ["[shop=supermarket]", "[shop=convenience]", "[shop=greengrocer]"],
				match: (t) => t.shop === "supermarket" ? "supermarket"
					: (t.shop === "convenience" || t.shop === "greengrocer") ? "convenience" : null },
			{ key: "pharmacy", core: true,
				selectors: ["[amenity=pharmacy]"],
				match: (t) => t.amenity === "pharmacy" ? "pharmacy" : null },
			{ key: "bakery",
				selectors: ["[shop=bakery]"],
				match: (t) => t.shop === "bakery" ? "bakery" : null },
		],
	},
	education: {
		radius: 1400,
		needs: [
			{ key: "school", core: true,
				selectors: ["[amenity=school]"],
				match: (t) => t.amenity === "school" ? "school" : null },
			/* Nurseries and universities are mapped far less consistently, so
			   they add to the score when they are there and never subtract. */
			{ key: "preschool",
				selectors: ["[amenity=kindergarten]"],
				match: (t) => t.amenity === "kindergarten" ? "kindergarten" : null },
			{ key: "higher",
				selectors: ["[amenity=university]", "[amenity=college]"],
				match: (t) => t.amenity === "university" ? "university"
					: t.amenity === "college" ? "college" : null },
		],
	},
	leisure: {
		radius: 1200,
		needs: [
			{ key: "green", core: true,
				selectors: ["[leisure=park]", "[leisure=garden]", "[place=square]"],
				match: (t) => (t.leisure === "park" || t.leisure === "garden") ? "park"
					: t.place === "square" ? "square" : null },
			{ key: "dining", core: true,
				selectors: ["[amenity=cafe]", "[amenity=restaurant]"],
				match: (t) => (t.amenity === "cafe" || t.amenity === "restaurant") ? "dining" : null },
			{ key: "active",
				selectors: ["[leisure=playground]", "[leisure=fitness_centre]", "[leisure=sports_centre]"],
				match: (t) => t.leisure === "playground" ? "playground"
					: (t.leisure === "fitness_centre" || t.leisure === "sports_centre") ? "gym" : null },
		],
	},
	/* Where the staff go for lunch. Tighter than the leisure radius on
	   purpose: a lunch break is a short walk, not an outing. Anywhere that
	   feeds you will do, so these are alternatives. */
	dining: {
		radius: 700,
		combine: "best",
		needs: [
			{ key: "sitdown",
				selectors: ["[amenity=restaurant]", "[amenity=cafe]"],
				match: (t) => t.amenity === "restaurant" ? "restaurant"
					: t.amenity === "cafe" ? "cafe" : null },
			{ key: "quick",
				selectors: ["[amenity=fast_food]", "[shop=bakery]"],
				match: (t) => t.amenity === "fast_food" ? "fastfood"
					: t.shop === "bakery" ? "bakery" : null },
		],
	},
	/* Somewhere for customers and staff to leave the car. On-street parking
	   is not mapped consistently enough to count, so this is car parks only. */
	parking: {
		radius: 800,
		needs: [
			{ key: "parking", core: true,
				selectors: ["[amenity=parking]"],
				match: (t) => t.amenity === "parking"
					? (t.parking === "multi-storey" || t.parking === "underground" ? "garage" : "carpark")
					: null },
		],
	},
	/* Lorry access, so measured by car, not on foot: what matters for a
	   warehouse is how fast it reaches the ring road or the motorway. */
	roads: {
		radius: 8000,
		bands: [[2000, "excellent"], [4000, "verygood"], [6000, "good"]],
		needs: [
			{ key: "junction", core: true,
				selectors: ["[highway=motorway_junction]"],
				match: (t) => t.highway === "motorway_junction" ? "junction" : null },
		],
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
		for (const need of cat.needs) {
			for (const s of need.selectors) parts.push(`nwr(around:${cat.radius},${lat},${lng})${s};`);
		}
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
		/* Rate every need on its own, so none can hide another. */
		const hits = [];
		let missingCore = 0;
		for (const need of cat.needs) {
			let best = null;
			for (const el of elements) {
				const type = need.match(el.tags || {});
				if (!type) continue;
				const eLat = el.lat ?? el.center?.lat, eLng = el.lon ?? el.center?.lon;
				if (eLat == null) continue;
				const m = haversine(lat, lng, eLat, eLng);
				if (m > cat.radius) continue;
				if (!best || m < best.m) best = { type, m: Math.round(m) };
			}
			if (!best) {
				if (need.core) missingCore++; // nothing of the sort within reach
				continue;
			}
			const raw = bandFor(best.m, cat.bands);
			hits.push({ band: need.cap ? bandCeil(raw, need.cap) : raw, type: best.type, m: best.m,
				core: !!need.core });
		}
		// Best first. Stable, so an equal band keeps the order declared above
		// (rail before bus, the food shop before the bakery).
		hits.sort((a, b) => BAND_ORDER.indexOf(b.band) - BAND_ORDER.indexOf(a.band));

		let band;
		if (!hits.length) {
			band = "limited";
		} else if (cat.combine === "best") {
			band = hits[0].band; // alternatives: the best way out is the answer
		} else {
			/* Complementary needs: average the CORE bands, counting each core
			   need with nothing in range as `limited`. Optional needs are left
			   out of the sum entirely and only ever shown, because a bonus must
			   not punish: a university 1.2 km away is no reason to mark down a
			   flat whose school is 200 m away. Half-way lands on the LOWER band,
			   so a category never rounds its way up into a claim it cannot back. */
			const scores = hits.filter((h) => h.core).map((h) => BAND_ORDER.indexOf(h.band));
			for (let i = 0; i < missingCore; i++) scores.push(0);
			band = scores.length
				? BAND_ORDER[Math.max(0, Math.ceil(scores.reduce((a, b) => a + b, 0) / scores.length - 0.5))]
				: hits[0].band; // no core needs declared: fall back to the best found
		}

		/* Reading order. With "best" the top band goes first, because that is
		   the need which set the score. With an average no single POI set it,
		   so the nearest leads and the line simply reads closest-first. */
		const ordered = cat.combine === "best"
			? hits
			: hits.slice().sort((a, b) => a.m - b.m);

		const result = { band, type: ordered[0]?.type ?? null, m: ordered[0]?.m ?? null };
		// The rest of what was weighed, so the band is answerable on the page.
		if (ordered.length > 1) result.also = ordered.slice(1, 3).map((h) => ({ type: h.type, m: h.m }));
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
