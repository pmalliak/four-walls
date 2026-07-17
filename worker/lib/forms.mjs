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

/* The Make scenario routes on this exact string, so it is a contract
   between each form's CONFIG.id and the scenario's filters — not free
   text. Adding a form means adding it here AND adding a router branch:
   an id with no branch is silently dropped by Make, a branch with no id
   is refused below, and neither failure is visible to the consultant.
   (katachorisi has no CONFIG; it sets `form` in its payload by hand.) */
const FORM_IDS = new Set(["anathesi", "ypodeixi", "apodeixi", "katachorisi"]);

/* A signed contract with the logo lands around 200-600 KB of base64. The
   cap is loose enough for a five-property υπόδειξη and still refuses a
   body that could only be a mistake or an attack. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;

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
		// Never echo Make's own error text back to the tablet — it can
		// carry account details. The full story goes to the logs.
		console.error(`forms: Make forward failed for ${form} (HTTP ${fwd.status})`);
		return json({ error: "forward_failed" }, 502);
	}
	return json({ ok: true });
}
