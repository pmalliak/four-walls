/* =====================================================================
   Four Walls — «Ζητάω ακίνητο» form relay (/request, /en/request)
   ---------------------------------------------------------------------
   Until now every ζήτηση reached us through Spitogatos: they own the
   lead, we pay for it, and the CRM record is typed in by hand. This form
   is the same thing on our own site, so the next one costs nothing.

   Shape follows /api/contact exactly (Turnstile verified here, then
   relayed to Make): the difference is that the payload is structured,
   because a ζήτηση has criteria, not just a message. The Worker also
   composes `summary` — the same lines the office would type into the CRM
   — so neither Make nor the secretary has to reassemble them.

   WHY IT REUSES MAKE_CONTACT_WEBHOOK: a separate hook would need a new
   Worker secret, and secrets are set by hand in Cloudflare. The relay
   carries `form: "zitisi"`, and the Make scenario «Site - Φόρμα
   επικοινωνίας» routes on it to its own email. Splitting it into its own
   hook later is one secret + one filter, nothing else changes.

   The CONTACT and the incoming communication are written to the CRM by
   the MAKE scenario, not here: EstatePrime answers Worker-originated
   POSTs with 403 «Access denied» no matter the headers (2026-07-30),
   while Make posts to the same endpoints fine — so the scenario reuses
   the exact module chain the Spitogatos leads use. The Worker ships
   Make pre-sanitised fields (summaryLine, crmFirst/crmLast) because
   Make builds its JSON bodies as raw text. Only the ζήτηση record
   stays manual (POST /api/requests is broken upstream); the office or
   the spitogatos-requests-fetch skill (step 7β) creates it from the
   email. See docs/site-request-form.md.
   ===================================================================== */

const MAX = { name: 120, email: 200, phone: 50, message: 2000, areas: 300, num: 12, list: 20 };

const TRANSACTIONS = new Set(["rent", "sale"]);
const CATEGORIES = new Set(["residential", "commercial", "land"]);
/* Mirrors of the CRM slugs (docs/estateprime-api.md) so whatever the
   office pastes into a ζήτηση already matches the CRM's vocabulary. */
const SUBCATEGORIES = new Set([
	"apartment", "studio", "maisonette", "detached", "villa", "loft",
	"office", "store", "warehouse", "hall", "craft_space", "plot", "parcel", "parking",
]);
const FEATURES = new Set([
	"has_balcony", "has_parking", "has_storage_room", "has_elevator",
	"pets_allowed", "suitable_for_students", "has_air_condition", "is_furnished",
]);

const LABELS = {
	transaction: { rent: "Ενοικίαση", sale: "Αγορά" },
	category: { residential: "Κατοικία", commercial: "Επαγγελματικός χώρος", land: "Γη / Οικόπεδο" },
	subcategory: {
		apartment: "Διαμέρισμα", studio: "Στούντιο / Γκαρσονιέρα", maisonette: "Μεζονέτα",
		detached: "Μονοκατοικία", villa: "Βίλα", loft: "Loft", office: "Γραφείο",
		store: "Κατάστημα", warehouse: "Αποθήκη", hall: "Αίθουσα", craft_space: "Βιοτεχνικός χώρος",
		plot: "Οικόπεδο", parcel: "Αγροτεμάχιο", parking: "Θέση στάθμευσης",
	},
	features: {
		has_balcony: "Βεράντα", has_parking: "Πάρκινγκ", has_storage_room: "Αποθήκη",
		has_elevator: "Ασανσέρ", pets_allowed: "Δέχεται κατοικίδια",
		suitable_for_students: "Φοιτητικό", has_air_condition: "Κλιματισμός",
		is_furnished: "Επιπλωμένο",
	},
};

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
	status,
	headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
});

const str = (v, max) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);
/* Digits only, so «500€» and «περίπου 500» both land as 500 and nothing
   downstream has to guess. Empty when the visitor left it blank. */
const num = (v) => {
	const d = String(v ?? "").replace(/[^\d]/g, "").slice(0, MAX.num);
	return d ? String(Number(d)) : "";
};
const pick = (v, allowed) => (allowed.has(String(v ?? "")) ? String(v) : "");
/* For values Make drops into raw JSON: straight quotes would end the
   string, backslashes would escape into it. */
const jsonSafe = (v) => String(v ?? "").replace(/["\\]/g, "'").replace(/[\u0000-\u001F\u007F]/g, " ");

/* Make writes the CRM records (Worker-originated POSTs get 403 there),
   and its JSON bodies are raw text — so the phone/email land pre-shaped:
   digits for dedupe search, E.164 for storage, ready row-objects that
   drop into "phones": [...] / "emails": [...] verbatim. */
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
			type: "mobile-personal", number: e164, notes: "Από τη φόρμα του site",
		}) : "",
		emailJson: r.email.includes("@") ? JSON.stringify({
			type: "personal", email: r.email, notes: "Από τη φόρμα του site",
		}) : "",
	};
}


/* The email + the CRM ζήτηση both want the criteria as readable lines
   rather than a JSON blob, and building them once here keeps Make free
   of formatting logic. */
function buildSummary(r) {
	const L = [];
	const kind = [LABELS.transaction[r.transaction], LABELS.category[r.category],
		LABELS.subcategory[r.subcategory]].filter(Boolean).join(" · ");
	if (kind) L.push(kind);
	if (r.areas) L.push(`Περιοχές: ${r.areas}`);
	const price = r.priceMin && r.priceMax ? `${r.priceMin} ως ${r.priceMax} €`
		: r.priceMax ? `ως ${r.priceMax} €` : r.priceMin ? `από ${r.priceMin} €` : "";
	if (price) L.push(`Τιμή: ${price}`);
	const size = r.sizeMin && r.sizeMax ? `${r.sizeMin} ως ${r.sizeMax} τ.μ.`
		: r.sizeMax ? `ως ${r.sizeMax} τ.μ.` : r.sizeMin ? `από ${r.sizeMin} τ.μ.` : "";
	if (size) L.push(`Εμβαδόν: ${size}`);
	if (r.bedroomsMin) L.push(`Υπνοδωμάτια: από ${r.bedroomsMin}`);
	if (r.floorMin) L.push(`Όροφος: από ${r.floorMin}`);
	if (r.features.length) {
		L.push(`Χαρακτηριστικά: ${r.features.map((f) => LABELS.features[f] || f).join(", ")}`);
	}
	if (r.message) L.push(`Σχόλια: ${r.message}`);
	return L.join("\n");
}

export async function handlePropertyRequest(request, env) {
	if (request.method !== "POST") {
		return json({ success: false, error: "method_not_allowed" }, 405, { "Allow": "POST" });
	}
	if (!env.TURNSTILE_SECRET_KEY || !env.MAKE_CONTACT_WEBHOOK) {
		console.error("property-request: TURNSTILE_SECRET_KEY / MAKE_CONTACT_WEBHOOK secret not configured");
		return json({ success: false, error: "not_configured" }, 500);
	}

	let body;
	try {
		body = await request.json();
	} catch {
		return json({ success: false, error: "bad_request" }, 400);
	}

	if (typeof body.website === "string" && body.website !== "") {
		console.warn("property-request: honeypot tripped, dropping request");
		return json({ success: true }, 200);
	}

	const r = {
		firstName: str(body.firstName, MAX.name),
		lastName: str(body.lastName, MAX.name),
		email: str(body.email, MAX.email),
		phone: str(body.phone, MAX.phone),
		transaction: pick(body.transaction, TRANSACTIONS),
		category: pick(body.category, CATEGORIES),
		subcategory: pick(body.subcategory, SUBCATEGORIES),
		areas: str(body.areas, MAX.areas),
		priceMin: num(body.priceMin),
		priceMax: num(body.priceMax),
		sizeMin: num(body.sizeMin),
		sizeMax: num(body.sizeMax),
		bedroomsMin: num(body.bedroomsMin),
		floorMin: num(body.floorMin),
		features: (Array.isArray(body.features) ? body.features : [])
			.map((f) => pick(f, FEATURES)).filter(Boolean).slice(0, MAX.list),
		message: String(body.message ?? "").trim().slice(0, MAX.message),
		lang: body.lang === "en" ? "en" : "el",
		page: str(body.page, 200),
	};

	/* Older callers sent one «name» blob; split it so the floor below and
	   the CRM write see the same two fields the form now submits. */
	if (!r.firstName && body.name) {
		const parts = str(body.name, MAX.name).split(" ");
		r.firstName = parts[0] || "";
		r.lastName = parts.slice(1).join(" ");
	}
	r.name = [r.firstName, r.lastName].filter(Boolean).join(" ");

	/* A ζήτηση with no way to answer it is useless, and «what do you
	   want» is the whole point of the form — so name + one contact
	   channel + transaction + category are the floor. */
	if (!r.firstName || (!r.email && !r.phone) || !r.transaction || !r.category) {
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
		console.warn(`property-request: turnstile rejected (${(outcome["error-codes"] || []).join(", ")})`);
		return json({ success: false, error: "turnstile_failed" }, 403);
	}

	const summary = buildSummary(r);

	/* File the lead in the CRM first, so the email can name the contact.
	   Best-effort by design: recordSiteLead never throws, and a failed
	   write becomes a line in the email («καταχώρισέ τον με το χέρι»)
	   rather than a failed submit. */

	const fwd = await fetch(env.MAKE_CONTACT_WEBHOOK, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			/* The Make scenario routes on this; anything without it is the
			   plain contact form and keeps its old branch. */
			form: "zitisi",
			...r,
			transactionLabel: LABELS.transaction[r.transaction] || "",
			categoryLabel: LABELS.category[r.category] || "",
			subcategoryLabel: LABELS.subcategory[r.subcategory] || "",
			featuresLabel: r.features.map((f) => LABELS.features[f] || f).join(", "),
			summary,
			/* Make interpolates these into RAW JSON bodies for the CRM
			   writes — one line, no double quotes, or the body breaks. */
			summaryLine: jsonSafe(summary.replace(/\n/g, " · ")),
			crmFirst: jsonSafe(r.firstName),
			crmLast: jsonSafe(r.lastName),
			...makeCrmFields(r),
			/* The visitor's own words, kept apart from `message` — the email
			   shows this as «Σχόλια», and overwriting it with the summary
			   made every request look like it had a long comment. */
			comment: r.message,
			/* `message` is what the plain-contact branch would show, so a
			   misrouted ζήτηση is still readable instead of empty. */
			message: summary,
			received_at: new Date().toISOString(),
		}),
	});
	if (!fwd.ok) {
		console.error(`property-request: Make webhook forward failed (HTTP ${fwd.status})`);
		return json({ success: false, error: "forward_failed" }, 502);
	}

	console.log(JSON.stringify({
		event: "property_request",
		transaction: r.transaction,
		category: r.category,
		areas: r.areas,
		lang: r.lang,
		country: request.cf?.country || "",
		ts: new Date().toISOString(),
	}));
	return json({ success: true }, 200);
}
