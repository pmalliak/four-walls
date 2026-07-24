/* =====================================================================
   Four Walls Έντυπα — offline outbox + service-worker bootstrap (.fw)
   ---------------------------------------------------------------------
   The iPad often has no signal inside the property. Every "Αποστολή"
   goes through FWOutbox.submit(): try the POST, and on ANY failure the
   full payload (data + signatures + generated PDF) is stored in
   IndexedDB and retried automatically — when the network returns
   ('online'), when the tablet is unlocked (visibilitychange; the app is
   never swiped away, only locked), and on a slow timer while visible.
   A tap-to-send pill shows how many έντυπα are still queued.

   iOS has no Background Sync, so sending only happens while the app is
   open — that is exactly the unlock/reopen moment we hook. localStorage
   is NOT used: one signed PDF is ~0.5 MB of base64 and would blow its
   ~5 MB cap; IndexedDB on an installed (Home Screen) app is also exempt
   from Safari's 7-day storage eviction.

   Also registers sw.js (offline app shell) — kept here so every page
   needs just one extra <script> tag.
   ===================================================================== */
(function () {
	'use strict';

	var ENDPOINT = '/api/forms/submit';
	var DB_NAME = 'fw-outbox', STORE = 'queue';
	var _db = null, _flushing = false, _kickT = null;

	/* ---------- IndexedDB (tiny promise wrapper) ---------- */
	function db() {
		return _db ? Promise.resolve(_db) : new Promise(function (res, rej) {
			var r = indexedDB.open(DB_NAME, 1);
			r.onupgradeneeded = function () { r.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true }); };
			r.onsuccess = function () { _db = r.result; res(_db); };
			r.onerror = function () { rej(r.error); };
		});
	}
	function op(mode, fn) {
		return db().then(function (d) {
			return new Promise(function (res, rej) {
				var t = d.transaction(STORE, mode), s = t.objectStore(STORE), out = fn(s);
				t.oncomplete = function () { res(out && 'result' in out ? out.result : undefined); };
				t.onerror = function () { rej(t.error); };
			});
		});
	}
	function qAdd(rec) { return op('readwrite', function (s) { return s.add(rec); }); }
	function qAll() { return op('readonly', function (s) { return s.getAll(); }); }
	function qDel(id) { return op('readwrite', function (s) { return s.delete(id); }); }
	function qPut(rec) { return op('readwrite', function (s) { return s.put(rec); }); }

	/* ---------- send / queue ---------- */
	function post(payload) {
		return fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
	}
	function queue(payload, label, why) {
		return qAdd({ label: label || payload.title || payload.form, form: payload.form, created_at: new Date().toISOString(), attempts: 0, last_error: why, payload: payload }).then(badge);
	}

	/* Try to send now; on any failure keep it. Resolves {sent:true} or
	   {queued:true, reason:'offline'|'auth'|'http_NNN'} — it only throws
	   if even the local save failed (quota), so the form can warn that
	   the έντυπο was NOT kept anywhere. */
	async function submit(payload, label) {
		if (navigator.onLine === false) { await queue(payload, label, 'offline'); return { queued: true, reason: 'offline' }; }
		var r;
		try { r = await post(payload); }
		catch (e) { await queue(payload, label, 'network'); return { queued: true, reason: 'offline' }; }
		if (r.ok) return { sent: true };
		var reason = (r.status === 401 || r.status === 403) ? 'auth' : 'http_' + r.status;
		await queue(payload, label, reason);
		return { queued: true, reason: reason };
	}

	/* Drain the queue oldest-first. Offline/auth failures stop the run
	   (everything after would fail the same way); other HTTP errors skip
	   to the next record so one bad payload can't block the rest. */
	async function flush() {
		if (_flushing) return;
		_flushing = true;
		var sent = 0, auth = false;
		try {
			var recs = await qAll();
			for (var i = 0; i < recs.length; i++) {
				if (navigator.onLine === false) break;
				var rec = recs[i], r;
				try { r = await post(rec.payload); }
				catch (e) { break; } /* network died mid-run */
				if (r.ok) { await qDel(rec.id); sent++; continue; }
				rec.attempts = (rec.attempts || 0) + 1;
				if (r.status === 401 || r.status === 403) { rec.last_error = 'auth'; await qPut(rec); auth = true; break; }
				rec.last_error = 'http_' + r.status; await qPut(rec);
			}
		} finally { _flushing = false; }
		badge();
		if (sent > 0) toast(sent === 1 ? 'Το εκκρεμές έντυπο στάλθηκε.' : 'Στάλθηκαν ' + sent + ' εκκρεμή έντυπα.', 'ok');
		if (auth) toast('Χρειάζεται σύνδεση χρήστη — κλείσε και άνοιξε ξανά την εφαρμογή.', 'err');
		return sent;
	}
	function kick(delay) { /* debounced flush */
		clearTimeout(_kickT);
		_kickT = setTimeout(function () { flush().catch(function () {}); }, delay || 800);
	}

	/* ---------- pending pill (top-center, only when queue not empty) ---------- */
	function toast(msg, type) {
		if (typeof window.toast === 'function') return window.toast(msg, type);
		var el = document.getElementById('fwObToast');
		if (!el) {
			el = document.createElement('div'); el.id = 'fwObToast';
			el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:24px;background:#1C3457;color:#fff;padding:11px 16px;border-radius:10px;font-size:14px;max-width:90%;box-shadow:0 6px 20px rgba(0,0,0,.25);z-index:80;display:none;';
			document.body.appendChild(el);
		}
		el.style.background = type === 'err' ? '#a11d3f' : '#1C3457';
		el.textContent = msg; el.style.display = 'block';
		clearTimeout(el._t); el._t = setTimeout(function () { el.style.display = 'none'; }, 4600);
	}
	function badge() {
		return qAll().then(function (recs) {
			var n = recs.length, el = document.getElementById('fwObBadge');
			if (!n) { if (el) el.remove(); return n; }
			if (!el) {
				el = document.createElement('button'); el.id = 'fwObBadge'; el.type = 'button';
				el.style.cssText = 'position:fixed;top:calc(10px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;background:#1C3457;color:#fff;border:0;border-radius:999px;padding:9px 16px;font:700 13px/1 Manrope,system-ui,Arial,sans-serif;box-shadow:0 6px 18px rgba(20,30,50,.35);z-index:70;cursor:pointer;';
				el.onclick = function () { toast('Αποστολή εκκρεμών…'); kick(50); };
				document.body.appendChild(el);
			}
			el.innerHTML = '<span style="background:#FF0062;border-radius:999px;padding:3px 8px;font-size:12px;">' + n + '</span>' +
				(n === 1 ? 'έντυπο σε αναμονή' : 'έντυπα σε αναμονή') + ' · ΑΠΟΣΤΟΛΗ';
			return n;
		});
	}

	/* ---------- wiring ---------- */
	window.addEventListener('online', function () { kick(); });
	document.addEventListener('visibilitychange', function () { if (!document.hidden) kick(); });
	setInterval(function () { if (!document.hidden && navigator.onLine !== false) kick(); }, 180000);
	function boot() {
		badge().then(function (n) { if (n) kick(2000); });
		if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
	}
	(document.readyState === 'loading') ? document.addEventListener('DOMContentLoaded', boot) : boot();

	window.FWOutbox = { submit: submit, flush: flush, count: function () { return qAll().then(function (r) { return r.length; }); } };
})();
