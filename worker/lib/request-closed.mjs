/* =====================================================================
   Four Walls — «ολοκλήρωσα την αναζήτηση» (POST /api/request-closed)
   ---------------------------------------------------------------------
   Η σελίδα /request-closed είναι το landing του συνδέσμου στο κάτω μέρος
   των CRM email (ματσαρίσματα + προτάσεις ακινήτων). Ο πελάτης
   επιβεβαιώνει ότι δεν θέλει άλλες προτάσεις, εμείς ελέγχουμε το
   Turnstile και προωθούμε στο Make (MAKE_REQUEST_CLOSED_WEBHOOK), που
   στέλνει το email στο info@ για να κλείσει άνθρωπος τη ζήτηση.

   ΓΙΑΤΙ ΚΟΙΤΑΜΕ ΤΟ CRM ΕΔΩ. Και τα τέσσερα templates στέλνουν πλέον
   «?e=<email>» χωρίς ids (docs/request-closed.md), οπότε το email στο
   info@ έφτανε με «Ζήτηση —» και «Επαφή —»: ένα email που λέει «κάποιος
   σταμάτησε κάτι». Πριν το προωθήσουμε, λοιπόν, ρωτάμε το EstatePrime
   ποια επαφή είναι αυτό το email και ποιες ΕΝΕΡΓΕΣ ζητήσεις έχει, και
   στέλνουμε στο Make έτοιμο HTML με συνδέσμους: επαφή, κάθε ζήτηση, τα
   κριτήριά της. Στην πράξη η επαφή έχει μία ενεργή ζήτηση, οπότε το
   email δείχνει κατευθείαν ποια πρέπει να κλείσει.

   Η ΑΝΑΓΝΩΣΗ ΔΕΝ ΓΥΡΙΖΕΙ ΠΟΤΕ ΣΤΟΝ BROWSER. Το endpoint είναι δημόσιο
   και το «e=» είναι κείμενο από σύνδεσμο, δηλαδή είσοδος επισκέπτη: ό,τι
   βρεθεί μπαίνει ΜΟΝΟ μέσα στο email προς το info@, η απάντηση στη
   σελίδα μένει σκέτο {success:true}. Άρα μαντεύοντας ξένα email κανείς
   δεν μαθαίνει τίποτα, το χειρότερο σενάριο παραμένει ένα παραπλανητικό
   email στο γραφείο (και το Turnstile στέκεται μπροστά).

   ΤΟ EMAIL ΤΟ ΧΤΙΖΕΙ Ο WORKER, ΟΧΙ ΤΟ MAKE. Το σενάριο 6683649 κρατάει
   δύο modules (webhook -> Zoho Mail με {{1.subject}} / {{1.html}}), ίδιο
   μοτίβο με το digest των ματσαρισμάτων (6722234). Έτσι κάθε αλλαγή στο
   κείμενο είναι μια γραμμή κώδικα με git diff, όχι formula μέσα σε JSON.

   Το lookup είναι best-effort: αν το CRM αργήσει ή σκάσει, το email
   φεύγει με ό,τι ξέρουμε και μια γραμμή «δεν απάντησε το CRM». Ποτέ δεν
   χάνεται η ειδοποίηση επειδή απέτυχε ο εμπλουτισμός της.

   Βλ. docs/request-closed.md.
   ===================================================================== */

import { apiConfig } from "./estateprime.mjs";
import { normPhone, fmtPhone } from "./phone-lookup.mjs";

/* Πόσο περιμένουμε συνολικά το CRM πριν στείλουμε το email χωρίς αυτό.
   Ο πελάτης κοιτάει spinner όσο τρέχει αυτό, οπότε δεν μεγαλώνει. */
const LOOKUP_TIMEOUT_MS = 6000;
const MAX_PAGES = 20;
/* Πόσες περιοχές αξίζει να μεταφράσουμε σε ονόματα. Κάθε μία είναι μια
   κλήση /locations/{id}· πάνω από τόσες η γραμμή κριτηρίων γίνεται
   δυσανάγνωστη ούτως ή άλλως. */
const MAX_LOCATION_LOOKUPS = 8;

export async function handleRequestClosed(request, env) {
	if (request.method !== "POST") {
		return rcJson({ success: false, error: "method_not_allowed" }, 405, { "Allow": "POST" });
	}
	if (!env.TURNSTILE_SECRET_KEY || !env.MAKE_REQUEST_CLOSED_WEBHOOK) {
		console.error("request-closed: TURNSTILE_SECRET_KEY / MAKE_REQUEST_CLOSED_WEBHOOK secret not configured");
		return rcJson({ success: false, error: "not_configured" }, 500);
	}

	let body;
	try {
		body = await request.json();
	} catch {
		return rcJson({ success: false, error: "bad_request" }, 400);
	}

	if (typeof body.website === "string" && body.website !== "") {
		console.warn("request-closed: honeypot tripped, dropping confirmation");
		return rcJson({ success: true }, 200);
	}

	const digits = (v) => (/^\d{1,12}$/.test(String(v || "")) ? String(v) : "");
	const requestId = digits(body.request_id);
	const contactId = digits(body.contact_id);
	const reason = String(body.reason || "").trim().slice(0, 100);
	const comment = String(body.comment || "").trim().slice(0, 2000);
	const page = String(body.page || "").slice(0, 200);
	/* Το email του πελάτη έρχεται από το «?e=» του συνδέσμου. Ο browser
	   μπορεί να κρατάει παλιό fourwalls.js που δεν το στέλνει σε δικό του
	   πεδίο, οπότε το ψαρεύουμε και από το ίδιο το «page». */
	const clientRef = String(body.client_ref || refFromPage(page) || "").trim().slice(0, 200);

	const token = String(body.token || "");
	if (!token) {
		return rcJson({ success: false, error: "missing_token" }, 400);
	}
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
		console.warn(`request-closed: turnstile rejected (${(outcome["error-codes"] || []).join(", ")})`);
		return rcJson({ success: false, error: "turnstile_failed" }, 403);
	}

	const found = await lookupClient(env, { contactId, email: emailOf(clientRef) });
	const mail = buildEmail(env, {
		requestId, contactId, reason, comment, clientRef,
		receivedAt: new Date(),
		found,
	});

	const fwd = await fetch(env.MAKE_REQUEST_CLOSED_WEBHOOK, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			subject: mail.subject,
			html: mail.html,
			// Δομημένα πεδία για το module που θα κλείνει τη ζήτηση μόνο
			// του, όταν το EstatePrime δώσει endpoint ενημέρωσης.
			request_id: requestId,
			contact_id: contactId || (found.contact?.id ?? "") + "",
			// Χωριστά από το request_id: αυτό είπε ο πελάτης, εκείνο το
			// βρήκαμε εμείς. Γεμίζει μόνο όταν η επαφή έχει ΑΚΡΙΒΩΣ μία
			// ενεργή ζήτηση, δηλαδή όταν δεν υπάρχει τίποτα να διαλέξεις.
			resolved_request_id: found.requests.length === 1 ? String(found.requests[0].id) : "",
			active_requests: found.requests.length,
			contact_name: found.contact?.name || "",
			reason,
			comment,
			page,
			received_at: new Date().toISOString(),
		}),
	});
	if (!fwd.ok) {
		console.error(`request-closed: Make webhook forward failed (HTTP ${fwd.status})`);
		return rcJson({ success: false, error: "forward_failed" }, 502);
	}
	// One structured line per confirmation — queryable in Observability
	// next to the /go email_click events, so «άνοιξε το email → πάτησε
	// τον σύνδεσμο → επιβεβαίωσε» is reconstructable without the CRM.
	console.log(JSON.stringify({
		event: "request_closed",
		request_id: requestId,
		contact_id: contactId || found.contact?.id || "",
		active_requests: found.requests.length,
		lookup: found.note || "ok",
		reason,
		ts: new Date().toISOString(),
	}));
	return rcJson({ success: true }, 200);
}

function rcJson(obj, status, extraHeaders) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
	});
}

/* Το «?e=» μπορεί να είναι email ή σκέτο όνομα (το κουβαλάει το batch
   page). Μόνο το email ψάχνεται στο CRM. */
function refFromPage(page) {
	const q = page.indexOf("?");
	if (q < 0) return "";
	try {
		return new URLSearchParams(page.slice(q + 1)).get("e") || "";
	} catch {
		return "";
	}
}

function emailOf(ref) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ref) ? ref.toLowerCase() : "";
}

/* --------------------------------------------------------- CRM lookup */

/* Ποια επαφή είναι, και τι ενεργές ζητήσεις κρατάει ανοιχτές. Ό,τι
   αποτύχει γυρίζει ως `note` και μπαίνει στο email σαν γραμμή, ώστε η
   γραμματεία να ξέρει αν κοιτάει «καμία ζήτηση» ή «δεν ρωτήθηκε». */
export async function lookupClient(env, { contactId, email }) {
	const empty = { contact: null, requests: [], note: "" };
	if (!contactId && !email) return { ...empty, note: "χωρίς αναγνωριστικό στον σύνδεσμο" };

	try {
		return await withTimeout(lookupNow(env, { contactId, email }), LOOKUP_TIMEOUT_MS);
	} catch (err) {
		console.warn("request-closed: CRM lookup failed:", String(err));
		return { ...empty, note: "δεν απάντησε το CRM" };
	}
}

async function lookupNow(env, { contactId, email }) {
	const { base, headers } = apiConfig(env);
	const get = async (path) => {
		const res = await fetch(base + path, { headers });
		if (!res.ok) throw new Error(`EstatePrime ${res.status} on ${path}`);
		return res.json();
	};

	const contact = contactId
		? await contactById(get, contactId)
		: await contactByEmail(get, email);
	if (!contact) {
		return { contact: null, requests: [], note: "δεν βρέθηκε επαφή" };
	}

	const requests = (await activeRequests(get)).filter((r) => (r.contacts || []).some((c) => String(c) === String(contact.id)));
	const withAreas = await withAreaNames(get, requests);
	return { contact, requests: withAreas, note: "" };
}

async function contactById(get, id) {
	const raw = (await get(`/contacts/${encodeURIComponent(id)}`))?.data;
	// Άγνωστο id δεν δίνει 404: το EstatePrime απαντά 200 με data: []
	// (τεκμηριωμένο στο docs/estateprime-api.md).
	if (!raw || Array.isArray(raw) || raw.id == null) return null;
	return contactEntry(raw);
}

/* Το ?search= πιάνει τηλέφωνο/email/ονοματεπώνυμο (επιβεβαιωμένο από την
   EstatePrime). Κρατάμε μόνο ακριβές ταίριασμα email: ένα «περίπου»
   αποτέλεσμα θα έστελνε τη γραμματεία να κλείσει τη ζήτηση άλλου. */
async function contactByEmail(get, email) {
	if (!email) return null;
	const rows = (await get(`/contacts?search=${encodeURIComponent(email)}`))?.data || [];
	const hit = rows.find((r) => (r.emails || []).some((e) => String(e.email || "").toLowerCase() === email));
	return hit ? contactEntry(hit) : null;
}

function contactEntry(raw) {
	return {
		id: raw.id,
		name: raw.is_company && raw.company_name
			? raw.company_name
			: [raw.first_name, raw.last_name].filter(Boolean).join(" ").trim() || `Επαφή ${raw.id}`,
		phone: (raw.phones || []).map((p) => p.number).filter(Boolean)[0] || "",
		email: (raw.emails || []).map((e) => e.email).filter(Boolean)[0] || "",
	};
}

/* status 1 = Ενεργή. Δεν υπάρχει φίλτρο ανά επαφή στο public API, οπότε
   κατεβαίνουν όλες (5 σελίδες σήμερα) και φιλτράρονται εδώ. Η πρώτη
   σελίδα λέει πόσες είναι, οι υπόλοιπες φεύγουν παράλληλα. */
async function activeRequests(get) {
	const first = await get("/requests?page=1");
	const rows = [...(first.data || [])];
	const pages = Math.min(first.total_pages || 1, MAX_PAGES);
	if (pages > 1) {
		const rest = await Promise.all(
			Array.from({ length: pages - 1 }, (_, i) => get(`/requests?page=${i + 2}`)),
		);
		for (const body of rest) rows.push(...(body.data || []));
	}
	return rows.filter((r) => r.status === 1);
}

/* Οι ζητήσεις κουβαλούν area ids, όχι ονόματα. Τα ονόματα είναι το μόνο
   κομμάτι των κριτηρίων που διαβάζεται με μια ματιά («Ανάληψη» αντί για
   «499123»), οπότε αξίζουν τις λίγες κλήσεις. */
async function withAreaNames(get, requests) {
	const ids = [];
	for (const r of requests) {
		for (const loc of r.locations || []) {
			const id = loc.area_level3 || loc.area_level2 || loc.area_level1;
			if (id && !ids.includes(id)) ids.push(id);
		}
	}
	const names = new Map();
	await Promise.all(ids.slice(0, MAX_LOCATION_LOOKUPS).map(async (id) => {
		try {
			const d = (await get(`/locations/${id}`))?.data;
			if (d?.name_el) names.set(id, d.name_el);
		} catch {
			/* μια περιοχή που δεν λύθηκε απλώς δεν γράφεται */
		}
	}));
	return requests.map((r) => ({
		...r,
		areas: (r.locations || [])
			.map((loc) => names.get(loc.area_level3 || loc.area_level2 || loc.area_level1))
			.filter(Boolean),
	}));
}

function withTimeout(promise, ms) {
	return Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
	]);
}

/* -------------------------------------------------------------- email */

const AVAIL = { sale: "Πώληση", rent: "Ενοικίαση", auction: "Πλειστηριασμός", shortterm: "Βραχυχρόνια" };
const CATEG = { residential: "Κατοικία", commercial: "Επαγγελματικό", land: "Γη", other: "Άλλο" };

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// €100.000, τελεία για χιλιάδες όπως σε κάθε ελληνική σελίδα του site.
const euro = (n) => "€" + String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

function criteriaLine(r) {
	const bits = [CATEG[r.category] || r.category, AVAIL[r.availability] || r.availability];
	if (r.price_max) bits.push("έως " + euro(r.price_max));
	else if (r.price_min) bits.push("από " + euro(r.price_min));
	if (r.size_min || r.size_max) {
		bits.push(`${r.size_min || ""}${r.size_min && r.size_max ? "-" : ""}${r.size_max || "+"} τ.μ.`);
	}
	if (r.areas?.length) bits.push(r.areas.join(", "));
	return bits.filter(Boolean).join(" · ");
}

function athensStamp(d) {
	try {
		return new Intl.DateTimeFormat("el-GR", {
			timeZone: "Europe/Athens",
			day: "2-digit", month: "2-digit", year: "numeric",
			hour: "2-digit", minute: "2-digit", hour12: false,
		}).format(d).replace(", ", " ");
	} catch {
		return d.toISOString().slice(0, 16).replace("T", " ");
	}
}

export function buildEmail(env, { requestId, contactId, reason, comment, clientRef, receivedAt, found }) {
	const crm = `https://${env.ESTATEPRIME_SUBDOMAIN}.estateprime.gr`;
	const contact = found.contact;
	const requests = found.requests;

	const row = (label, value) => `<tr><td style="color:#777777; width:130px; padding:3px 0; vertical-align:top;">${label}</td><td style="padding:3px 0;">${value}</td></tr>`;

	// Το τηλέφωνο μπαίνει ως tel:, ώστε από το κινητό η γραμματεία να παίρνει
	// τον πελάτη με ένα άγγιγμα, χωρίς να ανοίξει καν το CRM.
	// normPhone δέχεται μόνο ελληνικά νούμερα· ένα ξένο (ή ό,τι δεν
	// αναγνωρίστηκε) μπαίνει όπως το γράφει το CRM, χωρίς να του κολλήσει
	// λάθος κωδικός χώρας.
	const digitsPhone = normPhone(contact?.phone);
	const telHref = digitsPhone ? `+30${digitsPhone}` : String(contact?.phone || "").replace(/[^\d+]/g, "");
	const phoneCell = contact?.phone
		? `<a href="tel:${esc(telHref)}" style="color:#777777; text-decoration:none;">${esc(digitsPhone ? fmtPhone(digitsPhone) : contact.phone)}</a>`
		: "";
	// Όταν ο σύνδεσμος κουβαλούσε contact id αλλά το CRM δεν απάντησε, το id
	// είναι ακόμη αρκετό για σύνδεσμο: καλύτερα «Επαφή 274» που ανοίγει, παρά
	// σκέτο κείμενο.
	const contactHref = contact ? `${crm}/contacts/view/${contact.id}` : contactId ? `${crm}/contacts/view/${contactId}` : "";
	const contactCell = contact
		? `<a href="${contactHref}" style="color:#FF1462; font-weight:bold; text-decoration:none;">${esc(contact.name)}</a>`
			+ (phoneCell || contact.email
				? `<div style="color:#777777; font-size:13px;">${[phoneCell, esc(contact.email)].filter(Boolean).join(" · ")}</div>`
				: "")
		: (contactId
			? `<a href="${contactHref}" style="color:#FF1462; font-weight:bold; text-decoration:none;">Επαφή ${esc(contactId)}</a>`
			: `<span style="font-weight:bold;">${esc(clientRef || "—")}</span>`)
			+ `<div style="color:#777777; font-size:13px;">${esc(clientRef
				? `${found.note || "δεν βρέθηκε επαφή"}, ψάξτε την στο CRM με αυτό το email`
				: found.note || "δεν ήρθε αναγνωριστικό πελάτη από τον σύνδεσμο")}</div>`;

	// Οι ενεργές ζητήσεις της επαφής. Σχεδόν πάντα μία, οπότε αυτή είναι
	// η απάντηση στο «ποια να κλείσω»· όταν είναι πολλές, ο λόγος και το
	// σχόλιο του πελάτη λένε ποια.
	const requestsBlock = !contact
		? ""
		: requests.length
			? `<tr><td style="padding:4px 20px 0 20px;">
<div style="font-size:12px; font-weight:bold; color:#777777; letter-spacing:1px; padding-bottom:6px;">${requests.length === 1 ? "ΕΝΕΡΓΗ ΖΗΤΗΣΗ" : `ΕΝΕΡΓΕΣ ΖΗΤΗΣΕΙΣ (${requests.length})`}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6e8ec; border-radius:6px;">
${requests.map((r) => `<tr><td style="padding:9px 12px; border-bottom:1px solid #f4f5f7; font-size:13px; line-height:1.55; color:#16233A;">
<a href="${crm}/requests/view/${r.id}" style="color:#FF1462; font-weight:bold; text-decoration:none;">Ζήτηση ${r.id}</a>${String(r.id) === String(requestId) ? ' <span style="color:#777777;">(αυτή έλεγε ο σύνδεσμος)</span>' : ""}
<div style="color:#16233A;">${esc(criteriaLine(r))}</div>
</td></tr>`).join("")}
</table>
</td></tr>`
			: `<tr><td style="padding:4px 20px 0 20px; font-size:13px; color:#777777;">Η επαφή δεν έχει καμία ενεργή ζήτηση, μάλλον έχει ήδη κλείσει.</td></tr>`;

	// Το κουμπί πάει εκεί που υπάρχει κάτι να πατηθεί: στη μία ζήτηση αν
	// είναι μία, αλλιώς στην επαφή (από εκεί φαίνονται όλες).
	const primary = requests.length === 1
		? { href: `${crm}/requests/view/${requests[0].id}`, label: "Άνοιγμα ζήτησης στο CRM" }
		: requestId && !requests.length
			? { href: `${crm}/requests/view/${requestId}`, label: "Άνοιγμα ζήτησης στο CRM" }
			: contactHref
				? { href: contactHref, label: "Άνοιγμα επαφής στο CRM" }
				: null;

	const html = `<!DOCTYPE html>
<html lang="el">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background:#f4f5f7; font-family:Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7; padding:16px 0;">
<tr><td align="center">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px; width:100%; background:#ffffff; border-radius:8px; overflow:hidden;">

<tr><td style="background:#16233A; padding:12px 20px; color:#ffffff; font-size:15px; font-weight:bold; letter-spacing:1px;">ΟΛΟΚΛΗΡΩΣΗ ΑΝΑΖΗΤΗΣΗΣ · ΚΛΕΙΣΤΕ ΤΗ ΖΗΤΗΣΗ</td></tr>
<tr><td style="height:3px; background:#FF1462;"></td></tr>

<tr><td style="padding:16px 20px 8px 20px; font-size:14px; line-height:1.7; color:#16233A;">
<p style="margin:0 0 12px 0;">Ο πελάτης πάτησε «σταματήστε τις προτάσεις» στη σελίδα /request-closed. Η ζήτηση <strong>δεν</strong> κλείνει αυτόματα, κλείστε τη στο CRM.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px; line-height:1.7; color:#16233A;">
${row("Επαφή", contactCell)}
${row("Λόγος", esc(reason || "—"))}
${row("Σχόλιο", comment ? esc(comment).replace(/\r?\n/g, "<br>") : "—")}
${row("Ημ/νία", esc(athensStamp(receivedAt)))}
</table>
</td></tr>

${requestsBlock}

${primary ? `<tr><td style="padding:14px 20px 18px 20px;">
<a href="${primary.href}" style="display:block; background:#FF1462; color:#ffffff; text-align:center; padding:14px; border-radius:6px; font-weight:bold; text-decoration:none; font-size:15px;">${primary.label}</a>
</td></tr>` : `<tr><td style="padding:14px 20px 18px 20px;"></td></tr>`}

</table>
</td></tr>
</table>
</body>
</html>`;

	const who = contact?.name || clientRef || "άγνωστη επαφή";
	return { subject: `ΟΛΟΚΛΗΡΩΣΗ ΑΝΑΖΗΤΗΣΗΣ · ${who}`, html };
}
