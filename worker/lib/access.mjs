/* =====================================================================
   Four Walls — Cloudflare Access gate for the Έντυπα PWA
   ---------------------------------------------------------------------
   Everything the tablet app talks to goes through here: the CRM pickers
   (crm.mjs) read the client database, and form submission (forms.mjs)
   carries a signed contract. Both are client PII, so both are gated.

   It fails closed: no Access config -> 503, never open.
   ===================================================================== */

/* Cloudflare Access sits in front of forms.four-walls.gr. It would be
   enough on its own IF the Worker were only reachable there — but
   workers_dev = true keeps a *.workers.dev URL alive for the CRM
   webhook, and that URL bypasses Access entirely. So the caller MUST
   also verify the JWT rather than trust the header's presence.

   Returns { denied, email }: `denied` is a Response to return as-is when
   the caller is not an authenticated Access user, null otherwise.
   `email` is who Access says they are — null on a local dev run, where
   there is no Access session and therefore nobody to name. */
export async function requireAccess(request, env, url) {
	if (isLocalDev(url, env)) return { denied: null, email: null };

	const team = env.ACCESS_TEAM_DOMAIN; // e.g. fourwalls.cloudflareaccess.com
	const aud = env.ACCESS_AUD; // Application Audience tag from the Access app
	if (!team || !aud) {
		return { denied: json({ error: "Access not configured" }, 503), email: null };
	}
	const token =
		request.headers.get("Cf-Access-Jwt-Assertion") ||
		cookieValue(request.headers.get("Cookie"), "CF_Authorization");
	if (!token) return { denied: json({ error: "Unauthorized" }, 401), email: null };

	const payload = await verifyAccessJwt(token, team, aud);
	if (!payload) return { denied: json({ error: "Unauthorized" }, 401), email: null };

	// Service tokens authenticate as `common_name`, not a person, so email
	// can legitimately be absent on a verified JWT.
	return { denied: null, email: payload.email || null };
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

async function verifyAccessJwt(token, team, aud) {
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
