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

import { SITE, PAGES_META } from "./pages-meta.mjs";

/* KV key of the feed — keep in sync with FEED_KEY in worker/index.mjs. */
const FEED_KEY = "listings.json";

/* Greek labels for CRM slugs — mirror of SUBCATEGORY / TRANSACTION in
   js/listings.fw.js (an IIFE, so nothing to import). The generated
   <title> must stay byte-identical to the client's document.title. */
const SUBCATEGORY = {
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
};

const TRANSACTION = {
	sale: "Πώληση", rent: "Ενοικίαση",
	auction: "Πλειστηριασμός", shortterm: "Βραχυχρόνια"
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

function fmtNumber(n) {
	return new Intl.NumberFormat("el-GR").format(n);
}

function subcategoryLabel(l) {
	return SUBCATEGORY[l.subcategory] || SUBCATEGORY[l.category] || l.subcategory || "";
}

/* The URL key of a listing — its public «Κωδικός», same rule as
   detailUrl()/findByKey() in js/listings.fw.js. */
function listingKey(l) {
	return l.code || l.id;
}

function canonicalUrl(l) {
	return SITE.origin + "/properties/" + encodeURIComponent(listingKey(l));
}

/* Byte-identical to the client's document.title (js/listings.fw.js
   initDetail) so the runtime overwrite changes nothing. */
function listingTitle(l) {
	const heading = subcategoryLabel(l) + (l.area != null ? " " + fmtNumber(l.area) + " τ.μ." : "");
	return heading + (l.location?.area ? ", " + l.location.area : "");
}

/* Meta description: the CRM's Greek description trimmed to ~155 chars
   on a word boundary; composed fallback when the CRM has none. */
function listingDescription(l) {
	const raw = (l.description || "").replace(/\s+/g, " ").trim();
	if (raw) {
		if (raw.length <= 158) return raw;
		let cut = raw.slice(0, 155);
		const sp = cut.lastIndexOf(" ");
		if (sp > 80) cut = cut.slice(0, sp);
		return cut + "…";
	}
	const bits = [TRANSACTION[l.transaction] || null, listingTitle(l)];
	if (l.price != null) {
		bits.push("€" + fmtNumber(l.price) + (l.transaction === "rent" || l.transaction === "shortterm" ? "/μήνα" : ""));
	}
	return bits.filter(Boolean).join(" · ") + " — Four Walls Real Estate, Θεσσαλονίκη.";
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

async function loadFeed(env) {
	// One KV read per request, edge-cached: feed updates reach listing
	// heads within ≤5 min, which webhook/cron cadence makes acceptable.
	return env.LISTINGS_KV.get(FEED_KEY, { type: "json", cacheTtl: 300 });
}

/* ------------------------------------------------------------------ */
/* Listing detail page: /properties/<code>                             */
/* ------------------------------------------------------------------ */

export async function serveListingPage(key, url, env) {
	let feed = null;
	try {
		feed = await loadFeed(env);
	} catch (err) {
		console.warn("seo: feed unavailable, serving plain shell:", err.message);
	}

	// Fetch the shell WITHOUT the browser's conditional headers — a 304
	// has no body to rewrite. The asset ETag is dropped for the same
	// reason (it identifies the un-rewritten shell).
	const shell = await env.ASSETS.fetch(new URL("/property", url));
	if (!feed || !Array.isArray(feed.listings)) return shell;

	const l = feed.listings.find((x) => x.code === key || x.id === key);
	if (!l) {
		// Real 404 (not a 200 soft-404): serve the branded 404 page body.
		const nf = await env.ASSETS.fetch(new URL("/404", url));
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
				e.setInnerContent(listingTitle(l) + " | Four Walls");
			},
		})
		.on('meta[name="description"]', {
			element(e) {
				e.setAttribute("content", listingDescription(l));
			},
		})
		.on("head", {
			element(e) {
				e.append(seoBlock(l), { html: true });
			},
		})
		.transform(new Response(shell.body, { status: 200, headers }));
}

/* Canonical + OG/Twitter + JSON-LD, appended to the shell's <head>.
   The static FW:HEAD block of property.html deliberately carries only
   title + description (workerManaged in pages-meta.mjs), so nothing
   here is emitted twice. */
function seoBlock(l) {
	const canonical = canonicalUrl(l);
	const title = listingTitle(l);
	const desc = listingDescription(l);
	const image = absImage(l.images?.[0]) || SITE.origin + SITE.ogImage;
	const tags = [
		`<link rel="canonical" href="${escAttr(canonical)}">`,
		`<meta property="og:site_name" content="${escAttr(SITE.name)}">`,
		`<meta property="og:locale" content="${escAttr(SITE.locale)}">`,
		`<meta property="og:type" content="website">`,
		`<meta property="og:url" content="${escAttr(canonical)}">`,
		`<meta property="og:title" content="${escAttr(title)}">`,
		`<meta property="og:description" content="${escAttr(desc)}">`,
		`<meta property="og:image" content="${escAttr(image)}">`,
		`<meta name="twitter:card" content="summary_large_image">`,
		`<meta name="twitter:title" content="${escAttr(title)}">`,
		`<meta name="twitter:description" content="${escAttr(desc)}">`,
		`<meta name="twitter:image" content="${escAttr(image)}">`,
		`<script type="application/ld+json">${listingJsonLd(l, canonical, title, desc)}</script>`,
	];
	return "\n\t" + tags.join("\n\t") + "\n";
}

/* Exported for direct testing in Node — pure function, no CF APIs. */
export function listingJsonLd(l, canonical, title, desc) {
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
			addressLocality: loc.area || loc.city || undefined,
			addressRegion: loc.city || "Θεσσαλονίκη",
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
		inLanguage: "el",
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
		itemListElement: [
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
   every webhook/cron rebuild. Feed missing → static pages only. */
export async function sitemapResponse(env) {
	let feed = null;
	try {
		feed = await loadFeed(env);
	} catch (err) {
		console.warn("seo: sitemap without listings, feed unavailable:", err.message);
	}

	const entries = [];
	for (const meta of Object.values(PAGES_META)) {
		if (meta.sitemap === false || !meta.path) continue;
		entries.push({ loc: SITE.origin + meta.path });
	}
	for (const l of feed?.listings || []) {
		if (!listingKey(l)) continue;
		entries.push({ loc: canonicalUrl(l), lastmod: isoDate(l.updatedAt) });
	}

	const xml =
		'<?xml version="1.0" encoding="UTF-8"?>\n' +
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
		entries
			.map((e) =>
				"\t<url>\n\t\t<loc>" + escXml(e.loc) + "</loc>\n" +
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
