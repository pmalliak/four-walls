/* =====================================================================
   Four Walls — «Ενδιαφέρομαι για το ακίνητο» relay (/properties/<code>)
   ---------------------------------------------------------------------
   The form in the sidebar of every listing page. Until now it was the
   theme's decorative `action="#"` (the visitor pressed Αποστολή and
   nothing happened, no error either), so the warmest lead on the site —
   somebody looking at one specific property — had to go find the contact
   page on their own.

   Same shape as /api/property-request: Turnstile verified here, then
   relayed to Make with `form: "endiaferon"`, which routes it to its own
   branch of «Site - Φόρμα επικοινωνίας» (CRM contact + incoming
   communication + email to the office). The CRM writes stay in Make
   because EstatePrime answers Worker-originated POSTs with 403
   (docs/site-request-form.md).

   WHAT THE CLIENT IS NOT TRUSTED WITH: the property. The browser sends
   only the listing `code`; everything the office reads (τύπος, εμβαδόν,
   περιοχή, τιμή, URL) is looked up in the feed here. A lead that names a
   €90.000 flat that is really €190.000 would be worse than no lead.
   ===================================================================== */

import { canonicalUrl, listingTitle, locField, fmtNumber } from "./seo.mjs";

const FEED_KEY = "listings.json";

const MAX = { name: 120, email: 200, phone: 50, message: 2000, code: 32 };

const LABELS = {
	el: { sale: "Πώληση", rent: "Ενοικίαση" },
	en: { sale: "Sale", rent: "Rent" },
};

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
	status,
	headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
});

const str = (v, max) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);
/* For values Make drops into raw JSON: straight quotes would end the
   string, backslashes would escape into it. */
const jsonSafe = (v) => String(v ?? "").replace(/["\\]/g, "'").replace(/[\u0000-\u001F\u007F]/g, " ");

/* Make writes the CRM records and builds its JSON bodies as raw text, so
   the phone/email land pre-shaped: digits for the dedupe search, E.164
   for storage, ready row-objects that drop into "phones": [...] /
   "emails": [...] verbatim. Identical to property-request.mjs. */
function makeCrmFields(r) {
	const digits = String(r.phone || "").replace(/\D/g, "").replace(/^0+/, "");
	const e164 = !digits ? ""
		: digits.length >= 12 ? "+" + digits
		: "+30" + digits;
	return {
		phoneDigits: digits,
		searchKey: digits.length > 9 ? digits.slice(-10)
			: (r.email.includes("@") ? r.email : ""),
		phoneJson: digits ? JSON.stringify({
			type: "mobile-personal", number: e164, notes: "Από τη σελίδα ακινήτου",
		}) : "",
		emailJson: r.email.includes("@") ? JSON.stringify({
			type: "personal", email: r.email, notes: "Από τη σελίδα ακινήτου",
		}) : "",
	};
}

/* One readable line about the property, from the feed and nothing else:
   «Διαμέρισμα 105 τ.μ., Άγιος Παύλος · Πώληση · 160.000 €». It is what
   the email shows and what lands in the CRM note, so it is composed once
   here rather than three times in Make. */
function listingLine(l, lang) {
	if (!l) return "";
	const price = l.price != null && l.price !== ""
		? fmtNumber(l.price, lang) + " €" + (l.transaction === "rent" ? (lang === "en" ? "/month" : "/μήνα") : "")
		: (lang === "en" ? "Price on request" : "Τιμή κατόπιν συνεννόησης");
	return [listingTitle(l, lang), LABELS[lang][l.transaction] || "", price].filter(Boolean).join(" · ");
}

export async function handlePropertyInquiry(request, env) {
	if (request.method !== "POST") {
		return json({ success: false, error: "method_not_allowed" }, 405, { "Allow": "POST" });
	}
	if (!env.TURNSTILE_SECRET_KEY || !env.MAKE_CONTACT_WEBHOOK) {
		console.error("property-inquiry: TURNSTILE_SECRET_KEY / MAKE_CONTACT_WEBHOOK secret not configured");
		return json({ success: false, error: "not_configured" }, 500);
	}

	let body;
	try {
		body = await request.json();
	} catch {
		return json({ success: false, error: "bad_request" }, 400);
	}

	if (typeof body.website === "string" && body.website !== "") {
		console.warn("property-inquiry: honeypot tripped, dropping request");
		return json({ success: true }, 200);
	}

	const r = {
		firstName: str(body.firstName, MAX.name),
		lastName: str(body.lastName, MAX.name),
		email: str(body.email, MAX.email),
		phone: str(body.phone, MAX.phone),
		/* The listing key as it appears in the URL — public code or id, so
		   letters, digits, dash and underscore and nothing else. */
		code: str(body.code, MAX.code).replace(/[^A-Za-z0-9_-]/g, ""),
		message: String(body.message ?? "").trim().slice(0, MAX.message),
		lang: body.lang === "en" ? "en" : "el",
		page: str(body.page, 200),
	};
	r.name = [r.firstName, r.lastName].filter(Boolean).join(" ");

	/* Name + one channel to answer on. Everything else (which property,
	   what it costs) we know ourselves. */
	if (!r.firstName || !r.lastName || (!r.email && !r.phone)) {
		return json({ success: false, error: "missing_fields" }, 400);
	}

	const token = String(body.token || "");
	if (!token) return json({ success: false, error: "missing_token" }, 400);
	const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			secret: env.TURNSTILE_SECRET_KEY,
			response: token,
			remoteip: request.headers.get("CF-Connecting-IP"),
		}),
	});
	const outcome = await verify.json();
	if (!outcome.success) {
		console.warn(`property-inquiry: turnstile rejected (${(outcome["error-codes"] || []).join(", ")})`);
		return json({ success: false, error: "turnstile_failed" }, 403);
	}

	/* The property, from the feed. A code that is not in it means the
	   listing left the market between the page load and the submit (or
	   somebody typed their own): the lead still goes through — a person
	   who wants to be called back is worth more than a tidy record — but
	   the email says so instead of inventing a property. */
	let listing = null;
	try {
		const raw = await env.LISTINGS_KV.get(FEED_KEY);
		const feed = raw ? JSON.parse(raw) : null;
		const listings = Array.isArray(feed?.listings) ? feed.listings : [];
		if (r.code) listing = listings.find((l) => l.code === r.code || l.id === r.code) || null;
	} catch (err) {
		console.error(`property-inquiry: feed read failed: ${err.message}`);
	}

	const line = listingLine(listing, r.lang);
	const url = listing ? canonicalUrl(listing, r.lang) : "";
	const summary = [
		`Ακίνητο: ${line || (r.code ? `κωδ. ${r.code} (δεν βρέθηκε στο feed)` : "—")}`,
		r.code ? `Κωδικός: ${r.code}` : "",
		url ? `Σελίδα: ${url}` : "",
		r.message ? `Μήνυμα: ${r.message}` : "",
	].filter(Boolean).join("\n");

	const fwd = await fetch(env.MAKE_CONTACT_WEBHOOK, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			/* The Make scenario routes on this; the other values are
			   zitisi / anathesi / (absent) = plain contact form. */
			form: "endiaferon",
			...r,
			/* Everything below is looked up, never sent by the browser. */
			listingCode: r.code,
			listingId: listing ? String(listing.id || "") : "",
			listingTitle: listing ? listingTitle(listing, r.lang) : "",
			listingLine: jsonSafe(line),
			listingUrl: url,
			listingArea: listing ? (locField(listing, "area", r.lang) || "") : "",
			listingPrice: listing && listing.price != null ? String(listing.price) : "",
			listingTransaction: listing ? listing.transaction || "" : "",
			listingTransactionLabel: listing ? (LABELS[r.lang][listing.transaction] || "") : "",
			listingFound: Boolean(listing),
			summary,
			/* Make interpolates these into RAW JSON bodies for the CRM
			   writes — one line, no double quotes, or the body breaks. */
			summaryLine: jsonSafe(summary.replace(/\n/g, " · ")),
			crmFirst: jsonSafe(r.firstName),
			crmLast: jsonSafe(r.lastName),
			...makeCrmFields(r),
			/* The visitor's own words, kept apart from `message` (which is
			   what the plain-contact branch would print) so the email can
			   show both «Ακίνητο» and «Μήνυμα» without repeating itself. */
			comment: r.message,
			message: summary,
			received_at: new Date().toISOString(),
		}),
	});
	if (!fwd.ok) {
		console.error(`property-inquiry: Make webhook forward failed (HTTP ${fwd.status})`);
		return json({ success: false, error: "forward_failed" }, 502);
	}

	console.log(JSON.stringify({
		event: "property_inquiry",
		code: r.code,
		found: Boolean(listing),
		lang: r.lang,
		country: request.cf?.country || "",
		ts: new Date().toISOString(),
	}));
	return json({ success: true }, 200);
}
