/* =====================================================================
   Four Walls — CRM writes for the site's lead forms (ζήτηση + ανάθεση)
   ---------------------------------------------------------------------
   The two public forms (/request, /list-property) used to end at an
   email; the contact was typed into EstatePrime by hand. But the public
   API endpoints the Make scenarios already use — POST /api/contacts and
   POST /api/communication — work fine over Basic auth, and the Worker
   holds those secrets for the feed anyway. So the Worker files the lead
   itself: dedupe by phone/email, create the contact if new, then log an
   incoming communication. Only the ζήτηση RECORD stays manual, because
   POST /api/requests is broken upstream (docs/estateprime-api.md).

   Everything here is best-effort: the email to the office is the
   delivery guarantee, the CRM write is a convenience. A 429 or an
   EstatePrime hiccup must never turn into a failed form submit, so the
   caller gets a status string instead of an exception.
   ===================================================================== */

/* Tag ids — ALWAYS by id, Panos renames tags freely (docs/estateprime-api.md).
   Contact namespace: 10=ΖΗΤΗΣΗ, 11=ΑΝΑΘΕΣΗ. A «website» tag does not
   exist yet in either namespace (contact or communication); when it is
   created in the CRM UI, put its ids here and every new lead carries it.
   null = skip. */
const WEBSITE_CONTACT_TAG = null;
const WEBSITE_COMM_TAG = null;
const CONTACT_TAGS = {
	zitisi: [WEBSITE_CONTACT_TAG, 10],
	anathesi: [WEBSITE_CONTACT_TAG, 11],
};

/* Contact sources (namespace of their own): 1=Έρευνα/Καλλιέργεια,
   2=Πελάτη, 3=Spitogatos.gr, 4=Ενοικιαστήριο/Πωλητήριο, 5=Πανό,
   6=Δημόσιες Σχέσεις, 7=Άλλο κανάλι, 8=Google (dumped from the CRM's
   contact page 2026-07-29). There is no «Website» entry; 7 is the
   closest truth. If one is added in the CRM UI, swap the id here. */
const SITE_SOURCE_ID = 7;

const MANOS = 2; // user id — site leads are assigned to Μάνος, like every lead

function api(env) {
	if (!env.ESTATEPRIME_SUBDOMAIN || !env.ESTATEPRIME_API_KEY || !env.ESTATEPRIME_API_SECRET) return null;
	const base = `https://${env.ESTATEPRIME_SUBDOMAIN}.estateprime.gr/api`;
	const headers = {
		"Authorization": "Basic " + btoa(`${env.ESTATEPRIME_API_KEY}:${env.ESTATEPRIME_API_SECRET}`),
		"Content-Type": "application/json",
	};
	return {
		get: async (path) => {
			const r = await fetch(base + path, { headers });
			return { http: r.status, body: await r.json().catch(() => null) };
		},
		post: async (path, obj) => {
			const r = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(obj) });
			return { http: r.status, body: await r.json().catch(() => null) };
		},
	};
}

/* Same normalization the intake skill uses: bare Greek numbers get +30,
   anything already international is left alone. */
function normPhone(p) {
	const s = String(p || "").replace(/[\s.\-()]/g, "");
	if (/^\+/.test(s)) return s;
	if (/^0030/.test(s)) return "+" + s.slice(2);
	if (/^30\d{10}$/.test(s)) return "+" + s;
	if (/^(69|2)\d{8,9}$/.test(s)) return "+30" + s;
	return s;
}

/* The forms ask first/last name separately (Panos, 2026-07-29 — the CRM
   stores two fields, so automated filing should never guess). This split
   remains only as a fallback for payloads that still send one blob. */
function splitName(full) {
	const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
	return { first: parts[0] || "Πελάτης", last: parts.slice(1).join(" ") || "(από το site)" };
}

function athensNow() {
	// en-CA gives YYYY-MM-DD; the API wants "YYYY-MM-DD HH:MM:SS" Athens time.
	const d = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Europe/Athens", year: "numeric", month: "2-digit", day: "2-digit",
		hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
	}).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
	return `${d.year}-${d.month}-${d.day} ${d.hour}:${d.minute}:${d.second}`;
}

/* Dedupe the way the Make scenarios do: ?search= matches phone digits and
   email. Phone first (unique in the CRM, the stronger key), then email. */
async function findContact(crm, phone, email) {
	const keys = [
		String(phone || "").replace(/\D/g, "").replace(/^30/, ""),
		String(email || "").trim(),
	].filter((k) => k.length > 3);
	for (const key of keys) {
		const { body } = await crm.get("/contacts?search=" + encodeURIComponent(key));
		const arr = body?.data;
		if (Array.isArray(arr) && arr.length) return arr[0].id;
	}
	return null;
}

/* File the lead: contact (reuse or create) + one incoming communication.
   `kind` picks the tag set; `notes` lands on a NEW contact only (the API
   has no update); `comments` is the communication body. */
export async function recordSiteLead(env, { kind, firstName, lastName, name, phone, email, notes, comments }) {
	const crm = api(env);
	if (!crm) {
		console.warn("crm-lead: EstatePrime secrets not configured, skipping CRM write");
		return { status: "skipped" };
	}
	try {
		let contactId = await findContact(crm, phone, email);
		let status = contactId ? "reused" : "created";

		if (!contactId) {
			const guessed = splitName(name || firstName);
			const first = firstName || guessed.first;
			const last = lastName || (firstName ? "(από το site)" : guessed.last);
			const { http, body } = await crm.post("/contacts", {
				first_name: first,
				last_name: last,
				is_lead: true, is_company: false, is_active: true,
				source_id: SITE_SOURCE_ID,
				country: "GR", language_id: 1, office_id: 1,
				created_by: MANOS, users: [MANOS],
				tags: (CONTACT_TAGS[kind] || []).filter(Boolean),
				phones: phone ? [{ type: "mobile-personal", number: normPhone(phone), notes: "Από τη φόρμα του site" }] : [],
				emails: email ? [{ type: "personal", email, email_address: email, notes: "Από τη φόρμα του site" }] : [],
				notes,
			});
			contactId = body?.data?.id;
			if (http !== 200 || !contactId) {
				console.error(`crm-lead: contact create failed (HTTP ${http}) ${body?.error_message || ""}`);
				return { status: "failed" };
			}
		}

		const comm = await crm.post("/communication", {
			contact_id: contactId,
			channel: 2, // Email — the form lands in the mailbox
			type: "incoming",
			user_id: MANOS,
			store_id: 1,
			communication_date: athensNow(),
			tags: [WEBSITE_COMM_TAG].filter(Boolean),
			comments,
		});
		const commId = comm.body?.data?.id;
		if (comm.http !== 200 || !commId) {
			// The contact made it in; a missing comm is worth a log, not a fail.
			console.error(`crm-lead: communication create failed (HTTP ${comm.http}) ${comm.body?.error_message || ""}`);
		}

		console.log(JSON.stringify({ event: "crm_lead", kind, status, contactId, commId: commId || null }));
		return { status, contactId, commId };
	} catch (err) {
		console.error(`crm-lead: ${err.message}`);
		return { status: "failed" };
	}
}
