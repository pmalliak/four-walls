/* =====================================================================
   Four Walls — form submission for the Έντυπα PWA (forms.four-walls.gr)
   ---------------------------------------------------------------------
   The tablet POSTs a filled, signed form here; we relay it to the Make
   scenario that mails the PDF out (and, once EstatePrime ships a contact
   update endpoint, writes back to the CRM).

   WHY THIS EXISTS instead of the browser calling Make directly: a Make
   hook URL is a bearer credential — anyone holding it can inject a fake
   signed contract into the pipeline. Client-side it lives in the page
   source and in git, which is exactly how katachorisi.html's hook and
   API key leaked. Here both are Worker secrets.

   It also lets us stamp WHO submitted. The caller has already passed the
   Access gate, so the JWT names the consultant; Make receives it as
   submitted_by, which the CRM write-back needs anyway.
   ===================================================================== */

import { json } from "./access.mjs";
import { renderDocPdf } from "./pdfrender.mjs";
import { VALUATION_REQ_PREFIX, VALUATION_TTL_SECONDS, markValuationSent } from "./valuation.mjs";
import { logSent } from "./sent-log.mjs";

/* The Make scenario routes on this exact string, so it is a contract
   between each form's CONFIG.id and the scenario's filters — not free
   text. Adding a form means adding it here AND adding a router branch:
   an id with no branch is silently dropped by Make, a branch with no id
   is refused below, and neither failure is visible to the consultant.
   (katachorisi has no CONFIG; it sets `form` in its payload by hand, and
   prosfora carries no document at all: no signatures, no PDF, just an
   internal message to info@ that a client made an offer.) */
const FORM_IDS = new Set(["anathesi", "ypodeixi", "apodeixi", "katachorisi", "prosfora", "ektimisi"]);

/* A signed contract with the logo lands around 200-600 KB of base64. The
   cap is loose enough for a five-property υπόδειξη and still refuses a
   body that could only be a mistake or an attack. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/* Ένα έντυπο φεύγει μία φορά.

   Το tablet στέλνει μέσα από το outbox: αν η απάντηση χαθεί στον δρόμο
   (κλείδωμα οθόνης, Wi-Fi που γίνεται 4G, στιγμιαίο κενό σήματος) η
   συσκευή το θεωρεί αποτυχία και ξαναστέλνει κάτι που είχε ήδη φτάσει.
   Έτσι έφυγε διπλή εκτίμηση στις 2026-07-31, και στην ανάθεση το ίδιο
   θα σήμαινε δεύτερο email και στον πελάτη.

   Το κλειδί ΔΕΝ έρχεται από τον client: ένα δεύτερο πάτημα φτιάχνει
   καινούργιο id και θα περνούσε. Υπογράφουμε το ίδιο το περιεχόμενο, και
   αφήνουμε απ' έξω ό,τι αλλάζει χωρίς να αλλάζει το έντυπο: η ώρα του
   tap, το PDF (το html2pdf γράφει CreationDate, άρα άλλα bytes σε κάθε
   δημιουργία) και το `ref` της καταχώρισης, που είναι κι αυτό ρολόι.

   Παράθυρο 48 ωρών. Ξεκίνησε στις 6, όσο χρειάζονταν τα retries, αλλά η
   εκτίμηση της 31/07 έφυγε δεύτερη φορά δύο μέρες μετά, από οθόνη που
   είχε μείνει ανοιχτή: μια αποστολή που ο σύμβουλος δεν θυμάται πια δεν
   είναι σκόπιμη επαναποστολή. Το παράθυρο δεν κλειδώνει τίποτα, ρωτάει:
   η φόρμα μαθαίνει ΠΟΤΕ είχε σταλεί και, αν όντως το θέλει, ξαναστέλνει
   με force_resend. Το ίδιο το flag μένει έξω από το hash, ώστε να μην
   είναι ένα «καινούργιο» έντυπο που θα περνούσε ούτως ή άλλως. */
const DEDUPE_PREFIX = "forms:sent:";
const DEDUPE_SECONDS = 48 * 60 * 60;
const DEDUPE_SKIP = new Set([
	"submitted_at", "submitted_by", "received_at", "ref", "force_resend",
	"pdf_base64", "pdf_filename", "pdf_mime", "pdf_rendered", "doc_html",
]);

async function submissionHash(payload) {
	// Σταθερή σειρά κλειδιών, ώστε το ίδιο έντυπο να δίνει το ίδιο hash
	// ακόμα κι αν μια φόρμα αλλάξει τη σειρά των πεδίων της.
	const stable = (v) => {
		if (v === null || typeof v !== "object") return v;
		if (Array.isArray(v)) return v.map(stable);
		const out = {};
		for (const k of Object.keys(v).sort()) out[k] = stable(v[k]);
		return out;
	};
	const subset = {};
	for (const k of Object.keys(payload)) {
		if (!DEDUPE_SKIP.has(k)) subset[k] = payload[k];
	}
	const bytes = new TextEncoder().encode(JSON.stringify(stable(subset)));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleFormSubmit(request, env, email) {
	if (request.method !== "POST") {
		return json({ error: "method_not_allowed" }, 405);
	}
	if (!env.MAKE_FORMS_WEBHOOK) {
		console.error("forms: MAKE_FORMS_WEBHOOK secret not configured");
		return json({ error: "not_configured" }, 503);
	}
	if (Number(request.headers.get("Content-Length") || 0) > MAX_BODY_BYTES) {
		return json({ error: "too_large" }, 413);
	}

	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: "bad_request" }, 400);
	}

	const form = String(body?.form || "");
	if (!FORM_IDS.has(form)) {
		// An unknown id would fall through every router filter in Make and
		// vanish with no error — the consultant would see "sent" and the
		// paperwork would never arrive. Refuse it here instead.
		console.warn(`forms: rejected unknown form id "${form.slice(0, 40)}"`);
		return json({ error: "unknown_form" }, 400);
	}

	const payload = {
		...body,
		form,
		// Access has already proved who this is — the browser gets no say,
		// so this deliberately overwrites anything the client sent.
		submitted_by: email,
		// submitted_at comes off the tablet's clock, which can be wrong or
		// simply lying. Keep both: theirs for the document, ours for audit.
		received_at: new Date().toISOString(),
	};

	// TRIAL: swap the client's photographed PDF for a real-text one rendered
	// server-side from the same document HTML. Fail-open by design — any
	// problem keeps the client PDF, and PDF_RENDER="0" turns it all off.
	const docHtml = payload.doc_html;
	delete payload.doc_html; // Make never needs the raw HTML
	if (docHtml) {
		try {
			const b64 = await renderDocPdf(env, docHtml);
			if (b64) {
				payload.pdf_base64 = b64;
				payload.pdf_mime = "application/pdf";
				payload.pdf_rendered = "server"; // visible in Make for the trial
			}
		} catch (err) {
			console.warn(`forms: server PDF render failed, keeping client PDF: ${String(err)}`);
		}
	}

	// Εκτίμηση, σε δύο βήματα. Βήμα 1 (χωρίς valuation_ref): το payload
	// παρκάρει στο KV με τυχαίο ref και γυρίζουμε στη φόρμα ΧΩΡΙΣ να
	// ειδοποιηθεί το Make· η φόρμα τραβάει το report από το
	// /api/valuation και το δείχνει επιτόπου. Βήμα 2 (με valuation_ref,
	// όταν πατηθεί «Αποστολή στο info@»): πέφτουμε στο fetch παρακάτω
	// και το Make στέλνει το ήδη κασαρισμένο report με email.
	if (form === "ektimisi") {
		const clientRef = String(payload.valuation_ref || "");
		if (!/^[0-9a-f-]{16,64}$/i.test(clientRef)) {
			const ref = crypto.randomUUID();
			payload.valuation_ref = ref;
			await env.LISTINGS_KV.put(VALUATION_REQ_PREFIX + ref, JSON.stringify(payload), {
				expirationTtl: VALUATION_TTL_SECONDS,
			});
			return json({ ok: true, valuation_ref: ref });
		}
	}

	// Το ίδιο έντυπο δεύτερη φορά μέσα στο παράθυρο: απαντάμε «εντάξει»
	// χωρίς να ειδοποιήσουμε το Make, και το δηλώνουμε ώστε η φόρμα να μη
	// γράψει «στάλθηκε» για email που δεν έφυγε. Μαζί γυρίζει και ΠΟΤΕ
	// είχε σταλεί: με παράθυρο 48 ωρών το «είχε ήδη σταλεί» χωρίς ώρα δεν
	// λέει τίποτα στον σύμβουλο, και είναι αυτό ακριβώς που κρίνει αν θα
	// ζητήσει επαναποστολή. Fail-open: αν το KV γκρινιάξει, προτιμότερο
	// διπλό έντυπο από χαμένο.
	const forced = payload.force_resend === true;
	let dedupeKey = null;
	let hash = null;
	try {
		hash = await submissionHash(payload);
		dedupeKey = DEDUPE_PREFIX + hash;
		const prevSentAt = await env.LISTINGS_KV.get(dedupeKey);
		if (prevSentAt && !forced) {
			console.log(`forms: duplicate ${form} suppressed (first sent ${prevSentAt})`);
			return json({ ok: true, duplicate: true, sent_at: prevSentAt });
		}
		if (prevSentAt) console.log(`forms: ${form} re-sent on purpose (first sent ${prevSentAt})`);
		// Γράφεται ΠΡΙΝ την προώθηση: δύο σχεδόν ταυτόχρονες προσπάθειες
		// (tap και flush μαζί) δεν πρέπει να φύγουν και οι δύο.
		await env.LISTINGS_KV.put(dedupeKey, payload.received_at, { expirationTtl: DEDUPE_SECONDS });
	} catch (err) {
		dedupeKey = null;
		console.warn(`forms: dedupe unavailable, forwarding anyway: ${String(err)}`);
	}

	const fwd = await fetch(env.MAKE_FORMS_WEBHOOK, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			// Optional second factor. Turn on API-key auth for the hook in
			// the Make UI and `wrangler secret put MAKE_FORMS_APIKEY`;
			// until then the unguessable hook URL, held only as a Worker
			// secret, is the credential — same as MAKE_CONTACT_WEBHOOK.
			...(env.MAKE_FORMS_APIKEY ? { "x-make-apikey": env.MAKE_FORMS_APIKEY } : {}),
		},
		body: JSON.stringify(payload),
	});
	if (!fwd.ok) {
		// Το έντυπο δεν έφυγε: ξεκλείδωσε το hash, αλλιώς το retry του
		// outbox θα έπαιρνε «στάλθηκε» για κάτι που δεν στάλθηκε ποτέ.
		if (dedupeKey) await env.LISTINGS_KV.delete(dedupeKey).catch(() => {});
		// Never echo Make's own error text back to the tablet — it can
		// carry account details. The full story goes to the logs.
		console.error(`forms: Make forward failed for ${form} (HTTP ${fwd.status})`);
		return json({ error: "forward_failed" }, 502);
	}
	// Εφυγε. Μία γραμμή στο ημερολόγιο απεσταλμένων, ώστε ο φύλακας να
	// μπορεί να δει το πρωί αν κάποιος πελάτης έλαβε το ίδιο δύο φορές.
	await logSent(env, payload, hash);
	// Και, στην εκτίμηση, σήμανση πάνω στη ΓΡΑΜΜΗ ΤΗΣ: το ημερολόγιο
	// κρατά 40 μέρες και δεν ξέρει από ref, ενώ το «στάλθηκε, πότε και σε
	// ποιον» πρέπει να ζει όσο και η ίδια η εκτίμηση.
	if (form === "ektimisi") await markValuationSent(env, payload);
	return json({ ok: true });
}
