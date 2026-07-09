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
const DEFAULT_WEBHOOK_PATH = "/webhooks/estateprime";

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (url.pathname === (env.WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH)) {
			return handleWebhook(request, env, ctx, url);
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

/* Pull the shared-secret token from wherever the caller put it. */
function tokenFrom(request, url) {
	const auth = request.headers.get("Authorization") || "";
	return (
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
		// Header NAMES only — helps identify EstatePrime's token mechanism
		// from `wrangler tail` without ever logging secret values.
		console.warn("webhook: rejected call; headers present:", [...request.headers.keys()].join(", "));
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
