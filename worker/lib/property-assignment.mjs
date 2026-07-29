/* =====================================================================
   Four Walls — «Αναθέστε μας το ακίνητό σας» relay (/list-property)
   ---------------------------------------------------------------------
   The ανάθεση twin of the ζήτηση form (property-request.mjs) and the
   same pipeline: Turnstile verified here, contact + incoming
   communication filed straight into the CRM (crm-lead.mjs), then the
   payload relayed to MAKE_CONTACT_WEBHOOK with `form: "anathesi"` so the
   Make router mails «ΝΕΑ ΑΝΑΘΕΣΗ» to the office.

   Deliberately FEWER fields than the ζήτηση: an owner deciding whether
   to trust us is one phone call away from giving every detail, so the
   form asks only what that call needs — what and roughly where. The
   listing itself is created in the CRM by a consultant after the visit,
   never from a public form. See docs/site-request-form.md.
   ===================================================================== */

import { recordSiteLead } from "./crm-lead.mjs";

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
	const crm = await recordSiteLead(env, {
		kind: "anathesi",
		firstName: r.firstName,
		lastName: r.lastName,
		phone: r.phone,
		email: r.email,
		notes: `Ανάθεση από τη φόρμα του site (${r.page || "/list-property"}).\n${summary}`,
		comments: `Ανάθεση ακινήτου από τη φόρμα του four-walls.gr/list-property. ${summary.replace(/\n/g, " ")}`,
	});

	const fwd = await fetch(env.MAKE_CONTACT_WEBHOOK, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			form: "anathesi",
			...r,
			transactionLabel: LABELS.transaction[r.transaction] || "",
			categoryLabel: LABELS.category[r.category] || "",
			summary,
			comment: r.message,
			/* readable fallback if the payload ever hits the plain branch */
			message: summary,
			crmStatus: crm.status,
			crmContactId: crm.contactId || "",
			crmContactUrl: crm.contactId
				? `https://${env.ESTATEPRIME_SUBDOMAIN}.estateprime.gr/contacts/view/${crm.contactId}` : "",
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
