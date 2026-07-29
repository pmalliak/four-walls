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

   The CRM write is deliberately NOT here: the public POST /api/requests
   is broken upstream and the internal /requests/form needs a browser
   session, so the ζήτηση is created by the office (or by the
   spitogatos-requests-fetch skill, which now reads these emails too).
   See docs/site-request-form.md.
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
		name: str(body.name, MAX.name),
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

	/* A ζήτηση with no way to answer it is useless, and «what do you
	   want» is the whole point of the form — so name + one contact
	   channel + transaction + category are the floor. */
	if (!r.name || (!r.email && !r.phone) || !r.transaction || !r.category) {
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
