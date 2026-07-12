/* =====================================================================
   Four Walls — listings renderer (grid + detail)
   ---------------------------------------------------------------------
   Renders real listings from the feed at data/listings.json (built by
   the Cloudflare Worker from the EstatePrime CRM — docs/listings-feed.md).

   Pages:
     akinita.html  — grid + filters. Activates when #fw-grid exists.
                     Reads initial filters from the URL (?transaction=
                     sale|rent, type=apartment|maisonette|house|commercial|
                     land, area=<text>, price=1..5, sort=...).
     akinito.html  — single listing. Activates when #fw-detail exists.
                     Served at /akinita/<code> (the listing's public
                     «Κωδικός»; Worker + preview-server rewrite); ?id=
                     still works as a fallback and accepts id or code,
                     and old /akinito/<code> links 301 to /akinita/.
     index.html    — «Νέες καταχωρήσεις» row: the 3 newest listings
                     (#fw-latest), and the «Επιλεγμένο ακίνητο» banner
                     (#fw-featured, see FEATURED_ID).

   No pagination by design — the stock is a few dozen listings.
   ===================================================================== */
(function () {
	"use strict";

	var FEED_URL = "data/listings.json";

	/* «Επιλεγμένο ακίνητο του μήνα» (index) — normally driven by the CRM:
	   the listing tagged FEATURED_TAG in EstatePrime arrives in the feed
	   with featured:true (see worker/lib/estateprime.mjs). This code (the
	   listing's public «Κωδικός») is the fallback while nothing is tagged;
	   last resort is the newest listing (e.g. sample-data mode). */
	var FEATURED_ID = "210694";

	/* ---------------- Greek labels for CRM slugs ---------------- */

	var SUBCATEGORY = {
		apartment: "Διαμέρισμα", maisonette: "Μεζονέτα", detached: "Μονοκατοικία",
		house: "Μονοκατοικία", studio: "Στούντιο",
		villa: "Βίλα", loft: "Loft", residential_building: "Κτίριο κατοικιών",
		apartment_complex: "Συγκρότημα διαμερισμάτων", farmhouse: "Αγροικία",
		houseboat: "Πλωτή κατοικία", other_residential: "Άλλη κατοικία",
		office: "Γραφείο", store: "Κατάστημα", warehouse: "Αποθήκη",
		hotel: "Ξενοδοχείο", commercial_building: "Επαγγελματικό κτίριο",
		hall: "Αίθουσα", industrial_space: "Βιομηχανικός χώρος",
		craft_space: "Βιοτεχνικός χώρος", other_commercial: "Άλλο επαγγελματικό",
		plot: "Οικόπεδο", parcel: "Αγροτεμάχιο", island: "Νησί",
		parking: "Πάρκινγκ", business: "Επιχείρηση", air: "Αέρας", other: "Άλλο"
	};

	var TRANSACTION = {
		sale: "Πώληση", rent: "Ενοικίαση",
		auction: "Πλειστηριασμός", shortterm: "Βραχυχρόνια"
	};

	var FEATURES = {
		has_security_door: "Πόρτα ασφαλείας", has_storage_room: "Αποθήκη",
		has_elevator: "Ασανσέρ", has_attic: "Σοφίτα", has_screens: "Σίτες",
		has_fireplace: "Τζάκι", has_internal_stairs: "Εσωτερική σκάλα",
		is_furnished: "Επιπλωμένο", has_alarm: "Συναγερμός",
		pets_allowed: "Δεκτά κατοικίδια", is_penthouse: "Ρετιρέ",
		has_awnings: "Τέντες", is_painted: "Βαμμένο", has_fiber: "Οπτική ίνα",
		has_night_electricity: "Νυχτερινό ρεύμα", has_private_pool: "Ιδιωτική πισίνα",
		/* view */ mountain: "Θέα βουνό", openspace: "Ανοιχτωσιά", sea: "Θέα θάλασσα",
		/* positioning */ is_front_facing: "Προσόψεως", is_corner: "Γωνιακό",
		is_interior: "Εσωτερικό",
		/* flooring */ marble: "Δάπεδο: μάρμαρο", ceramic_tile: "Δάπεδο: πλακάκι",
		wood: "Δάπεδο: ξύλο", mosaic: "Δάπεδο: μωσαϊκό"
	};

	var HEATING = {
		individual: "Ατομική", autonomous: "Αυτόνομη",
		central: "Κεντρική", none: "Χωρίς θέρμανση"
	};

	var CONDITION = {
		new: "Νεόδμητο", good: "Καλή κατάσταση", renovated: "Ανακαινισμένο",
		needs_renovation: "Χρήζει ανακαίνισης", under_construction: "Υπό κατασκευή"
	};

	var ENERGY = {
		ap: "Α+", a: "Α", bp: "Β+", b: "Β", c: "Γ",
		d: "Δ", e: "Ε", f: "Ζ", g: "Η"
	};

	/* Type filter groups (option value -> CRM subcategories) */
	var TYPE_GROUPS = {
		apartment: ["apartment", "loft"],
		maisonette: ["maisonette"],
		house: ["detached", "villa", "farmhouse", "residential_building",
			"apartment_complex", "houseboat", "other_residential"],
		commercial: ["office", "store", "warehouse", "hotel", "commercial_building",
			"hall", "industrial_space", "craft_space", "other_commercial", "business"],
		land: ["plot", "parcel", "island"]
	};

	/* Price bands per transaction (value 1..5, aligned with js/fourwalls.js) */
	var PRICE_BANDS = {
		sale: [[0, 100000], [100000, 200000], [200000, 300000], [300000, 500000], [500000, Infinity]],
		rent: [[0, 400], [400, 600], [600, 900], [900, 1500], [1500, Infinity]]
	};

	/* ---------------- helpers ---------------- */

	function el(tag, className, text) {
		var node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	}

	/* Direct src (not data-src): the theme's lazy loader only scans at boot,
	   before these dynamic nodes exist. */
	function icon(name, className) {
		var img = document.createElement("img");
		img.src = "images/icon/" + name + ".svg";
		img.alt = "";
		img.className = className || "icon";
		return img;
	}

	function fmtNumber(n) {
		return new Intl.NumberFormat("el-GR").format(n);
	}

	function fmtPrice(listing) {
		if (listing.price == null) return "Κατόπιν επικοινωνίας";
		var out = "€" + fmtNumber(listing.price);
		if (listing.transaction === "rent" || listing.transaction === "shortterm") out += "/μήνα";
		return out;
	}

	function subcategoryLabel(l) {
		return SUBCATEGORY[l.subcategory] || SUBCATEGORY[l.category] || l.subcategory || "";
	}

	function shortAddress(l) {
		var parts = [];
		if (l.location.neighbourhood && l.location.neighbourhood !== l.location.area) parts.push(l.location.neighbourhood);
		if (l.location.area) parts.push(l.location.area);
		if (!parts.length && l.location.city) parts.push(l.location.city);
		return parts.join(", ");
	}

	/* Detail-page URL — path style with the listing's public code, the
	   «Κωδικός» shown on the listing (/akinita/2341241). The Worker (and
	   tools/preview-server.js locally) rewrites these paths to
	   akinito.html; root-absolute so it resolves the same from every
	   page, including the detail page itself. */
	function detailUrl(l) {
		return "/akinita/" + encodeURIComponent(l.code || l.id);
	}

	/* Look a listing up by what a URL may carry — the public code
	   (canonical) or the internal id (older links). */
	function findByKey(feed, key) {
		return feed.listings.find(function (x) { return x.code === key || x.id === key; });
	}

	function fetchFeed() {
		return fetch(FEED_URL).then(function (res) {
			if (!res.ok) throw new Error("feed " + res.status);
			return res.json();
		});
	}

	/* Shared listing card — used by the akinita grid and the index home row. */
	function listingCard(l, colClass) {
		var col = el("div", colClass);
		var photos = l.images.slice(0, 3);
		if (!photos.length) photos = ["images/lazy.svg"];
		var cid = "fwc-" + l.id;
		var href = detailUrl(l);

		var indicators = photos.map(function (_, i) {
			return '<button type="button" data-bs-target="#' + cid + '" data-bs-slide-to="' + i + '"' +
				(i === 0 ? ' class="active" aria-current="true"' : '') + ' aria-label="Φωτογραφία ' + (i + 1) + '"></button>';
		}).join("");
		var slides = photos.map(function (src, i) {
			return '<div class="carousel-item' + (i === 0 ? " active" : "") + '">' +
				'<a href="' + href + '" class="d-block"><img src="' + encodeURI(src) + '" class="w-100" loading="lazy" alt=""></a></div>';
		}).join("");

		col.innerHTML =
			'<div class="listing-card-one border-25 h-100 w-100">' +
				'<div class="img-gallery p-15">' +
					'<div class="position-relative border-25 overflow-hidden">' +
						'<div class="tag border-25' + (l.transaction === "sale" ? " sale" : "") + '"></div>' +
						'<div id="' + cid + '" class="carousel slide">' +
							(photos.length > 1 ? '<div class="carousel-indicators">' + indicators + '</div>' : '') +
							'<div class="carousel-inner">' + slides + '</div>' +
						'</div>' +
					'</div>' +
				'</div>' +
				'<div class="property-info p-25">' +
					'<a href="' + href + '" class="title tran3s stretched-link"></a>' +
					'<div class="address"></div>' +
					'<ul class="style-none feature d-flex flex-wrap align-items-center justify-content-between"></ul>' +
					'<div class="pl-footer top-border d-flex align-items-center justify-content-between">' +
						'<strong class="price fw-500 color-dark"></strong>' +
						'<a href="' + href + '" class="btn-four rounded-circle"><i class="bi bi-arrow-up-right"></i></a>' +
					'</div>' +
				'</div>' +
			'</div>';

		/* Text via textContent — CRM strings must never parse as HTML. */
		var cardTitle = subcategoryLabel(l) + (l.area ? " " + fmtNumber(l.area) + " τ.μ." : "");
		col.querySelector(".tag").textContent = TRANSACTION[l.transaction] || l.transaction || "";
		col.querySelector(".title").textContent = cardTitle;
		col.querySelector(".address").textContent = shortAddress(l);
		/* alt via property assignment (never innerHTML) for the same reason. */
		col.querySelectorAll(".carousel-item img").forEach(function (img, i) {
			img.alt = cardTitle + (shortAddress(l) ? ", " + shortAddress(l) : "") + " — φωτογραφία " + (i + 1);
		});
		var feats = col.querySelector(".feature");
		[[l.area != null, "icon_04", fmtNumber(l.area) + " τ.μ."],
		 [l.bedrooms != null && l.bedrooms > 0, "icon_05", l.bedrooms + " υπν."],
		 [l.bathrooms != null && l.bathrooms > 0, "icon_06", l.bathrooms + " μπάνι" + (l.bathrooms === 1 ? "ο" : "α")]]
			.forEach(function (row) {
				if (!row[0]) return;
				var li = el("li", "d-flex align-items-center");
				li.appendChild(icon(row[1], "icon me-2"));
				li.appendChild(el("span", "fs-16", row[2]));
				feats.appendChild(li);
			});
		var price = col.querySelector(".price");
		if (l.price != null && (l.transaction === "rent" || l.transaction === "shortterm")) {
			price.textContent = "€" + fmtNumber(l.price) + "/";
			price.appendChild(el("sub", null, "μήνα"));
		} else {
			price.textContent = fmtPrice(l);
		}
		return col;
	}

	/* ---------------- grid page (akinita.html) ---------------- */

	function initGrid(feed) {
		var grid = document.getElementById("fw-grid");
		var listings = feed.listings;
		var params = new URLSearchParams(window.location.search);

		var controls = {
			transaction: document.getElementById("fw-f-transaction"),
			type: document.getElementById("fw-f-type"),
			area: document.getElementById("fw-f-area"),
			price: document.getElementById("fw-f-price"),
			sort: document.getElementById("fw-sort"),
			/* extra filters (advanceFilterModal) */
			bedrooms: document.getElementById("fw-f-bedrooms"),
			bathrooms: document.getElementById("fw-f-bathrooms"),
			areaMin: document.getElementById("fw-f-area-min"),
			areaMax: document.getElementById("fw-f-area-max"),
			keyword: document.getElementById("fw-f-keyword")
		};

		/* Areas straight from the feed, alphabetically (Greek collation). */
		var areas = Array.from(new Set(listings.map(function (l) { return l.location.area; })
			.filter(Boolean))).sort(function (a, b) { return a.localeCompare(b, "el"); });
		areas.forEach(function (a) {
			var opt = document.createElement("option");
			opt.value = a;
			opt.textContent = a;
			controls.area.appendChild(opt);
		});

		/* Preselect from URL (hero form / category links land here). */
		["transaction", "type", "sort", "bedrooms", "bathrooms"].forEach(function (key) {
			var v = params.get(key);
			if (v && controls[key] && controls[key].querySelector('option[value="' + v + '"]')) {
				controls[key].value = v;
			}
		});
		[["amin", "areaMin"], ["amax", "areaMax"], ["q", "keyword"]].forEach(function (pair) {
			var v = params.get(pair[0]);
			if (v && controls[pair[1]]) controls[pair[1]].value = v;
		});
		var areaParam = (params.get("area") || "").trim();
		if (areaParam) {
			/* exact option if it exists, otherwise keep as free-text match */
			var exact = areas.find(function (a) { return a.toLowerCase() === areaParam.toLowerCase(); });
			if (exact) controls.area.value = exact;
		}
		/* Price is preselected AFTER swapPriceOptions: the static markup only
		   holds the placeholder option, so ?price=N has nothing to match until
		   the bands (which depend on the transaction above) are built. */
		swapPriceOptions(controls, false);
		var priceParam = params.get("price");
		if (priceParam && controls.price.querySelector('option[value="' + priceParam + '"]')) {
			controls.price.value = priceParam;
		}

		/* nice-select has already wrapped the selects — refresh them. */
		if (window.jQuery) window.jQuery(".fw-filter-select").niceSelect("update");

		function currentFilters() {
			return {
				transaction: controls.transaction.value,
				type: controls.type.value,
				area: controls.area.value || areaParam,
				price: controls.price.value,
				sort: controls.sort.value,
				bedrooms: controls.bedrooms ? controls.bedrooms.value : "",
				bathrooms: controls.bathrooms ? controls.bathrooms.value : "",
				amin: controls.areaMin ? controls.areaMin.value : "",
				amax: controls.areaMax ? controls.areaMax.value : "",
				q: controls.keyword ? controls.keyword.value.trim() : ""
			};
		}

		function apply() {
			var f = currentFilters();
			var out = listings.filter(function (l) {
				if (f.transaction && l.transaction !== f.transaction) return false;
				if (f.type && TYPE_GROUPS[f.type] &&
					TYPE_GROUPS[f.type].indexOf(l.subcategory) === -1) return false;
				if (f.area) {
					var hay = [l.location.area, l.location.neighbourhood, l.location.city]
						.filter(Boolean).join(" ").toLowerCase();
					if (hay.indexOf(f.area.toLowerCase()) === -1) return false;
				}
				if (f.price) {
					var bands = PRICE_BANDS[f.transaction === "rent" ? "rent" : "sale"];
					var band = bands[Number(f.price) - 1];
					if (band && (l.price == null || l.price < band[0] || l.price >= band[1])) return false;
				}
				if (f.bedrooms && !(l.bedrooms >= Number(f.bedrooms))) return false;
				if (f.bathrooms && !(l.bathrooms >= Number(f.bathrooms))) return false;
				if (f.amin && !(l.area >= Number(f.amin))) return false;
				if (f.amax && !(l.area <= Number(f.amax))) return false;
				if (f.q) {
					var text = [l.code, l.description, subcategoryLabel(l),
						l.location.area, l.location.neighbourhood, l.location.city]
						.filter(Boolean).join(" ").toLowerCase();
					if (text.indexOf(f.q.toLowerCase()) === -1) return false;
				}
				return true;
			});

			out.sort(function (a, b) {
				switch (f.sort) {
					case "price-asc": return (a.price ?? Infinity) - (b.price ?? Infinity);
					case "price-desc": return (b.price ?? -1) - (a.price ?? -1);
					case "area-desc": return (b.area ?? 0) - (a.area ?? 0);
					default: return (b.updatedAt || "").localeCompare(a.updatedAt || "");
				}
			});

			render(out);

			var count = document.getElementById("fw-count");
			if (count) {
				/* no pagination — «X από Y» only makes sense when filters hide some */
				var noun = listings.length === 1 ? " ακίνητο" : " ακίνητα";
				count.innerHTML = out.length === listings.length
					? "<span class=\"color-dark fw-500\">" + listings.length + "</span>" + noun
					: "Εμφάνιση <span class=\"color-dark fw-500\">" + out.length +
						"</span> από <span class=\"color-dark fw-500\">" + listings.length + "</span>" + noun;
			}

			/* keep the URL shareable */
			var qs = new URLSearchParams();
			Object.keys(f).forEach(function (k) { if (f[k]) qs.set(k, f[k]); });
			var q = qs.toString();
			history.replaceState(null, "", window.location.pathname + (q ? "?" + q : ""));
		}

		/* Empty results are a lead, not a dead end: offer to search on the
		   visitor's behalf — the contact message arrives pre-written with
		   their criteria (?msg=, read by js/fourwalls.js) — plus a free
		   valuation link for owners gauging prices in their own area. */
		function selectedLabel(control) {
			if (!control || !control.value) return "";
			var opt = control.options[control.selectedIndex];
			return opt ? opt.textContent : "";
		}

		function searchSummary() {
			var f = currentFilters();
			var parts = [];
			var type = selectedLabel(controls.type);
			if (type) parts.push(type.toLowerCase());
			if (f.transaction) parts.push(f.transaction === "rent" ? "για ενοικίαση" : "για αγορά");
			if (f.area) parts.push("περιοχή " + f.area);
			var price = selectedLabel(controls.price);
			if (price) parts.push("τιμή " + price.toLowerCase());
			if (f.bedrooms) parts.push(f.bedrooms + "+ υπνοδωμάτια");
			if (f.bathrooms) parts.push(f.bathrooms + "+ μπάνια");
			if (f.amin) parts.push("από " + f.amin + " τ.μ.");
			if (f.amax) parts.push("έως " + f.amax + " τ.μ.");
			if (f.q) parts.push("«" + f.q + "»");
			return parts.join(", ");
		}

		/* Same look as the index CTA (fancy-banner-three): title-one heading
		   with the pink swash underline + the theme's btn-five pill. */
		function emptyCta() {
			var summary = searchSummary();
			var msg = "Γεια σας, αναζητώ " + (summary ? "ακίνητο: " + summary : "ακίνητο") +
				". Θα ήθελα να με ενημερώσετε αν προκύψει κάτι αντίστοιχο.";

			var box = el("div", "fw-empty-cta");
			var title = el("div", "title-one mb-35");
			var h = el("h3", null, "Δεν βρήκατε ");
			var accent = el("span", null, "αυτό που ψάχνετε;");
			var swash = document.createElement("img");
			swash.src = "images/shape/title_shape_08.fw.svg";
			swash.alt = "";
			accent.appendChild(swash);
			h.appendChild(accent);
			title.appendChild(h);
			box.appendChild(title);
			box.appendChild(el("p", "fs-20 mb-40",
				"Πείτε μας τι ζητάτε και θα σας ενημερώσουμε μόλις βρεθεί το κατάλληλο ακίνητο."));
			var btn = el("a", "btn-five text-uppercase", "Πείτε μας τι ψάχνετε");
			btn.href = "/contact?msg=" + encodeURIComponent(msg) + "#contact-form";
			box.appendChild(btn);
			var owner = el("p", "fw-cta-alt mt-30");
			owner.appendChild(document.createTextNode("Έχετε δικό σας ακίνητο; "));
			var est = el("a", null, "Ζητήστε δωρεάν εκτίμηση");
			est.href = "/service_ektimisi";
			owner.appendChild(est);
			owner.appendChild(document.createTextNode("."));
			box.appendChild(owner);
			return box;
		}

		function render(items) {
			grid.textContent = "";
			if (!items.length) {
				var empty = el("div", "col-12 text-center pt-40 pb-40");
				empty.appendChild(el("p", "fs-20", "Δεν βρέθηκαν ακίνητα με αυτά τα κριτήρια."));
				var reset = el("a", "fw-reset-btn");
				reset.appendChild(el("i", "bi bi-arrow-repeat"));
				reset.appendChild(document.createTextNode("Καθαρισμός φίλτρων"));
				reset.href = window.location.pathname;
				empty.appendChild(reset);
				empty.appendChild(emptyCta());
				grid.appendChild(empty);
				return;
			}
			items.forEach(function (l) { grid.appendChild(listingCard(l, "col-lg-4 col-md-6 d-flex mb-50")); });
		}

		/* filter events — nice-select re-emits change via jQuery .trigger(),
		   which never reaches addEventListener handlers; bind through jQuery. */
		Object.keys(controls).forEach(function (k) {
			if (!controls[k]) return;
			var onChange = function () {
				if (k === "transaction") swapPriceOptions(controls, true);
				apply();
			};
			if (window.jQuery) window.jQuery(controls[k]).on("change", onChange);
			else controls[k].addEventListener("change", onChange);
		});
		/* «Αναζήτηση» should land the user on the results. While the filter
		   modal is closing Bootstrap still locks body scrolling (and it drops
		   .show before submit fires), so key off body.modal-open and wait for
		   the modal's hidden event before scrolling. */
		function scrollToResults(modal) {
			var target = grid.closest(".property-listing-six") || grid;
			var go = function () { target.scrollIntoView({ behavior: "smooth" }); };
			if (modal && document.body.classList.contains("modal-open")) {
				modal.addEventListener("hidden.bs.modal", go, { once: true });
			} else {
				go();
			}
		}

		var form = document.getElementById("fw-filter-form");
		if (form) form.addEventListener("submit", function (e) { e.preventDefault(); apply(); scrollToResults(); });
		var moreForm = document.getElementById("fw-filter-more-form");
		if (moreForm) moreForm.addEventListener("submit", function (e) { e.preventDefault(); apply(); scrollToResults(moreForm.closest(".modal")); });
		var reset = document.getElementById("fw-filter-reset");
		if (reset) reset.addEventListener("click", function (e) {
			e.preventDefault();
			areaParam = "";
			Object.keys(controls).forEach(function (k) {
				if (controls[k] && k !== "sort") controls[k].value = "";
			});
			swapPriceOptions(controls, true);
			if (window.jQuery) window.jQuery(".fw-filter-select").niceSelect("update");
			apply();
		});

		apply();
	}

	/* Rent and sale price scales differ — rebuild the price options. */
	function swapPriceOptions(controls, refresh) {
		var rent = controls.transaction.value === "rent";
		var labels = rent
			? ["Έως €400/μήνα", "€400-600/μήνα", "€600-900/μήνα", "€900-1.500/μήνα", "€1.500+/μήνα"]
			: ["Έως €100.000", "€100.000-200.000", "€200.000-300.000", "€300.000-500.000", "€500.000+"];
		var keep = controls.price.value;
		controls.price.textContent = "";
		var any = document.createElement("option");
		any.value = "";
		any.textContent = "Οποιαδήποτε τιμή";
		controls.price.appendChild(any);
		labels.forEach(function (label, i) {
			var opt = document.createElement("option");
			opt.value = String(i + 1);
			opt.textContent = label;
			controls.price.appendChild(opt);
		});
		controls.price.value = keep || "";
		if (refresh && window.jQuery) window.jQuery(controls.price).niceSelect("update");
	}

	/* ---------------- detail page (akinito.html) ---------------- */

	function initDetail(feed) {
		/* /akinita/<code> path (canonical; old /akinito/ still matched —
		   the Worker 301s it, but Live-Server-style setups don't), with
		   ?id= kept as fallback; the key may be a public code or id. */
		var m = window.location.pathname.match(/\/akinit[ao]\/([^\/]+?)\/?$/);
		var key = m ? decodeURIComponent(m[1]) : new URLSearchParams(window.location.search).get("id");
		var l = findByKey(feed, key);
		if (!l) {
			document.getElementById("fw-title").textContent = "Το ακίνητο δεν βρέθηκε";
			document.getElementById("fw-detail").querySelectorAll(".fw-when-found")
				.forEach(function (n) { n.style.display = "none"; });
			return;
		}

		/* Heading without the area — the address right below carries it;
		   the browser-tab title keeps it for context. */
		var heading = subcategoryLabel(l) + (l.area ? " " + fmtNumber(l.area) + " τ.μ." : "");
		var title = heading + (l.location.area ? ", " + l.location.area : "");
		document.title = title + " | Four Walls";
		setText("fw-title", heading);
		setText("fw-tag", TRANSACTION[l.transaction] || l.transaction || "");
		setText("fw-address", " " + [shortAddress(l), l.location.city].filter(Boolean).join(", "));
		setText("fw-code", l.code ? "Κωδικός: " + l.code : "");
		setText("fw-price", "Τιμή: " + fmtPrice(l));

		/* Sidebar contact CTA carries the listing reference, so the
		   contact form arrives pre-written (?msg=, read by fourwalls.js) */
		var cta = document.getElementById("fw-contact-cta");
		if (cta) {
			var ask = "Γεια σας, ενδιαφέρομαι για το ακίνητο «" + title + "»" +
				(l.code ? " (κωδ. " + l.code + ")" : "") +
				". Θα ήθελα περισσότερες πληροφορίες.";
			cta.href = "/contact?msg=" + encodeURIComponent(ask) + "#contact-form";
		}

		/* gallery */
		var photos = l.images.length ? l.images : ["images/lazy.svg"];
		var inner = document.getElementById("fw-gallery");
		inner.textContent = "";
		photos.slice(0, 8).forEach(function (src, i) {
			var item = el("div", "carousel-item" + (i === 0 ? " active" : ""));
			var img = document.createElement("img");
			img.src = src;
			img.alt = title + " — φωτογραφία " + (i + 1);
			img.className = "border-20 w-100";
			if (i > 0) img.loading = "lazy";
			item.appendChild(img);
			inner.appendChild(item);
		});
		var thumbs = document.getElementById("fw-thumbs");
		thumbs.textContent = "";
		photos.slice(0, 4).forEach(function (src, i) {
			var b = document.createElement("button");
			b.type = "button";
			b.setAttribute("data-bs-target", "#media_slider");
			b.setAttribute("data-bs-slide-to", String(i));
			if (i === 0) { b.className = "active"; b.setAttribute("aria-current", "true"); }
			b.setAttribute("aria-label", "Φωτογραφία " + (i + 1));
			var img = document.createElement("img");
			img.src = src;
			img.alt = "";
			img.className = "border-10 w-100";
			img.loading = "lazy";
			b.appendChild(img);
			thumbs.appendChild(b);
		});
		var photosBtn = document.getElementById("fw-photos-btn");
		photosBtn.textContent = "";
		if (photos.length > 1 && photos[0] !== "images/lazy.svg") {
			photosBtn.appendChild(document.createTextNode("Δείτε και τις " + photos.length + " φωτογραφίες"));
			photos.forEach(function (src) {
				var a = document.createElement("a");
				a.href = src;
				a.className = "d-block";
				a.setAttribute("data-fancybox", "mainImg");
				a.setAttribute("data-caption", title);
				photosBtn.appendChild(a);
			});
		}

		/* overview strip */
		var ov = document.getElementById("fw-overview");
		ov.textContent = "";
		[[l.area != null, "icon_47", fmtNumber(l.area) + " τ.μ."],
		 [l.bedrooms != null && l.bedrooms > 0, "icon_48", l.bedrooms + " υπνοδωμάτια"],
		 [l.bathrooms != null && l.bathrooms > 0, "icon_49", l.bathrooms + " μπάνια"],
		 [l.floor != null && l.floor !== "", "stairs.fw", "Όροφος: " + l.floor],
		 [true, "icon_51", subcategoryLabel(l)]]
			.forEach(function (row) {
				if (!row[0]) return;
				var li = document.createElement("li");
				li.appendChild(icon(row[1]));
				li.appendChild(el("span", "fs-20 color-dark", row[2]));
				ov.appendChild(li);
			});

		/* description */
		setText("fw-description", l.description || "");

		/* details list */
		var det = document.getElementById("fw-details-list");
		det.textContent = "";
		[["Κωδικός", l.code],
		 ["Τύπος", subcategoryLabel(l)],
		 ["Εμβαδόν", l.area != null ? fmtNumber(l.area) + " τ.μ." : null],
		 ["Υπνοδωμάτια", l.bedrooms],
		 ["Μπάνια", l.bathrooms],
		 ["WC", l.wc],
		 ["Κουζίνες", l.kitchens],
		 ["Σαλόνια", l.livingRooms],
		 ["Όροφος", l.floor],
		 ["Θέσεις στάθμευσης", l.parking],
		 ["Έτος κατασκευής", l.yearBuilt],
		 ["Έτος ανακαίνισης", l.yearRenovated],
		 ["Κατάσταση", CONDITION[l.condition]],
		 ["Θέρμανση", HEATING[l.heating]],
		 ["Ενεργειακή κλάση", ENERGY[l.energyClass]],
		 ["Κοινόχρηστα", l.monthlyMaintenance != null ? "€" + fmtNumber(l.monthlyMaintenance) + "/μήνα" : null]]
			.forEach(function (pair) {
				if (pair[1] == null || pair[1] === "") return;
				var li = document.createElement("li");
				li.appendChild(el("span", null, pair[0] + ": "));
				li.appendChild(el("span", "fw-500 color-dark", String(pair[1])));
				det.appendChild(li);
			});

		/* amenities (features + view + positioning + flooring) */
		var slugs = [].concat(l.features || [], l.view || [], l.positioning || [], l.flooring || []);
		var am = document.getElementById("fw-amenities");
		am.textContent = "";
		slugs.forEach(function (slug) {
			am.appendChild(el("li", null, FEATURES[slug] || slug.replace(/^(has|is)_/, "").replace(/_/g, " ")));
		});
		if (!slugs.length) hide("fw-amenities-block");

		/* video tour */
		if (l.youtubeUrl) {
			document.getElementById("fw-video-link").href = l.youtubeUrl;
			var poster = document.getElementById("fw-video-poster");
			if (poster && photos[0] !== "images/lazy.svg") poster.src = photos[0];
			show("fw-video-block");
		}

		/* map (approximate coordinates by design — privacy) */
		if (l.location.lat != null && l.location.lng != null) {
			document.getElementById("fw-map").src =
				"https://maps.google.com/maps?q=" + l.location.lat + "," + l.location.lng +
				"&z=15&hl=el&output=embed";
		} else {
			hide("fw-map-block");
		}

		/* inquiry message prefill */
		var msg = document.getElementById("fw-inquiry-msg");
		if (msg) msg.placeholder = "Γεια σας, ενδιαφέρομαι για το ακίνητο " + (l.code || title) + ".";

		/* similar listings: same transaction + category, closest price */
		var similar = feed.listings.filter(function (x) {
			return x.id !== l.id && x.transaction === l.transaction && x.category === l.category;
		}).sort(function (a, b) {
			return Math.abs((a.price ?? 0) - (l.price ?? 0)) - Math.abs((b.price ?? 0) - (l.price ?? 0));
		}).slice(0, 3);
		var simRow = document.getElementById("fw-similar");
		simRow.textContent = "";
		if (!similar.length) hide("fw-similar-block");
		similar.forEach(function (s) {
			var col = el("div", "col-md-4 d-flex mb-30");
			var href = detailUrl(s);
			col.innerHTML =
				'<div class="listing-card-one shadow4 style-three border-30 h-100 w-100">' +
					'<div class="img-gallery p-15">' +
						'<div class="position-relative border-20 overflow-hidden">' +
							'<div class="tag bg-white text-dark fw-500 border-20"></div>' +
							'<img src="' + encodeURI(s.images[0] || "images/lazy.svg") + '" class="w-100 border-20" loading="lazy" alt="">' +
						'</div>' +
					'</div>' +
					'<div class="property-info pe-4 ps-4 pb-4">' +
						'<a href="' + href + '" class="title tran3s stretched-link"></a>' +
						'<div class="address m0 pb-5"></div>' +
						'<div class="pl-footer m0 d-flex align-items-center justify-content-between">' +
							'<strong class="price fw-500 color-dark"></strong>' +
						'</div>' +
					'</div>' +
				'</div>';
			var simTitle = subcategoryLabel(s) + (s.area ? " " + fmtNumber(s.area) + " τ.μ." : "");
			col.querySelector(".tag").textContent = TRANSACTION[s.transaction] || "";
			col.querySelector(".title").textContent = simTitle;
			col.querySelector(".address").textContent = shortAddress(s);
			col.querySelector(".price").textContent = fmtPrice(s);
			col.querySelector(".img-gallery img").alt = simTitle + (shortAddress(s) ? ", " + shortAddress(s) : "");
			simRow.appendChild(col);
		});
	}

	function setText(id, text) {
		var n = document.getElementById(id);
		if (n) n.textContent = text;
	}
	function hide(id) {
		var n = document.getElementById(id);
		if (n) n.style.display = "none";
	}
	function show(id) {
		var n = document.getElementById(id);
		if (n) n.style.display = "";
	}

	/* ---------------- home page (index.html) ---------------- */

	function byNewest(a, b) {
		return (b.updatedAt || "").localeCompare(a.updatedAt || "");
	}

	function initHome(feed) {
		/* «Νέες καταχωρήσεις» — one row, the 3 newest listings */
		var row = document.getElementById("fw-latest");
		if (row) {
			row.textContent = "";
			feed.listings.slice().sort(byNewest).slice(0, 3).forEach(function (l) {
				row.appendChild(listingCard(l, "col-lg-4 col-md-6 d-flex mt-40"));
			});
		}

		/* «Επιλεγμένο ακίνητο του μήνα» banner */
		var banner = document.getElementById("fw-featured");
		if (!banner) return;
		var l = feed.listings.filter(function (x) { return x.featured; }).sort(byNewest)[0] ||
			findByKey(feed, FEATURED_ID) ||
			feed.listings.slice().sort(byNewest)[0];
		if (!l) {
			banner.style.display = "none";
			return;
		}
		/* The listing's own photos become the section background — a
		   multi-row collage (.fw-feat-collage) of cover-cropped tiles,
		   so no photo is ever stretched, and #fw-featured:before veils
		   it white so it reads faint. A single-photo listing fills the
		   collage with that one photo spanning the whole grid (CSS
		   img:only-child), so it rides the parallax too. */
		var collage = banner.querySelector(".fw-feat-collage");
		var imgs = l.images || [];
		if (collage && imgs.length) {
			var tiles = imgs.length > 1 ? 12 : 1; /* 4×3 on desktop; CSS trims to 2×3 on phones */
			collage.textContent = "";
			for (var i = 0; i < tiles; i++) {
				var tile = document.createElement("img");
				/* Shift each row by one so a short photo list never
				   stacks the same shot in a column. */
				tile.src = imgs.length >= tiles ? imgs[i] : imgs[(i + Math.floor(i / 4)) % imgs.length];
				tile.alt = "";
				tile.loading = "lazy";
				collage.appendChild(tile);
			}
			banner.style.backgroundImage = "none";
		} else if (imgs[0]) {
			banner.style.backgroundImage = 'url("' + encodeURI(imgs[0]) + '")';
		}
		var href = detailUrl(l);
		banner.querySelectorAll("a.fw-feat-link").forEach(function (a) { a.href = href; });
		setBannerText(banner, ".fw-feat-tag", TRANSACTION[l.transaction] || l.transaction || "");
		/* No area in the title — the address line next to it carries it. */
		setBannerText(banner, ".fw-feat-title",
			subcategoryLabel(l) + (l.area ? " " + fmtNumber(l.area) + " τ.μ." : ""));
		setBannerText(banner, ".fw-feat-address", [shortAddress(l), l.location.city].filter(Boolean).join(", "));
		setBannerText(banner, ".fw-feat-price", fmtPrice(l));
		[[".fw-feat-sqm", l.area != null ? fmtNumber(l.area) : null],
		 [".fw-feat-bed", l.bedrooms > 0 ? String(l.bedrooms) : null],
		 [".fw-feat-bath", l.bathrooms > 0 ? String(l.bathrooms) : null]]
			.forEach(function (pair) {
				var li = banner.querySelector(pair[0]);
				if (!li) return;
				if (pair[1] == null) { li.style.display = "none"; return; }
				li.querySelector("strong").textContent = pair[1];
			});
	}

	function setBannerText(root, selector, text) {
		var n = root.querySelector(selector);
		if (n) n.textContent = text;
	}

	/* ---------------- boot ---------------- */

	/* Hero form (index): replace the hardcoded area options with the feed's,
	   keeping the static list as fallback while the feed loads. */
	function fillHeroAreas(select, feed) {
		var areas = Array.from(new Set(feed.listings.map(function (l) { return l.location.area; })
			.filter(Boolean))).sort(function (a, b) { return a.localeCompare(b, "el"); });
		if (!areas.length) return;
		var keep = select.value;
		select.textContent = "";
		var any = document.createElement("option");
		any.value = "";
		any.textContent = "Όλες οι περιοχές";
		select.appendChild(any);
		areas.forEach(function (a) {
			var opt = document.createElement("option");
			opt.value = a;
			opt.textContent = a;
			select.appendChild(opt);
		});
		if (keep && areas.indexOf(keep) !== -1) select.value = keep;
		if (window.jQuery) window.jQuery(select).niceSelect("update");
	}

	function boot() {
		var isGrid = document.getElementById("fw-grid");
		var isDetail = document.getElementById("fw-detail");
		var heroArea = document.getElementById("fw-hero-area");
		var isHome = document.getElementById("fw-latest") || document.getElementById("fw-featured");
		if (!isGrid && !isDetail && !heroArea && !isHome) return;
		fetchFeed().then(function (feed) {
			if (heroArea) fillHeroAreas(heroArea, feed);
			if (isGrid) initGrid(feed);
			if (isDetail) initDetail(feed);
			if (isHome) initHome(feed);
		}).catch(function (err) {
			var target = isGrid || document.getElementById("fw-title");
			if (target) target.textContent = "Τα ακίνητα δεν είναι διαθέσιμα αυτή τη στιγμή. Δοκιμάστε ξανά σε λίγο.";
			var latest = document.getElementById("fw-latest");
			if (latest) {
				latest.textContent = "";
				var msg = el("div", "col-12 text-center mt-40");
				msg.appendChild(el("p", "fs-20 m0", "Τα ακίνητα δεν είναι διαθέσιμα αυτή τη στιγμή. Δοκιμάστε ξανά σε λίγο."));
				latest.appendChild(msg);
			}
			var banner = document.getElementById("fw-featured");
			if (banner) banner.style.display = "none";
			console.error("listings feed:", err);
		});
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", boot);
	} else {
		boot();
	}
})();
