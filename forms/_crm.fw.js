/* =====================================================================
   Four Walls — CRM picker for the Έντυπα PWA
   ---------------------------------------------------------------------
   Adds «Από το CRM» buttons to the forms: search a client or a property
   on the tablet, tap it, and the fields fill in from EstatePrime.

   Deliberately self-contained: it attaches by finding known data-k
   fields and injecting into their section header, so no form's own
   script needs to change — each page just loads this file.

   Data comes from /api/crm/* (worker/lib/crm.mjs), which is behind
   Cloudflare Access. Index is downloaded ONCE and searched locally:
   ~58 contacts is a few KB, so it stays instant and keeps working on a
   bad 4G signal at a viewing. Only the tapped record costs a request.

   READ-ONLY — the EstatePrime API has no contact update endpoint, so
   nothing here writes back to the CRM. Corrections the consultant makes
   in the form stay in the form (asked EstatePrime 2026-07-17).
   ===================================================================== */
(function () {
	"use strict";

	/* One entry per «pick a person» card, keyed by an anchor field that
	   only that card has: `map` is CRM detail key -> the form's data-k.
	   A form only gets a button for the cards it actually contains.

	   The απόδειξη document names the parties in labelled rows, so the
	   NOMINATIVE the CRM holds is the correct case as-is. (The *_geniki
	   keys are historical — renaming them would break saved drafts.) */
	var BLOCKS = [
		{
			// ανάθεση + υπόδειξη: an identical «Στοιχεία εντολέα» card.
			// The ΑΔΤ issue date/authority keys carry no entoleas_ prefix.
			anchor: "entoleas_onomatepwnymo",
			map: {
				onomatepwnymo: "entoleas_onomatepwnymo",
				patronymo: "entoleas_patronymo",
				katoikia: "entoleas_katoikia",
				adt: "entoleas_adt",
				adt_imerominia_ekdosis: "adt_imerominia_ekdosis",
				adt_arxi_ekdosis: "adt_arxi_ekdosis",
				afm: "entoleas_afm",
				email: "entoleas_email",
				phone: "entoleas_tilefono",
			},
		},
		{
			// απόδειξη · «Καταβάλλων». This is the person the receipt is
			// for, so it carries the delivery email/phone.
			anchor: "katavallon_geniki",
			map: {
				onomatepwnymo: "katavallon_geniki",
				afm: "katavallon_afm",
				email: "katavallon_email",
				phone: "katavallon_tilefono",
			},
		},
	];

	var cache = { contacts: null, listings: null };

	/* ------------------------------------------------------------ util */

	/* Greek search has to ignore accents AND final sigma, or «τζιορτζιος»
	   never finds «Τζιόρτζιος». NFD splits the tonos into a combining
	   mark that the range below strips. */
	function norm(s) {
		return String(s == null ? "" : s)
			.toLowerCase()
			.normalize("NFD")
			.replace(/[\u0300-\u036f]/g, "")
			.replace(/ς/g, "σ")
			.trim();
	}

	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	}

	function setField(key, value) {
		var n = document.querySelector('[data-k="' + key + '"]');
		if (!n) return false;
		n.value = value == null ? "" : String(value);
		return true;
	}

	function money(n) {
		if (n == null || n === "") return "";
		var num = Number(n);
		if (!isFinite(num)) return String(n);
		// Greek format: "." thousands, "," decimals (docs/localization.md).
		// Decimals appear only when real — half a month's rent can be x,50 €.
		var int = Math.floor(num);
		var dec = Math.round((num - int) * 100);
		if (dec === 100) { int += 1; dec = 0; }
		var s = String(int).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
		if (dec) s += "," + (dec < 10 ? "0" + dec : dec);
		return s + " €";
	}

	/* Office standard the consultant can overtype: sale 2% with a €1.000
	   floor (the two rules meet exactly at €50.000), rent half a month.
	   Hidden/missing price or auction/shortterm -> blank, never a guess. */
	function suggestedFee(l) {
		if (l.hiddenPrice || l.price == null) return "";
		if (l.availability === "rent") return money(l.price / 2);
		if (l.availability === "sale") return money(Math.max(Math.round(l.price * 0.02), 1000));
		return "";
	}

	async function getJson(url) {
		var res = await fetch(url, { headers: { Accept: "application/json" } });
		if (res.status === 401 || res.status === 403) {
			throw new Error("Χρειάζεται σύνδεση — άνοιξε ξανά την εφαρμογή.");
		}
		if (res.status === 503) {
			throw new Error("Η σύνδεση με το CRM δεν έχει ρυθμιστεί ακόμη.");
		}
		if (!res.ok) throw new Error("Σφάλμα " + res.status + " από το CRM.");
		return res.json();
	}

	/* ----------------------------------------------------------- sheet */

	/* Full-screen sheet rather than a <select>: on an iPad with a pencil
	   a native dropdown is unusable, and the list needs a search box. */
	function openSheet(opts) {
		var back = el("div", "crmsheet");
		var panel = el("div", "crmpanel");

		var head = el("div", "crmhead");
		var input = el("input", "crmsearch");
		input.type = "search";
		input.placeholder = opts.placeholder;
		input.autocomplete = "off";
		var close = el("button", "crmclose", "Άκυρο");
		head.appendChild(input);
		head.appendChild(close);

		var list = el("div", "crmlist");
		var status = el("div", "crmstatus", "Φόρτωση…");
		list.appendChild(status);

		panel.appendChild(head);
		panel.appendChild(list);
		back.appendChild(panel);
		document.body.appendChild(back);
		document.body.style.overflow = "hidden";

		function shut() {
			back.remove();
			document.body.style.overflow = "";
		}
		close.onclick = shut;
		back.onclick = function (e) {
			if (e.target === back) shut();
		};

		var rows = [];
		function render() {
			var q = norm(input.value);
			list.textContent = "";
			var hits = q
				? rows.filter(function (r) {
						return r._hay.indexOf(q) !== -1;
				  })
				: rows;
			if (!hits.length) {
				list.appendChild(el("div", "crmstatus", q ? "Κανένα αποτέλεσμα." : "Κενό."));
				return;
			}
			hits.slice(0, 60).forEach(function (r) {
				var b = el("button", "crmrow");
				b.appendChild(el("div", "crmrow-t", r._title));
				if (r._sub) b.appendChild(el("div", "crmrow-s", r._sub));
				b.onclick = function () {
					shut();
					opts.onPick(r);
				};
				list.appendChild(b);
			});
			if (hits.length > 60) {
				list.appendChild(el("div", "crmstatus", "…και άλλα " + (hits.length - 60) + ". Στένεψε την αναζήτηση."));
			}
		}

		input.oninput = render;
		setTimeout(function () {
			input.focus();
		}, 50);

		opts
			.load()
			.then(function (items) {
				rows = items;
				render();
			})
			.catch(function (err) {
				list.textContent = "";
				list.appendChild(el("div", "crmstatus", err.message || "Σφάλμα."));
			});
	}

	/* -------------------------------------------------------- contacts */

	async function loadContacts() {
		if (!cache.contacts) {
			var data = await getJson("/api/crm/contacts");
			cache.contacts = (data.contacts || []).map(function (c) {
				var sub = [c.phone, c.email].filter(Boolean).join(" · ");
				return {
					id: c.id,
					_title: c.name || "(χωρίς όνομα)",
					_sub: sub + (c.isLead ? (sub ? " · " : "") + "lead" : ""),
					_hay: norm([c.name, c.phone, c.email].join(" ")),
				};
			});
		}
		return cache.contacts;
	}

	function pickContact(map) {
		openSheet({
			placeholder: "Όνομα, τηλέφωνο ή email…",
			load: loadContacts,
			onPick: async function (row) {
				try {
					var c = await getJson("/api/crm/contacts/" + row.id);
					var missing = [];
					Object.keys(map).forEach(function (src) {
						var val = c[src];
						setField(map[src], val);
						if (!val) missing.push(src);
					});
					// The CRM holds no πατρώνυμο/κατοικία for most contacts
					// yet — say so instead of leaving silent blanks that get
					// signed as-is.
					toast(
						missing.length
							? "Συμπληρώθηκε. Λείπουν από το CRM: " + missing.length + " πεδία."
							: "Συμπληρώθηκε από το CRM.",
					);
				} catch (err) {
					toast(err.message || "Σφάλμα.");
				}
			},
		});
	}

	/* ------------------------------------------- αιτιολογία (απόδειξη) */

	/* Greek needs the article to agree with the noun, so each entry stores
	   article + genitive together rather than trying to inflect at runtime.
	   This is a lookup, not a guess: a word's gender is fixed.

	   Keys mirror the CRM slugs in worker/lib/seo.mjs / js/listings.fw.js —
	   keep them in step when a new subcategory shows up. Anything unknown
	   falls back to «του ακινήτου», which is always grammatical. */
	var OF_SUBCATEGORY = {
		apartment: "του διαμερίσματος", maisonette: "της μεζονέτας",
		detached: "της μονοκατοικίας", house: "της μονοκατοικίας",
		studio: "του στούντιο", villa: "της βίλας", loft: "του loft",
		residential_building: "του κτιρίου κατοικιών",
		apartment_complex: "του συγκροτήματος διαμερισμάτων",
		farmhouse: "της αγροικίας", houseboat: "της πλωτής κατοικίας",
		other_residential: "της κατοικίας",
		office: "του γραφείου", store: "του καταστήματος",
		warehouse: "της αποθήκης", hotel: "του ξενοδοχείου",
		commercial_building: "του επαγγελματικού κτιρίου",
		hall: "της αίθουσας", industrial_space: "του βιομηχανικού χώρου",
		craft_space: "του βιοτεχνικού χώρου",
		other_commercial: "του επαγγελματικού χώρου",
		plot: "του οικοπέδου", parcel: "του αγροτεμαχίου",
		island: "του νησιού", parking: "του πάρκινγκ",
		business: "της επιχείρησης", air: "του αέρα", other: "του ακινήτου",
	};

	/* Same idea: «για ΤΗΝ πώληση» but «για ΤΟΝ πλειστηριασμό». */
	var FOR_TRANSACTION = {
		sale: "την πώληση", rent: "την εκμίσθωση",
		auction: "τον πλειστηριασμό", shortterm: "τη βραχυχρόνια μίσθωση",
	};

	/* Deliberately says nothing about the εντολέας. The receipt already
	   names them one sentence earlier («εισέπραξε … κατ’ εντολή X»), so
	   repeating it would only force us to guess their gender — which the
	   CRM does not carry — to pick between «του εντολέα» and «της
	   εντολέως». The document reads «… ευρώ, ως {aitiologia}.», hence no
	   leading «ως» here. */
	function aitiologiaFor(l) {
		var what = FOR_TRANSACTION[l.availability] || "τη συναλλαγή";
		var kind = OF_SUBCATEGORY[l.subcategory] || "του ακινήτου";
		var s = "προκαταβολή για " + what + " " + kind;
		return l.address ? s + " επί της οδού " + l.address : s;
	}

	/* -------------------------------------------------------- listings */

	async function loadListings() {
		if (!cache.listings) {
			var data = await getJson("/api/crm/listings");
			cache.listings = (data.listings || []).map(function (l) {
				return {
					raw: l,
					_title: (l.code ? l.code + " · " : "") + (l.address || "(χωρίς διεύθυνση)"),
					_sub: [l.area, l.size ? l.size + " τ.μ." : "", l.hiddenPrice ? "κρυφή τιμή" : money(l.price)]
						.filter(Boolean)
						.join(" · "),
					_hay: norm([l.code, l.address, l.area].join(" ")),
				};
			});
		}
		return cache.listings;
	}

	/* keys: the data-k names for this property row. */
	function pickListing(keys) {
		openSheet({
			placeholder: "Κωδικός, διεύθυνση ή περιοχή…",
			load: loadListings,
			onPick: function (row) {
				var l = row.raw;
				if (keys.kodikos) setField(keys.kodikos, l.code);
				if (keys.dieuthynsi) setField(keys.dieuthynsi, l.address);
				if (keys.tm) setField(keys.tm, l.size);
				if (keys.timi) setField(keys.timi, l.hiddenPrice ? "" : money(l.price));
				// Prefilled from the office formula (suggestedFee), NOT from
				// the CRM's assignment_fee — that is what the OWNER agreed
				// on the ανάθεση, not what this client is asked for. The
				// input stays editable; the consultant has the last word.
				if (keys.amoivi) setField(keys.amoivi, suggestedFee(l));
				toast("Συμπληρώθηκε από το CRM.");
			},
		});
	}

	/* απόδειξη: pick the PROPERTY, and the εντολέας fills in from whoever
	   owns it — the receipt is written on the owner's behalf, so the
	   property is what the consultant actually has in mind. Costs one extra
	   request (listing -> ownerId -> contact), only on the tap. */
	function pickListingOwner() {
		openSheet({
			placeholder: "Κωδικός, διεύθυνση ή περιοχή…",
			load: loadListings,
			onPick: async function (row) {
				var l = row.raw;
				// The sentence needs no CRM round-trip, so write it even if
				// the owner lookup below fails.
				setField("aitiologia", aitiologiaFor(l));
				if (!l.ownerId) {
					toast("Η αιτιολογία μπήκε. Το ακίνητο δεν έχει ιδιοκτήτη στο CRM.");
					return;
				}
				try {
					var c = await getJson("/api/crm/contacts/" + l.ownerId);
					setField("entoleas_geniki", c.onomatepwnymo);
					setField("entoleas_afm", c.afm);
					toast("Συμπληρώθηκε από το CRM.");
				} catch (err) {
					toast(err.message || "Σφάλμα.");
				}
			},
		});
	}

	/* ----------------------------------------------------------- toast */

	function toast(msg) {
		var t = document.getElementById("toast");
		if (!t) return;
		t.textContent = msg;
		t.classList.add("on");
		setTimeout(function () {
			t.classList.remove("on");
		}, 2600);
	}

	/* ---------------------------------------------------------- attach */

	function button(label, onClick) {
		var b = el("button", "crmbtn", label);
		b.type = "button";
		b.onclick = onClick;
		return b;
	}

	/* Put a button in the header of the .card that owns `anchorKey`. */
	function cardButton(anchorKey, label, onClick) {
		var anchor = document.querySelector('[data-k="' + anchorKey + '"]');
		if (!anchor) return;
		var card = anchor.closest(".card");
		var head = card && card.querySelector(".sect");
		if (!head) return;
		head.appendChild(button(label, onClick));
	}

	function attach() {
		// One button per person-card the page actually has: ανάθεση and
		// υπόδειξη have only the εντολέας; the απόδειξη's καταβάλλων is the
		// one person there who is picked as a person.
		BLOCKS.forEach(function (block) {
			cardButton(block.anchor, "Από το CRM", function () {
				pickContact(block.map);
			});
		});

		// απόδειξη · «Εντολέας (για λογαριασμό του)» — reached through the
		// property rather than the contact list, which also lets us prefill
		// the αιτιολογία from that property's type/deal/address.
		cardButton("entoleas_geniki", "Από ακίνητο", pickListingOwner);

		// Property rows: υπόδειξη renders up to 5 `.akin` blocks; ανάθεση
		// has a single un-numbered set. Both are covered by reading the
		// row's own kodikos/dieuthynsi keys.
		document.querySelectorAll(".akin").forEach(function (row) {
			var lab = row.querySelector(".lab");
			var code = row.querySelector('[data-k$="_kodikos"]');
			if (!lab || !code) return;
			var n = code.getAttribute("data-k").replace(/_kodikos$/, "");
			lab.appendChild(
				button("Από το CRM", function () {
					pickListing({
						kodikos: n + "_kodikos",
						dieuthynsi: n + "_dieuthynsi",
						tm: n + "_tm",
						timi: n + "_timi",
						amoivi: n + "_amoivi",
					});
				}),
			);
		});
	}

	/* ------------------------------------------------------------ boot */

	var CSS =
		// The .akin row label is plain inline text; without flex the button
		// lands glued to «ΑΚΙΝΗΤΟ 1». Flex + the button's margin-left:auto
		// sends it to the right edge, matching the .sect header layout.
		".akin .lab{display:flex;align-items:center;gap:8px;}" +
		".crmbtn{margin-left:auto;font-size:11px;padding:4px 9px;background:var(--navy);color:#fff;border:0;border-radius:7px;font-weight:700;letter-spacing:.01em;}" +
		".crmbtn:active{opacity:.75;}" +
		".crmsheet{position:fixed;inset:0;background:rgba(16,24,40,.45);z-index:9999;display:flex;align-items:flex-end;justify-content:center;}" +
		"@media(min-width:640px){.crmsheet{align-items:center;}}" +
		".crmpanel{background:var(--bg,#eef1f5);width:100%;max-width:560px;max-height:86vh;border-radius:16px 16px 0 0;display:flex;flex-direction:column;overflow:hidden;}" +
		"@media(min-width:640px){.crmpanel{border-radius:16px;max-height:76vh;}}" +
		".crmhead{display:flex;gap:8px;padding:12px;background:#fff;border-bottom:1px solid var(--line,#d7dce3);}" +
		".crmsearch{flex:1;font:inherit;font-size:16px;padding:11px 12px;border:1px solid var(--line,#d7dce3);border-radius:10px;background:#fff;color:var(--ink,#242a33);}" +
		".crmsearch:focus{outline:2px solid var(--navy,#1C3457);outline-offset:-1px;}" +
		".crmclose{flex:0 0 auto;padding:0 14px;}" +
		".crmlist{overflow-y:auto;-webkit-overflow-scrolling:touch;padding:8px;}" +
		".crmrow{display:block;width:100%;text-align:left;background:#fff;border:1px solid var(--line,#d7dce3);border-radius:10px;padding:12px 13px;margin-bottom:7px;min-height:52px;}" +
		".crmrow:active{border-color:var(--pink,#FF0062);}" +
		".crmrow-t{font-weight:700;color:var(--navy,#1C3457);font-size:14px;}" +
		".crmrow-s{color:var(--muted,#6b7280);font-size:12px;margin-top:2px;}" +
		".crmstatus{padding:22px 12px;text-align:center;color:var(--muted,#6b7280);font-size:13px;}";

	function boot() {
		document.head.appendChild(el("style", null, CSS));
		attach();
	}

	// The editor is rendered by the form's own script on DOMContentLoaded,
	// so wait a tick to be sure the fields exist before anchoring to them.
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", function () {
			setTimeout(boot, 0);
		});
	} else {
		setTimeout(boot, 0);
	}
})();
