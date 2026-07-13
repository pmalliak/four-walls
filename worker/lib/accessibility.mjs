/* =====================================================================
   Four Walls — area accessibility ratings from OpenStreetMap
   ---------------------------------------------------------------------
   An HONEST, Greek-market answer to Homy's "Walk Score" (walkscore.com is
   US/CA/AU/NZ only — no Greece coverage, so the template's numbers are
   placeholders). For a listing's coordinates we grade four categories by
   the walking distance to the nearest relevant POI in OpenStreetMap:

     transit    μετρό / τραμ / τρένο / στάση λεωφορείου
     errands    σούπερ μάρκετ / φούρνος / φαρμακείο / μίνι μάρκετ
     education  σχολείο / νηπιαγωγείο / πανεπιστήμιο / κολέγιο
     leisure    πάρκο / πλατεία / παιδική χαρά / γυμναστήριο / εστίαση

   Ratings are qualitative bands (excellent…limited) — NOT invented 0–100
   numbers — and AREA-LEVEL / approximate (published coords are fuzzed for
   privacy). The result per category is { band, type, m } where `type` is a
   POI slug the site localises and `m` is the straight-line metres.

   USAGE — precompute OFFLINE, read in the Worker.
     Overpass is NOT reachable from the Cloudflare Worker (its outbound
     requests to the public mirrors hang, which stalled the feed rebuild).
     So ratings are precomputed by tools/build-accessibility.mjs — which
     calls `computeAccessibility(lat, lng)` here — into the committed map
     worker/lib/accessibility-data.mjs. estateprime.mjs merges that map into
     the feed by listing id (no network in the rebuild path). Re-run the tool
     and redeploy when a listing is added or its coordinates change.

   Source: © OpenStreetMap contributors (ODbL).
   ===================================================================== */

/* Overpass mirrors — the main overpass-api.de rate-limits hard; kumi needs
   a UA. Tried in order until one returns JSON. */
const MIRRORS = [
	"https://maps.mail.ru/osm/tools/overpass/api/interpreter",
	"https://overpass.private.coffee/api/interpreter",
	"https://overpass-api.de/api/interpreter",
];
const UA = "four-walls-accessibility/1.0 (+https://four-walls.gr)";

/* Walking-distance bands (metres, straight-line — kept conservative since
   coords are fuzzed and real walking paths aren't straight). */
const BANDS = [[300, "excellent"], [600, "verygood"], [1000, "good"], [1600, "moderate"]];
function bandFor(m) {
	if (m == null) return "limited";
	for (const [max, name] of BANDS) if (m <= max) return name;
	return "limited";
}

/* Band ceiling — a bus-only area can't score "excellent transit" no matter
   how close the stop is. */
const BAND_ORDER = ["limited", "moderate", "good", "verygood", "excellent"];
function bandCeil(band, cap) {
	return BAND_ORDER.indexOf(band) > BAND_ORDER.indexOf(cap) ? cap : band;
}

/* Each category grades by walking distance to the nearest relevant POI. A
   category may define `tiers` tried in priority order: the first tier with
   any match wins (so rail beats bus — buses are everywhere and would other-
   wise always be the nearest "transit", hiding metro proximity). `match`
   returns a `type` slug the site localises; `cap` ceilings a tier's band. */
const CATEGORIES = {
	transit: {
		radius: 1600,
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
		tiers: [{ match: (t) =>
			t.shop === "supermarket" ? "supermarket" :
			t.shop === "bakery" ? "bakery" :
			t.amenity === "pharmacy" ? "pharmacy" :
			(t.shop === "convenience" || t.shop === "greengrocer") ? "convenience" : null }],
	},
	education: {
		radius: 1400,
		tiers: [{ match: (t) =>
			t.amenity === "school" ? "school" :
			t.amenity === "kindergarten" ? "kindergarten" :
			t.amenity === "university" ? "university" :
			t.amenity === "college" ? "college" : null }],
	},
	leisure: {
		radius: 1200,
		tiers: [{ match: (t) =>
			(t.leisure === "park" || t.leisure === "garden") ? "park" :
			t.place === "square" ? "square" :
			t.leisure === "playground" ? "playground" :
			(t.leisure === "fitness_centre" || t.leisure === "sports_centre") ? "gym" :
			(t.amenity === "cafe" || t.amenity === "restaurant") ? "dining" : null }],
	},
};
const MAX_RADIUS = Math.max(...Object.values(CATEGORIES).map((c) => c.radius));

function haversine(aLat, aLng, bLat, bLng) {
	const R = 6371000, rad = (x) => (x * Math.PI) / 180;
	const dLat = rad(bLat - aLat), dLng = rad(bLng - aLng);
	const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(s));
}

function overpassQuery(lat, lng) {
	const sels = [
		"[station=subway]", "[railway=station]", "[railway=subway_entrance]",
		"[railway=tram_stop]", "[railway=halt]", "[highway=bus_stop]",
		"[shop=supermarket]", "[shop=bakery]", "[amenity=pharmacy]",
		"[shop=convenience]", "[shop=greengrocer]",
		"[amenity=school]", "[amenity=kindergarten]", "[amenity=university]", "[amenity=college]",
		"[leisure=park]", "[leisure=garden]", "[place=square]", "[leisure=playground]",
		"[leisure=fitness_centre]", "[leisure=sports_centre]", "[amenity=cafe]", "[amenity=restaurant]",
	];
	const body = sels.map((s) => `nwr(around:${MAX_RADIUS},${lat},${lng})${s};`).join("");
	return `[out:json][timeout:30];(${body});out center tags;`;
}

async function fetchOverpass(lat, lng) {
	const q = overpassQuery(lat, lng);
	let lastErr = "no mirror responded";
	for (const ep of MIRRORS) {
		try {
			const res = await fetch(ep, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
				body: "data=" + encodeURIComponent(q),
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

function scoreFromElements(lat, lng, elements) {
	const out = {};
	for (const [key, cat] of Object.entries(CATEGORIES)) {
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
				const band = tier.cap ? bandCeil(bandFor(best.m), tier.cap) : bandFor(best.m);
				result = { band, type: best.type, m: best.m };
				break; // first (highest-priority) tier with a match wins
			}
		}
		out[key] = result;
	}
	return out;
}

/* Compute the four category ratings for a coordinate (queries Overpass).
   Used only by the OFFLINE tool — never call this from the Worker. */
export async function computeAccessibility(lat, lng) {
	return scoreFromElements(lat, lng, await fetchOverpass(lat, lng));
}
