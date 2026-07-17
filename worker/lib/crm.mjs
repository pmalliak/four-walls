/* =====================================================================
   Four Walls — CRM read API for the Έντυπα PWA (forms.four-walls.gr)
   ---------------------------------------------------------------------
   Feeds the contact/property pickers in forms/: the consultant searches
   a client on the tablet and the form's fields autofill from the CRM.

   PRIVACY — this serves the client database (names, phones, ΑΦΜ, ΑΔΤ).
   Every route is gated by requireAccess() below and MUST stay that way.
   It fails closed: no Cloudflare Access config -> 503, never open.

   SHAPE OF THE CALLS (why it is only 3 requests, not 58)
     The list endpoint does NOT return custom_fields/tags/users — only
     GET /contacts/{id} does (reported to EstatePrime 2026-07-17). So
     rather than N+1 fetching every contact's custom fields up front:
       - index()  -> 2 list calls, just enough to search on (name/phone/
                     email). Cached in KV, small payload, searched
                     client-side on the tablet.
       - detail() -> 1 call, only for the contact the user actually taps.

   CONTACT FIELD MAP (verified live against the fourwalls account,
   2026-07-17 — see docs/estateprime-api.md):
     Ονοματεπώνυμο   first_name + last_name   (NOT full_name: that is
                                               "Επώνυμο Όνομα" and reads
                                               backwards in the contract)
     ΑΦΜ             vat_number      native
     Α.Δ.Τ.          id_number       native
     Πατρώνυμο       custom_fields[7]
     Κατοικία        custom_fields[8]
     ΑΔΤ ημ/νία      custom_fields[10]  already ISO YYYY-MM-DD
     ΑΔΤ αρχή        custom_fields[11]
   The native ΑΦΜ/ΑΔΤ pair is only editable in the CRM's contact EDIT
   form (missing from the create form) — that is a CRM quirk, not ours.
   Empty custom fields are omitted from the object entirely, so never
   assume a key exists.
   ===================================================================== */

import { apiConfig } from "./estateprime.mjs";

/* Custom-field ids, created by hand in the EstatePrime UI. These are
   positional: deleting and recreating a field in the CRM gives it a NEW
   id and silently breaks the mapping (ΑΦΜ was 12, then 13, before it
   went back to the native field). If a field ever reads empty for every
   contact, check GET /api/contacts/custom-fields first. */
const CF_PATRONYMO = "7";
const CF_KATOIKIA = "8";
const CF_ADT_DATE = "10";
const CF_ADT_AUTHORITY = "11";

const CONTACTS_KEY = "crm:contacts-index";
const LISTINGS_KEY = "crm:listings-index";
const INDEX_TTL = 900; // seconds a cached index counts as fresh
const MAX_PAGES = 50;

/* ---------------------------------------------------------------- auth */

/* Cloudflare Access sits in front of forms.four-walls.gr. It would be
   enough on its own IF the Worker were only reachable there — but
   workers_dev = true keeps a *.workers.dev URL alive for the CRM
   webhook, and that URL bypasses Access entirely. So the caller MUST
   also verify the JWT rather than trust the header's presence. */
export async function requireAccess(request, env, url) {
	if (isLocalDev(url, env)) return null; // local `wrangler dev` only

	const team = env.ACCESS_TEAM_DOMAIN; // e.g. fourwalls.cloudflareaccess.com
	const aud = env.ACCESS_AUD; // Application Audience tag from the Access app
	if (!team || !aud) {
		return json({ error: "Access not configured" }, 503);
	}
	const token =
		request.headers.get("Cf-Access-Jwt-Assertion") ||
		cookieValue(request.headers.get("Cookie"), "CF_Authorization");
	if (!token) return json({ error: "Unauthorized" }, 401);

	const payload = await verifyAccessJwt(token, team, aud);
	if (!payload) return json({ error: "Unauthorized" }, 401);
	return null; // authorised
}

/* `wrangler dev` reports the hostname from wrangler.toml's [routes]
   (four-walls.gr), NOT localhost — so the hostname alone cannot tell us
   we are running locally. Hence the explicit flag.

   CRM_DEV_BYPASS disables the Access gate on the client database. It
   lives in .dev.vars (gitignored) and must NEVER be added to
   wrangler.toml [vars] or set via `wrangler deploy` — that would publish
   every contact's name, phone, ΑΦΜ and ΑΔΤ to the open internet. */
export function isLocalDev(url, env) {
	if (env?.CRM_DEV_BYPASS === "1") return true;
	return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

function cookieValue(header, name) {
	if (!header) return null;
	for (const part of header.split(";")) {
		const [k, ...v] = part.trim().split("=");
		if (k === name) return v.join("=");
	}
	return null;
}

let jwksCache = null;
let jwksCachedAt = 0;

async function getJwks(team) {
	const now = Date.now();
	if (jwksCache && now - jwksCachedAt < 3600_000) return jwksCache;
	const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
	if (!res.ok) throw new Error(`Access certs ${res.status}`);
	jwksCache = await res.json();
	jwksCachedAt = now;
	return jwksCache;
}

export async function verifyAccessJwt(token, team, aud) {
	try {
		const [h, p, s] = token.split(".");
		if (!h || !p || !s) return null;

		const header = JSON.parse(b64urlToText(h));
		const payload = JSON.parse(b64urlToText(p));

		const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
		if (!auds.includes(aud)) return null;
		if (payload.iss !== `https://${team}`) return null;

		const now = Math.floor(Date.now() / 1000);
		if (typeof payload.exp === "number" && payload.exp < now) return null;
		if (typeof payload.nbf === "number" && payload.nbf > now + 60) return null;

		const jwks = await getJwks(team);
		const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
		if (!jwk) return null;

		const key = await crypto.subtle.importKey(
			"jwk",
			{ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		const ok = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			key,
			b64urlToBytes(s),
			new TextEncoder().encode(`${h}.${p}`),
		);
		return ok ? payload : null;
	} catch {
		return null;
	}
}

function b64urlToBytes(s) {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function b64urlToText(s) {
	return new TextDecoder().decode(b64urlToBytes(s));
}

/* ------------------------------------------------------- fetch + cache */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* EstatePrime rate-limits — it answered 429 on /contacts and /listings
   during development (2026-07-17). The threshold is undocumented, so
   back off and retry rather than failing the consultant's first tap.
   Asked EstatePrime for the actual limits. */
async function apiJson(base, headers, path, tries = 3) {
	let delay = 700;
	for (let attempt = 1; ; attempt++) {
		const res = await fetch(base + path, { headers });
		if (res.ok) return res.json();
		const retryable = res.status === 429 || res.status >= 500;
		if (!retryable || attempt >= tries) {
			throw new Error(`EstatePrime ${res.status} on ${path}`);
		}
		await sleep(delay);
		delay *= 2;
	}
}

/* Serve-stale-on-error. A rate-limited CRM must not leave the picker
   empty in front of a client: an index that is a few hours old still
   finds the right person far better than an error message does. The
   entry is stored WITHOUT expirationTtl on purpose — it is the fallback,
   so it must outlive its own freshness window. */
async function cachedIndex(env, key, build) {
	const cached = await env.LISTINGS_KV.get(key, "json");
	const fresh = cached && Date.now() - Date.parse(cached.generatedAt) < INDEX_TTL * 1000;
	if (fresh) return cached;

	try {
		const built = await build();
		await env.LISTINGS_KV.put(key, JSON.stringify(built));
		return built;
	} catch (err) {
		if (cached) {
			console.warn(`CRM refresh failed for ${key}, serving stale:`, String(err));
			return { ...cached, stale: true };
		}
		throw err; // nothing cached yet — the caller turns this into a 502
	}
}

/* ------------------------------------------------------------ contacts */

/* Search index: every contact, trimmed to what the searchbox matches on.
   58 contacts today -> a few KB, so the tablet downloads it once and
   filters locally (instant, and survives a bad 4G signal at a viewing). */
export async function contactsIndex(env) {
	return cachedIndex(env, CONTACTS_KEY, async () => {
		const rows = await fetchAllPages(env, "/contacts");
		return {
			generatedAt: new Date().toISOString(),
			count: rows.length,
			contacts: rows.map(indexEntry),
		};
	});
}

/* Walk a paginated list endpoint to the end. The ?page= guard mirrors
   the listings feed: if the API ever ignores the query param (the spec
   wants `page` in a GET body, which fetch cannot send), every request
   returns page 1 and this would loop forever. */
async function fetchAllPages(env, path) {
	const { base, headers } = apiConfig(env);
	const rows = [];
	let firstIdOfPrevPage = null;
	for (let page = 1; page <= MAX_PAGES; page++) {
		const body = await apiJson(base, headers, `${path}?page=${page}`);
		const items = body.data ?? [];
		if (!items.length) break;
		if (items[0]?.id != null && items[0].id === firstIdOfPrevPage) break;
		firstIdOfPrevPage = items[0]?.id ?? null;
		rows.push(...items);
		if (body.total_pages && page >= body.total_pages) break;
	}
	return rows;
}

function indexEntry(raw) {
	return {
		id: raw.id,
		name: displayName(raw),
		phone: raw.phones?.[0]?.number ?? null,
		email: raw.emails?.[0]?.email ?? null,
		isLead: !!raw.is_lead,
	};
}

/* The full record for the one contact the consultant tapped, mapped to
   the form's data-k keys so the client just assigns them across. */
export async function contactDetail(env, id) {
	const { base, headers } = apiConfig(env);
	const raw = (await apiJson(base, headers, `/contacts/${encodeURIComponent(id)}`))?.data;
	// An unknown id does NOT 404 — EstatePrime answers 200 with `data: []`
	// (the same router artifact documented for /listings/bogus). `[]` is
	// truthy, so a plain falsy check lets it through and every field maps
	// to undefined: the form would silently blank instead of erroring.
	if (!raw || Array.isArray(raw) || raw.id == null) return null;

	const cf = raw.custom_fields || {};
	return {
		id: raw.id,
		onomatepwnymo: displayName(raw),
		patronymo: cf[CF_PATRONYMO] ?? "",
		katoikia: cf[CF_KATOIKIA] ?? "",
		adt: raw.id_number ?? "",
		adt_imerominia_ekdosis: cf[CF_ADT_DATE] ?? "", // already ISO
		adt_arxi_ekdosis: cf[CF_ADT_AUTHORITY] ?? "",
		afm: raw.vat_number ?? "",
		phone: raw.phones?.[0]?.number ?? "",
		email: raw.emails?.[0]?.email ?? "",
	};
}

/* full_name comes back as "Επώνυμο Όνομα", which reads backwards inside
   «Ο/Η υπογράφων/ούσα …» — build the natural order instead. */
function displayName(raw) {
	if (raw.is_company && raw.company_name) return raw.company_name;
	return [raw.first_name, raw.last_name].filter(Boolean).join(" ").trim();
}

/* ------------------------------------------------------------ listings */

/* Active stock for the property picker. NOTE: this deliberately reads
   the REAL address, not the fake one the public feed publishes for
   display_address="fake" listings (14 of 15 active ones). A σύμβαση
   υπόδειξης naming an approximate address would be worthless — this is
   the internal tool, behind Access, so it gets the real data. */
export async function listingsIndex(env) {
	return cachedIndex(env, LISTINGS_KEY, async () => {
		const rows = await fetchAllPages(env, "/listings");
		const active = rows.filter((r) => r.status === "active");
		return {
			generatedAt: new Date().toISOString(),
			count: active.length,
			listings: active.map((raw) => {
				const loc = raw.location || {};
				return {
					id: raw.id,
					code: raw.code ?? "",
					address: loc.address_el ?? "",
					area: loc.area_level3?.name_el || loc.area_level2?.name_el || "",
					size: raw.size ?? null,
					price: raw.price ?? null,
					hiddenPrice: !!raw.has_hidden_price,
					availability: raw.availability ?? "",
					fee: raw.assignment_fee ?? null,
					feeType: raw.assignment_fee_type ?? null,
				};
			}),
		};
	});
}

/* ---------------------------------------------------------------- util */

export function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			// Client data: never let a proxy or the browser keep a copy.
			"Cache-Control": "no-store",
		},
	});
}
