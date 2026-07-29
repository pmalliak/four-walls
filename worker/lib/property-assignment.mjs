/* =====================================================================
   Four Walls — «Αναθέστε μας το ακίνητό σας» relay (/list-property)
   ---------------------------------------------------------------------
   The ανάθεση twin of the ζήτηση form (property-request.mjs) and the
   same pipeline: Turnstile verified here, then everything relayed to
   MAKE_CONTACT_WEBHOOK with `form: "anathesi"` — the Make scenario
   mails «ΝΕΑ ΑΝΑΘΕΣΗ» AND files the CRM contact + communication
   (Worker-originated CRM POSTs get 403, see property-request.mjs).

   Deliberately FEWER fields than the ζήτηση: an owner deciding whether
   to trust us is one phone call away from giving every detail, so the
   form asks only what that call needs — what and roughly where. The
   listing itself is created in the CRM by a consultant after the visit,
   never from a public form. See docs/site-request-form.md.
   ===================================================================== */

const MAX = { name: 120, email: 200, phone: 50, message: 2000, areas: 300, num: 12 };

const TRANSACTIONS = new Set(["sale", "rent"]);
const CATEGORIES = new Set(["residential", "commercial", "land"]);

const LABELS = {
	transaction: { sale: "Πώληση", rent: "Ενοικίαση" },
	category: { residential: "Κατοικία", commercial: "Επαγγελματικός χώρος", land: "Γη / Οικόπεδο" },
};

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
	status,
	headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
});

const str = (v, max) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, max);
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


function buildSummary(r) {
	const L = [];
	const kind = [LABELS.transaction[r.transaction], LABELS.category[r.category]]
		.filter(Boolean).join(" · ");
	if (kind) L.push(kind);
	if (r.areas) L.push(`Περιοχή/διεύθυνση: ${r.areas}`);
	if (r.size) L.push(`Εμβαδόν: ~${r.size} τ.μ.`);
	if (r.price) L.push(`Ζητούμενη τιμή: ${r.price} €${r.transaction === "rent" ? "/μήνα" : ""}`);
	if (r.message) L.push(`Σχόλια: ${r.message}`);
	return L.join("\n");
}

export async function handlePropertyAssignment(request, env) {
	if (request.method !== "POST") {
		return json({ success: false, error: "method_not_allowed" }, 405, { "Allow": "POST" });
	}
	if (!env.TURNSTILE_SECRET_KEY || !env.MAKE_CONTACT_WEBHOOK) {
		console.error("property-assignment: TURNSTILE_SECRET_KEY / MAKE_CONTACT_WEBHOOK secret not configured");
		return json({ success: false, error: "not_configured" }, 500);
	}

	let body;
	try {
		body = await request.json();
	} catch {
		return json({ success: false, error: "bad_request" }, 400);
	}

	if (typeof body.website === "string" && body.website !== "") {
		console.warn("property-assignment: honeypot tripped, dropping request");
		return json({ success: true }, 200);
	}

	const r = {
		firstName: str(body.firstName, MAX.name),
		lastName: str(body.lastName, MAX.name),
		email: str(body.email, MAX.email),
		phone: str(body.phone, MAX.phone),
		transaction: pick(body.transaction, TRANSACTIONS),
		category: pick(body.category, CATEGORIES),
		areas: str(body.areas, MAX.areas),
		size: num(body.size),
		price: num(body.price),
		message: String(body.message ?? "").trim().slice(0, MAX.message),
		lang: body.lang === "en" ? "en" : "el",
		page: str(body.page, 200),
	};

	if (!r.firstName && body.name) {
		const parts = str(body.name, MAX.name).split(" ");
		r.firstName = parts[0] || "";
		r.lastName = parts.slice(1).join(" ");
	}
	r.name = [r.firstName, r.lastName].filter(Boolean).join(" ");

	/* An owner we cannot call back is not a lead. Name + a contact
	   channel + what they are assigning is the floor; everything else
	   the first phone call fills in. */
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
		console.warn(`property-assignment: turnstile rejected (${(outcome["error-codes"] || []).join(", ")})`);
		return json({ success: false, error: "turnstile_failed" }, 403);
	}

	const summary = buildSummary(r);

	const fwd = await fetch(env.MAKE_CONTACT_WEBHOOK, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			form: "anathesi",
			...r,
			transactionLabel: LABELS.transaction[r.transaction] || "",
			categoryLabel: LABELS.category[r.category] || "",
			summary,
			/* Make interpolates these into RAW JSON bodies for the CRM
			   writes — one line, no double quotes, or the body breaks. */
			summaryLine: jsonSafe(summary.replace(/\n/g, " · ")),
			crmFirst: jsonSafe(r.firstName),
			crmLast: jsonSafe(r.lastName),
			...makeCrmFields(r),
			comment: r.message,
			/* readable fallback if the payload ever hits the plain branch */
			message: summary,
			received_at: new Date().toISOString(),
		}),
	});
	if (!fwd.ok) {
		console.error(`property-assignment: Make webhook forward failed (HTTP ${fwd.status})`);
		return json({ success: false, error: "forward_failed" }, 502);
	}

	console.log(JSON.stringify({
		event: "property_assignment",
		transaction: r.transaction,
		category: r.category,
		areas: r.areas,
		lang: r.lang,
		country: request.cf?.country || "",
		ts: new Date().toISOString(),
	}));
	return json({ success: true }, 200);
}
