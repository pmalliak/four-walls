/* =====================================================================
   Four Walls — Cloudflare Worker (site hosting + listings feed)
   ---------------------------------------------------------------------
   One Worker does four jobs:

     1. Serves the static site (assets binding -> repo root).
     2. POST <WEBHOOK_PATH>   — EstatePrime change webhook. Re-fetches
        all listings from the CRM API and stores the feed in KV. The
        webhook payload is ignored on purpose (signal, not data).
     3. GET /data/listings.json — serves the feed from KV.
     4. SEO (worker/lib/seo.mjs): /akinita/<code> serves the detail
        shell with per-listing title/meta/OG/JSON-LD injected (social
        scrapers don't run JS); /sitemap.xml and /robots.txt are
        generated; non-production hosts answer Disallow-all + noindex.
     5. POST /api/contact — contact-form relay: verifies the visitor's
        Cloudflare Turnstile token, then forwards the message to the
        Make scenario webhook. Both the Turnstile secret and the
        webhook URL are Worker secrets (TURNSTILE_SECRET_KEY,
        MAKE_CONTACT_WEBHOOK) — neither ever reaches the browser.

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

const FEED_KEY = "listings.json";
const DEFAULT_WEBHOOK_PATH = "/listings"; // overridden by WEBHOOK_PATH var

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		// Tolerate a trailing slash on the webhook path ("/listings/").
		const pathname = url.pathname.replace(/\/+$/, "") || "/";
		const webhookPath = env.WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH;

		// Host-aware robots.txt on EVERY hostname (before the forms rewrite,
		// so forms.* answers Disallow-all instead of serving a form asset).
		if (pathname === "/robots.txt") {
			return robotsResponse(url);
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
		if (pathname === "/api/contact") {
			return handleContact(request, env);
		}
		if (url.pathname === "/data/listings.json") {
			return serveFeed(env);
		}
		if (pathname === "/sitemap.xml") {
			return sitemapResponse(env);
		}
		// Pretty listing URLs: /akinita/<public code> serves the detail
		// shell with the per-listing SEO head injected (worker/lib/seo.mjs);
		// js/listings.fw.js reads the key from the path and renders the
		// visible page client-side. Unknown key -> real 404.
		if (/^\/akinita\/[^/]+$/.test(pathname)) {
			const key = decodeURIComponent(pathname.slice("/akinita/".length));
			return devNoindex(await serveListingPage(key, url, env), url);
		}
		// Old-style detail URLs (/akinito/<id>, /akinito?id=<id>) —
		// permanent redirect to the canonical /akinita/<key> form; bare
		// /akinito goes to the grid.
		if (/^\/akinito\/[^/]+$/.test(pathname)) {
			const to = new URL(url);
			to.pathname = "/akinita" + pathname.slice("/akinito".length);
			return Response.redirect(to, 301);
		}
		if (pathname === "/akinito") {
			const id = url.searchParams.get("id");
			const to = new URL(url);
			to.search = "";
			to.pathname = id ? "/akinita/" + encodeURIComponent(id) : "/akinita";
			return Response.redirect(to, 301);
		}
		// Renamed pages (2026-07): template file names dropped in favour of
		// clean ones — permanent redirects so old links/bookmarks keep working.
		{
			const renamed = {
				"/about_us_01": "/about",
				"/about_us_01.html": "/about",
				"/service_01": "/services",
				"/service_01.html": "/services",
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
