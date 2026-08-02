/* =====================================================================
   Four Walls Έντυπα: περιοχή και διεύθυνση με autocomplete (.fw)
   ---------------------------------------------------------------------
   Δύο πεδία της «Εκτίμησης» που μοιάζουν ισοδύναμα και δεν είναι:

   • ΠΕΡΙΟΧΗ. Οδηγεί ΤΑ ΠΑΝΤΑ στον υπολογισμό: την άγκυρα €/τ.μ., τη
     ζώνη (prime/urban/regional), το μερίδιο γης, τα μισθώματα των
     επαγγελματικών, το φιλτράρισμα των συγκριτικών. Και μέχρι τώρα ήταν
     ελεύθερο κείμενο: ένα «Καλαμριά» δεν ταίριαζε με καμία γραμμή του
     πίνακα, ο `findAreaPrices` γύριζε null και η εκτίμηση έβγαινε ΧΩΡΙΣ
     ΑΓΚΥΡΑ χωρίς να το πάρει είδηση κανείς. Τώρα ο σύμβουλος διαλέγει
     από τις περιοχές που ο πίνακας πραγματικά ξέρει, και βλέπει με τα
     μάτια του αν αυτό που έγραψε αναγνωρίστηκε.

   • ΔΙΕΥΘΥΝΣΗ. Δεν μπαίνει στον υπολογισμό (πάει στο όνομα του PDF και
     στον πίνακα «τα στοιχεία που δόθηκαν»), αλλά η επιλογή της ξέρει
     ΠΟΥ είναι ο δρόμος, άρα γεμίζει την περιοχή και την απόσταση από τη
     στάση μετρό, και ΑΥΤΗ αλλάζει το νούμερο (premium έως ~150 μ.,
     σβήνει στα ~350· docs/valuation.md).

   ΓΙΑΤΙ ΤΟΠΙΚΟΣ ΚΑΤΑΛΟΓΟΣ ΚΑΙ ΟΧΙ GEOCODING API: τα δωρεάν APIs
   δοκιμάστηκαν (2026-08-02) και αποτυγχάνουν στα ελληνικά: το Photon
   γυρίζει Πορτογαλία για «Μεταμορφώσεως», το Nominatim γυρίζει κενό για
   «Τσιμισκή, Θεσσαλονίκη». Τα δεδομένα υπάρχουν στο OSM· το text search
   τους φταίει. Οπότε ο κατάλογος κατεβαίνει μία φορά με το
   `node tools/build-streets.mjs` και ψάχνει η ίδια η συσκευή: δουλεύει
   OFFLINE (όπως όλο το PWA), ταιριάζει ΧΩΡΙΣ ΤΟΝΟΥΣ, είναι ακαριαίο και
   δεν έχει ούτε κλειδί ούτε rate limit ούτε κόστος.

   API (window.FWPlaces):
     attach(cfg), όπου cfg:
        area     id/element του input περιοχής
        address  id/element του input διεύθυνσης (προαιρετικό)
        metro    id/element του input «απόσταση από μετρό» (προαιρετικό)
        onPick   optional (info)->void μετά από επιλογή διεύθυνσης
   ===================================================================== */
(function () {
	"use strict";

	var MAX_ROWS = 7;             // όσα χωράνε σε οθόνη κινητού χωρίς σκρολ
	var MIN_CHARS = 2;
	var NEAR_M = 1500;            // πάνω από αυτό, «δεν υπάρχει κοντά»

	function el(x) {
		return typeof x === "string" ? document.getElementById(x) : x;
	}

	/* Χωρίς τόνους, πεζά, τελικό σίγμα ενοποιημένο. Ο σύμβουλος στον δρόμο
	   γράφει «τσιμισκη», και ΠΡΕΠΕΙ να βρει την «Τσιμισκή». Αυτό ακριβώς
	   δεν κάνει κανένας από τους δωρεάν geocoders, και δεν το κάνει ούτε
	   το <datalist> του browser, γι' αυτό το dropdown είναι δικό μας. */
	function norm(s) {
		return String(s == null ? "" : s)
			.toLowerCase()
			.normalize("NFD")
			.replace(/[̀-ͯ]/g, "")
			.replace(/ς/g, "σ")
			.replace(/\s+/g, " ")
			.trim();
	}

	function metres(aLat, aLon, bLat, bLon) {
		var R = 6371000, rad = function (x) { return (x * Math.PI) / 180; };
		var dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
		var s = Math.sin(dLat / 2) * Math.sin(dLat / 2)
			+ Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
		return 2 * R * Math.asin(Math.sqrt(s));
	}

	/* ---------------------------------------------------- ο κατάλογος */

	var DATA = window.FW_STREETS || null;
	var AREAS = [];               // [{name, norm}]
	var STREETS = [];             // [{name, norm, area, lat, lon}]
	var METRO = [];               // [{name, lat, lon, live}]

	if (DATA) {
		/* Οι περιοχές έρχονται από το `areaNames` (ΟΛΟΣ ο πίνακας τιμών) και
		   όχι από το `areas` (μόνο όσες έχουν δρόμους): μια περιοχή που
		   σκόνταψε στο κατέβασμα πρέπει να παραμένει επιλέξιμη, αλλιώς η
		   αποτυχία του βοηθητικού θα έσπαγε το κρίσιμο. */
		(DATA.areaNames || (DATA.areas || []).map(function (p) { return p[0]; }))
			.forEach(function (area, i) {
				AREAS.push({
					name: area, norm: norm(area),
					zone: (DATA.zones && DATA.zones[i]) || "regional",
				});
			});
		/* Το `rank` της περιοχής είναι η θέση της στον πίνακα τιμών, που
		   ξεκινά από το Κέντρο Θεσσαλονίκης και κατεβαίνει προς την επαρχία,
		   δηλαδή είναι ήδη ταξινομημένος κατά το πού δουλεύει το γραφείο.
		   Χρειάζεται ως tie-break: το OSM έχει «Αγιας Σοφίας» (χωρίς τόνο,
		   τυπογραφικό) στα Νέα Μουδανιά, που κέρδιζε αλφαβητικά την «Αγίας
		   Σοφίας» του κέντρου και έβγαινε πρώτη επιλογή 60 km μακριά. */
		(DATA.areas || []).forEach(function (pair, idx) {
			var area = pair[0], rank = -1;
			for (var a = 0; a < AREAS.length; a++) if (AREAS[a].name === area) { rank = a; break; }
			if (rank < 0) rank = 999;
			var far = AREAS[rank] && AREAS[rank].zone === "regional";
			(pair[1] || []).forEach(function (s) {
				STREETS.push({
					name: s[0], norm: norm(s[0]), area: area,
					areaRank: rank, far: far, lat: s[1], lon: s[2],
				});
			});
		});
		METRO = (DATA.metro || []).map(function (m) {
			return { name: m[0], lat: m[1], lon: m[2], live: m[3] === 1 };
		});
	}

	/* Το ίδιο χαλαρό ταίριασμα που κάνει ο Worker στο findAreaPrices
	   (worker/lib/area-prices.mjs). Κρατιούνται ΣΚΟΠΙΜΑ ίδια: αν εδώ πει
	   «✓ στον πίνακα» και εκεί δεν βρει γραμμή, η ένδειξη γίνεται ψέμα. */
	function matchArea(text) {
		var want = norm(text);
		if (!want) return null;
		var best = null;
		for (var i = 0; i < AREAS.length; i++) {
			var have = AREAS[i].norm;
			if (have === want) return AREAS[i];
			if (!best && (have.indexOf(want) >= 0 || want.indexOf(have.split(" ")[0]) >= 0)) best = AREAS[i];
			if (!best) {
				var parts = have.split(/[\s/(),]+/);
				for (var p = 0; p < parts.length; p++) {
					if (parts[p].length > 3 && want.indexOf(parts[p]) >= 0) { best = AREAS[i]; break; }
				}
			}
		}
		return best;
	}

	/* Ο αριθμός γράφεται μαζί με τον δρόμο («Τσιμισκή 43»), αλλά ο
	   κατάλογος έχει μόνο ονόματα. Τον κόβουμε για την αναζήτηση και τον
	   ξανακολλάμε στην επιλογή, ώστε να μη χρειάζεται δεύτερο πεδίο. */
	function splitNumber(text) {
		var m = String(text || "").match(/^(.*?)[\s,]+(\d+[Α-Ωα-ωA-Za-z]?)\s*$/);
		return m ? { street: m[1], number: m[2] } : { street: String(text || ""), number: "" };
	}

	/* Κατάταξη: πρώτα ό,τι ΑΡΧΙΖΕΙ από ό,τι πληκτρολογήθηκε, μετά ό,τι
	   έχει λέξη που αρχίζει έτσι, τελευταία ό,τι απλώς το περιέχει. Μέσα
	   σε κάθε βαθμίδα προηγείται η επιλεγμένη περιοχή: ο ίδιος δρόμος
	   υπάρχει σε πέντε δήμους και ο σωστός είναι σχεδόν πάντα ο τοπικός. */
	function searchStreets(text, areaName) {
		var q = norm(splitNumber(text).street);
		if (q.length < MIN_CHARS) return [];
		var inArea = areaName ? norm(areaName) : "";
		var hits = [];
		for (var i = 0; i < STREETS.length; i++) {
			var s = STREETS[i], rank;
			if (s.norm.indexOf(q) === 0) rank = 0;
			else if (s.norm.indexOf(" " + q) >= 0) rank = 1;
			else if (s.norm.indexOf(q) >= 0) rank = 2;
			else continue;
			/* Ένας δρόμος στην επαρχία υποβιβάζεται ΜΙΑ βαθμίδα. Το γραφείο
			   είναι στη Θεσσαλονίκη, και ο κεντρικός της δρόμος λέγεται
			   «Ιωάννη Τσιμισκή»: χωρίς αυτό, το «τσιμισκη» έβγαζε πρώτες τις
			   σκέτες «Τσιμισκή» της Κατερίνης και των Σερρών, που ταιριάζουν
			   από τον πρώτο χαρακτήρα. Η ρητή επιλογή περιοχής υπερισχύει
			   πάντα και των δύο. */
			if (s.far) rank += 1;
			if (inArea && norm(s.area) === inArea) rank -= 2;
			hits.push({ s: s, rank: rank });
		}
		hits.sort(function (a, b) {
			return a.rank - b.rank
				|| a.s.areaRank - b.s.areaRank        // κεντρικές περιοχές πρώτα
				|| a.s.name.length - b.s.name.length
				|| a.s.name.localeCompare(b.s.name, "el");
		});
		/* Ίδιο όνομα + ίδια περιοχή = μία γραμμή. Και το πολύ SAME_NAME
		   γραμμές ανά όνομα: τα bbox των γειτονικών συνοικιών επικαλύπτονται
		   επίτηδες, οπότε η «Παπάφη» εμφανιζόταν σε επτά περιοχές και έπιανε
		   ΟΛΟ το dropdown, κρύβοντας κάθε άλλο δρόμο που ταίριαζε. Οι
		   κοντινότερες στην επιλεγμένη περιοχή είναι ήδη πρώτες. */
		var SAME_NAME = 3;
		var seen = {}, perName = {}, out = [];
		for (var h = 0; h < hits.length && out.length < MAX_ROWS; h++) {
			var s2 = hits[h].s, key = s2.norm + "|" + s2.area;
			if (seen[key]) continue;
			if ((perName[s2.norm] || 0) >= SAME_NAME) continue;
			seen[key] = 1;
			perName[s2.norm] = (perName[s2.norm] || 0) + 1;
			out.push(s2);
		}
		return out;
	}

	function searchAreas(text) {
		var q = norm(text);
		var out = [];
		for (var i = 0; i < AREAS.length && out.length < MAX_ROWS; i++) {
			if (!q || AREAS[i].norm.indexOf(q) >= 0) out.push(AREAS[i]);
		}
		if (!out.length) {                       // «Τουμπα» → «Τούμπα»
			var m = matchArea(text);
			if (m) out.push(m);
		}
		return out;
	}

	/* Κοντινότερη ΛΕΙΤΟΥΡΓΟΥΣΑ στάση. Οι υπό κατασκευή γυρίζουν χωριστά:
	   η αγορά τις τιμολογεί, αλλά όχι όπως μια στάση που δουλεύει, οπότε
	   την απόφαση την παίρνει ο σύμβουλος, όχι εμείς σιωπηλά. */
	function nearestMetro(lat, lon) {
		var live = null, soon = null;
		for (var i = 0; i < METRO.length; i++) {
			var m = METRO[i], d = metres(lat, lon, m.lat, m.lon);
			var cur = { name: m.name, m: d };
			if (m.live) { if (!live || d < live.m) live = cur; }
			else if (!soon || d < soon.m) soon = cur;
		}
		return { live: live, soon: soon };
	}

	/* ------------------------------------------------------------ UI */

	function makeBox(input) {
		var wrap = document.createElement("div");
		wrap.className = "acwrap";
		input.parentNode.insertBefore(wrap, input);
		wrap.appendChild(input);
		var box = document.createElement("div");
		box.className = "acbox";
		box.hidden = true;
		wrap.appendChild(box);
		return box;
	}

	/* Ένα generic dropdown για τα δύο πεδία. `render` δίνει το HTML της
	   γραμμής, `pick` τρέχει στην επιλογή. Το mousedown (όχι click) είναι
	   σκόπιμο: το blur του input προλαβαίνει το click και θα έκλεινε το
	   dropdown πριν προλάβει να διαλέξει ο χρήστης. */
	function bind(input, cfg) {
		var box = makeBox(input);
		var items = [], active = -1;

		function close() { box.hidden = true; active = -1; }

		function paint(list) {
			items = list;
			if (!list.length) return close();
			box.innerHTML = list.map(function (it, i) {
				return '<div class="acrow' + (i === active ? " on" : "") + '" data-i="' + i + '">'
					+ cfg.render(it) + "</div>";
			}).join("");
			box.hidden = false;
		}

		function choose(i) {
			if (!items[i]) return;
			cfg.pick(items[i]);
			close();
		}

		input.addEventListener("input", function () {
			if (cfg.onEdit) cfg.onEdit();
			paint(cfg.search(input.value));
		});
		input.addEventListener("focus", function () {
			if (cfg.openOnFocus || input.value.trim()) paint(cfg.search(input.value));
		});
		input.addEventListener("blur", function () {
			setTimeout(close, 120);
			if (cfg.onBlur) cfg.onBlur();
		});
		input.addEventListener("keydown", function (e) {
			if (box.hidden) return;
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				active = Math.max(0, Math.min(items.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
				paint(items);
			} else if (e.key === "Enter") {
				if (active >= 0) { e.preventDefault(); choose(active); }
			} else if (e.key === "Escape") {
				close();
			}
		});
		box.addEventListener("mousedown", function (e) {
			var row = e.target.closest(".acrow");
			if (!row) return;
			e.preventDefault();
			choose(+row.dataset.i);
		});
		return { close: close };
	}

	function esc(s) {
		return String(s).replace(/[&<>"]/g, function (c) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
		});
	}

	/* --------------------------------------------------------- attach */

	function attach(cfg) {
		var areaIn = el(cfg.area);
		var addrIn = cfg.address ? el(cfg.address) : null;
		var metroIn = cfg.metro ? el(cfg.metro) : null;
		if (!areaIn || !DATA) return;             // χωρίς κατάλογο, τα πεδία μένουν απλά inputs

		/* Η ένδειξη κάτω από την περιοχή. Δεν εμποδίζει τίποτα, γιατί μια
		   περιοχή εκτός πίνακα είναι θεμιτή (η εκτίμηση απλώς πλαταίνει
		   το εύρος), αλλά παύει να είναι αόρατη. */
		var note = document.createElement("div");
		note.className = "acnote";
		areaIn.parentNode.appendChild(note);

		function sayArea() {
			var v = areaIn.value.trim();
			if (!v) { note.textContent = ""; note.className = "acnote"; return; }
			var m = matchArea(v);
			/* Οι κλάσεις είναι `acgood`/`acout` επίτηδες: η φόρμα έχει δική
			   της `.warn` (το πλαίσιο των κρίσιμων που λείπουν) και ένα
			   σκέτο «warn» εδώ την κληρονομούσε. */
			if (m && norm(m.name) === norm(v)) {
				note.textContent = "Στον πίνακα τιμών.";
				note.className = "acnote acgood";
			} else if (m) {
				note.textContent = "Θα μετρήσει ως «" + m.name + "».";
				note.className = "acnote acgood";
			} else {
				note.textContent = "Εκτός πίνακα τιμών: η εκτίμηση θα δώσει πλατύτερο εύρος.";
				note.className = "acnote acout";
			}
		}

		bind(areaIn, {
			openOnFocus: true,
			search: searchAreas,
			render: function (a) { return esc(a.name); },
			pick: function (a) { areaIn.value = a.name; sayArea(); },
			onBlur: sayArea,
		});
		if (areaIn.value.trim()) sayArea();

		/* Η επιλογή ακινήτου από το CRM γεμίζει την περιοχή με κώδικα, χωρίς
		   input event: χωρίς αυτό η ένδειξη θα έμενε από την προηγούμενη
		   τιμή, δηλαδή θα έλεγε ψέματα ακριβώς εκεί που δεν το περιμένεις. */
		window.FWPlaces.refresh = sayArea;

		if (!addrIn) return;

		var addrNote = document.createElement("div");
		addrNote.className = "acnote";
		addrIn.parentNode.appendChild(addrNote);

		bind(addrIn, {
			search: function (t) { return searchStreets(t, areaIn.value); },
			/* Η ένδειξη του μετρό ανήκει στον δρόμο που ΕΠΙΛΕΧΘΗΚΕ. Μόλις
			   αλλάξει το κείμενο, δεν ισχύει πια: χωρίς αυτό, σβήνεις τον
			   δρόμο και γράφεις άλλον, και από κάτω μένει η απόσταση του
			   προηγούμενου, δηλαδή ένα λάθος νούμερο με ύφος βεβαιότητας. */
			onEdit: function () { addrNote.textContent = ""; },
			render: function (s) {
				return esc(s.name) + '<span class="acsub">' + esc(s.area) + "</span>";
			},
			pick: function (s) {
				var num = splitNumber(addrIn.value).number;
				addrIn.value = s.name + (num ? " " + num : "");

				// Η περιοχή γεμίζει ΜΟΝΟ αν είναι κενή: ό,τι έγραψε ο
				// σύμβουλος (ή ήρθε από το CRM) δεν το πατάει ο κατάλογος.
				if (!areaIn.value.trim()) { areaIn.value = s.area; sayArea(); }

				var near = nearestMetro(s.lat, s.lon);
				var bits = [];
				if (near.live && near.live.m <= NEAR_M) {
					var d = Math.round(near.live.m / 50) * 50;
					if (metroIn && !metroIn.value.trim()) metroIn.value = String(d);
					bits.push("Μετρό «" + near.live.name + "» ~" + d + " μ.");
				}
				if (near.soon && near.soon.m <= NEAR_M
					&& (!near.live || near.soon.m < near.live.m)) {
					bits.push("υπό κατασκευή «" + near.soon.name + "» ~"
						+ Math.round(near.soon.m / 50) * 50 + " μ.");
				}
				// Το κεντροειδές είναι το ΜΕΣΟ του δρόμου, όχι το κτίριο:
				// σε μεγάλο δρόμο η απόσταση αστοχεί εύκολα 300 μ. Λέγεται
				// ρητά ώστε ο σύμβουλος να τη διορθώσει όταν ξέρει.
				addrNote.textContent = bits.length
					? bits.join(" · ") + " (κατά προσέγγιση, από το μέσο του δρόμου)"
					: "";
				addrNote.className = "acnote";
				if (cfg.onPick) cfg.onPick({ street: s, metro: near });
			},
		});
	}

	window.FWPlaces = {
		attach: attach, matchArea: matchArea, norm: norm,
		refresh: function () {},        // αντικαθίσταται από το attach
	};
})();
