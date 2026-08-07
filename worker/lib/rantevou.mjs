/* =====================================================================
   Four Walls — σελίδα ραντεβού: /r/<id> («Δείτε το ραντεβού σας»)
   ---------------------------------------------------------------------
   Το SMS του EstatePrime (new_appointment / appointment_reminder) δεν
   χωράει παρά 2-3 γραμμές, και δεν μπορεί να κουβαλήσει τυχαίο token:
   τα πρότυπά του δέχονται μόνο πεδία που ξέρει το CRM, άρα το link
   χτίζεται από το id του ραντεβού, που είναι αύξων αριθμός. Η άμυνα
   λοιπόν ΔΕΝ είναι το URL αλλά η πύλη: η σελίδα δεν δείχνει τίποτα
   πριν δοθούν τα 4 τελευταία ψηφία του κινητού της επαφής, με όριο
   προσπαθειών ανά ραντεβού και λήξη μετά το ραντεβού. Η σελίδα δεν
   περιέχει κανένα προσωπικό στοιχείο του πελάτη, μόνο ό,τι έγραψε το
   γραφείο: μέρα και ώρα, τίτλο, σημείωση, σημείο συνάντησης. Ακίνητα
   ΔΕΝ εμφανίζονται σκόπιμα: ένα ραντεβού μπορεί να αφορά πολλά ή κανένα
   (απόφαση Πάνου 07/08/2026).

   ΤΟ ΣΗΜΕΙΟ ΣΥΝΑΝΤΗΣΗΣ έρχεται από το ΙΔΙΟ το SMS: το /api/calendar δεν
   επιστρέφει τη διεύθυνση του ραντεβού (ελέγχθηκε και με POST, αγνοείται),
   τη διεύθυνση όμως την ξέρει το SMS πρότυπο του CRM
   (appointment.address), οπότε το link του SMS κουβαλά το στίγμα ως
   ?a=<lat>,<lng> όταν υπάρχει. Για να μην μπορεί κάποιος να «δηλητηριάσει»
   τον χάρτη πραγματικού ραντεβού με πλαστό ?a=, το στίγμα αποθηκεύεται
   (KV rantevou:coords:<id>) ΜΟΝΟ μετά από σωστό pin, δηλαδή μόνο από τον
   πραγματικό παραλήπτη του SMS.

     GET  /r/<id>        πύλη (ή στοιχεία, αν υπάρχει έγκυρο cookie)
     POST /r/<id>        pin=ψηφία  -> στοιχεία + cookie
                         pin+action=confirm|change -> καταγραφή απάντησης
     GET  /r/<id>/ics    αρχείο ημερολογίου, με ?p=<ψηφία> ή cookie

   Η ΙΔΙΑ πύλη σερβίρεται και για id που δεν υπάρχει: η ύπαρξη ενός
   ραντεβού δεν αποκαλύπτεται πριν από σωστό pin, οπότε το σκανάρισμα
   διαδοχικών id δείχνει παντού την ίδια φόρμα. Τα δεδομένα έρχονται
   από GET /api/calendar/<id> + /api/contacts/<id> με cache 10 λεπτών
   στο KV, άρα μια μετάθεση του ραντεβού στο CRM φαίνεται στη σελίδα
   σε λίγα λεπτά, και το ΙΔΙΟ link ισχύει πριν και μετά την αλλαγή.

   Η απάντηση του πελάτη (επιβεβαίωση ή αίτημα αλλαγής) γράφεται στο
   KV και προωθείται στο Make (secret MAKE_RANTEVOU_WEBHOOK), που
   ειδοποιεί το γραφείο. Χωρίς το secret η καταγραφή γίνεται κανονικά
   και μόνο η ειδοποίηση λείπει, ώστε το feature να μη σπάει πριν
   στηθεί το σενάριο. Βλ. docs/rantevou.md.
   ===================================================================== */

import { apiConfig } from "./estateprime.mjs";

const CACHE_TTL = 600;            // δευτ. cache ραντεβού στο KV
const NEG_TTL = 300;              // δευτ. cache για id που δεν βρέθηκε
const TRIES_MAX = 8;              // προσπάθειες pin ανά ραντεβού ανά ώρα
const GRACE_MS = 6 * 3600 * 1000; // πόσο μετά τη λήξη ζει ακόμη η σελίδα

const SITE_ORIGIN = "https://four-walls.gr";
const PHONE_DISPLAY = "+30 6907 483 463";
const PHONE_HREF = "+306907483463";

/* Κατηγορίες ραντεβού του CRM (ids από το modal του /settings/sms). */
const CATEGORIES = {
	1: { el: "Υπόδειξη ακινήτου", en: "Property viewing" },
	2: { el: "Ανάθεση ακινήτου", en: "Listing appointment" },
	3: { el: "Φωτογράφιση", en: "Photo session" },
	4: { el: "Ραντεβού με συνεργάτη", en: "Meeting" },
	6: { el: "Ραντεβού", en: "Appointment" },
};

const STR = {
	el: {
		docTitle: "Το ραντεβού σας · Four Walls Real Estate",
		gateLead: "Για να δείτε τα στοιχεία του ραντεβού σας, γράψτε τα 4 τελευταία ψηφία του κινητού σας.",
		gatePlaceholder: "π.χ. 4570",
		gateBtn: "ΠΡΟΒΟΛΗ ΡΑΝΤΕΒΟΥ",
		gateWrong: "Τα ψηφία δεν ταιριάζουν ή το ραντεβού δεν είναι διαθέσιμο. Δοκιμάστε ξανά ή καλέστε μας.",
		gateLocked: "Πολλές προσπάθειες. Δοκιμάστε ξανά σε μία ώρα ή καλέστε μας.",
		expired: "Αυτή η σελίδα ραντεβού δεν είναι πλέον διαθέσιμη.",
		expiredLead: "Αν χρειάζεστε νέο ραντεβού ή οποιαδήποτε πληροφορία, καλέστε μας ή στείλτε μας μήνυμα.",
		when: "Πότε",
		what: "Ραντεβού",
		note: "Σημείωση",
		fullDay: "Ολοήμερο",
		confirmBtn: "ΕΠΙΒΕΒΑΙΩΝΩ ΤΟ ΡΑΝΤΕΒΟΥ",
		changeBtn: "ΘΕΛΩ ΑΛΛΑΓΗ ΩΡΑΣ",
		confirmed: "Ευχαριστούμε, το ραντεβού επιβεβαιώθηκε. Σας περιμένουμε!",
		changeAsked: "Το σημειώσαμε. Θα επικοινωνήσουμε μαζί σας για νέα ώρα.",
		respondedSwap: "Αλλάξατε γνώμη; Πατήστε το άλλο κουμπί και θα ενημερωθούμε.",
		ics: "ΠΡΟΣΘΗΚΗ ΣΤΟ ΗΜΕΡΟΛΟΓΙΟ",
		meet: "Σημείο συνάντησης",
		mapBtn: "ΑΝΟΙΓΜΑ ΣΤΟΝ ΧΑΡΤΗ",
		call: "Αν βιάζεστε ή κάτι άλλαξε, καλέστε μας:",
		footer: "Four Walls Real Estate · Φραγκίνη 9, 54624 Θεσσαλονίκη",
	},
	en: {
		docTitle: "Your appointment · Four Walls Real Estate",
		gateLead: "To view your appointment details, enter the last 4 digits of your mobile number.",
		gatePlaceholder: "e.g. 4570",
		gateBtn: "VIEW APPOINTMENT",
		gateWrong: "The digits do not match or the appointment is unavailable. Try again or call us.",
		gateLocked: "Too many attempts. Try again in an hour or call us.",
		expired: "This appointment page is no longer available.",
		expiredLead: "If you need a new appointment or any information, call us or send us a message.",
		when: "When",
		what: "Appointment",
		note: "Note",
		fullDay: "All day",
		confirmBtn: "CONFIRM APPOINTMENT",
		changeBtn: "REQUEST A NEW TIME",
		confirmed: "Thank you, your appointment is confirmed. See you there!",
		changeAsked: "Noted. We will contact you to arrange a new time.",
		respondedSwap: "Changed your mind? Press the other button and we will know.",
		ics: "ADD TO CALENDAR",
		meet: "Meeting point",
		mapBtn: "OPEN THE MAP",
		call: "In a hurry, or did something change? Call us:",
		footer: "Four Walls Real Estate · 9 Fragkini st, 54624 Thessaloniki",
	},
};

const DAYS = {
	el: ["Κυριακή", "Δευτέρα", "Τρίτη", "Τετάρτη", "Πέμπτη", "Παρασκευή", "Σάββατο"],
	en: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
};
const MONTHS = {
	el: ["Ιανουαρίου", "Φεβρουαρίου", "Μαρτίου", "Απριλίου", "Μαΐου", "Ιουνίου",
		"Ιουλίου", "Αυγούστου", "Σεπτεμβρίου", "Οκτωβρίου", "Νοεμβρίου", "Δεκεμβρίου"],
	en: ["January", "February", "March", "April", "May", "June",
		"July", "August", "September", "October", "November", "December"],
};

export async function handleRantevou(request, env, url, pathname, ctx) {
	const m = pathname.match(/^\/r\/(\d{1,10})(\/ics)?$/);
	if (!m) return notFound();
	const id = m[1];
	const wantsIcs = !!m[2];

	const appt = await loadAppointment(env, id);
	const lang = appt?.lang === "en" ? "en" : "el";
	const S = STR[lang];

	// Πέρασε η ώρα του: η σελίδα λέει μόνο ότι έληξε, ούτε πύλη ούτε στοιχεία.
	if (appt && !appt.missing && isExpired(appt)) {
		return page(expiredHtml(S), 410, S.docTitle);
	}

	const authed = await hasValidCookie(request, env, id, appt);

	if (wantsIcs) {
		if (!appt || appt.missing) return notFound();
		const pin = url.searchParams.get("p") || "";
		if (!authed && !(await pinOk(env, id, appt, pin))) return notFound();
		return icsResponse(appt, lang, await storedCoords(env, id));
	}

	if (request.method === "POST") {
		return handlePost(request, env, id, appt, lang, ctx, url);
	}

	if (authed && appt && !appt.missing) {
		const resp = await env.LISTINGS_KV.get(`rantevou:resp:${id}`, "json");
		return page(detailsHtml(appt, lang, resp, appt.pin || "", await storedCoords(env, id)), 200, S.docTitle);
	}
	return page(gateHtml(id, lang, null, url.searchParams.get("a")), 200, S.docTitle);
}

async function handlePost(request, env, id, appt, lang, ctx, url) {
	const S = STR[lang];
	let form;
	try { form = await request.formData(); } catch { form = new Map(); }
	const pin = String(form.get("pin") || "").replace(/\D/g, "").slice(0, 4);
	const action = String(form.get("action") || "");
	const rawA = url?.searchParams.get("a") || null;

	// Το όριο προσπαθειών μετράει ΚΑΘΕ λάθος pin, και για ανύπαρκτα id:
	// αλλιώς η πύλη γίνεται μαντείο για το ποια ραντεβού υπάρχουν.
	const triesKey = `rantevou:tries:${id}`;
	const tries = Number(await env.LISTINGS_KV.get(triesKey)) || 0;
	if (tries >= TRIES_MAX) {
		return page(gateHtml(id, lang, S.gateLocked, rawA), 429, S.docTitle);
	}
	if (!appt || appt.missing || !(await pinOk(env, id, appt, pin))) {
		await env.LISTINGS_KV.put(triesKey, String(tries + 1), { expirationTtl: 3600 });
		return page(gateHtml(id, lang, S.gateWrong, rawA), 200, S.docTitle);
	}

	// Σωστό pin: αν το link κουβαλά στίγμα (?a= από το SMS πρότυπο), τώρα
	// είναι η στιγμή που το εμπιστευόμαστε και το κρατάμε για τις επόμενες
	// επισκέψεις (cookie, .ics), που δεν θα έχουν το query string.
	const coords = parseCoords(rawA);
	if (coords) {
		const end = athensToUtcMs(appt.dateEnding || appt.dateStarting);
		const ttl = Math.max(3600, end ? Math.floor((end + GRACE_MS - Date.now()) / 1000) : 3600);
		await env.LISTINGS_KV.put(`rantevou:coords:${id}`, JSON.stringify(coords), { expirationTtl: ttl });
	}

	let resp = await env.LISTINGS_KV.get(`rantevou:resp:${id}`, "json");
	if (action === "confirm" || action === "change") {
		resp = { action, at: new Date().toISOString() };
		await env.LISTINGS_KV.put(`rantevou:resp:${id}`, JSON.stringify(resp), { expirationTtl: 90 * 86400 });
		// Ειδοποίηση γραφείου μέσω Make. Αποτυχία δεν χαλάει την απάντηση του
		// πελάτη: η καταγραφή στο KV έχει ήδη γίνει. Όσο δεν υπάρχει
		// αποκλειστικό σενάριο (MAKE_RANTEVOU_WEBHOOK), η ειδοποίηση περνά
		// από το webhook της φόρμας επικοινωνίας: ο router του 6530594
		// στέλνει ό,τι δεν είναι zitisi/anathesi/endiaferon ως απλό email
		// στο info@, χωρίς να αγγίξει CRM, οπότε φτάνει στο γραφείο σήμερα
		// χωρίς καμία αλλαγή στο Make.
		let target = env.MAKE_RANTEVOU_WEBHOOK || null;
		let payload = {
			appointment_id: appt.id,
			title: appt.title || "",
			date_starting: appt.dateStarting || "",
			action,
			lang,
		};
		if (!target && env.MAKE_CONTACT_WEBHOOK) {
			target = env.MAKE_CONTACT_WEBHOOK;
			payload = {
				form: "rantevou",
				name: `Ραντεβού #${appt.id}`,
				email: "",
				phone: "",
				message: [
					action === "confirm"
						? "Ο πελάτης ΕΠΙΒΕΒΑΙΩΣΕ το ραντεβού."
						: "Ο πελάτης ζητά ΑΛΛΑΓΗ ΩΡΑΣ. Θέλει τηλέφωνο για νέα ώρα.",
					appt.title ? `Ραντεβού: ${appt.title}` : "",
					appt.dateStarting ? `Πότε: ${appt.dateStarting}` : "",
					`Σελίδα: ${SITE_ORIGIN}/r/${appt.id}`,
				].filter(Boolean).join("\n"),
				page: `/r/${appt.id}`,
			};
		}
		if (target) {
			const notify = fetch(target, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			}).then((r) => {
				if (!r.ok) console.error(`rantevou: Make notify failed (HTTP ${r.status})`);
			}).catch((err) => console.error("rantevou: Make notify failed", String(err)));
			if (ctx?.waitUntil) ctx.waitUntil(notify); else await notify;
		} else {
			console.warn("rantevou: no Make webhook configured; response logged in KV only");
		}
	}

	const headers = await cookieHeaders(env, id, appt);
	return page(detailsHtml(appt, lang, resp, pin, coords || await storedCoords(env, id)), 200, STR[lang].docTitle, headers);
}

/* Το στίγμα του σημείου συνάντησης, όπως ήρθε από το ?a= του SMS link.
   Δεκτό μόνο «lat,lng» με λογικές τιμές, οτιδήποτε άλλο αγνοείται. */
function parseCoords(raw) {
	const m = String(raw || "").match(/^(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/);
	if (!m) return null;
	const lat = Number(m[1]);
	const lng = Number(m[2]);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
	return { lat, lng };
}

async function storedCoords(env, id) {
	return env.LISTINGS_KV.get(`rantevou:coords:${id}`, "json");
}

/* ---------------------------------------------------------------------
   Δεδομένα: CRM -> KV cache
   --------------------------------------------------------------------- */

async function loadAppointment(env, id) {
	const cacheKey = `rantevou:${id}`;
	const cached = await env.LISTINGS_KV.get(cacheKey, "json");
	if (cached) return cached;

	let record;
	try {
		const { base, headers } = apiConfig(env);
		const res = await fetch(`${base}/calendar/${encodeURIComponent(id)}`, { headers });
		const ev = res.ok ? (await res.json())?.data : null;
		if (!ev) {
			record = { missing: true };
		} else {
			// Η πύλη θέλει το κινητό της επαφής, η γλώσσα της σελίδας τη γλώσσα
			// της επαφής (language_id 2 = English, βλ. σύμβαση ξένων τηλεφώνων).
			let pin = null;
			let lang = "el";
			const contactId = Array.isArray(ev.contacts) ? ev.contacts[0] : null;
			if (contactId) {
				const cres = await fetch(`${base}/contacts/${contactId}`, { headers });
				const c = cres.ok ? (await cres.json())?.data : null;
				const digits = String(c?.phones?.[0]?.number || "").replace(/\D/g, "");
				if (digits.length >= 4) pin = digits.slice(-4);
				if (Number(c?.language_id) === 2) lang = "en";
			}
			record = {
				id: String(ev.id),
				title: ev.title || "",
				description: ev.description || "",
				categoryId: ev.category_id ?? null,
				fullDay: !!ev.full_day,
				dateStarting: ev.date_starting || "",
				dateEnding: ev.date_ending || ev.date_starting || "",
				pin,
				lang,
			};
		}
	} catch (err) {
		// CRM άφαντο: μην κρύψεις υπαρκτό ραντεβού για πάντα, απλώς μην
		// γράψεις τίποτα στο cache και δείξε την πύλη (το POST θα ξαναρωτήσει).
		console.error("rantevou: CRM fetch failed", err?.stack || String(err));
		return null;
	}
	await env.LISTINGS_KV.put(cacheKey, JSON.stringify(record), {
		expirationTtl: record.missing ? NEG_TTL : CACHE_TTL,
	});
	return record;
}

/* ---------------------------------------------------------------------
   Πύλη: pin, όριο προσπαθειών, cookie
   --------------------------------------------------------------------- */

async function pinOk(env, id, appt, pin) {
	// Επαφή χωρίς τηλέφωνο δεν μπορεί να περάσει καμία πύλη, και δεν έχει
	// λάβει και SMS. Η σελίδα της μένει κλειδωμένη αντί να ανοίξει σε όλους.
	if (!appt?.pin) return false;
	return pin === appt.pin;
}

function isExpired(appt) {
	const end = athensToUtcMs(appt.dateEnding || appt.dateStarting);
	return end !== null && Date.now() > end + GRACE_MS;
}

/* Το cookie γλιτώνει το ξαναπληκτρολόγημα του pin σε επόμενη επίσκεψη:
   HMAC(WEBHOOK_KEY, id + pin), οπότε δεν πλαστογραφείται χωρίς το secret
   και αχρηστεύεται μόνο του αν αλλάξει το τηλέφωνο της επαφής. */
async function cookieValue(env, id, appt) {
	if (!env.WEBHOOK_KEY || !appt?.pin) return null;
	const data = new TextEncoder().encode(`r:${id}:${appt.pin}`);
	const key = await crypto.subtle.importKey(
		"raw", new TextEncoder().encode(env.WEBHOOK_KEY),
		{ name: "HMAC", hash: "SHA-256" }, false, ["sign"],
	);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
	return [...sig].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hasValidCookie(request, env, id, appt) {
	const want = await cookieValue(env, id, appt);
	if (!want) return false;
	const cookies = request.headers.get("Cookie") || "";
	const m = cookies.match(new RegExp(`(?:^|;\\s*)fwr${id}=([0-9a-f]+)`));
	return !!m && m[1] === want;
}

async function cookieHeaders(env, id, appt) {
	const v = await cookieValue(env, id, appt);
	if (!v) return {};
	const end = athensToUtcMs(appt.dateEnding || appt.dateStarting);
	const maxAge = Math.min(
		60 * 86400,
		Math.max(3600, end ? Math.floor((end + GRACE_MS - Date.now()) / 1000) : 3600),
	);
	return { "Set-Cookie": `fwr${id}=${v}; Max-Age=${maxAge}; Path=/r/${id}; Secure; HttpOnly; SameSite=Lax` };
}

/* ---------------------------------------------------------------------
   Ώρα Ελλάδας: το CRM γράφει «YYYY-MM-DD HH:MM:SS» τοπική Αθήνας.
   Η μετατροπή σε UTC θέλει μόνο τον κανόνα EEST, τελευταία Κυριακή
   Μαρτίου έως τελευταία Κυριακή Οκτωβρίου· τα λεπτά γύρω από την αλλαγή
   ώρας δεν μας αγγίζουν, η λήξη έχει έτσι κι αλλιώς 6 ώρες χάρη.
   --------------------------------------------------------------------- */

function parseCrmDate(s) {
	const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
	if (!m) return null;
	return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
}

function athensOffsetHours(y, mo, d) {
	const lastSunday = (year, month1to12) => {
		const last = new Date(Date.UTC(year, month1to12, 0));
		return last.getUTCDate() - last.getUTCDay();
	};
	if (mo > 3 && mo < 10) return 3;
	if (mo === 3) return d >= lastSunday(y, 3) ? 3 : 2;
	if (mo === 10) return d < lastSunday(y, 10) ? 3 : 2;
	return 2;
}

function athensToUtcMs(s) {
	const p = parseCrmDate(s);
	if (!p) return null;
	return Date.UTC(p.y, p.mo - 1, p.d, p.h - athensOffsetHours(p.y, p.mo, p.d), p.mi);
}

function fmtWhen(appt, lang) {
	const p = parseCrmDate(appt.dateStarting);
	if (!p) return "";
	const weekday = DAYS[lang][new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay()];
	const date = `${weekday} ${p.d} ${MONTHS[lang][p.mo - 1]} ${p.y}`;
	if (appt.fullDay) return `${date} (${STR[lang].fullDay})`;
	const hh = String(p.h).padStart(2, "0");
	const mi = String(p.mi).padStart(2, "0");
	return `${date}, ${hh}:${mi}`;
}

/* ---------------------------------------------------------------------
   HTML
   --------------------------------------------------------------------- */

function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => (
		{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
	));
}

/* Η σημείωση του ραντεβού συχνά κουβαλά ένα link (π.χ. Google Maps για το
   σημείο συνάντησης): κάνε τα URLs πατήσιμα, όλο το υπόλοιπο μένει σκέτο
   escaped κείμενο. */
function escWithLinks(s) {
	return esc(s).replace(/https?:\/\/[^\s<]+/g, (u) =>
		`<a href="${u}" style="color:#FF1462; word-break:break-all;">${u}</a>`);
}

function page(body, status, title, extraHeaders = {}) {
	const html = `<!DOCTYPE html>
<html lang="el">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<style>
	body { margin:0; background:#f4f5f7; font-family:Arial, Helvetica, sans-serif; color:#333; }
	.band { background:#16233A; padding:18px 16px; text-align:center; border-bottom:3px solid #FF1462; }
	.band img { height:34px; vertical-align:middle; }
	.wrap { max-width:520px; margin:24px auto 40px; padding:0 14px; }
	.card { background:#fff; border-radius:10px; box-shadow:0 2px 10px rgba(22,35,58,.08); padding:26px 22px; }
	h1 { font-size:20px; color:#16233A; margin:0 0 14px; }
	p { line-height:1.55; }
	.row { margin:0 0 14px; }
	.label { font-size:11px; letter-spacing:.08em; color:#8a93a3; text-transform:uppercase; margin:0 0 2px; }
	.value { font-size:17px; color:#16233A; font-weight:bold; margin:0; }
	.when { font-size:22px; color:#16233A; font-weight:bold; margin:0; line-height:1.3; }
	.maplink { display:inline-block; margin-top:6px; color:#FF1462; font-weight:bold; text-decoration:none; }
	.btn { display:block; text-align:center; padding:13px 18px; border-radius:8px; border:0; width:100%;
		font-size:14px; font-weight:bold; letter-spacing:.04em; cursor:pointer; text-decoration:none;
		box-sizing:border-box; margin:0 0 10px; font-family:inherit; }
	.btn-pink { background:#FF1462; color:#fff; }
	.btn-navy { background:#16233A; color:#fff; }
	.btn-line { background:#fff; color:#16233A; border:2px solid #16233A; }
	input[type=text] { width:100%; box-sizing:border-box; font-size:22px; letter-spacing:.35em; text-align:center;
		padding:12px; border:2px solid #d5dae3; border-radius:8px; margin:0 0 14px; }
	input[type=text]:focus { outline:none; border-color:#FF1462; }
	.error { background:#fdecf2; color:#b00040; border-radius:8px; padding:10px 14px; font-size:14px; }
	.ok { background:#eaf7ef; color:#1a6b3c; border-radius:8px; padding:12px 14px; font-size:15px; }
	.footer { text-align:center; font-size:12px; color:#8a93a3; margin-top:22px; line-height:1.6; }
	.footer a { color:#8a93a3; }
	.call { text-align:center; font-size:14px; margin-top:18px; }
	.call a { color:#FF1462; font-weight:bold; text-decoration:none; font-size:17px; }
</style>
</head>
<body>
<div class="band"><img src="${SITE_ORIGIN}/images/logo/fourwalls_logo.svg" alt="Four Walls Real Estate"></div>
<div class="wrap">${body}</div>
</body>
</html>`;
	return new Response(html, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Robots-Tag": "noindex",
			...extraHeaders,
		},
	});
}

function callBlock(S) {
	return `<p class="call">${esc(S.call)}<br><a href="tel:${PHONE_HREF}">${PHONE_DISPLAY}</a></p>
	<p class="footer">${esc(S.footer)}</p>`;
}

function gateHtml(id, lang, error, rawA) {
	const S = STR[lang];
	// Το ?a= (στίγμα από το SMS) πρέπει να επιζήσει του POST της πύλης,
	// γι' αυτό μένει πάνω στο action. Μπαίνει μόνο αν είναι έγκυρο στίγμα,
	// ώστε το action να μην γίνεται όχημα για σκουπίδια.
	const keepA = parseCoords(rawA) ? `?a=${encodeURIComponent(rawA)}` : "";
	return `<div class="card">
	<h1>${esc(S.docTitle.split(" · ")[0])}</h1>
	<p>${esc(S.gateLead)}</p>
	${error ? `<p class="error">${esc(error)}</p>` : ""}
	<form method="POST" action="/r/${esc(id)}${keepA}">
		<input type="text" name="pin" inputmode="numeric" autocomplete="one-time-code"
			pattern="[0-9]{4}" maxlength="4" placeholder="${esc(S.gatePlaceholder)}" required>
		<button class="btn btn-pink" type="submit">${esc(S.gateBtn)}</button>
	</form>
</div>
${callBlock(S)}`;
}

function expiredHtml(S) {
	return `<div class="card">
	<h1>${esc(S.expired)}</h1>
	<p>${esc(S.expiredLead)}</p>
</div>
${callBlock(S)}`;
}

function detailsHtml(appt, lang, resp, pin, coords) {
	const S = STR[lang];
	const cat = CATEGORIES[appt.categoryId]?.[lang] || CATEGORIES[6][lang];
	const respBlock = resp
		? `<p class="ok">${esc(resp.action === "confirm" ? S.confirmed : S.changeAsked)}</p>
		   <p style="font-size:13px;color:#8a93a3;">${esc(S.respondedSwap)}</p>`
		: "";
	return `<div class="card">
	<h1>${esc(cat)}</h1>
	${respBlock}
	<div class="row"><p class="label">${esc(S.when)}</p><p class="when">${esc(fmtWhen(appt, lang))}</p></div>
	${coords ? `<div class="row"><p class="label">${esc(S.meet)}</p>
		<a class="maplink" href="https://maps.google.com/?q=${coords.lat},${coords.lng}">${esc(S.mapBtn)} ↗</a></div>` : ""}
	${appt.title ? `<div class="row"><p class="label">${esc(S.what)}</p><p class="value">${esc(appt.title)}</p></div>` : ""}
	${appt.description ? `<div class="row"><p class="label">${esc(S.note)}</p><p style="margin:0;">${escWithLinks(appt.description)}</p></div>` : ""}
	<form method="POST" action="/r/${esc(appt.id)}" style="margin-top:18px;">
		<input type="hidden" name="pin" value="${esc(pin)}">
		${!resp || resp.action !== "confirm" ? `<button class="btn btn-pink" type="submit" name="action" value="confirm">${esc(S.confirmBtn)}</button>` : ""}
		${!resp || resp.action !== "change" ? `<button class="btn btn-line" type="submit" name="action" value="change">${esc(S.changeBtn)}</button>` : ""}
	</form>
	<a class="btn btn-navy" href="/r/${esc(appt.id)}/ics?p=${esc(pin)}">${esc(S.ics)}</a>
</div>
${callBlock(S)}`;
}

/* ---------------------------------------------------------------------
   ics: ώρες με TZID Europe/Athens ώστε να δουλεύουν σωστά και σε
   ημερολόγιο ρυθμισμένο σε άλλη ζώνη.
   --------------------------------------------------------------------- */

function icsEsc(s) {
	return String(s ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function icsLocal(s) {
	const p = parseCrmDate(s);
	if (!p) return null;
	const pad = (n) => String(n).padStart(2, "0");
	return `${p.y}${pad(p.mo)}${pad(p.d)}T${pad(p.h)}${pad(p.mi)}00`;
}

function icsResponse(appt, lang, coords) {
	const cat = CATEGORIES[appt.categoryId]?.[lang] || CATEGORIES[6][lang];
	const pad = (n) => String(n).padStart(2, "0");
	const now = new Date();
	const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
	const summary = appt.title ? `${cat}: ${appt.title}` : cat;
	let times;
	if (appt.fullDay) {
		const p = parseCrmDate(appt.dateStarting);
		times = p ? `DTSTART;VALUE=DATE:${p.y}${pad(p.mo)}${pad(p.d)}` : "";
	} else {
		times = `DTSTART;TZID=Europe/Athens:${icsLocal(appt.dateStarting)}\r\nDTEND;TZID=Europe/Athens:${icsLocal(appt.dateEnding)}`;
	}
	const ics = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//Four Walls Real Estate//rantevou//EL",
		"BEGIN:VTIMEZONE",
		"TZID:Europe/Athens",
		"BEGIN:DAYLIGHT",
		"TZOFFSETFROM:+0200",
		"TZOFFSETTO:+0300",
		"TZNAME:EEST",
		"DTSTART:19700329T030000",
		"RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
		"END:DAYLIGHT",
		"BEGIN:STANDARD",
		"TZOFFSETFROM:+0300",
		"TZOFFSETTO:+0200",
		"TZNAME:EET",
		"DTSTART:19701025T040000",
		"RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
		"END:STANDARD",
		"END:VTIMEZONE",
		"BEGIN:VEVENT",
		`UID:rantevou-${appt.id}@four-walls.gr`,
		`DTSTAMP:${stamp}`,
		times,
		`SUMMARY:${icsEsc(summary)}`,
		appt.description ? `DESCRIPTION:${icsEsc(appt.description)}` : "",
		// Το στίγμα ανοίγει πλοήγηση από το ίδιο το ημερολόγιο του κινητού.
		coords ? `LOCATION:${icsEsc(`https://maps.google.com/?q=${coords.lat},${coords.lng}`)}` : "",
		coords ? `GEO:${coords.lat};${coords.lng}` : "",
		`URL:${SITE_ORIGIN}/r/${appt.id}`,
		`CONTACT:Four Walls Real Estate ${PHONE_DISPLAY}`,
		"END:VEVENT",
		"END:VCALENDAR",
		"",
	].filter(Boolean).join("\r\n");
	return new Response(ics, {
		headers: {
			"Content-Type": "text/calendar; charset=utf-8",
			"Content-Disposition": `attachment; filename="fourwalls-rantevou-${appt.id}.ics"`,
			"Cache-Control": "no-store",
		},
	});
}

function notFound() {
	return new Response("Not Found", { status: 404 });
}
