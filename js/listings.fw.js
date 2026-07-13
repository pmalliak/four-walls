/* =====================================================================
   Four Walls — listings renderer (grid + detail)
   ---------------------------------------------------------------------
   Renders real listings from the feed at data/listings.json (built by
   the Cloudflare Worker from the EstatePrime CRM — docs/listings-feed.md).

   Pages:
     properties.html — grid + filters. Activates when #fw-grid exists.
                     Reads initial filters from the URL (?transaction=
                     sale|rent, type=apartment|maisonette|house|commercial|
                     land, area=<text>, price=1..5, sort=...).
     property.html — single listing. Activates when #fw-detail exists.
                     Served at /properties/<code> (the listing's public
                     «Κωδικός»; Worker + preview-server rewrite); ?id=
                     still works as a fallback and accepts id or code,
                     and old /akinit[ao]/<code> links 301 to /properties/.
     index.html    — «Νέες καταχωρήσεις» row: the 3 newest listings
                     (#fw-latest), and the «Επιλεγμένο ακίνητο» banner
                     (#fw-featured, see FEATURED_ID).

   No pagination by design — the stock is a few dozen listings.
   ===================================================================== */
(function () {
	"use strict";

	/* Page language comes from <html lang> (el on /, en on /en/ pages).
	   Every label map and UI string below is selected once from it; feed
	   content falls back to Greek per field when no English exists
	   (docs/listings-feed.md). */
	var LANG = /^en\b/i.test(document.documentElement.lang || "") ? "en" : "el";
	var BASE = LANG === "en" ? "/en" : "";

	var FEED_URL = "data/listings.json";

	/* «Επιλεγμένο ακίνητο του μήνα» (index) — normally driven by the CRM:
	   the listing tagged FEATURED_TAG in EstatePrime arrives in the feed
	   with featured:true (see worker/lib/estateprime.mjs). This code (the
	   listing's public «Κωδικός») is the fallback while nothing is tagged;
	   last resort is the newest listing (e.g. sample-data mode). */
	var FEATURED_ID = "210694";

	/* ---------------- labels for CRM slugs (per language) ----------------
	   The el SUBCATEGORY/TRANSACTION maps are mirrored BYTE-IDENTICALLY in
	   worker/lib/seo.mjs (and the en ones in its *_EN twins) so the runtime
	   document.title overwrite on the detail page is a no-op — keep all
	   four in sync. */

	var SUBCATEGORY = ({
		el: {
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
		},
		en: {
			apartment: "Apartment", maisonette: "Maisonette", detached: "Detached house",
			house: "Detached house", studio: "Studio",
			villa: "Villa", loft: "Loft", residential_building: "Residential building",
			apartment_complex: "Apartment complex", farmhouse: "Farmhouse",
			houseboat: "Houseboat", other_residential: "Other residential",
			office: "Office", store: "Retail space", warehouse: "Warehouse",
			hotel: "Hotel", commercial_building: "Commercial building",
			hall: "Hall", industrial_space: "Industrial space",
			craft_space: "Light-industrial space", other_commercial: "Other commercial",
			plot: "Plot of land", parcel: "Land parcel", island: "Island",
			parking: "Parking space", business: "Business", air: "Air rights", other: "Other"
		}
	})[LANG];

	var TRANSACTION = ({
		el: {
			sale: "Πώληση", rent: "Ενοικίαση",
			auction: "Πλειστηριασμός", shortterm: "Βραχυχρόνια"
		},
		en: {
			sale: "For sale", rent: "For rent",
			auction: "Auction", shortterm: "Short-term let"
		}
	})[LANG];

	var FEATURES = ({
		el: {
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
		},
		en: {
			has_security_door: "Security door", has_storage_room: "Storage room",
			has_elevator: "Lift", has_attic: "Attic", has_screens: "Fly screens",
			has_fireplace: "Fireplace", has_internal_stairs: "Internal staircase",
			is_furnished: "Furnished", has_alarm: "Alarm system",
			pets_allowed: "Pets allowed", is_penthouse: "Penthouse",
			has_awnings: "Awnings", is_painted: "Freshly painted", has_fiber: "Fibre broadband",
			has_night_electricity: "Off-peak electricity", has_private_pool: "Private pool",
			/* view */ mountain: "Mountain view", openspace: "Unobstructed view", sea: "Sea view",
			/* positioning */ is_front_facing: "Front-facing", is_corner: "Corner property",
			is_interior: "Interior-facing",
			/* flooring */ marble: "Flooring: marble", ceramic_tile: "Flooring: tiles",
			wood: "Flooring: wood", mosaic: "Flooring: mosaic"
		}
	})[LANG];

	var HEATING = ({
		el: {
			individual: "Ατομική", autonomous: "Αυτόνομη",
			central: "Κεντρική", none: "Χωρίς θέρμανση"
		},
		en: {
			individual: "Individual", autonomous: "Autonomous",
			central: "Central", none: "No heating"
		}
	})[LANG];

	var CONDITION = ({
		el: {
			new: "Νεόδμητο", good: "Καλή κατάσταση", renovated: "Ανακαινισμένο",
			needs_renovation: "Χρήζει ανακαίνισης", under_construction: "Υπό κατασκευή"
		},
		en: {
			new: "Newly built", good: "Good condition", renovated: "Renovated",
			needs_renovation: "In need of renovation", under_construction: "Under construction"
		}
	})[LANG];

	/* Greek energy classes Α+…Η map to the Latin A+…G scale on /en/. */
	var ENERGY = ({
		el: {
			ap: "Α+", a: "Α", bp: "Β+", b: "Β", c: "Γ",
			d: "Δ", e: "Ε", f: "Ζ", g: "Η"
		},
		en: {
			ap: "A+", a: "A", bp: "B+", b: "B", c: "C",
			d: "D", e: "E", f: "F", g: "G"
		}
	})[LANG];

	/* ---------------- UI strings (per language) ---------------- */

	var STR = ({
		el: {
			sqm: " τ.μ.",
			month: "μήνα",
			priceOnRequest: "Κατόπιν επικοινωνίας",
			bdShort: " υπν.",
			beds: function (n) { return n + (n === 1 ? " υπνοδωμάτιο" : " υπνοδωμάτια"); },
			baths: function (n) { return n + (n === 1 ? " μπάνιο" : " μπάνια"); },
			photoN: function (i) { return "Φωτογραφία " + i; },
			photoOf: function (i) { return " — φωτογραφία " + i; },
			propNoun: function (n) { return n === 1 ? " ακίνητο" : " ακίνητα"; },
			showing: "Εμφάνιση ",
			of: " από ",
			forRent: "για ενοικίαση", forBuy: "για αγορά",
			areaPrefix: "περιοχή ", pricePrefix: "τιμή ",
			bedroomsPlus: "+ υπνοδωμάτια", bathsPlus: "+ μπάνια",
			fromSqm: function (v) { return "από " + v + " τ.μ."; },
			toSqm: function (v) { return "έως " + v + " τ.μ."; },
			quoted: function (q) { return "«" + q + "»"; },
			emptyMsg: function (summary) {
				return "Γεια σας, αναζητώ " + (summary ? "ακίνητο: " + summary : "ακίνητο") +
					". Θα ήθελα να με ενημερώσετε αν προκύψει κάτι αντίστοιχο.";
			},
			emptyTitle: "Δεν βρήκατε ", emptyAccent: "αυτό που ψάχνετε;",
			emptyBody: "Πείτε μας τι ζητάτε και θα σας ενημερώσουμε μόλις βρεθεί το κατάλληλο ακίνητο.",
			emptyBtn: "Πείτε μας τι ψάχνετε",
			emptyOwner: "Έχετε δικό σας ακίνητο; ",
			emptyValuation: "Ζητήστε δωρεάν εκτίμηση",
			noResults: "Δεν βρέθηκαν ακίνητα με αυτά τα κριτήρια.",
			resetFilters: "Καθαρισμός φίλτρων",
			anyPrice: "Οποιαδήποτε τιμή",
			rentBands: ["Έως €400/μήνα", "€400-600/μήνα", "€600-900/μήνα", "€900-1.500/μήνα", "€1.500+/μήνα"],
			saleBands: ["Έως €100.000", "€100.000-200.000", "€200.000-300.000", "€300.000-500.000", "€500.000+"],
			notFound: "Το ακίνητο δεν βρέθηκε",
			refLabel: "Κωδικός: ",
			priceLabel: "Τιμή: ",
			detailAsk: function (title, code) {
				return "Γεια σας, ενδιαφέρομαι για το ακίνητο «" + title + "»" +
					(code ? " (κωδ. " + code + ")" : "") + ". Θα ήθελα περισσότερες πληροφορίες.";
			},
			allPhotos: function (n) { return "Δείτε και τις " + n + " φωτογραφίες"; },
			floorLabel: "Όροφος: ",
			floorNames: { "-1": "Υπόγειο", "0": "Ισόγειο", "0.5": "Ημιόροφος" },
			floorOrdinal: function (n) { return n + "ος"; },
			distM: "μ", distKm: "χλμ",
			access: {
				cat: { transit: "Συγκοινωνίες", errands: "Καθημερινά ψώνια", education: "Εκπαίδευση", leisure: "Αναψυχή & πράσινο" },
				band: { excellent: "Άριστη", verygood: "Πολύ καλή", good: "Καλή", moderate: "Μέτρια", limited: "Περιορισμένη" },
				types: { metro: "μετρό", tram: "τραμ", train: "τρένο", bus: "στάση λεωφορείου", supermarket: "σούπερ μάρκετ", bakery: "φούρνος", pharmacy: "φαρμακείο", convenience: "μίνι μάρκετ", school: "σχολείο", kindergarten: "νηπιαγωγείο", university: "πανεπιστήμιο", college: "κολέγιο", park: "πάρκο", square: "πλατεία", playground: "παιδική χαρά", gym: "γυμναστήριο", dining: "εστίαση" }
			},
			details: {
				code: "Κωδικός", type: "Τύπος", area: "Εμβαδόν", bedrooms: "Υπνοδωμάτια",
				bathrooms: "Μπάνια", wc: "WC", kitchens: "Κουζίνες", livingRooms: "Σαλόνια",
				floor: "Όροφος", parking: "Θέσεις στάθμευσης", yearBuilt: "Έτος κατασκευής",
				yearRenovated: "Έτος ανακαίνισης", condition: "Κατάσταση", heating: "Θέρμανση",
				energyClass: "Ενεργειακή κλάση", maintenance: "Κοινόχρηστα"
			},
			inquiry: function (ref) { return "Γεια σας, ενδιαφέρομαι για το ακίνητο " + ref + "."; },
			allAreas: "Όλες οι περιοχές",
			feedError: "Τα ακίνητα δεν είναι διαθέσιμα αυτή τη στιγμή. Δοκιμάστε ξανά σε λίγο."
		},
		en: {
			sqm: " m²",
			month: "month",
			priceOnRequest: "Price on request",
			bdShort: " bd",
			beds: function (n) { return n + (n === 1 ? " bedroom" : " bedrooms"); },
			baths: function (n) { return n + (n === 1 ? " bathroom" : " bathrooms"); },
			photoN: function (i) { return "Photo " + i; },
			photoOf: function (i) { return " — photo " + i; },
			propNoun: function (n) { return n === 1 ? " property" : " properties"; },
			showing: "Showing ",
			of: " of ",
			forRent: "to rent", forBuy: "to buy",
			areaPrefix: "area ", pricePrefix: "price ",
			bedroomsPlus: "+ bedrooms", bathsPlus: "+ bathrooms",
			fromSqm: function (v) { return "from " + v + " m²"; },
			toSqm: function (v) { return "up to " + v + " m²"; },
			quoted: function (q) { return "“" + q + "”"; },
			emptyMsg: function (summary) {
				return "Hello, I am looking for " + (summary ? "a property: " + summary : "a property") +
					". I would appreciate it if you could let me know when something suitable comes up.";
			},
			emptyTitle: "Didn't find ", emptyAccent: "what you're looking for?",
			emptyBody: "Tell us what you need and we will let you know as soon as the right property comes up.",
			emptyBtn: "Tell us what you're looking for",
			emptyOwner: "Own a property? ",
			emptyValuation: "Request a free valuation",
			noResults: "No properties match these criteria.",
			resetFilters: "Reset filters",
			anyPrice: "Any price",
			rentBands: ["Up to €400/month", "€400-600/month", "€600-900/month", "€900-1,500/month", "€1,500+/month"],
			saleBands: ["Up to €100,000", "€100,000-200,000", "€200,000-300,000", "€300,000-500,000", "€500,000+"],
			notFound: "Property not found",
			refLabel: "Reference: ",
			priceLabel: "Price: ",
			detailAsk: function (title, code) {
				return "Hello, I am interested in the property “" + title + "”" +
					(code ? " (ref. " + code + ")" : "") + ". I would like more information.";
			},
			allPhotos: function (n) { return "View all " + n + " photos"; },
			floorLabel: "Floor: ",
			floorNames: { "-1": "Basement", "0": "Ground floor", "0.5": "Mezzanine" },
			floorOrdinal: function (n) { var s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); },
			distM: "m", distKm: "km",
			access: {
				cat: { transit: "Public transport", errands: "Everyday shopping", education: "Education", leisure: "Leisure & green" },
				band: { excellent: "Excellent", verygood: "Very good", good: "Good", moderate: "Moderate", limited: "Limited" },
				types: { metro: "metro", tram: "tram", train: "train", bus: "bus stop", supermarket: "supermarket", bakery: "bakery", pharmacy: "pharmacy", convenience: "mini market", school: "school", kindergarten: "kindergarten", university: "university", college: "college", park: "park", square: "square", playground: "playground", gym: "gym", dining: "cafes/dining" }
			},
			details: {
				code: "Reference", type: "Type", area: "Floor area", bedrooms: "Bedrooms",
				bathrooms: "Bathrooms", wc: "WC", kitchens: "Kitchens", livingRooms: "Living rooms",
				floor: "Floor", parking: "Parking spaces", yearBuilt: "Year built",
				yearRenovated: "Year renovated", condition: "Condition", heating: "Heating",
				energyClass: "Energy class", maintenance: "Service charges"
			},
			inquiry: function (ref) { return "Hello, I am interested in property " + ref + "."; },
			allAreas: "All areas",
			feedError: "Listings are unavailable right now. Please try again shortly."
		}
	})[LANG];

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
		return new Intl.NumberFormat(LANG === "en" ? "en-GB" : "el-GR").format(n);
	}

	/* Metres for the accessibility evidence line: round to 10 m under 1 km,
	   otherwise one-decimal km with the page-language decimal mark. */
	function fmtDist(m) {
		if (m == null) return "";
		if (m < 1000) return Math.round(m / 10) * 10 + STR.distM;
		return (m / 1000).toFixed(1).replace(".", LANG === "en" ? "." : ",") + STR.distKm;
	}

	/* EstatePrime sends floor as a number: -1 basement, 0 ground, 0.5
	   mezzanine, 1..n storeys. Turn it into a human label; null when absent. */
	function floorLabel(v) {
		if (v == null || v === "") return null;
		var n = Number(v);
		if (!isFinite(n)) return String(v);
		if (STR.floorNames[n] != null) return STR.floorNames[n];
		if (Number.isInteger(n) && n >= 1) return STR.floorOrdinal(n);
		return String(v);
	}

	function fmtPrice(listing) {
		if (listing.price == null) return STR.priceOnRequest;
		var out = "€" + fmtNumber(listing.price);
		if (listing.transaction === "rent" || listing.transaction === "shortterm") out += "/" + STR.month;
		return out;
	}

	function subcategoryLabel(l) {
		return SUBCATEGORY[l.subcategory] || SUBCATEGORY[l.category] || l.subcategory || "";
	}

	/* Location field in the page's language, falling back to Greek when
	   the feed carries no English for it. */
	function loc(l, key) {
		return (LANG === "en" && l.location[key + "_en"]) || l.location[key] || null;
	}

	function shortAddress(l) {
		var parts = [];
		var n = loc(l, "neighbourhood"), a = loc(l, "area"), c = loc(l, "city");
		if (n && n !== a) parts.push(n);
		if (a) parts.push(a);
		if (!parts.length && c) parts.push(c);
		return parts.join(", ");
	}

	/* Detail-page URL — path style with the listing's public code, the
	   «Κωδικός» shown on the listing (/properties/2341241). The Worker
	   (and tools/preview-server.js locally) rewrites these paths to
	   property.html; root-absolute so it resolves the same from every
	   page, including the detail page itself. English pages link to the
	   /en/ twin route. */
	function detailUrl(l) {
		return BASE + "/properties/" + encodeURIComponent(l.code || l.id);
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

	/* Shared listing card — used by the properties grid and the index home row. */
	function listingCard(l, colClass) {
		var col = el("div", colClass);
		var photos = l.images.slice(0, 3);
		if (!photos.length) photos = ["images/lazy.svg"];
		var cid = "fwc-" + l.id;
		var href = detailUrl(l);

		var indicators = photos.map(function (_, i) {
			return '<button type="button" data-bs-target="#' + cid + '" data-bs-slide-to="' + i + '"' +
				(i === 0 ? ' class="active" aria-current="true"' : '') + ' aria-label="' + STR.photoN(i + 1) + '"></button>';
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
		var cardTitle = subcategoryLabel(l) + (l.area ? " " + fmtNumber(l.area) + STR.sqm : "");
		col.querySelector(".tag").textContent = TRANSACTION[l.transaction] || l.transaction || "";
		col.querySelector(".title").textContent = cardTitle;
		col.querySelector(".address").textContent = shortAddress(l);
		/* alt via property assignment (never innerHTML) for the same reason. */
		col.querySelectorAll(".carousel-item img").forEach(function (img, i) {
			img.alt = cardTitle + (shortAddress(l) ? ", " + shortAddress(l) : "") + STR.photoOf(i + 1);
		});
		var feats = col.querySelector(".feature");
		[[l.area != null, "icon_04", fmtNumber(l.area) + STR.sqm],
		 [l.bedrooms != null && l.bedrooms > 0, "icon_05", l.bedrooms + STR.bdShort],
		 [l.bathrooms != null && l.bathrooms > 0, "icon_06", STR.baths(l.bathrooms)]]
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
			price.appendChild(el("sub", null, STR.month));
		} else {
			price.textContent = fmtPrice(l);
		}
		return col;
	}

	/* ---------------- grid page (properties.html) ---------------- */

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

		/* Areas straight from the feed, alphabetically (page-language
		   collation and names — Greek fallback per listing). */
		var areas = Array.from(new Set(listings.map(function (l) { return loc(l, "area"); })
			.filter(Boolean))).sort(function (a, b) { return a.localeCompare(b, LANG); });
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
					/* Both languages in the haystack — shared filter links
					   (?area=Kalamaria / ?area=Καλαμαριά) match everywhere. */
					var hay = [l.location.area, l.location.neighbourhood, l.location.city,
						l.location.area_en, l.location.neighbourhood_en, l.location.city_en]
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
					var text = [l.code, l.description, l.description_en, subcategoryLabel(l),
						l.location.area, l.location.neighbourhood, l.location.city,
						l.location.area_en, l.location.neighbourhood_en, l.location.city_en]
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
				var noun = STR.propNoun(listings.length);
				count.innerHTML = out.length === listings.length
					? "<span class=\"color-dark fw-500\">" + listings.length + "</span>" + noun
					: STR.showing + "<span class=\"color-dark fw-500\">" + out.length +
						"</span>" + STR.of + "<span class=\"color-dark fw-500\">" + listings.length + "</span>" + noun;
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
			if (f.transaction) parts.push(f.transaction === "rent" ? STR.forRent : STR.forBuy);
			if (f.area) parts.push(STR.areaPrefix + f.area);
			var price = selectedLabel(controls.price);
			if (price) parts.push(STR.pricePrefix + price.toLowerCase());
			if (f.bedrooms) parts.push(f.bedrooms + STR.bedroomsPlus);
			if (f.bathrooms) parts.push(f.bathrooms + STR.bathsPlus);
			if (f.amin) parts.push(STR.fromSqm(f.amin));
			if (f.amax) parts.push(STR.toSqm(f.amax));
			if (f.q) parts.push(STR.quoted(f.q));
			return parts.join(", ");
		}

		/* Same look as the index CTA (fancy-banner-three): title-one heading
		   with the pink swash underline + the theme's btn-five pill. */
		function emptyCta() {
			var summary = searchSummary();
			var msg = STR.emptyMsg(summary);

			var box = el("div", "fw-empty-cta");
			var title = el("div", "title-one mb-35");
			var h = el("h3", null, STR.emptyTitle);
			var accent = el("span", null, STR.emptyAccent);
			var swash = document.createElement("img");
			swash.src = "images/shape/title_shape_08.fw.svg";
			swash.alt = "";
			accent.appendChild(swash);
			h.appendChild(accent);
			title.appendChild(h);
			box.appendChild(title);
			box.appendChild(el("p", "fs-20 mb-40", STR.emptyBody));
			var btn = el("a", "btn-five text-uppercase", STR.emptyBtn);
			btn.href = BASE + "/contact?msg=" + encodeURIComponent(msg) + "#contact-form";
			box.appendChild(btn);
			var owner = el("p", "fw-cta-alt mt-30");
			owner.appendChild(document.createTextNode(STR.emptyOwner));
			var est = el("a", null, STR.emptyValuation);
			est.href = BASE + "/services/valuation";
			owner.appendChild(est);
			owner.appendChild(document.createTextNode("."));
			box.appendChild(owner);
			return box;
		}

		function render(items) {
			grid.textContent = "";
			if (!items.length) {
				var empty = el("div", "col-12 text-center pt-40 pb-40");
				empty.appendChild(el("p", "fs-20", STR.noResults));
				var reset = el("a", "fw-reset-btn");
				reset.appendChild(el("i", "bi bi-arrow-repeat"));
				reset.appendChild(document.createTextNode(STR.resetFilters));
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
		var labels = rent ? STR.rentBands : STR.saleBands;
		var keep = controls.price.value;
		controls.price.textContent = "";
		var any = document.createElement("option");
		any.value = "";
		any.textContent = STR.anyPrice;
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

	/* ---------------- detail page (property.html) ---------------- */

	function initDetail(feed) {
		/* /properties/<code> path (canonical; old Greek /akinit[ao]/ still
		   matched — the Worker 301s them, but Live-Server-style setups
		   don't), with ?id= kept as fallback; the key may be a public code
		   or id. */
		var m = window.location.pathname.match(/\/(?:properties|akinit[ao])\/([^\/]+?)\/?$/);
		var key = m ? decodeURIComponent(m[1]) : new URLSearchParams(window.location.search).get("id");
		var l = findByKey(feed, key);
		if (!l) {
			document.getElementById("fw-title").textContent = STR.notFound;
			document.getElementById("fw-detail").querySelectorAll(".fw-when-found")
				.forEach(function (n) { n.style.display = "none"; });
			return;
		}

		/* Heading without the area — the address right below carries it;
		   the browser-tab title keeps it for context. Format mirrored
		   byte-identically in worker/lib/seo.mjs (listingTitle) per
		   language so this overwrite is a no-op. */
		var heading = subcategoryLabel(l) + (l.area ? " " + fmtNumber(l.area) + STR.sqm : "");
		var title = heading + (loc(l, "area") ? ", " + loc(l, "area") : "");
		document.title = title + " | Four Walls";
		setText("fw-title", heading);
		setText("fw-tag", TRANSACTION[l.transaction] || l.transaction || "");
		setText("fw-address", " " + [shortAddress(l), loc(l, "city")].filter(Boolean).join(", "));
		setText("fw-code", l.code ? STR.refLabel + l.code : "");
		setText("fw-price", STR.priceLabel + fmtPrice(l));

		/* Sidebar contact CTA carries the listing reference, so the
		   contact form arrives pre-written (?msg=, read by fourwalls.js) */
		var cta = document.getElementById("fw-contact-cta");
		if (cta) {
			var ask = STR.detailAsk(title, l.code);
			cta.href = BASE + "/contact?msg=" + encodeURIComponent(ask) + "#contact-form";
		}

		/* gallery */
		var photos = l.images.length ? l.images : ["images/lazy.svg"];
		var inner = document.getElementById("fw-gallery");
		inner.textContent = "";
		photos.slice(0, 8).forEach(function (src, i) {
			var item = el("div", "carousel-item" + (i === 0 ? " active" : ""));
			var img = document.createElement("img");
			img.src = src;
			img.alt = title + STR.photoOf(i + 1);
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
			b.setAttribute("aria-label", STR.photoN(i + 1));
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
			photosBtn.appendChild(document.createTextNode(STR.allPhotos(photos.length)));
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
		[[l.area != null, "icon_47", fmtNumber(l.area) + STR.sqm],
		 [l.bedrooms != null && l.bedrooms > 0, "icon_48", STR.beds(l.bedrooms)],
		 [l.bathrooms != null && l.bathrooms > 0, "icon_49", STR.baths(l.bathrooms)],
		 [floorLabel(l.floor) != null, "stairs.fw", STR.floorLabel + floorLabel(l.floor)],
		 [true, "icon_51", subcategoryLabel(l)]]
			.forEach(function (row) {
				if (!row[0]) return;
				var li = document.createElement("li");
				li.appendChild(icon(row[1]));
				li.appendChild(el("span", "fs-20 color-dark", row[2]));
				ov.appendChild(li);
			});

		/* description (English when the CRM carries it, else Greek) */
		setText("fw-description", (LANG === "en" && l.description_en) || l.description || "");

		/* details list */
		var det = document.getElementById("fw-details-list");
		det.textContent = "";
		[[STR.details.code, l.code],
		 [STR.details.type, subcategoryLabel(l)],
		 [STR.details.area, l.area != null ? fmtNumber(l.area) + STR.sqm : null],
		 [STR.details.bedrooms, l.bedrooms],
		 [STR.details.bathrooms, l.bathrooms],
		 [STR.details.wc, l.wc],
		 [STR.details.kitchens, l.kitchens],
		 [STR.details.livingRooms, l.livingRooms],
		 [STR.details.floor, floorLabel(l.floor)],
		 [STR.details.parking, l.parking],
		 [STR.details.yearBuilt, l.yearBuilt],
		 [STR.details.yearRenovated, l.yearRenovated],
		 [STR.details.condition, CONDITION[l.condition]],
		 [STR.details.heating, HEATING[l.heating]],
		 [STR.details.energyClass, ENERGY[l.energyClass]],
		 [STR.details.maintenance, l.monthlyMaintenance != null ? "€" + fmtNumber(l.monthlyMaintenance) + "/" + STR.month : null]]
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

		/* nearby ("Κοντινά σημεία" / "What's nearby") — parsed by the Worker
		   from the description into [{label, value}]; prefer the page
		   language, fall back to the Greek list when no English one exists. */
		var nearby = (LANG === "en" && l.nearby_en && l.nearby_en.length ? l.nearby_en : l.nearby) || [];
		var nb = document.getElementById("fw-nearby");
		if (nb && nearby.length) {
			nb.textContent = "";
			nearby.forEach(function (p) {
				var li = document.createElement("li");
				li.appendChild(document.createTextNode(p.label + (p.value ? ": " : "")));
				if (p.value) li.appendChild(el("span", "fw-500 color-dark", p.value));
				nb.appendChild(li);
			});
			show("fw-nearby-block");
		} else {
			hide("fw-nearby-block");
		}

		/* accessibility ("Προσβασιμότητα περιοχής") — OSM ratings computed and
		   KV-cached by the Worker; qualitative band + nearest-POI evidence. */
		var acc = l.accessibility;
		var scoreRow = document.getElementById("fw-score");
		if (scoreRow && acc) {
			scoreRow.textContent = "";
			["transit", "errands", "education", "leisure"].forEach(function (catKey) {
				var c = acc[catKey];
				if (!c || !c.band) return;
				var col = el("div", "col-md-6");
				var block = el("div", "block mb-25");
				block.appendChild(el("h6", "mb-1", STR.access.cat[catKey]));
				block.appendChild(el("span", "fw-band fw-band-" + c.band, STR.access.band[c.band] || c.band));
				if (c.type) {
					block.appendChild(el("span", "fs-16 fw-score-ev",
						(STR.access.types[c.type] || c.type) + (c.m != null ? " " + fmtDist(c.m) : "")));
				}
				col.appendChild(block);
				scoreRow.appendChild(col);
			});
			show("fw-score-block");
		} else {
			hide("fw-score-block");
		}

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
				"&z=15&hl=" + LANG + "&output=embed";
		} else {
			hide("fw-map-block");
		}

		/* inquiry message prefill */
		var msg = document.getElementById("fw-inquiry-msg");
		if (msg) msg.placeholder = STR.inquiry(l.code || title);

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
			var simTitle = subcategoryLabel(s) + (s.area ? " " + fmtNumber(s.area) + STR.sqm : "");
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
			subcategoryLabel(l) + (l.area ? " " + fmtNumber(l.area) + STR.sqm : ""));
		setBannerText(banner, ".fw-feat-address", [shortAddress(l), loc(l, "city")].filter(Boolean).join(", "));
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
		var areas = Array.from(new Set(feed.listings.map(function (l) { return loc(l, "area"); })
			.filter(Boolean))).sort(function (a, b) { return a.localeCompare(b, LANG); });
		if (!areas.length) return;
		var keep = select.value;
		select.textContent = "";
		var any = document.createElement("option");
		any.value = "";
		any.textContent = STR.allAreas;
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
			if (target) target.textContent = STR.feedError;
			var latest = document.getElementById("fw-latest");
			if (latest) {
				latest.textContent = "";
				var msg = el("div", "col-12 text-center mt-40");
				msg.appendChild(el("p", "fs-20 m0", STR.feedError));
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
