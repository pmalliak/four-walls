/* =====================================================================
   Four Walls Έντυπα — Bugsnag error monitoring
   ---------------------------------------------------------------------
   Loads in the <head> of every page, right after bugsnag.min.js
   (self-hosted so the service worker caches it and it opens offline).
   Project: "four walls forms" (the API key is public by design).

   - Reports only from production (four-walls.gr / forms.four-walls.gr);
     localhost and the preview server stay silent.
   - Offline: Bugsnag has no offline queue of its own, so a tiny one
     lives here. Errors thrown with no connection are kept in
     localStorage (max 20, 7 days) and re-notified on the next
     'online' or page load — the timestamp of the original error is
     attached, the Bugsnag event time is the replay time.
   ===================================================================== */
'use strict';
(function () {
	var KEY = 'fw-err-queue';
	var prod = /(^|\.)four-walls\.gr$/.test(location.hostname);
	var page = (location.pathname.split('/').pop() || 'index').replace(/\.html$/, '') || 'index';

	if (window.Bugsnag) {
		Bugsnag.start({
			apiKey: 'ace8302eac48c976cd2272512e9e04f3',
			releaseStage: prod ? 'production' : 'development',
			enabledReleaseStages: ['production'],
			collectUserIp: false,
			metadata: { app: { form: page } }
		});
	}

	if (!prod) return;

	function load() {
		try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { return []; }
	}
	function save(q) {
		try { localStorage.setItem(KEY, JSON.stringify(q.slice(-20))); } catch (e) { /* full/blocked */ }
	}
	function queue(message, stack) {
		var q = load();
		q.push({ m: String(message || 'error'), s: String(stack || ''), f: page, t: Date.now() });
		save(q);
	}

	/* Bugsnag's own delivery just fails silently without a network,
	   so keep a copy of anything thrown while offline. */
	window.addEventListener('error', function (ev) {
		if (navigator.onLine) return;
		queue((ev.error && ev.error.message) || ev.message, ev.error && ev.error.stack);
	});
	window.addEventListener('unhandledrejection', function (ev) {
		if (navigator.onLine) return;
		var r = ev.reason || {};
		queue(r.message || r, r.stack);
	});

	function drain() {
		if (!window.Bugsnag || !navigator.onLine) return;
		var q = load();
		if (!q.length) return;
		try { localStorage.removeItem(KEY); } catch (e) { }
		var cutoff = Date.now() - 7 * 24 * 3600 * 1000;
		q.forEach(function (it) {
			if (!it || !it.t || it.t < cutoff) return;
			var err = new Error(it.m);
			if (it.s) err.stack = it.s;
			Bugsnag.notify(err, function (event) {
				event.addMetadata('offline', { form: it.f, thrownAt: new Date(it.t).toISOString() });
			});
		});
	}
	window.addEventListener('online', drain);
	drain();
})();
