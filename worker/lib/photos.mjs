/* =====================================================================
   Four Walls — AI photo enhancement pipeline (forms.four-walls.gr)
   ---------------------------------------------------------------------
   A consultant opens forms/enhance.html, optionally picks a property
   from the CRM, ticks which edits they want (declutter, lighting, …),
   and uploads the listing photos. This module is the ingest half:

     POST /api/photos/init            create a batch, compose the AI
                                      prompt from the ticked options
     PUT  /api/photos/upload/<b>/<n>  stream one original into R2
     POST /api/photos/finalize/<b>    hand Make signed URLs + the prompt

   Make then pulls each original by its signed URL, runs it through
   Gemini ("Nano Banana"), drops originals + edited into a Google Drive
   folder, and emails info@ (cc panos, manos) with the Drive link and a
   link to the CRM property (or to create one, when left blank).

   WHY R2 IN THE MIDDLE: a listing shoot is 15-40 photos / 50-300 MB —
   far past what a Make webhook payload will swallow. The browser stages
   the full-res originals here (behind Access, so staff-only), and Make
   fetches them one at a time from:

     GET /api/photos/file/<b>/<name>?exp=&sig=

   That download route is reached by Make (a server with no Access
   cookie), so it lives on the apex host (no Access) and is guarded by a
   short-lived HMAC signature instead — same "the URL is the credential"
   idea as the Make webhooks, but expiring and per-object.

   Mirrors the browser→Worker→Make-secret pattern already used by
   worker/lib/forms.mjs and the /api/contact relay in worker/index.mjs.
   ===================================================================== */

import { json } from "./access.mjs";

/* ------------------------------------------------------------ limits */

const MAX_FILES = 60;                       // a generous single-shoot cap
const MAX_FILE_BYTES = 30 * 1024 * 1024;    // 30 MB per original
const SIGNED_URL_TTL = 6 * 3600;            // Make must fetch within 6 h
const ALLOWED_MIME = new Set([
	"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
]);
const EXT_FOR_MIME = {
	"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
	"image/heic": "heic", "image/heif": "heif",
};

/* -------------------------------------------------- prompt composition

   The form sends OPTION KEYS, never prompt text — the mapping stays here
   (version-controlled, reviewable) instead of being hand-typed into a
   Make module. Two options change what the buyer sees as the property's
   true condition, so they are OFF by default in the form AND actively
   clamped here: when «repair damage» is off we tell the model to PRESERVE
   every defect, so the default can never quietly hide a real fault. */

const SAFE_FRAGMENTS = {
	declutter:
		"Remove clutter and personal items — dishes, food, cables, chargers, laundry, shoes, toiletries, bins, fridge magnets, loose papers and small objects on counters, tables, beds and floors. Tidy and neatly arrange whatever furniture and textiles remain: straighten cushions, make beds, align chairs.",
	lighting:
		"Improve exposure and colour: brighten the scene so it reads clean and airy, correct white balance to neutral, gently recover detail in blown-out windows and dark shadows, and keep colour natural and realistic — never oversaturated.",
	straighten:
		"Correct the geometry: level the horizon and straighten vertical lines (walls, door frames) to remove camera tilt and keystoning.",
	sky:
		"Where sky is visible through a window or in an exterior view, replace a dull or overcast sky with a clear, natural blue sky with soft clouds, keeping the building's exposure consistent with it.",
	remove_people:
		"Remove any people and pets from the scene, and remove the photographer's reflection from mirrors, windows and glossy surfaces.",
};

const KNOWN_OPTIONS = new Set([
	...Object.keys(SAFE_FRAGMENTS), "repair_damage", "virtual_staging",
]);

function composePrompt(options) {
	const on = new Set(options);
	const lines = [
		"You are a professional real-estate photo editor preparing this photograph for a property listing.",
		"Apply only the edits listed below. Keep the result fully photorealistic, keep the exact same framing and aspect ratio, and output the entire scene.",
	];

	for (const key of Object.keys(SAFE_FRAGMENTS)) {
		if (on.has(key)) lines.push("- " + SAFE_FRAGMENTS[key]);
	}

	// Damage — the honesty clamp. Off (the default) must actively preserve.
	lines.push(on.has("repair_damage")
		? "- Repair visible surface damage: fill cracks, remove stains and water marks, and touch up peeling or scuffed paint so walls and surfaces look sound and freshly maintained."
		: "- Preserve ALL visible damage exactly as it is: cracks, stains, water marks, peeling paint, scuffs and wear must remain clearly visible and unaltered. Do not hide or repair any defect.");

	// Staging — off (the default) must add nothing.
	lines.push(on.has("virtual_staging")
		? "- If a room is empty or sparsely furnished, add tasteful, realistic, appropriately-scaled furniture and decor suited to the room type, without misrepresenting the room's true size or layout."
		: "- Do not add any furniture, appliances or decorative objects that are not already physically present in the photo.");

	lines.push(
		"HARD RULES: never add, remove, resize or relocate any permanent architectural feature — walls, doors, windows, floors, ceilings, stairs, built-in cabinetry — and never alter the view seen through windows. The edited photo must not misrepresent the property.",
	);
	return lines.join("\n");
}

/* ------------------------------------------------------ signed URLs */

function b64url(bytes) {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(env, message) {
	const key = await crypto.subtle.importKey(
		"raw", new TextEncoder().encode(env.PHOTO_SIGN_KEY),
		{ name: "HMAC", hash: "SHA-256" }, false, ["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return b64url(new Uint8Array(sig));
}

async function signedFileUrl(env, origin, batchId, name) {
	const exp = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL;
	const sig = await hmac(env, `${batchId}/${name}\n${exp}`);
	return `${origin}/api/photos/file/${batchId}/${encodeURIComponent(name)}?exp=${exp}&sig=${sig}`;
}

/* Constant-ish time compare — the batch id is already unguessable, but no
   reason to leak signature bytes through early-return timing. */
function safeEqual(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/* --------------------------------------------------------- helpers */

function newBatchId() {
	const b = crypto.getRandomValues(new Uint8Array(16));
	return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const isBatchId = (s) => /^[0-9a-f]{32}$/.test(s);

function sanitizeName(name, mime) {
	let base = String(name || "photo").split(/[\\/]/).pop().slice(0, 80);
	base = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "photo";
	if (!/\.[A-Za-z0-9]+$/.test(base)) base += "." + (EXT_FOR_MIME[mime] || "jpg");
	return base;
}

/* CRM/site links the email needs. The back-office paths follow EstatePrime's
   `/<resource>/view/<id>` + `/<resource>/form` UI scheme (docs/estateprime-
   crm-ui.md: /requests/view/{id}, /requests/form) applied to the `listings`
   resource. TODO(estateprime): confirm /listings/view + /listings/form open
   correctly (some edit deep-links there redirect to the list) and fix HERE. */
function propertyLinks(env, property) {
	const site = "https://four-walls.gr";
	const crmBase = `https://${env.ESTATEPRIME_SUBDOMAIN || "fourwalls"}.estateprime.gr`;
	if (!property || !property.id) {
		return { public: null, crm: null, crmCreate: `${crmBase}/listings/form` };
	}
	return {
		public: property.code ? `${site}/properties/${encodeURIComponent(property.code)}` : null,
		crm: `${crmBase}/listings/view/${encodeURIComponent(property.id)}`,
		crmCreate: null,
	};
}

/* ----------------------------------------------------- API routing

   Every route here is already past the Access gate (see worker/index.mjs)
   — the caller is a named consultant. `email` is who Access says they are
   (null only on a local `wrangler dev` run). */

export async function handlePhotoApi(request, env, url, email) {
	if (!env.PHOTO_BUCKET) {
		console.error("photos: PHOTO_BUCKET (R2) not bound");
		return json({ error: "not_configured" }, 503);
	}
	const parts = url.pathname.split("/").filter(Boolean); // api photos <action> ...

	if (request.method === "POST" && parts[2] === "init") {
		return initBatch(request, env, url, email);
	}
	if (request.method === "PUT" && parts[2] === "upload") {
		return uploadOne(request, env, parts[3], parts[4]);
	}
	if (request.method === "POST" && parts[2] === "finalize") {
		return finalizeBatch(request, env, url, parts[3]);
	}
	return json({ error: "not_found" }, 404);
}

async function initBatch(request, env, url, email) {
	let body;
	try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }

	const count = Number(body?.count || 0);
	if (!Number.isInteger(count) || count < 1 || count > MAX_FILES) {
		return json({ error: "bad_count", max: MAX_FILES }, 400);
	}

	const options = Array.isArray(body?.options)
		? [...new Set(body.options.filter((o) => KNOWN_OPTIONS.has(o)))]
		: [];

	// property: keep only the fields we trust and the email needs. A blank
	// property is legitimate — the email then links to "create a listing".
	let property = null;
	if (body?.property && body.property.id) {
		property = {
			id: String(body.property.id).slice(0, 40),
			code: body.property.code ? String(body.property.code).slice(0, 40) : null,
			address: body.property.address ? String(body.property.address).slice(0, 200) : null,
			area: body.property.area ? String(body.property.area).slice(0, 120) : null,
		};
	}

	const batchId = newBatchId();
	const meta = {
		batch_id: batchId,
		created_at: new Date().toISOString(),
		submitted_by: email || null,
		property,
		links: propertyLinks(env, property),
		options,
		prompt: composePrompt(options),
		count,
	};
	await env.PHOTO_BUCKET.put(`photos/${batchId}/meta.json`, JSON.stringify(meta), {
		httpMetadata: { contentType: "application/json" },
	});
	return json({ ok: true, batch_id: batchId });
}

async function uploadOne(request, env, batchId, seqRaw) {
	if (!isBatchId(batchId)) return json({ error: "bad_batch" }, 400);
	const seq = Number(seqRaw);
	if (!Number.isInteger(seq) || seq < 0 || seq >= MAX_FILES) return json({ error: "bad_seq" }, 400);

	// Only a batch that init created can be written to (also blocks stray PUTs).
	if (!(await env.PHOTO_BUCKET.head(`photos/${batchId}/meta.json`))) {
		return json({ error: "unknown_batch" }, 404);
	}

	const mime = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
	if (!ALLOWED_MIME.has(mime)) return json({ error: "bad_type", got: mime }, 415);
	if (Number(request.headers.get("Content-Length") || 0) > MAX_FILE_BYTES) {
		return json({ error: "too_large", max: MAX_FILE_BYTES }, 413);
	}

	const bytes = await request.arrayBuffer();
	if (bytes.byteLength === 0) return json({ error: "empty" }, 400);
	if (bytes.byteLength > MAX_FILE_BYTES) return json({ error: "too_large", max: MAX_FILE_BYTES }, 413);

	const safe = sanitizeName(request.headers.get("X-Filename"), mime);
	const name = String(seq).padStart(3, "0") + "-" + safe;
	await env.PHOTO_BUCKET.put(`photos/${batchId}/orig/${name}`, bytes, {
		httpMetadata: { contentType: mime },
	});
	return json({ ok: true, name });
}

async function finalizeBatch(request, env, url, batchId) {
	if (!isBatchId(batchId)) return json({ error: "bad_batch" }, 400);
	if (!env.MAKE_PHOTO_WEBHOOK) {
		console.error("photos: MAKE_PHOTO_WEBHOOK secret not configured");
		return json({ error: "not_configured" }, 503);
	}

	const metaObj = await env.PHOTO_BUCKET.get(`photos/${batchId}/meta.json`);
	if (!metaObj) return json({ error: "unknown_batch" }, 404);
	const meta = await metaObj.json();

	// Enumerate what actually landed (the browser may have dropped a file).
	const objects = [];
	let cursor;
	do {
		const page = await env.PHOTO_BUCKET.list({ prefix: `photos/${batchId}/orig/`, cursor });
		objects.push(...page.objects);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	if (!objects.length) return json({ error: "no_photos" }, 400);

	// Signed URLs point at the apex (no Access) so Make can fetch them; on a
	// local dev run there is no Make, so the request origin is fine.
	const origin = url.hostname === "localhost" || url.hostname === "127.0.0.1"
		? url.origin
		: `https://${url.hostname.replace(/^forms\./, "")}`;

	const photos = [];
	for (const o of objects.sort((a, b) => (a.key < b.key ? -1 : 1))) {
		const name = o.key.slice(`photos/${batchId}/orig/`.length);
		photos.push({
			name,
			content_type: o.httpMetadata?.contentType || "image/jpeg",
			url: await signedFileUrl(env, origin, batchId, name),
		});
	}

	const payload = {
		batch_id: batchId,
		submitted_by: meta.submitted_by,
		submitted_at: new Date().toISOString(),
		has_property: !!meta.property,
		property: meta.property,
		links: meta.links,
		options: meta.options,
		prompt: meta.prompt,
		count: photos.length,
		photos,
	};

	const fwd = await fetch(env.MAKE_PHOTO_WEBHOOK, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(env.MAKE_PHOTO_APIKEY ? { "x-make-apikey": env.MAKE_PHOTO_APIKEY } : {}),
		},
		body: JSON.stringify(payload),
	});
	if (!fwd.ok) {
		console.error(`photos: Make forward failed for ${batchId} (HTTP ${fwd.status})`);
		return json({ error: "forward_failed" }, 502);
	}
	console.log(JSON.stringify({
		event: "photo_batch", batch_id: batchId, count: photos.length,
		has_property: !!meta.property, options: meta.options, by: meta.submitted_by,
		ts: new Date().toISOString(),
	}));
	return json({ ok: true, count: photos.length });
}

/* --------------------------------------------------- signed download

   Reached by Make on the apex host (no Access cookie). Guarded by the
   HMAC signature + expiry minted in finalizeBatch — nothing else. Serves
   ONLY originals under this batch's orig/ prefix; the signed name carries
   no slash, so it cannot walk out to meta.json or another batch. */
export async function servePhotoFile(request, env, url) {
	if (!env.PHOTO_BUCKET || !env.PHOTO_SIGN_KEY) {
		return new Response("Not configured", { status: 503 });
	}
	const m = url.pathname.match(/^\/api\/photos\/file\/([0-9a-f]{32})\/([^/]+)$/);
	if (!m) return new Response("Not Found", { status: 404 });
	const batchId = m[1];
	const name = decodeURIComponent(m[2]);

	const exp = Number(url.searchParams.get("exp") || 0);
	const sig = url.searchParams.get("sig") || "";
	if (!exp || exp < Math.floor(Date.now() / 1000)) {
		return new Response("Link expired", { status: 410 });
	}
	const expected = await hmac(env, `${batchId}/${name}\n${exp}`);
	if (!safeEqual(sig, expected)) return new Response("Forbidden", { status: 403 });

	const obj = await env.PHOTO_BUCKET.get(`photos/${batchId}/orig/${name}`);
	if (!obj) return new Response("Not Found", { status: 404 });
	return new Response(obj.body, {
		headers: {
			"Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
			"Content-Length": String(obj.size),
			// Client photos: keep proxies/CDN from retaining a copy.
			"Cache-Control": "private, no-store",
		},
	});
}
