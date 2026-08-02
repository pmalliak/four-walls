/* =====================================================================
   Four Walls — φύλακας αποτυχημένων εκτελέσεων του Make
   ---------------------------------------------------------------------
   Οταν ένα σενάριο του Make σκοντάψει (κενό email πελάτη, έντυπο χωρίς
   PDF, σφάλμα του Gemini), το bundle παρκάρει στα «incomplete executions»
   και ΤΟ ΣΕΝΑΡΙΟ ΣΥΝΕΧΙΖΕΙ. Αυτό είναι σκόπιμο (αλλιώς μια κακή υποβολή
   θα κατέβαζε όλα τα έντυπα), αλλά το Make δεν ειδοποιεί κανέναν: στις
   31/07/2026 βρέθηκαν εννιά ανεπίλυτα, το παλαιότερο δεκαπέντε ημερών,
   ανάμεσά τους μια εντολή ανάθεσης που δεν έφτασε ποτέ στον πελάτη.

   Αυτό το αρχείο κλείνει το κενό: μία φορά την ημέρα ο cron του Worker
   ρωτάει το Make API ποια σενάρια έχουν ανεπίλυτα bundles, φτιάχνει ένα
   ελληνικό email για τη γραμματεία (τι δεν έφυγε, πότε, τι κάνουμε) και
   το σπρώχνει στο MAKE_DLQ_WEBHOOK, που το στέλνει από το info@.

   Γιατί ο έλεγχος ζει εδώ και όχι σε σενάριο Make: το Make API θέλει
   token, και το token θα κατέληγε μέσα στο blueprint, δηλαδή στο git.
   Ετσι το μυστικό μένει secret του Worker και το σενάριο είναι δύο
   modules (webhook → email), χωρίς τίποτα ευαίσθητο μέσα του.

   Config (secrets/vars):
     MAKE_API_TOKEN    Make API token με δικαίωμα ανάγνωσης σεναρίων/DLQ
     MAKE_DLQ_WEBHOOK  το hook του σεναρίου «Φύλακας — ό,τι δεν στάλθηκε»
     MAKE_TEAM_ID      var, default 2060918
     MAKE_ZONE         var, default eu1.make.com
   Χωρίς token ή webhook ο φύλακας μένει σιωπηλός (δεν σκάει ο cron).
   ===================================================================== */

import { findDuplicateSends } from "./sent-log.mjs";

const KV_LAST_RUN = "dlq-watch:last-run";
const MAX_DETAIL = 12; // πόσα bundles ανοίγουμε για ανθρώπινα στοιχεία

/* Τι είναι κάθε σενάριο, στη γλώσσα της γραμματείας, και τι κάνουμε όταν
   κάτι του μείνει στη μέση. Ο,τι δεν είναι εδώ παίρνει το γενικό μήνυμα. */
const SCENARIOS = {
	6600035: {
		what: "Ενα υπογεγραμμένο έντυπο από το tablet δεν στάλθηκε",
		action: "Ο πελάτης ΔΕΝ το έλαβε. Πες στον Μάνο να το ξανασυμπληρώσει, αφού πρώτα ελέγξετε το email του πελάτη στο CRM.",
	},
	6688477: {
		what: "Φωτογραφίες ακινήτου που δεν επεξεργάστηκαν",
		action: "Δεν έφτασαν στο Google Drive. Πες στον Μάνο να τις ξανανεβάσει από τα Εντυπα.",
	},
	6405443: {
		what: "Αίτηση ανάθεσης από το Spitogatos που δεν μπήκε στο CRM",
		action: "Βρες το αρχικό email του Spitogatos στον φάκελο «Spitogatos» και πέρασε την επαφή με το χέρι.",
	},
	6604242: {
		what: "Ενδιαφερόμενος από το Spitogatos που δεν μπήκε στο CRM",
		action: "Βρες το αρχικό email του Spitogatos στον φάκελο «Spitogatos» και πέρασε την επαφή με το χέρι.",
	},
	6530594: {
		what: "Μήνυμα από τη φόρμα επικοινωνίας του site που δεν έφτασε",
		action: "Ειδοποίησε τον Πάνο: το μήνυμα του επισκέπτη υπάρχει μόνο μέσα στο Make.",
	},
	6683649: {
		what: "Δήλωση «ολοκλήρωσα την αναζήτηση» που δεν καταγράφηκε",
		action: "Ειδοποίησε τον Πάνο. Αν ξέρεις ποιον πελάτη αφορά, κλείσε τη ζήτησή του στο CRM.",
	},
	6722234: {
		what: "Η ημερήσια λίστα «νέα ακίνητα σε ζητήσεις» δεν βγήκε",
		action: "Ειδοποίησε τον Πάνο. Οι ζητήσεις δεν χάνονται, απλώς δεν ήρθε το email της ημέρας.",
	},
	6762737: {
		what: "Ο μηνιαίος έλεγχος τιμών περιοχών δεν ολοκληρώθηκε",
		action: "Αφορά μόνο τον Πάνο, προώθησέ του το.",
	},
};

const FORM_LABELS = {
	anathesi: "Εντολή Ανάθεσης",
	ypodeixi: "Εντολή Υπόδειξης",
	apodeixi: "Απόδειξη Είσπραξης",
	katachorisi: "Φόρμα Καταχώρισης",
	prosfora: "Προσφορά",
	ektimisi: "Εκτίμηση Ακινήτου",
	"lead-reply": "Αυτόματη απάντηση σε ενδιαφερόμενο",
};

/* Ο cron του Worker χτυπάει κάθε 15 λεπτά για το feed. Ο φύλακας θέλει να
   τρέχει μία φορά την ημέρα, το πρωί, ώρα Ελλάδας. */
export async function maybeRunDlqWatch(env) {
	if (!env.MAKE_API_TOKEN || !env.MAKE_DLQ_WEBHOOK) return { skipped: "not_configured" };

	const now = athensParts();
	if (now.hour < 8) return { skipped: "too_early" };

	const last = await env.LISTINGS_KV.get(KV_LAST_RUN);
	if (last === now.date) return { skipped: "already_ran" };

	// Γράφουμε ΠΡΙΝ στείλουμε: δύο ταυτόχρονα cron ticks δεν πρέπει να
	// στείλουν δύο email. Μια χαμένη μέρα είναι ασήμαντη, ένα διπλό όχι.
	await env.LISTINGS_KV.put(KV_LAST_RUN, now.date, { expirationTtl: 40 * 24 * 3600 });

	const report = await buildDlqReport(env);
	if (!report.count) return { sent: false, count: 0 };

	await fetch(env.MAKE_DLQ_WEBHOOK, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ subject: report.subject, html: report.html, count: report.count }),
	});
	return { sent: true, count: report.count };
}

/* GET /api/dlq-report?key=<WEBHOOK_KEY> — χειροκίνητη προεπισκόπηση, ίδιο
   περιεχόμενο με το email. Θέλει κλειδί: το report γράφει ονόματα πελατών. */
export async function handleDlqReport(request, env, url) {
	if (!env.WEBHOOK_KEY || url.searchParams.get("key") !== env.WEBHOOK_KEY) {
		return new Response("Not found", { status: 404 });
	}
	if (!env.MAKE_API_TOKEN) {
		return Response.json({ error: "not_configured" }, { status: 503 });
	}
	const report = await buildDlqReport(env);
	if (url.searchParams.get("format") === "html") {
		return new Response(report.html || "<p>Καθαρά, τίποτα δεν εκκρεμεί.</p>", {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	}
	return Response.json(report);
}

async function buildDlqReport(env) {
	const zone = env.MAKE_ZONE || "eu1.make.com";
	const team = env.MAKE_TEAM_ID || "2060918";
	const api = async (path) => {
		const r = await fetch(`https://${zone}/api/v2${path}`, {
			headers: { Authorization: `Token ${env.MAKE_API_TOKEN}` },
		});
		if (!r.ok) throw new Error(`Make API ${path} → ${r.status}`);
		return r.json();
	};

	let scenarios;
	try {
		({ scenarios } = await api(`/scenarios?teamId=${team}`));
	} catch (err) {
		console.error("dlq-watch: δεν διαβάστηκε η λίστα σεναρίων", String(err));
		return { count: 0, error: String(err) };
	}

	const stuck = [];
	for (const s of scenarios || []) {
		if (!s.dlqCount) continue;
		let items = [];
		try {
			({ dlqs: items } = await api(`/dlqs?teamId=${team}&scenarioId=${s.id}`));
		} catch (err) {
			console.error(`dlq-watch: σενάριο ${s.id}`, String(err));
			continue;
		}
		for (const d of (items || []).filter((x) => !x.resolved)) {
			stuck.push({ scenarioId: s.id, scenarioName: s.name, ...d });
		}
	}
	// Ανεξάρτητος έλεγχος, δικό του KV: μια αποτυχία εδώ δεν πρέπει να
	// καταπιεί την αναφορά των εκκρεμοτήτων.
	let dupes = [];
	try {
		dupes = await findDuplicateSends(env);
	} catch (err) {
		console.warn("dlq-watch: ο έλεγχος για διπλά απέτυχε", String(err));
	}

	if (!stuck.length) return finish(stuck, dupes);

	stuck.sort((a, b) => (a.created < b.created ? -1 : 1)); // παλαιότερο πρώτο

	// Το bundle κρύβει τα ανθρώπινα στοιχεία (τι έντυπο, ποιος πελάτης).
	for (const item of stuck.slice(0, MAX_DETAIL)) {
		try {
			const b = await api(`/dlqs/${item.id}/bundle?teamId=${team}`);
			Object.assign(item, describeBundle(b?.response));
		} catch {
			/* χωρίς λεπτομέρεια, το email στέκει και με το όνομα του σεναρίου */
		}
	}

	return finish(stuck, dupes);
}

/* Το ίδιο έντυπο, δύο φορές στον ίδιο πελάτη. Ο φύλακας το βρίσκει επειδή
   κανείς άλλος δεν κοιτάζει: το `forms:sent:` κόβει μόνο το πανομοιότυπο,
   και ό,τι ξαναμπαίνει στο Make απευθείας (resolve, replay) δεν περνάει
   καν από τον Worker. Ενημερώνει, δεν εμποδίζει: το email έχει ήδη φύγει,
   και η επόμενη κίνηση είναι ένα τηλέφωνο, όχι ένα rollback. */
function finish(stuck, dupes) {
	const total = stuck.length + dupes.length;
	if (!total) return { count: 0 };
	const parts = [];
	if (stuck.length) parts.push(`${stuck.length} ${stuck.length === 1 ? "εκκρεμότητα" : "εκκρεμότητες"}`);
	if (dupes.length) parts.push(`${dupes.length} ${dupes.length === 1 ? "διπλό" : "διπλά"}`);
	const subject = stuck.length
		? `ΔΕΝ ΣΤΑΛΘΗΚΕ · ${parts.join(", ")}`
		: `ΕΦΥΓΕ ΔΙΠΛΟ · ${parts.join(", ")}`;
	return { count: total, subject, html: buildHtml(stuck, dupes) };
}

/* Το payload του webhook είναι το module 1 του σεναρίου. Για τα έντυπα
   ξέρουμε το σχήμα του (docs/forms-submit.md) και βγάζουμε όνομα πελάτη.

   Οταν ΔΕΝ βρίσκεται τίποτα, το λέμε ρητά αντί να αφήσουμε σκέτο «Εντολή
   Ανάθεσης», που δεν βοηθάει κανέναν: άδειο payload + `submitted_by: null`
   (δηλαδή δεν πέρασε από το Access, άρα δεν ήρθε από το iPad) σημαίνει
   σχεδόν πάντα δοκιμή από τοπική ανάπτυξη. Το είδαμε στις 31/07/2026, όπου
   και τα εννιά ανεπίλυτα ήταν δοκιμές. */
function describeBundle(response) {
	const first = response && typeof response === "object" ? response["1"] : null;
	const out = { detail: "", note: "", link: "" };
	out.link = response?.$inputvars?.context?.scenario?.executionUrl || "";
	if (!first || typeof first !== "object") return out;

	const d = first.data || {};
	const bits = [];
	if (first.form) bits.push(FORM_LABELS[first.form] || first.form);
	const who =
		d.entoleas_onomatepwnymo ||
		d.katavallon_geniki ||
		d.owner_name ||
		d.client_name ||
		d.name ||
		first.summary;
	if (who) bits.push(String(who));

	const contact = d.entoleas_email || d.katavallon_email || d.owner_email || d.client_email;
	const phone = d.entoleas_tilefono || d.katavallon_tilefono || d.owner_phone;
	if (contact) bits.push(String(contact));
	if (phone) bits.push(String(phone));
	if (first.submitted_by) bits.push(`από ${first.submitted_by}`);

	out.detail = bits.join(" · ");
	if (!who && !contact) {
		out.note = first.submitted_by
			? "Δεν σώθηκαν στοιχεία πελάτη, δες το στο Make."
			: "Χωρίς στοιχεία πελάτη και χωρίς σύμβουλο: δεν ήρθε από το tablet, είναι σχεδόν σίγουρα δοκιμή.";
	}
	return out;
}

/* Μια γραμμή ανά ζεύγος: τι, σε ποιον, πότε έφυγαν τα δύο. Το «επίτηδες»
   δεν είναι σφάλμα, αλλά μπαίνει κι αυτό: όποιος διαβάζει το email πρέπει
   να ξέρει ότι ο πελάτης έλαβε δύο, όχι να μαντεύει γιατί. */
function buildDupeRows(dupes) {
	return dupes
		.map((d) => {
			const what = [FORM_LABELS[d.form] || d.form, d.label].filter(Boolean).join(" · ");
			const same = d.sameDocument ? "ακριβώς το ίδιο έγγραφο" : "με μικρές διαφορές";
			const gap = d.gapHours < 1
				? `${Math.max(1, Math.round(d.gapHours * 60))} λεπτά διαφορά`
				: `${String(d.gapHours).replace(".", ",")} ώρες διαφορά`;
			const why = d.forced
				? "Ο σύμβουλος επιβεβαίωσε ότι το ξαναστέλνει. Δεν είναι σφάλμα, αλλά ο πελάτης έλαβε δύο."
				: "Δεν ζητήθηκε επαναποστολή: κάποιο βήμα το ξανάστειλε μόνο του.";
			return `<tr><td style="padding:14px 0;border-bottom:1px solid #e6e9ef;">
				<div style="font-size:15px;font-weight:bold;color:#16233A;">${esc(what)}</div>
				<div style="font-size:14px;color:#16233A;padding-top:2px;">Προς ${esc(d.to)}</div>
				<div style="font-size:13.5px;color:#777777;padding-top:2px;">${esc(greekDate(d.first))} και ${esc(greekDate(d.second))} · ${esc(gap)} · ${esc(same)}</div>
				<div style="font-size:14px;color:#8a6d00;padding-top:2px;">${esc(why)}</div>
				<div style="font-size:14px;color:#16233A;padding-top:6px;"><strong>Τι κάνουμε:</strong> Δες αν χρειάζεται να ειδοποιηθεί ο πελάτης ότι ισχύει ένα έγγραφο. Στο CRM αρχειοθετούμε μία φορά.</div>
			</td></tr>`;
		})
		.join("");
}

function buildHtml(items, dupes = []) {
	const rows = items
		.map((it) => {
			const meta = SCENARIOS[it.scenarioId] || {
				what: it.scenarioName,
				action: "Ειδοποίησε τον Πάνο.",
			};
			const when = greekDate(it.created);
			const detail = it.detail
				? `<div style="font-size:14px;color:#16233A;padding-top:2px;">${esc(it.detail)}</div>`
				: "";
			// Οταν λείπουν τα στοιχεία, η οδηγία «πες στον Μάνο» είναι άχρηστη:
			// δεν ξέρει κανείς ποιο έντυπο να ξανακάνει. Λέμε τι ξέρουμε.
			const note = it.note
				? `<div style="font-size:14px;color:#8a6d00;padding-top:2px;">${esc(it.note)}</div>`
				: "";
			const link = it.link
				? `<div style="font-size:13px;padding-top:6px;"><a href="${esc(it.link)}" style="color:#FF1462;">Δες το στο Make</a></div>`
				: "";
			return `<tr><td style="padding:14px 0;border-bottom:1px solid #e6e9ef;">
				<div style="font-size:15px;font-weight:bold;color:#16233A;">${esc(meta.what)}</div>
				${detail}
				${note}
				<div style="font-size:13.5px;color:#777777;padding-top:2px;">${esc(when)}</div>
				<div style="font-size:14px;color:#16233A;padding-top:6px;"><strong>Τι κάνουμε:</strong> ${esc(meta.action)}</div>
				${link}
			</td></tr>`;
		})
		.join("");

	const heading = items.length ? "ΚΑΤΙ ΔΕΝ ΣΤΑΛΘΗΚΕ" : "ΕΦΥΓΕ ΔΙΠΛΟ";
	const stuckBlock = items.length
		? `<tr><td style='padding:22px 24px 4px 24px;font-size:14.5px;line-height:1.65;color:#16233A;'><p style='margin:0 0 4px 0;'>Τα παρακάτω ξεκίνησαν αλλά <strong>δεν ολοκληρώθηκαν</strong>. Δεν χάθηκαν, είναι φυλαγμένα και ξαναστέλνονται, χρειάζονται όμως μια ανθρώπινη κίνηση.</p></td></tr><tr><td style='padding:4px 24px 6px 24px;'><table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='border-top:1px solid #e6e9ef;'>${rows}</table></td></tr>`
		: "";
	const dupeBlock = dupes.length
		? `<tr><td style='padding:22px 24px 4px 24px;font-size:14.5px;line-height:1.65;color:#16233A;'><p style='margin:0 0 4px 0;'><strong>Το ίδιο έντυπο έφυγε δύο φορές στον ίδιο παραλήπτη.</strong> Εδώ δεν λείπει τίποτα, το αντίθετο: κάποιος έλαβε δύο email για ένα έγγραφο.</p></td></tr><tr><td style='padding:4px 24px 6px 24px;'><table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='border-top:1px solid #e6e9ef;'>${buildDupeRows(dupes)}</table></td></tr>`
		: "";
	const footer = items.length
		? "Το email αυτό έρχεται μόνο όταν υπάρχει κάτι να δεις. Οι εκκρεμότητες <strong>ξαναέρχονται αύριο</strong> μέχρι να τακτοποιηθούν, τα διπλά αναφέρονται για τρεις ημέρες και μετά σταματούν μόνα τους."
		: "Το email αυτό έρχεται μόνο όταν υπάρχει κάτι να δεις. Τα διπλά αναφέρονται για τρεις ημέρες και μετά σταματούν μόνα τους. Οταν όλα είναι εντάξει, δεν λαμβάνεις τίποτα.";

	return `<!DOCTYPE html><html lang='el'><head><meta charset='utf-8'></head><body style='margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;'><table role='presentation' width='100%' cellpadding='0' cellspacing='0' style='background:#f4f5f7;padding:18px 0;'><tr><td align='center'><table role='presentation' width='560' cellpadding='0' cellspacing='0' style='max-width:560px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;'><tr><td style='background:#16233A;padding:16px 24px 6px 24px;'><span style='font-weight:bold;font-size:15px;letter-spacing:3px;color:#ffffff;'>FOUR WALLS</span><span style='font-weight:bold;font-size:10px;letter-spacing:2px;color:#FF1462;padding-left:8px;'>REAL ESTATE</span></td></tr><tr><td style='background:#16233A;padding:0 24px 14px 24px;color:#ffffff;font-size:16px;font-weight:bold;letter-spacing:1px;'>${heading}</td></tr><tr><td style='height:3px;background:#FF1462;'></td></tr>${stuckBlock}${dupeBlock}<tr><td style='padding:14px 24px 20px 24px;font-size:14.5px;line-height:1.65;color:#16233A;'><p style='margin:0;color:#777777;font-size:13.5px;'>${footer}</p></td></tr><tr><td style='background:#16233A;padding:16px 24px;'><p style='margin:0;font-size:12px;line-height:1.6;color:#cdd3de;'><strong style='color:#ffffff;'>Four Walls Real Estate</strong> · αυτόματος ημερήσιος έλεγχος</p></td></tr></table></td></tr></table></body></html>`;
}

function esc(s) {
	return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function greekDate(iso) {
	try {
		const d = new Date(iso);
		const fmt = new Intl.DateTimeFormat("el-GR", {
			timeZone: "Europe/Athens",
			day: "2-digit",
			month: "2-digit",
			year: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
		const days = Math.floor((Date.now() - d.getTime()) / 86400000);
		const ago = days <= 0 ? "σήμερα" : days === 1 ? "χθες" : `πριν ${days} ημέρες`;
		return `${fmt.format(d)} (${ago})`;
	} catch {
		return String(iso || "");
	}
}

function athensParts() {
	const now = new Date();
	const f = new Intl.DateTimeFormat("en-CA", {
		timeZone: "Europe/Athens",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hour12: false,
	});
	const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
	return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
