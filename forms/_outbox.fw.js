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

	/* Ο Worker κόβει το ίδιο έντυπο δεύτερη φορά (χαμένη απάντηση που μας
	   έκανε να ξαναστείλουμε, ή δεύτερο πάτημα) και το δηλώνει, μαζί με την
	   ώρα της πρώτης αποστολής. Το λέμε στον σύμβουλο: «στάλθηκε» και «είχε
	   ήδη σταλεί» δεν είναι το ίδιο πράγμα όταν περιμένει ο πελάτης email. */
	function readResult(r) {
		return r.json().then(function (j) { return j || {}; }).catch(function () { return {}; });
	}

	/* «χθες στις 15:49» το διαβάζει άνθρωπος, ένα ISO timestamp όχι. Ωρα
	   Ελλάδας πάντα: ο Worker γράφει UTC και το tablet μπορεί να έχει
	   οτιδήποτε στο ρολόι του. */
	function whenLabel(iso) {
		var d = iso ? new Date(iso) : null;
		if (!d || isNaN(d.getTime())) return '';
		var tz = { timeZone: 'Europe/Athens' };
		var day = d.toLocaleDateString('el-GR', tz);
		var time = d.toLocaleTimeString('el-GR', { timeZone: 'Europe/Athens', hour: '2-digit', minute: '2-digit' });
		var today = new Date().toLocaleDateString('el-GR', tz);
		var yesterday = new Date(Date.now() - 86400000).toLocaleDateString('el-GR', tz);
		var when = (day === today) ? 'σήμερα' : (day === yesterday ? 'χθες' : 'στις ' + day);
		return when + ' στις ' + time;
	}

	/* Try to send now; on any failure keep it. Resolves {sent:true,
	   duplicate:bool, sent_at:iso} or {queued:true,
	   reason:'offline'|'auth'|'http_NNN'} — it only throws if even the local
	   save failed (quota), so the form can warn that the έντυπο was NOT kept
	   anywhere. */
	async function submit(payload, label, opts) {
		if (navigator.onLine === false) { await queue(payload, label, 'offline'); return { queued: true, reason: 'offline' }; }
		var r;
		try { r = await post(payload); }
		catch (e) { await queue(payload, label, 'network'); return { queued: true, reason: 'offline' }; }
		if (r.ok) {
			var j = await readResult(r);
			/* Μέσα στο παράθυρο των 48 ωρών δεν αποφασίζουμε εμείς: ούτε το
			   κόβουμε σιωπηλά, ούτε το ξαναστέλνουμε σιωπηλά. Μόνο ο
			   σύμβουλος ξέρει αν το ξαναστέλνει επίτηδες, και η ερώτηση λέει
			   πότε είχε φύγει. «Ακυρο» σημαίνει «είχε ήδη σταλεί». */
			if (j.duplicate && !(opts && opts.forced)) {
				var q = 'Το ίδιο έντυπο είχε ήδη σταλεί ' + (whenLabel(j.sent_at) || 'πρόσφατα') + '.'
					+ '\n\nΝα σταλεί ΞΑΝΑ; Ο παραλήπτης θα το λάβει δεύτερη φορά.';
				if (confirm(q)) {
					var again = Object.assign({}, payload, { force_resend: true });
					return submit(again, label, { forced: true });
				}
			}
			return { sent: true, duplicate: !!j.duplicate, sent_at: j.sent_at };
		}
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
		var sent = 0, dup = 0, auth = false;
		try {
			var recs = await qAll();
			for (var i = 0; i < recs.length; i++) {
				if (navigator.onLine === false) break;
				var rec = recs[i], r;
				try { r = await post(rec.payload); }
				catch (e) { break; } /* network died mid-run */
				/* Το ίδιο έντυπο που είχε ήδη φτάσει: φεύγει από την ουρά
				   σαν τακτοποιημένο, αλλά δεν το λέμε «στάλθηκε τώρα». Εδώ
				   ΔΕΝ ρωτάμε τίποτα: το άδειασμα της ουράς τρέχει μόνο του,
				   συχνά με κλειδωμένη οθόνη, και μια ερώτηση θα έμενε
				   αναπάντητη ή θα απαντιόταν στα τυφλά. */
				if (r.ok) { await qDel(rec.id); if ((await readResult(r)).duplicate) dup++; else sent++; continue; }
				rec.attempts = (rec.attempts || 0) + 1;
				if (r.status === 401 || r.status === 403) { rec.last_error = 'auth'; await qPut(rec); auth = true; break; }
				rec.last_error = 'http_' + r.status; await qPut(rec);
			}
		} finally { _flushing = false; }
		// Με await, ώστε όποιος περιμένει το flush να βρίσκει και το pill
		// και τα κουμπιά «Σε αναμονή» ήδη ενημερωμένα.
		await badge();
		if (sent > 0) toast(sent === 1 ? 'Το εκκρεμές έντυπο στάλθηκε.' : 'Στάλθηκαν ' + sent + ' εκκρεμή έντυπα.', 'ok');
		if (dup > 0) toast(dup === 1 ? 'Ένα εκκρεμές έντυπο είχε ήδη σταλεί. Δεν ξαναστάλθηκε.' : dup + ' εκκρεμή έντυπα είχαν ήδη σταλεί. Δεν ξαναστάλθηκαν.', 'ok');
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
	/* Το κουμπί «Σε αναμονή» ανήκει στη φόρμα, αλλά μόνο εδώ ξέρουμε πότε
	   άδειασε η ουρά: χωρίς αυτό θα έμενε να λέει «σε αναμονή» για κάτι
	   που έχει ήδη φύγει. Μία γραμμή εδώ αντί για handler σε πέντε έντυπα. */
	function clearQueuedButtons() {
		var bs = document.querySelectorAll('button');
		for (var i = 0; i < bs.length; i++) {
			if (bs[i].textContent.indexOf('Σε αναμονή') === 0) bs[i].textContent = 'Στάλθηκε ✓';
		}
	}

	function badge() {
		return qAll().then(function (recs) {
			var n = recs.length, el = document.getElementById('fwObBadge');
			if (!n) { if (el) el.remove(); clearQueuedButtons(); return n; }
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
