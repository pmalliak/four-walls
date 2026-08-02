/* =====================================================================
   Four Walls Έντυπα — drafts: autosave + «Πρόχειρα» (.fw)
   ---------------------------------------------------------------------
   A half-filled έντυπο must survive leaving the page (phone call, other
   form, locked iPad). Every form registers an adapter and from then on
   whatever is typed is autosaved (debounced) into a per-form list of
   drafts in localStorage. Reopening the form shows a banner listing the
   drafts («Συνέχεια» / «Διαγραφή»); the index page shows all of them.

   One draft = one visit that got somewhere: a draft is born once ~10% of
   the form is filled in (never fewer than MIN_FIELDS), so a tap on a
   segment or a switch does not fill the «Πρόχειρα» list with nothing.
   From then on every change updates THAT draft. Loading a draft makes it
   the current one. A successful submit deletes it.

   Deliberately NOT saved: signatures. A signature belongs to the exact
   text signed at that moment — restoring it onto edited fields would
   fabricate a signed document. After a restore both parties sign again.

   localStorage (not IndexedDB): drafts are small JSON (no signature
   PNGs, no PDFs), and the synchronous API lets us flush reliably on
   pagehide. Storage is per-origin and, on the installed Home-Screen
   app, exempt from Safari's 7-day eviction (same as the outbox).

   API (window.FWDrafts):
     register(cfg)  — page adapter; cfg:
         form     'anathesi' | ... (the CONFIG.id / payload form string)
         mount    element or selector: banner + status line go at its top
         collect  () -> plain object of the current form values
         apply    (values) -> void: restore values into the form/UI
         label    (values) -> short human label for the lists
         onSave   optional (msg)->void: page shows its own saved-tag
     touch()        — schedule an autosave (pages whose state changes
                      without input/change/click events call this)
     discard()      — after a successful submit: delete current draft,
                      re-baseline on the just-sent values
     rebase()       — after a form reset(): current DOM = new baseline
     importDraft(form, values, label) — one-off migration helper
     renderHome(el) — the index page's «Πρόχειρα» section
   ===================================================================== */
(function () {
	'use strict';

	var LS = 'fw_drafts_v1';
	var TTL_MS = 30 * 24 * 3600 * 1000;  /* drafts expire after 30 days */
	var MAX_PER_FORM = 10;
	var DEBOUNCE_MS = 900;
	/* Πότε γεννιέται πρόχειρο: το 10% των πεδίων της φόρμας, ποτέ λιγότερα
	   από 3. Ένα κουμπί που άλλαξε δεν είναι μισοσυμπληρωμένο έντυπο. */
	var MIN_FIELDS = 3;
	var MIN_RATIO = 0.10;

	var TITLES = {
		anathesi: 'Εντολή Ανάθεσης', ypodeixi: 'Εντολή Υπόδειξης',
		apodeixi: 'Απόδειξη Είσπραξης', katachorisi: 'Καταχώριση ακινήτου',
		prosfora: 'Προσφορά', ektimisi: 'Εκτίμηση ακινήτου',
	};

	var cfg = null;          /* the page adapter, once register()ed */
	var curId = null;        /* draft being edited (null = fresh form) */
	var lastJson = null;     /* what was last written for curId */
	var baseVals = null;     /* form values at register-time … */
	var baseJson = null;     /* … so defaults (σημερινή ημ/νία) never count */
	var saveT = null;
	var bannerEl = null, statusEl = null;

	/* ---------- store ---------- */
	function readAll() {
		try { var o = JSON.parse(localStorage.getItem(LS) || '{}'); return (o && typeof o === 'object') ? o : {}; }
		catch (e) { return {}; }
	}
	function writeAll(o) { try { localStorage.setItem(LS, JSON.stringify(o)); } catch (e) { /* quota: draft lost, form still on screen */ } }
	function prune(o) {
		var cut = Date.now() - TTL_MS;
		Object.keys(o).forEach(function (f) {
			var arr = (o[f] || []).filter(function (d) { return d && d.v && new Date(d.updated_at).getTime() > cut; });
			arr.sort(function (a, b) { return String(b.updated_at).localeCompare(String(a.updated_at)); });
			if (arr.length > MAX_PER_FORM) arr.length = MAX_PER_FORM;
			if (arr.length) o[f] = arr; else delete o[f];
		});
		return o;
	}
	function newId() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
	function removeDraft(form, id) {
		var o = readAll();
		if (!o[form]) return;
		o[form] = o[form].filter(function (d) { return d.id !== id; });
		if (!o[form].length) delete o[form];
		writeAll(o);
	}

	/* ---------- tiny helpers ---------- */
	function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
	function pad2(n) { return ('0' + n).slice(-2); }
	function hhmm(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
	function fmtRel(iso) {
		var d = new Date(iso); if (isNaN(d)) return '';
		var now = new Date(), s = (now - d) / 1000;
		if (s < 60) return 'μόλις τώρα';
		if (s < 3600) return 'πριν ' + Math.floor(s / 60) + '′';
		var t = hhmm(d);
		if (d.toDateString() === now.toDateString()) return 'σήμερα ' + t;
		var y = new Date(now); y.setDate(y.getDate() - 1);
		if (d.toDateString() === y.toDateString()) return 'χθες ' + t;
		return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' + t;
	}
	function labelOf(d) { return d.label || 'Χωρίς στοιχεία ακόμα'; }
	function notify(msg) { if (cfg && cfg.onSave) cfg.onSave(msg); else if (statusEl) { statusEl.textContent = msg; statusEl.style.display = 'block'; } }

	/* Πόσο έχει πιάσει η φόρμα: πεδία που διαφέρουν από το baseline ΚΑΙ
	   έχουν περιεχόμενο, ώστε μια προεπιλεγμένη ημερομηνία ή ένα άδειασμα
	   πεδίου να μη μετράνε. Το επιλεγμένο ακίνητο/επαφή είναι ολόκληρη
	   εγγραφή του CRM (αναζήτηση, όχι tap), οπότε μετράει για δύο. */
	function countFilled(v) {
		var n = 0;
		for (var k in v) {
			if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
			var a = v[k], b = baseVals ? baseVals[k] : undefined;
			if (JSON.stringify(a) === JSON.stringify(b)) continue;
			if (a == null || a === '' || a === false) continue;
			if (typeof a === 'string' && !a.trim()) continue;
			if (Array.isArray(a) && !a.length) continue;
			n += (typeof a === 'object' && !Array.isArray(a)) ? 2 : 1;
		}
		return n;
	}

	/* Πρόχειρο μόνο όταν αξίζει να ξαναβρεθεί. Το κατώφλι βγαίνει από το
	   μέγεθος της ίδιας της φόρμας: 10% των πεδίων του baseline, με
	   κατώτατο τα MIN_FIELDS. Μόλις γεννηθεί, κάθε επόμενη αλλαγή (ακόμα
	   και ένα κουμπί, ακόμα και σβήσιμο) ενημερώνει κανονικά. */
	function worthSaving(v) {
		var total = baseVals ? Object.keys(baseVals).length : 0;
		return countFilled(v) >= Math.max(MIN_FIELDS, Math.ceil(total * MIN_RATIO));
	}

	/* ---------- autosave ---------- */
	function doSave() {
		saveT = null;
		if (!cfg) return;
		var v, j;
		try { v = cfg.collect(); j = JSON.stringify(v); } catch (e) { return; }
		if (j === lastJson) return;
		if (curId == null) {
			if (j === baseJson || !worthSaving(v)) return;
			curId = newId();
		}
		var o = readAll();
		var arr = o[cfg.form] = o[cfg.form] || [];
		var d = null;
		for (var i = 0; i < arr.length; i++) if (arr[i].id === curId) { d = arr[i]; break; }
		if (!d) { d = { id: curId, created_at: new Date().toISOString() }; arr.unshift(d); }
		d.updated_at = new Date().toISOString();
		d.v = JSON.parse(j);
		try { d.label = String((cfg.label && cfg.label(v)) || ''); } catch (e) { d.label = ''; }
		writeAll(prune(o));
		lastJson = j;
		notify('Πρόχειρο αποθηκευμένο · ' + hhmm(new Date()));
	}
	function touch() { clearTimeout(saveT); saveT = setTimeout(doSave, DEBOUNCE_MS); }
	function flushNow() { if (saveT) { clearTimeout(saveT); doSave(); } }

	/* The baseline must be a SNAPSHOT. katachorisi's collect() returns its
	   live `state` object — without the copy, baseVals would alias it and
	   hasNewContent() would compare the state with itself (never a diff,
	   never a draft). */
	function snapshot() {
		var v = cfg.collect();
		baseJson = JSON.stringify(v);
		baseVals = JSON.parse(baseJson);
	}
	function rebase() {
		clearTimeout(saveT); saveT = null;
		curId = null; lastJson = null;
		if (cfg) { try { snapshot(); } catch (e) {} }
	}
	function discard() {
		if (cfg && curId != null) removeDraft(cfg.form, curId);
		rebase();
	}

	/* ---------- restore ---------- */
	function loadDraft(d) {
		flushNow(); /* whatever was being typed becomes its own draft first */
		try { cfg.apply(JSON.parse(JSON.stringify(d.v))); }
		catch (e) { notify('Το πρόχειρο δεν άνοιξε.'); return; }
		curId = d.id; lastJson = JSON.stringify(d.v);
		if (bannerEl) { bannerEl.remove(); bannerEl = null; }
		notify('Ανακτήθηκε πρόχειρο · αποθηκεύεται αυτόματα');
		window.scrollTo(0, 0);
	}

	/* ---------- banner (top of the form) ---------- */
	var S = {
		card: 'background:#fff;border:1px solid #dbe1ea;border-left:4px solid #1C3457;border-radius:12px;padding:12px 14px;margin:0 0 14px;font-family:Manrope,system-ui,Arial,sans-serif;',
		hd: 'font-weight:800;font-size:13.5px;color:#1C3457;',
		sub: 'font-size:11.5px;color:#6b7280;margin-top:2px;',
		row: 'display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid #eef1f5;margin-top:9px;',
		lbl: 'flex:1;min-width:0;',
		l1: 'font-weight:700;font-size:14px;color:#242a33;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
		l2: 'font-size:12px;color:#6b7280;margin-top:1px;',
		go: 'flex:0 0 auto;background:#1C3457;color:#fff;border:0;border-radius:999px;padding:8px 14px;font:700 12.5px Manrope,system-ui,Arial,sans-serif;cursor:pointer;',
		del: 'flex:0 0 auto;background:none;border:1px solid #dbe1ea;color:#6b7280;border-radius:999px;width:30px;height:30px;font:700 14px/1 Manrope,system-ui,Arial,sans-serif;cursor:pointer;',
	};

	function renderBanner(mount) {
		var drafts = readAll()[cfg.form] || [];
		if (bannerEl) { bannerEl.remove(); bannerEl = null; }
		if (!drafts.length) return;
		var el = document.createElement('div');
		el.style.cssText = S.card;
		el.innerHTML = '<div style="' + S.hd + '">' +
			(drafts.length === 1 ? 'Υπάρχει πρόχειρο' : 'Υπάρχουν ' + drafts.length + ' πρόχειρα') + '</div>' +
			'<div style="' + S.sub + '">Αποθηκευμένα σε αυτή τη συσκευή · χωρίς υπογραφές. Αλλιώς το έντυπο ξεκινά κενό.</div>';
		drafts.forEach(function (d) {
			var row = document.createElement('div');
			row.style.cssText = S.row;
			row.innerHTML = '<div style="' + S.lbl + '"><div style="' + S.l1 + '">' + esc(labelOf(d)) + '</div>' +
				'<div style="' + S.l2 + '">' + esc(fmtRel(d.updated_at)) + '</div></div>' +
				'<button type="button" style="' + S.go + '">Συνέχεια</button>' +
				'<button type="button" style="' + S.del + '" aria-label="Διαγραφή">×</button>';
			var btns = row.querySelectorAll('button');
			btns[0].onclick = function () { loadDraft(d); };
			btns[1].onclick = function () {
				if (!window.confirm('Διαγραφή προχείρου «' + labelOf(d) + '»;')) return;
				removeDraft(cfg.form, d.id);
				renderBanner(mount);
			};
			el.appendChild(row);
		});
		mount.insertBefore(el, mount.firstChild);
		bannerEl = el;
	}

	/* ---------- page adapter ---------- */
	function register(c) {
		cfg = c;
		writeAll(prune(readAll()));
		try { snapshot(); } catch (e) { baseVals = {}; baseJson = '{}'; }

		var mount = typeof c.mount === 'string' ? document.querySelector(c.mount) : c.mount;
		if (mount && !c.onSave) {
			statusEl = document.createElement('div');
			statusEl.style.cssText = 'display:none;font-size:11.5px;color:#6b7280;text-align:center;margin:0 0 10px;font-family:Manrope,system-ui,Arial,sans-serif;';
			mount.insertBefore(statusEl, mount.firstChild);
		}

		/* Deep link from the index page: ?draft=<id> opens that draft. */
		var m = location.search.match(/[?&]draft=([^&]+)/);
		if (m) {
			var want = decodeURIComponent(m[1]);
			var found = (readAll()[c.form] || []).filter(function (d) { return d.id === want; })[0];
			if (found) loadDraft(found);
		}
		if (curId == null && mount) renderBanner(mount);

		/* Autosave triggers. Typing fires input/change; segment buttons,
		   steppers and the CRM pickers only fire clicks — the debounced
		   collect()-and-compare makes the extra wake-ups free. */
		document.addEventListener('input', touch, true);
		document.addEventListener('change', touch, true);
		document.addEventListener('click', function (e) {
			if (e.target && e.target.closest && e.target.closest('button,[role="button"],label,input,select,.pill')) touch();
		}, true);
		/* Locking the iPad or leaving the page must not lose the last
		   keystrokes — flush the pending debounce synchronously. */
		window.addEventListener('pagehide', flushNow);
		document.addEventListener('visibilitychange', function () { if (document.hidden) flushNow(); });
	}

	/* one-off migration (katachorisi's old single-draft key) */
	function importDraft(form, v, label) {
		if (!v || typeof v !== 'object') return;
		var o = readAll();
		var now = new Date().toISOString();
		(o[form] = o[form] || []).unshift({ id: newId(), label: label || '', created_at: now, updated_at: now, v: v });
		writeAll(prune(o));
	}

	/* ---------- index page ---------- */
	function renderHome(el) {
		if (!el) return;
		function paint() {
			var o = prune(readAll()); writeAll(o);
			var rows = [];
			Object.keys(o).forEach(function (f) { o[f].forEach(function (d) { rows.push({ form: f, d: d }); }); });
			rows.sort(function (a, b) { return String(b.d.updated_at).localeCompare(String(a.d.updated_at)); });
			if (!rows.length) { el.innerHTML = ''; return; }
			var html = '<div style="font-weight:800;font-size:12px;letter-spacing:.1em;color:#6b7280;margin:2px 2px 10px;">ΠΡΟΧΕΙΡΑ</div>';
			el.innerHTML = html;
			rows.forEach(function (r) {
				var row = document.createElement('div');
				row.style.cssText = 'display:flex;align-items:center;gap:12px;background:#fff;border:1px solid #dbe1ea;border-left:4px solid #1C3457;border-radius:14px;padding:14px 16px;margin-bottom:10px;box-shadow:0 2px 10px rgba(20,30,50,.06);';
				row.innerHTML = '<div style="flex:1;min-width:0;">' +
					'<div style="font-weight:800;color:#1C3457;font-size:14.5px;">' + esc(TITLES[r.form] || r.form) + '</div>' +
					'<div style="font-size:13px;color:#242a33;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(labelOf(r.d)) + '</div>' +
					'<div style="font-size:12px;color:#6b7280;margin-top:1px;">' + esc(fmtRel(r.d.updated_at)) + '</div></div>' +
					'<a style="' + S.go + 'text-decoration:none;" href="' + esc(r.form) + '.html?draft=' + encodeURIComponent(r.d.id) + '">Συνέχεια</a>' +
					'<button type="button" style="' + S.del + '" aria-label="Διαγραφή">×</button>';
				row.querySelector('button').onclick = function () {
					if (!window.confirm('Διαγραφή προχείρου «' + labelOf(r.d) + '»;')) return;
					removeDraft(r.form, r.d.id);
					paint();
				};
				el.appendChild(row);
			});
			el.style.marginBottom = '18px';
		}
		paint();
		/* back-navigation from a form restores the page from bfcache —
		   repaint so a just-deleted or just-sent draft disappears; same for
		   an index tab that was open in the background all along */
		window.addEventListener('pageshow', paint);
		document.addEventListener('visibilitychange', function () { if (!document.hidden) paint(); });
	}

	window.FWDrafts = {
		register: register, touch: touch, discard: discard, rebase: rebase,
		importDraft: importDraft, renderHome: renderHome,
	};
})();
