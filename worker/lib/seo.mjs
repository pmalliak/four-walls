/* =====================================================================
   Four Walls — Worker-side SEO (per-listing head injection, sitemap,
   robots)
   ---------------------------------------------------------------------
   Listing pages are client-rendered (js/listings.fw.js), so without
   this module every /properties/<code> URL serves the same generic head:
   social scrapers (Facebook/Instagram/Viber/WhatsApp) never execute JS
   and would show no preview at all, and search engines would see only
   the shell. serveListingPage() rewrites the property.html shell per
   listing with <title>, meta description, canonical, Open Graph /
   Twitter tags and schema.org JSON-LD — the client JS then renders the
   visible page as before (its document.title write is a same-string
   no-op).

   Also serves /sitemap.xml (static pages from worker/lib/pages-meta.mjs
   + one URL per feed listing) and a host-aware /robots.txt (crawling is
   only allowed on the production hosts).
   ===================================================================== */

import { SITE, PAGES_META, pageLang, alternateKey } from "./pages-meta.mjs";

/* KV key of the feed — keep in sync with FEED_KEY in worker/index.mjs. */
const FEED_KEY = "listings.json";

/* Labels for CRM slugs, per language — mirrors of the el/en SUBCATEGORY /
   TRANSACTION maps in js/listings.fw.js (an IIFE, so nothing to import).
   The generated <title> must stay byte-identical to the client's
   document.title in BOTH languages — keep all four maps in sync. */
const SUBCATEGORY = {
	el: {
		apartment: "Διαμέρισμα", maisonette: "Μεζονέτα", detached: "Μονοκατοικία",
		house: "Μονοκατοικία", studio: "Στούντιο",
		villa: "Βίλα", loft: "Loft", residential_building: "Κτίριο κατοικιών",
		apartment_complex: "Συγκρότημα διαμερισμάτων", farmhouse: "Αγροικία",
		houseboat: "Πλωτή κατοικία", other_residential: "Άλλη κατοικία",
		office: "Γραφείο", store: "Κατάστημα", warehouse: "Αποθήκη",
		hotel: "Ξενοδοχείο", commercial_building: "Επαγγελματικό κτίριο",
		hall: "Αίθουσα", industrial_space: "Βιομηχανικός χώρος",
		craft_space: "Βιοτεχνικός χώρος", other_commercial: "Άλλο επαγγελματικό",
		plot: "Οικόπεδο", parcel: "Αγροτεμάχιο", island: "Νησί",
		parking: "Πάρκινγκ", business: "Επιχείρηση", air: "Αέρας", other: "Άλλο"
	},
	en: {
		apartment: "Apartment", maisonette: "Maisonette", detached: "Detached house",
		house: "Detached house", studio: "Studio",
		villa: "Villa", loft: "Loft", residential_building: "Residential building",
		apartment_complex: "Apartment complex", farmhouse: "Farmhouse",
		houseboat: "Houseboat", other_residential: "Other residential",
		office: "Office", store: "Retail space", warehouse: "Warehouse",
		hotel: "Hotel", commercial_building: "Commercial building",
		hall: "Hall", industrial_space: "Industrial space",
		craft_space: "Light-industrial space", other_commercial: "Other commercial",
		plot: "Plot of land", parcel: "Land parcel", island: "Island",
		parking: "Parking space", business: "Business", air: "Air rights", other: "Other"
	}
};

const TRANSACTION = {
	el: {
		sale: "Πώληση", rent: "Ενοικίαση",
		auction: "Πλειστηριασμός", shortterm: "Βραχυχρόνια"
	},
	en: {
		sale: "For sale", rent: "For rent",
		auction: "Auction", shortterm: "Short-term let"
	}
};

/* schema.org type for the offered item, by CRM subcategory (fallback by
   category). Real estate has no Google rich result; the goal is clean,
   valid entity data — never Product (Google's Product docs exclude
   real-estate listings). */
const SCHEMA_TYPE = {
	apartment: "Apartment", studio: "Apartment", loft: "Apartment",
	maisonette: "House", detached: "House", house: "House", villa: "House",
	farmhouse: "House", houseboat: "House",
	residential_building: "Residence", apartment_complex: "ApartmentComplex",
	other_residential: "Accommodation",
	plot: "Place", parcel: "Place", island: "Place",
};
const SCHEMA_TYPE_BY_CATEGORY = {
	residential: "Accommodation", commercial: "Accommodation",
	land: "Place", other: "Place",
};

export function isProdHost(hostname) {
	return hostname === "four-walls.gr" || hostname === "www.four-walls.gr";
}

function fmtNumber(n, lang = "el") {
	return new Intl.NumberFormat(lang === "en" ? "en-GB" : "el-GR").format(n);
}

function subcategoryLabel(l, lang = "el") {
	const map = SUBCATEGORY[lang];
	return map[l.subcategory] || map[l.category] || l.subcategory || "";
}

/* Location field in the requested language, Greek fallback per field —
   same rule as loc() in js/listings.fw.js. */
function locField(l, key, lang) {
	const loc = l.location || {};
	return (lang === "en" && loc[key + "_en"]) || loc[key] || null;
}

/* The URL key of a listing — its public «Κωδικός», same rule as
   detailUrl()/findByKey() in js/listings.fw.js. */
function listingKey(l) {
	return l.code || l.id;
}

function canonicalUrl(l, lang = "el") {
	return SITE.origin + (lang === "en" ? "/en" : "") +
		"/properties/" + encodeURIComponent(listingKey(l));
}

/* Byte-identical to the client's document.title (js/listings.fw.js
   initDetail) so the runtime overwrite changes nothing — in BOTH
   languages (client: heading + ", " + loc(l, "area")). */
function listingTitle(l, lang = "el") {
	const sqm = lang === "en" ? " m²" : " τ.μ.";
	const heading = subcategoryLabel(l, lang) + (l.area != null ? " " + fmtNumber(l.area, lang) + sqm : "");
	const area = locField(l, "area", lang);
	return heading + (area ? ", " + area : "");
}

/* Meta description: the CRM's description trimmed to ~155 chars on a
   word boundary (English falls back to Greek text when the CRM has no
   English); composed fallback when the CRM has none at all. */
function listingDescription(l, lang = "el") {
	const src = (lang === "en" && l.description_en) || l.description || "";
	const raw = src.replace(/\s+/g, " ").trim();
	if (raw) {
		if (raw.length <= 158) return raw;
		let cut = raw.slice(0, 155);
		const sp = cut.lastIndexOf(" ");
		if (sp > 80) cut = cut.slice(0, sp);
		return cut + "…";
	}
	const rent = l.transaction === "rent" || l.transaction === "shortterm";
	const bits = [TRANSACTION[lang][l.transaction] || null, listingTitle(l, lang)];
	if (l.price != null) {
		bits.push("€" + fmtNumber(l.price, lang) + (rent ? (lang === "en" ? "/month" : "/μήνα") : ""));
	}
	return bits.filter(Boolean).join(" · ") +
		(lang === "en" ? " — Four Walls Real Estate, Thessaloniki." : " — Four Walls Real Estate, Θεσσαλονίκη.");
}

function escAttr(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/* Feed image paths are relative in sample mode, absolute from the CRM. */
function absImage(src) {
	if (!src) return null;
	try {
		return new URL(src, SITE.origin + "/").href;
	} catch {
		return null;
	}
}

/* Origin of an absolute URL, or null for relative/malformed input — used
   to preconnect to the photo host. Never throws (a throw inside seoBlock
   would fail the whole detail-page rewrite). */
function urlOrigin(src) {
	if (!src) return null;
	try {
		return new URL(src).origin;
	} catch {
		return null;
	}
}

async function loadFeed(env) {
	// One KV read per request, edge-cached: feed updates reach listing
	// heads within ≤5 min, which webhook/cron cadence makes acceptable.
	return env.LISTINGS_KV.get(FEED_KEY, { type: "json", cacheTtl: 300 });
}

/* ------------------------------------------------------------------ */
/* Listing detail page: /properties/<code> and /en/properties/<code>   */
/* ------------------------------------------------------------------ */

export async function serveListingPage(key, url, env, lang = "el") {
	let feed = null;
	try {
		feed = await loadFeed(env);
	} catch (err) {
		console.warn("seo: feed unavailable, serving plain shell:", err.message);
	}

	// Fetch the shell WITHOUT the browser's conditional headers — a 304
	// has no body to rewrite. The asset ETag is dropped for the same
	// reason (it identifies the un-rewritten shell).
	const shell = await env.ASSETS.fetch(new URL(lang === "en" ? "/en/property" : "/property", url));
	if (!feed || !Array.isArray(feed.listings)) return shell;

	const l = feed.listings.find((x) => x.code === key || x.id === key);
	if (!l) {
		// Real 404 (not a 200 soft-404): serve the branded 404 page body.
		const nf = await env.ASSETS.fetch(new URL(lang === "en" ? "/en/404" : "/404", url));
		const headers = new Headers(nf.headers);
		headers.delete("ETag");
		return new Response(nf.body, { status: 404, headers });
	}

	const headers = new Headers(shell.headers);
	headers.delete("ETag");
	headers.set("Cache-Control", "public, max-age=300");

	return new HTMLRewriter()
		.on("title", {
			element(e) {
				e.setInnerContent(listingTitle(l, lang) + " | Four Walls");
			},
		})
		.on('meta[name="description"]', {
			element(e) {
				e.setAttribute("content", listingDescription(l, lang));
			},
		})
		.on("head", {
			element(e) {
				e.append(seoBlock(l, lang), { html: true });
			},
		})
		.transform(new Response(shell.body, { status: 200, headers }));
}

/* Canonical + hreflang + OG/Twitter + JSON-LD, appended to the shell's
   <head>. The static FW:HEAD block of property.html deliberately carries
   only title + description (workerManaged in pages-meta.mjs), so nothing
   here is emitted twice. Both languages emit the identical hreflang
   triple (el / en / x-default→el). */
function seoBlock(l, lang = "el") {
	const canonical = canonicalUrl(l, lang);
	const elUrl = canonicalUrl(l, "el");
	const enUrl = canonicalUrl(l, "en");
	const title = listingTitle(l, lang);
	const desc = listingDescription(l, lang);
	const image = absImage(l.images?.[0]) || SITE.origin + SITE.ogImage;
	/* LCP fast path: warm the connection to the photo host and preload the
	   first gallery image. Without this the hero photo only starts loading
	   AFTER the theme scripts + 115 KB feed fetch + client render, over a
	   cold connection — the single biggest delay on the detail page. Plain
	   <img> loads are no-cors, so neither hint carries `crossorigin` (a
	   mismatch would open a second, unused connection); the preload href is
	   the raw CRM URL so it byte-matches the src js/listings.fw.js will set.
	   Skipped in sample mode, where images are relative (no host to warm). */
	const firstImg = l.images?.[0];
	const imgOrigin = urlOrigin(firstImg);
	const perf = imgOrigin
		? [
			`<link rel="preconnect" href="${escAttr(imgOrigin)}">`,
			`<link rel="preload" as="image" href="${escAttr(firstImg)}" fetchpriority="high">`,
		]
		: [];
	const tags = [
		...perf,
		`<link rel="alternate" hreflang="el" href="${escAttr(elUrl)}">`,
		`<link rel="alternate" hreflang="en" href="${escAttr(enUrl)}">`,
		`<link rel="alternate" hreflang="x-default" href="${escAttr(elUrl)}">`,
		`<link rel="canonical" href="${escAttr(canonical)}">`,
		`<meta property="og:site_name" content="${escAttr(SITE.name)}">`,
		`<meta property="og:locale" content="${escAttr(SITE.locales[lang])}">`,
		`<meta property="og:type" content="website">`,
		`<meta property="og:url" content="${escAttr(canonical)}">`,
		`<meta property="og:title" content="${escAttr(title)}">`,
		`<meta property="og:description" content="${escAttr(desc)}">`,
		`<meta property="og:image" content="${escAttr(image)}">`,
		`<meta name="twitter:card" content="summary_large_image">`,
		`<meta name="twitter:title" content="${escAttr(title)}">`,
		`<meta name="twitter:description" content="${escAttr(desc)}">`,
		`<meta name="twitter:image" content="${escAttr(image)}">`,
		`<script type="application/ld+json">${listingJsonLd(l, canonical, title, desc, lang)}</script>`,
	];
	return "\n\t" + tags.join("\n\t") + "\n";
}

/* Exported for direct testing in Node — pure function, no CF APIs. */
export function listingJsonLd(l, canonical, title, desc, lang = "el") {
	const loc = l.location || {};
	const images = (l.images || []).slice(0, 8).map(absImage).filter(Boolean);
	const rent = l.transaction === "rent" || l.transaction === "shortterm";

	const item = {
		// Same slug fallback as subcategoryLabel(): sample data carries the
		// subcategory slug in `category`, the live CRM in `subcategory`.
		"@type": SCHEMA_TYPE[l.subcategory] || SCHEMA_TYPE[l.category]
			|| SCHEMA_TYPE_BY_CATEGORY[l.category] || "Accommodation",
		"@id": canonical + "#item",
		name: title,
		url: canonical,
		address: {
			"@type": "PostalAddress",
			streetAddress: loc.address || undefined,
			addressLocality: locField(l, "area", lang) || locField(l, "city", lang) || undefined,
			addressRegion: locField(l, "city", lang) || (lang === "en" ? "Thessaloniki" : "Θεσσαλονίκη"),
			addressCountry: "GR",
		},
		// Privacy is already enforced upstream: the feed carries fake
		// coordinates when the CRM says display_address="fake".
		geo: loc.lat != null && loc.lng != null
			? { "@type": "GeoCoordinates", latitude: loc.lat, longitude: loc.lng }
			: undefined,
		floorSize: l.area != null
			? { "@type": "QuantitativeValue", value: l.area, unitCode: "MTK" }
			: undefined,
		numberOfBedrooms: l.bedrooms ?? undefined,
		numberOfBathroomsTotal: l.bathrooms ?? undefined,
		yearBuilt: l.yearBuilt ?? undefined,
	};

	const listing = {
		"@type": "RealEstateListing",
		"@id": canonical,
		url: canonical,
		name: title,
		description: desc,
		inLanguage: lang,
		datePosted: isoDate(l.updatedAt),
		image: images.length ? images : undefined,
		mainEntity: { "@id": l.price != null ? canonical + "#offer" : canonical + "#item" },
	};

	const graph = [listing];

	if (l.price != null) {
		graph.push({
			"@type": "Offer",
			"@id": canonical + "#offer",
			url: canonical,
			price: l.price,
			priceCurrency: "EUR",
			availability: "https://schema.org/InStock",
			priceSpecification: rent
				? {
					"@type": "UnitPriceSpecification",
					price: l.price,
					priceCurrency: "EUR",
					unitCode: "MON",
				}
				: undefined,
			// Links to the RealEstateAgent node stamped in the footer of
			// every page (partials/footer.html).
			seller: { "@id": SITE.origin + "/#organization" },
			itemOffered: item,
		});
	} else {
		// Hidden price («Κατόπιν επικοινωνίας»): no Offer node at all —
		// a price-less Offer only invites validation warnings.
		graph.push(item);
	}

	graph.push({
		"@type": "BreadcrumbList",
		itemListElement: lang === "en"
			? [
				{ "@type": "ListItem", position: 1, name: "Home", item: SITE.origin + "/en/" },
				{ "@type": "ListItem", position: 2, name: "Properties", item: SITE.origin + "/en/properties" },
				{ "@type": "ListItem", position: 3, name: title },
			]
			: [
				{ "@type": "ListItem", position: 1, name: "Αρχική", item: SITE.origin + "/" },
				{ "@type": "ListItem", position: 2, name: "Ακίνητα", item: SITE.origin + "/properties" },
				{ "@type": "ListItem", position: 3, name: title },
			],
	});

	// <-escape so "</script>" can never occur inside the block.
	return JSON.stringify({ "@context": "https://schema.org", "@graph": graph })
		.replace(/</g, "\\u003c");
}

/* "2026-07-01 12:34:56" / ISO → "2026-07-01"; anything else → omit. */
function isoDate(s) {
	const d = String(s || "").slice(0, 10);
	return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined;
}

/* ------------------------------------------------------------------ */
/* sitemap.xml + robots.txt                                            */
/* ------------------------------------------------------------------ */

function escXml(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/* A Worker route (not a static file) because listing URLs change on
   every webhook/cron rebuild. Feed missing → static pages only.
   Every URL with a translation pair carries xhtml:link alternates
   (el / en / x-default→el), mirroring the on-page hreflang triples. */
export async function sitemapResponse(env) {
	let feed = null;
	try {
		feed = await loadFeed(env);
	} catch (err) {
		console.warn("seo: sitemap without listings, feed unavailable:", err.message);
	}

	const entries = [];
	for (const [key, meta] of Object.entries(PAGES_META)) {
		if (meta.sitemap === false || !meta.path) continue;
		const alt = PAGES_META[alternateKey(key)];
		let alternates;
		if (alt && alt.path && alt.sitemap !== false) {
			const elPath = pageLang(key) === "el" ? meta.path : alt.path;
			const enPath = pageLang(key) === "el" ? alt.path : meta.path;
			alternates = { el: SITE.origin + elPath, en: SITE.origin + enPath };
		}
		entries.push({ loc: SITE.origin + meta.path, alternates });
	}
	for (const l of feed?.listings || []) {
		if (!listingKey(l)) continue;
		const alternates = { el: canonicalUrl(l, "el"), en: canonicalUrl(l, "en") };
		for (const lang of ["el", "en"]) {
			entries.push({ loc: canonicalUrl(l, lang), lastmod: isoDate(l.updatedAt), alternates });
		}
	}

	const alternateLinks = (a) =>
		!a ? "" :
		[["el", a.el], ["en", a.en], ["x-default", a.el]]
			.map(([hreflang, href]) =>
				'\t\t<xhtml:link rel="alternate" hreflang="' + hreflang + '" href="' + escXml(href) + '"/>\n')
			.join("");

	const xml =
		'<?xml version="1.0" encoding="UTF-8"?>\n' +
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
		entries
			.map((e) =>
				"\t<url>\n\t\t<loc>" + escXml(e.loc) + "</loc>\n" +
				alternateLinks(e.alternates) +
				(e.lastmod ? "\t\t<lastmod>" + e.lastmod + "</lastmod>\n" : "") +
				"\t</url>\n")
			.join("") +
		"</urlset>\n";

	return new Response(xml, {
		headers: {
			"Content-Type": "application/xml; charset=utf-8",
			"Cache-Control": "public, max-age=600",
		},
	});
}

/* Host-aware: only the production hosts may be crawled. dev.*,
   *.workers.dev and forms.* answer Disallow-all so they never end up in
   the index while the apex still points at the old host (and after). */
export function robotsResponse(url) {
	const body = isProdHost(url.hostname)
		? "User-agent: *\nDisallow: /forms/\n\nSitemap: " + SITE.origin + "/sitemap.xml\n"
		: "User-agent: *\nDisallow: /\n";
	return new Response(body, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
}
