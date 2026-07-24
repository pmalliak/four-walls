/* =====================================================================
   Four Walls — Cloudflare Worker (site hosting + listings feed)
   ---------------------------------------------------------------------
   One Worker does four jobs:

     1. Serves the static site (assets binding -> repo root).
     2. POST <WEBHOOK_PATH>   — EstatePrime change webhook. Re-fetches
        all listings from the CRM API and stores the feed in KV. The
        webhook payload is ignored on purpose (signal, not data).
     3. GET /data/listings.json — serves the feed from KV.
     4. SEO (worker/lib/seo.mjs): /properties/<code> serves the detail
        shell with per-listing title/meta/OG/JSON-LD injected (social
        scrapers don't run JS); /sitemap.xml and /robots.txt are
        generated; non-production hosts answer Disallow-all + noindex.
     5. POST /api/contact — contact-form relay: verifies the visitor's
        Cloudflare Turnstile token, then forwards the message to the
        Make scenario webhook. Both the Turnstile secret and the
        webhook URL are Worker secrets (TURNSTILE_SECRET_KEY,
        MAKE_CONTACT_WEBHOOK) — neither ever reaches the browser.
     6. POST /api/request-closed — same relay for the «ολοκλήρωσα την
        αναζήτηση» confirmation on /request-closed, the landing page of
        the link in the CRM matchings email (MAKE_REQUEST_CLOSED_WEBHOOK).

   A nightly cron (see wrangler.toml [triggers]) rebuilds the feed as
   reconciliation for any webhook deliveries that were missed.

   AUTH — EstatePrime's token delivery is undocumented, so the token is
   accepted from any of: ?key= query param (embed it in the webhook URL
   you register — always works), Authorization (raw or Bearer), or the
   X-Webhook-Token / X-Api-Key headers. Rejected calls log the header
   NAMES they carried (never values), so `wrangler tail` on the first
   real delivery reveals which mechanism EstatePrime uses.

   Deploy/setup steps: docs/listings-feed.md.
   ===================================================================== */

import { buildFeed } from "./lib/estateprime.mjs";
import { robotsResponse, sitemapResponse, serveListingPage, isProdHost } from "./lib/seo.mjs";
import { requireAccess, isLocalDev, json } from "./lib/access.mjs";
import { contactsIndex, contactDetail, listingsIndex } from "./lib/crm.mjs";
import { handleFormSubmit } from "./lib/forms.mjs";
import { handlePhotoApi, servePhotoFile } from "./lib/photos.mjs";

const FEED_KEY = "listings.json";
const DEFAULT_WEBHOOK_PATH = "/listings"; // overridden by WEBHOOK_PATH var

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		// Tolerate a trailing slash on the webhook path ("/listings/").
		const pathname = url.pathname.replace(/\/+$/, "") || "/";
		const webhookPath = env.WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH;

		// www is only an alias — permanent redirect to the apex, the
		// canonical origin everywhere (docs/seo.md).
		if (url.hostname === "www.four-walls.gr") {
			const to = new URL(url);
			to.hostname = "four-walls.gr";
			return Response.redirect(to, 301);
		}

		// Host-aware robots.txt on EVERY hostname (before the forms rewrite,
		// so forms.* answers Disallow-all instead of serving a form asset).
		if (pathname === "/robots.txt") {
			return robotsResponse(url);
		}

		// The Έντυπα PWA's private API: the CRM pickers read the client
		// database, and /api/forms/submit carries a signed contract. Both
		// are client PII, so both live on exactly two hostnames — the forms
		// domain, which Cloudflare Access sits in front of, and localhost
		// for `wrangler dev`. NOT on workers.dev: that URL is kept alive for
		// the CRM webhook and bypasses Access entirely, which would leave
		// the whole client database wide open. The host check is defence in
		// depth; requireAccess() below is the real gate, for both.
		if (pathname.startsWith("/api/crm/") || pathname === "/api/forms/submit") {
			if (!(url.hostname.startsWith("forms.") || isLocalDev(url, env))) {
				return new Response("Not Found", { status: 404 });
			}
			const { denied, email } = await requireAccess(request, env, url);
			if (denied) return denied;
			return pathname === "/api/forms/submit"
				? handleFormSubmit(request, env, email)
				: handleCrm(request, env, pathname);
		}

		// AI photo enhancement — the STAFF half (init/upload/finalize). Same
		// gate as the CRM pickers above: forms host + a verified Access JWT,
		// so only a signed-in consultant can stage originals and spend Gemini
		// credits. The public download half (/api/photos/file/) is deliberately
		// NOT here — Make fetches it from the apex with an HMAC signature.
		if (pathname.startsWith("/api/photos/") && !pathname.startsWith("/api/photos/file/")) {
			if (!(url.hostname.startsWith("forms.") || isLocalDev(url, env))) {
				return new Response("Not Found", { status: 404 });
			}
			const { denied, email } = await requireAccess(request, env, url);
			if (denied) return denied;
			return handlePhotoApi(request, env, url, email);
		}

		// forms.four-walls.gr serves ONLY the Έντυπα PWA: the forms/ folder
		// mapped to the domain root. The app uses root-absolute paths
		// (/manifest.webmanifest, /icon-192.png, start_url "/"), so it only
		// works as a PWA when forms/ IS the root — this rewrite does that.
		if (url.hostname.startsWith("forms.")) {
			const assetUrl = new URL(request.url);
			assetUrl.pathname = "/forms" + url.pathname;
			const res = await env.ASSETS.fetch(new Request(assetUrl, request));
			// The assets layer canonicalizes paths with redirects (e.g.
			// /forms/index.html -> /forms/); strip the internal /forms
			// prefix from any Location so it stays on this hostname's root.
			const loc = res.headers.get("Location");
			if (loc && loc.startsWith("/forms")) {
				const headers = new Headers(res.headers);
				headers.set("Location", loc.slice("/forms".length) || "/");
				return devNoindex(new Response(res.body, { status: res.status, headers }), url);
			}
			return devNoindex(res, url);
		}

		// A dedicated webhook hostname (webhooks.four-walls.gr) exposes ONLY
		// the webhook endpoint — the site and feed are 404 there. On every
		// other hostname (site domain, workers.dev) all routes work.
		if (url.hostname.startsWith("webhooks.")) {
			if (pathname === webhookPath) {
				return handleWebhook(request, env, ctx, url);
			}
			return new Response("Not Found", { status: 404 });
		}

		if (pathname === webhookPath) {
			return handleWebhook(request, env, ctx, url);
		}
		// AI photo enhancement — the PUBLIC half: Make pulls each staged
		// original by its signed URL. No Access (Make has no cookie); the
		// HMAC signature + short expiry minted in photos.mjs is the guard.
		// Lives on the apex precisely because that host has no Access in front.
		if (pathname.startsWith("/api/photos/file/")) {
			return servePhotoFile(request, env, url);
		}
		if (pathname === "/api/contact") {
			return handleContact(request, env);
		}
		if (pathname === "/api/request-closed") {
			return handleRequestClosed(request, env);
		}
		// Tracked outbound links from our emails/CRM: /go?to=/path&c=<campaign>.
		// Logs one structured "email_click" line (queryable in the Worker's
		// Observability tab — logs are already persisted, wrangler.toml) and
		// 302s to the destination with UTM stamped on, so Cloudflare Web
		// Analytics also attributes the landing visit. `to` is forced to a
		// same-origin absolute path: the open-redirect guard below rebuilds
		// the URL on THIS origin and bails to "/" if anything (//evil.com,
		// a scheme, a backslash trick) lands it off-host — four-walls.gr can
		// never be used to launder a link to another site.
		if (pathname === "/go") {
			const rawTo = url.searchParams.get("to") || "/";
			const campaign = (url.searchParams.get("c") || "link").slice(0, 64);
			const to = /^\/(?!\/)[^\\]*$/.test(rawTo) ? rawTo : "/";
			let dest = new URL(to, url.origin);
			if (dest.origin !== url.origin) dest = new URL("/", url.origin);
			dest.searchParams.set("utm_source", "email");
			dest.searchParams.set("utm_medium", "email");
			dest.searchParams.set("utm_campaign", campaign);
			console.log(JSON.stringify({
				event: "email_click",
				campaign,
				to: dest.pathname,
				ref: request.headers.get("Referer") || "",
				ua: request.headers.get("User-Agent") || "",
				country: request.cf?.country || "",
				ts: new Date().toISOString(),
			}));
			return Response.redirect(dest.toString(), 302);
		}
		if (url.pathname === "/data/listings.json") {
			return serveFeed(env);
		}
		if (pathname === "/sitemap.xml") {
			return sitemapResponse(env);
		}
		// Pretty listing URLs: /properties/<public code> serves the detail
		// shell with the per-listing SEO head injected (worker/lib/seo.mjs);
		// js/listings.fw.js reads the key from the path and renders the
		// visible page client-side. Unknown key -> real 404.
		if (/^\/properties\/[^/]+$/.test(pathname)) {
			const key = decodeURIComponent(pathname.slice("/properties/".length));
			return devNoindex(await serveListingPage(key, url, env), url);
		}
		// English twin: /en/properties/<code> — same shell/SEO injection,
		// English shell (en/property.html), labels, JSON-LD and canonical.
		if (/^\/en\/properties\/[^/]+$/.test(pathname)) {
			const key = decodeURIComponent(pathname.slice("/en/properties/".length));
			return devNoindex(await serveListingPage(key, url, env, "en"), url);
		}
		if (pathname === "/en/property") {
			const id = url.searchParams.get("id");
			const to = new URL(url);
			to.search = "";
			to.pathname = id ? "/en/properties/" + encodeURIComponent(id) : "/en/properties";
			return Response.redirect(to, 301);
		}
		// Old Greek detail URLs (/akinita/<key>, /akinito/<id>,
		// /akinito?id=<id>) — permanent redirect to the canonical
		// /properties/<key> form; bare /akinito and the /property shell
		// go to the grid.
		if (/^\/akinit[ao]\/[^/]+$/.test(pathname)) {
			const to = new URL(url);
			to.pathname = "/properties/" + pathname.split("/")[2];
			return Response.redirect(to, 301);
		}
		if (pathname === "/akinito" || pathname === "/property") {
			const id = url.searchParams.get("id");
			const to = new URL(url);
			to.search = "";
			to.pathname = id ? "/properties/" + encodeURIComponent(id) : "/properties";
			return Response.redirect(to, 301);
		}
		// Renamed pages (2026-07): template file names, then the Greek
		// transliterated paths, dropped in favour of clean English ones —
		// permanent redirects so old links/bookmarks keep working.
		{
			const renamed = {
				"/about_us_01": "/about",
				"/about_us_01.html": "/about",
				"/service_01": "/services",
				"/service_01.html": "/services",
				"/akinita": "/properties",
				"/akinita.html": "/properties",
				"/akinito.html": "/properties",
				"/service_agora": "/services/buying",
				"/service_agora.html": "/services/buying",
				"/service_polisi": "/services/selling",
				"/service_polisi.html": "/services/selling",
				"/service_enoikiasi": "/services/renting",
				"/service_enoikiasi.html": "/services/renting",
				"/service_ektimisi": "/services/valuation",
				"/service_ektimisi.html": "/services/valuation",
				"/service_anakainisi": "/services/renovation",
				"/service_anakainisi.html": "/services/renovation",
				"/service_diaxeirisi": "/services/property-management",
				"/service_diaxeirisi.html": "/services/property-management",
				"/oroi_xrisis": "/terms-of-use",
				"/oroi_xrisis.html": "/terms-of-use",
				"/politiki_aporritou": "/privacy-policy",
				"/politiki_aporritou.html": "/privacy-policy",
			};
			if (renamed[pathname]) {
				const to = new URL(url);
				to.pathname = renamed[pathname];
				return Response.redirect(to, 301);
			}
		}
		return devNoindex(await env.ASSETS.fetch(request), url);
	},

	async scheduled(_event, env, ctx) {
		ctx.waitUntil(regenerate(env, "cron"));
	},
};

/* CRM pickers for the Έντυπα PWA. Read-only: the EstatePrime API has no
   documented update endpoint for contacts (asked 2026-07-17), so nothing
   here writes back to the CRM yet.

   Every response carries client PII. The caller has already cleared the
   Access gate — never route here without it. */
async function handleCrm(request, env, pathname) {
	if (request.method !== "GET") {
		return json({ error: "Method not allowed" }, 405);
	}

	try {
		if (pathname === "/api/crm/contacts") {
			return json(await contactsIndex(env));
		}
		const m = pathname.match(/^\/api\/crm\/contacts\/(\d+)$/);
		if (m) {
			const contact = await contactDetail(env, m[1]);
			return contact ? json(contact) : json({ error: "Not found" }, 404);
		}
		if (pathname === "/api/crm/listings") {
			return json(await listingsIndex(env));
		}
		return json({ error: "Not found" }, 404);
	} catch (err) {
		// Never surface the CRM's own error text — it can carry account
		// details. The full error goes to the Observability logs instead.
		console.error("CRM route failed", pathname, err?.stack || String(err));
		return json({ error: "Upstream error" }, 502);
	}
}

/* Keep non-production hosts (dev.*, *.workers.dev, forms.*) out of
   search indexes even when a page is linked externally — robots.txt
   alone blocks crawling but doesn't deindex. */
function devNoindex(res, url) {
	if (isProdHost(url.hostname)) return res;
	const ct = res.headers.get("Content-Type") || "";
	if (!ct.includes("text/html")) return res;
	const headers = new Headers(res.headers);
	headers.set("X-Robots-Tag", "noindex");
	return new Response(res.body, { status: res.status, headers });
}

/* Pull the shared-secret token from wherever the caller put it.
   EstatePrime sends its webhook token in an `EstatePrime` header
   (observed live 2026-07-09); the rest are generic fallbacks. */
function tokenFrom(request, url) {
	const auth = request.headers.get("Authorization") || "";
	return (
		request.headers.get("EstatePrime") ||
		url.searchParams.get("key") ||
		request.headers.get("X-Webhook-Token") ||
		request.headers.get("X-Api-Key") ||
		(auth.startsWith("Bearer ") ? auth.slice(7) : auth)
	);
}

async function handleWebhook(request, env, ctx, url) {
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", { status: 405, headers: { "Allow": "POST" } });
	}
	if (!env.WEBHOOK_KEY) {
		console.error("webhook: WEBHOOK_KEY secret is not configured");
		return new Response("Webhook not configured", { status: 500 });
	}
	if (tokenFrom(request, url) !== env.WEBHOOK_KEY) {
		// Header NAMES and body FIELD NAMES only (never values) — enough to
		// identify EstatePrime's token mechanism from the logs.
		let bodyKeys = "(not JSON)";
		try {
			bodyKeys = Object.keys(JSON.parse(await request.text())).join(", ") || "(empty)";
		} catch { /* non-JSON or empty body */ }
		console.warn(`webhook: rejected call; headers: ${[...request.headers.keys()].join(", ")}; body keys: ${bodyKeys}`);
		return new Response("Forbidden", { status: 403 });
	}

	// Ack fast; regenerate after the response so the CRM never times out
	// and retries a request that actually succeeded.
	ctx.waitUntil(regenerate(env, "webhook"));
	return new Response("OK", { status: 200 });
}

/* POST /api/contact — the site's contact form (contact.html +
   js/fourwalls.js). The browser sends the fields plus a Turnstile
   token; we verify the token with Cloudflare and only then relay the
   message to the Make scenario's webhook, so the webhook URL never
   appears client-side and bots can't reach it. Field names match the
   Make scenario mapping: name, email, phone, message, page — phone
   has its own row in the scenario's email template. The hidden
   `website` field is a honeypot — a bot that filled it gets a fake
   success and nothing is forwarded. */
async function handleContact(request, env) {
	if (request.method !== "POST") {
		return contactJson({ success: false, error: "method_not_allowed" }, 405, { "Allow": "POST" });
	}
	if (!env.TURNSTILE_SECRET_KEY || !env.MAKE_CONTACT_WEBHOOK) {
		console.error("contact: TURNSTILE_SECRET_KEY / MAKE_CONTACT_WEBHOOK secret not configured");
		return contactJson({ success: false, error: "not_configured" }, 500);
	}

	let body;
	try {
		body = await request.json();
	} catch {
		return contactJson({ success: false, error: "bad_request" }, 400);
	}

	if (typeof body.website === "string" && body.website !== "") {
		console.warn("contact: honeypot tripped, dropping message");
		return contactJson({ success: true }, 200);
	}

	const name = String(body.name || "").trim().slice(0, 200);
	const email = String(body.email || "").trim().slice(0, 200);
	const phone = String(body.phone || "").trim().slice(0, 50);
	const message = String(body.message || "").trim().slice(0, 5000);
	if (!name || !email || !message) {
		return contactJson({ success: false, error: "missing_fields" }, 400);
	}
	const token = String(body.token || "");
	if (!token) {
		return contactJson({ success: false, error: "missing_token" }, 400);
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
		console.warn(`contact: turnstile rejected (${(outcome["error-codes"] || []).join(", ")})`);
		return contactJson({ success: false, error: "turnstile_failed" }, 403);
	}

	const fwd = await fetch(env.MAKE_CONTACT_WEBHOOK, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name,
			email,
			phone,
			message,
			page: String(body.page || "").slice(0, 200),
		}),
	});
	if (!fwd.ok) {
		console.error(`contact: Make webhook forward failed (HTTP ${fwd.status})`);
		return contactJson({ success: false, error: "forward_failed" }, 502);
	}
	return contactJson({ success: true }, 200);
}

/* POST /api/request-closed — the «ολοκλήρωσα την αναζήτηση» button on
   /request-closed, the landing page of the link in the CRM matchings
   email (crm/request-matchings.twig.html). Same shape as the contact
   relay: Turnstile is verified here, then the confirmation is forwarded
   to its own Make webhook (MAKE_REQUEST_CLOSED_WEBHOOK), which emails
   info@ so a consultant closes the ζήτηση by hand. When EstatePrime
   exposes a request-update endpoint, Make gets a second module and this
   route does not change.

   The ids come from the email link's query string, so they are visitor
   input: both are accepted ONLY as digits and are otherwise dropped —
   Make must treat a blank id as «άγνωστη ζήτηση, ψάξ' το» rather than
   matching on something arbitrary. Nothing here reads or returns CRM
   data, so a guessed id can at worst file one misleading email. */
async function handleRequestClosed(request, env) {
	if (request.method !== "POST") {
		return contactJson({ success: false, error: "method_not_allowed" }, 405, { "Allow": "POST" });
	}
	if (!env.TURNSTILE_SECRET_KEY || !env.MAKE_REQUEST_CLOSED_WEBHOOK) {
		console.error("request-closed: TURNSTILE_SECRET_KEY / MAKE_REQUEST_CLOSED_WEBHOOK secret not configured");
		return contactJson({ success: false, error: "not_configured" }, 500);
	}

	let body;
	try {
		body = await request.json();
	} catch {
		return contactJson({ success: false, error: "bad_request" }, 400);
	}

	if (typeof body.website === "string" && body.website !== "") {
		console.warn("request-closed: honeypot tripped, dropping confirmation");
		return contactJson({ success: true }, 200);
	}

	const digits = (v) => (/^\d{1,12}$/.test(String(v || "")) ? String(v) : "");
	const requestId = digits(body.request_id);
	const contactId = digits(body.contact_id);
	const reason = String(body.reason || "").trim().slice(0, 100);
	const comment = String(body.comment || "").trim().slice(0, 2000);

	const token = String(body.token || "");
	if (!token) {
		return contactJson({ success: false, error: "missing_token" }, 400);
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
		return contactJson({ success: false, error: "turnstile_failed" }, 403);
	}

	const fwd = await fetch(env.MAKE_REQUEST_CLOSED_WEBHOOK, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			request_id: requestId,
			contact_id: contactId,
			reason,
			comment,
			page: String(body.page || "").slice(0, 200),
			received_at: new Date().toISOString(),
		}),
	});
	if (!fwd.ok) {
		console.error(`request-closed: Make webhook forward failed (HTTP ${fwd.status})`);
		return contactJson({ success: false, error: "forward_failed" }, 502);
	}
	// One structured line per confirmation — queryable in Observability
	// next to the /go email_click events, so «άνοιξε το email → πάτησε
	// τον σύνδεσμο → επιβεβαίωσε» is reconstructable without the CRM.
	console.log(JSON.stringify({
		event: "request_closed",
		request_id: requestId,
		contact_id: contactId,
		reason,
		ts: new Date().toISOString(),
	}));
	return contactJson({ success: true }, 200);
}

function contactJson(obj, status, extraHeaders) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
	});
}

async function serveFeed(env) {
	const feed = await env.LISTINGS_KV.get(FEED_KEY);
	if (feed === null) {
		return new Response(JSON.stringify({ error: "feed not generated yet" }), {
			status: 503,
			headers: { "Content-Type": "application/json; charset=utf-8", "Retry-After": "60" },
		});
	}
	return new Response(feed, {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "public, max-age=60",
		},
	});
}

async function regenerate(env, trigger) {
	try {
		const feed = await buildFeed(env);
		await env.LISTINGS_KV.put(FEED_KEY, JSON.stringify(feed));
		console.log(`feed regenerated (${trigger}): ${feed.count} listings, source=${feed.source}`);
	} catch (err) {
		console.error(`feed regeneration FAILED (${trigger}): ${err.message}`);
	}
}
