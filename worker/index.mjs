/* =====================================================================
   Four Walls — Cloudflare Worker (site hosting + listings feed)
   ---------------------------------------------------------------------
   One Worker does three jobs:

     1. Serves the static site (assets binding -> repo root).
     2. POST <WEBHOOK_PATH>   — EstatePrime change webhook. Re-fetches
        all listings from the CRM API and stores the feed in KV. The
        webhook payload is ignored on purpose (signal, not data).
     3. GET /data/listings.json — serves the feed from KV.

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

const FEED_KEY = "listings.json";
const DEFAULT_WEBHOOK_PATH = "/listings"; // overridden by WEBHOOK_PATH var

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		// Tolerate a trailing slash on the webhook path ("/listings/").
		const pathname = url.pathname.replace(/\/+$/, "") || "/";
		const webhookPath = env.WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH;

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
				return new Response(res.body, { status: res.status, headers });
			}
			return res;
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
		// TEMPORARY (key-protected) CRM lookup passthrough — remove after use.
		if (pathname === "/debug/ep") {
			if (tokenFrom(request, url) !== env.WEBHOOK_KEY) {
				return new Response("Forbidden", { status: 403 });
			}
			const path = url.searchParams.get("path") || "";
			if (!/^[a-z0-9/?&=_-]+$/i.test(path)) return new Response("bad path", { status: 400 });
			const res = await fetch(`https://${env.ESTATEPRIME_SUBDOMAIN}.estateprime.gr/api/${path}`, {
				headers: {
					"Authorization": "Basic " + btoa(`${env.ESTATEPRIME_API_KEY}:${env.ESTATEPRIME_API_SECRET}`),
					"Content-Type": "application/json",
					"Accept": "application/json",
				},
			});
			return new Response(await res.text(), {
				status: res.status,
				headers: { "Content-Type": "application/json; charset=utf-8" },
			});
		}
		if (url.pathname === "/data/listings.json") {
			return serveFeed(env);
		}
		return env.ASSETS.fetch(request);
	},

	async scheduled(_event, env, ctx) {
		ctx.waitUntil(regenerate(env, "cron"));
	},
};

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
