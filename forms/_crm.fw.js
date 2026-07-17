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

	/* CRM detail key -> the form's data-k key. Shared by ανάθεση and
	   υπόδειξη, which carry an identical «Στοιχεία εντολέα» block. Note
	   the ΑΔΤ issue date/authority keys carry no entoleas_ prefix. */
	var ENTOLEAS = {
		onomatepwnymo: "entoleas_onomatepwnymo",
		patronymo: "entoleas_patronymo",
		katoikia: "entoleas_katoikia",
		adt: "entoleas_adt",
		adt_imerominia_ekdosis: "adt_imerominia_ekdosis",
		adt_arxi_ekdosis: "adt_arxi_ekdosis",
		afm: "entoleas_afm",
	};

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
		// Greek pages use "." as the thousands separator (docs/localization.md).
		return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".") + " €";
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
				// The μεσιτική αμοιβή is deliberately NOT filled from
				// assignment_fee: that is what the OWNER agreed to pay on
				// the ανάθεση, which is not necessarily what this client
				// is being asked for. Wrong number on a signed contract.
				toast("Συμπληρώθηκε από το CRM.");
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

	function attach() {
		// «Στοιχεία εντολέα» — anchor on a field we know is in that card.
		var anchor = document.querySelector('[data-k="' + ENTOLEAS.onomatepwnymo + '"]');
		if (anchor) {
			var card = anchor.closest(".card");
			var head = card && card.querySelector(".sect");
			if (head) {
				head.appendChild(
					button("Από το CRM", function () {
						pickContact(ENTOLEAS);
					}),
				);
			}
		}

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
					});
				}),
			);
		});
	}

	/* ------------------------------------------------------------ boot */

	var CSS =
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
