/* =====================================================================
   Four Walls Έντυπα — service worker: offline app shell
   ---------------------------------------------------------------------
   Lets the PWA open and build PDFs with no signal (inside a property):
   precaches the pages + html2pdf (now self-hosted) + icons, and
   runtime-caches the Google Fonts files after the first online visit.
   The actual queued sending lives in _outbox.fw.js, NOT here — iOS has
   no Background Sync, so a SW 'sync' handler would never fire.

   Registered by _outbox.fw.js with a RELATIVE path, so the same file
   works on both mounts: forms.four-walls.gr/ (Worker rewrites to
   /forms/*) and four-walls.gr/forms/ (scope /forms/).

   Cache strategy:
   - navigations (the .html pages): network-first, cache fallback —
     edits go live immediately, offline still opens.
   - same-origin assets (js/icons/manifest): stale-while-revalidate.
   - fonts.googleapis.com / fonts.gstatic.com: cache-first.
   - /api/* is NEVER touched: CRM lookups carry client PII and the
     submit POST must always hit the network (the outbox handles
     failures).

   BUMP `VERSION` when the shell list or strategies change.
   ===================================================================== */
'use strict';

var VERSION = 'fw-entypa-v4';
var SHELL = [
	'./', 'index.html', 'anathesi.html', 'ypodeixi.html', 'apodeixi.html', 'katachorisi.html', 'enhance.html',
	'_crm.fw.js', '_outbox.fw.js', 'html2pdf.bundle.min.js',
	'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'favicon.png',
];

/* One key per page regardless of how it was reached: the assets layer
   redirects /anathesi.html -> /anathesi in prod, while localhost serves
   the .html directly. Both normalize to the extensionless path. */
function normKey(url) {
	var u = new URL(url, self.registration.scope);
	var p = u.pathname;
	if (p.slice(-5) === '.html') p = p.slice(0, -5);
	if (p.slice(-6) === '/index') p = p.slice(0, -6) + '/';
	return u.origin + p;
}

/* Store a response stripped of its redirect flag — a redirected
   response replayed for a navigation is rejected by the browser. */
async function putClean(cache, key, res) {
	if (!res || !res.ok) return;
	var body = await res.clone().blob();
	var h = new Headers();
	if (res.headers.get('Content-Type')) h.set('Content-Type', res.headers.get('Content-Type'));
	await cache.put(normKey(key), new Response(body, { status: 200, headers: h }));
}

self.addEventListener('install', function (e) {
	e.waitUntil((async function () {
		var cache = await caches.open(VERSION);
		/* Fetch one by one and tolerate misses — an atomic addAll() would
		   brick the install on a single 404. */
		await Promise.all(SHELL.map(async function (u) {
			try {
				var res = await fetch(new Request(u, { credentials: 'same-origin', redirect: 'follow', cache: 'no-cache' }));
				await putClean(cache, u, res);
			} catch (err) { /* offline install: keep whatever we get */ }
		}));
		self.skipWaiting();
	})());
});

self.addEventListener('activate', function (e) {
	e.waitUntil((async function () {
		var names = await caches.keys();
		await Promise.all(names.map(function (n) { return n === VERSION ? 0 : caches.delete(n); }));
		await self.clients.claim();
	})());
});

self.addEventListener('fetch', function (e) {
	var req = e.request;
	if (req.method !== 'GET') return;
	var url = new URL(req.url);

	/* API: always live, never cached (PII + the outbox owns retries). */
	if (url.origin === self.location.origin && url.pathname.indexOf('/api/') !== -1) return;

	/* Google Fonts: cache-first (they are versioned/immutable). */
	if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
		e.respondWith((async function () {
			var cache = await caches.open(VERSION);
			var hit = await cache.match(req);
			if (hit) return hit;
			var res = await fetch(req);
			if (res && (res.ok || res.type === 'opaque')) await cache.put(req, res.clone());
			return res;
		})());
		return;
	}

	if (url.origin !== self.location.origin) return;

	if (req.mode === 'navigate') {
		/* Network-first. fetch(req) keeps the request's own redirect mode,
		   so the prod .html -> extensionless redirect flows through the
		   browser untouched; we only cache final clean 200s. */
		e.respondWith((async function () {
			var cache = await caches.open(VERSION);
			try {
				var res = await fetch(req);
				if (res.ok && res.type === 'basic' && !res.redirected) await cache.put(normKey(req.url), res.clone());
				return res;
			} catch (err) {
				var hit = await cache.match(normKey(req.url));
				return hit || (await cache.match(normKey('./'))) || Response.error();
			}
		})());
		return;
	}

	/* Same-origin assets: stale-while-revalidate. */
	e.respondWith((async function () {
		var cache = await caches.open(VERSION);
		var key = normKey(req.url);
		var hit = await cache.match(key);
		var refresh = fetch(req).then(function (res) {
			if (res.ok && res.type === 'basic' && !res.redirected) cache.put(key, res.clone());
			return res;
		}).catch(function () { return null; });
		if (hit) { e.waitUntil(refresh); return hit; }
		return (await refresh) || Response.error();
	})());
});
