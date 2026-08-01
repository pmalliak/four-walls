/* =====================================================================
   Four Walls — γρήγορη καταχώριση leads από πινακίδες (forms/lead.html)
   ---------------------------------------------------------------------
   Ο σύμβουλος περπατάει, βλέπει ένα ΠΩΛΕΙΤΑΙ / ΕΝΟΙΚΙΑΖΕΤΑΙ, το
   φωτογραφίζει και το ξεχνάει. Η φωτογραφία φτάνει εδώ, ένα vision
   μοντέλο διαβάζει την πινακίδα (τηλέφωνο, είδος, τ.μ., τιμή, ιδιώτης ή
   γραφείο), η τοποθεσία γίνεται διεύθυνση, και ένα email με όλη τη βόλτα
   πάει στο info@.

     POST /api/leads/init             άνοιγμα batch
     PUT  /api/leads/upload/<b>/<n>   μία φωτογραφία στο R2
     POST /api/leads/finalize/<b>     AI + geocoding + email (το βαρύ μέρος)
     GET  /api/leads/file/<b>/<name>?exp=&sig=    (apex, HMAC — για το email)

   ΔΥΟ ΕΓΓΥΗΣΕΙΣ, ΚΑΙ ΟΙ ΔΥΟ ΣΚΟΠΙΜΕΣ:

   1. ΤΟΠΟΘΕΣΙΑ ΠΑΝΤΑ. Το EXIF GPS λείπει πολύ συχνά (φωτό μέσα από
      browser, Android photo picker, WhatsApp, κλειστό location, χωρίς
      fix, screenshot), οπότε ΔΕΝ στηριζόμαστε σε αυτό: η φόρμα κλειδώνει
      την τοποθεσία πάνω στον δρόμο — στίγμα συσκευής, αλλιώς EXIF,
      αλλιώς χειρόγραφη διεύθυνση — και δεν αφήνει αποστολή χωρίς αυτήν.
      Εδώ γίνεται ο ίδιος έλεγχος server-side (`no_location`): αν έλειπε,
      το lead θα ήταν άχρηστο και κανείς δεν θα μπορούσε να το σώσει
      αργότερα από το γραφείο.

   2. ΤΗΛΕΦΩΝΟ ΟΧΙ ΠΑΝΤΑ — και δεν το κρύβουμε. Θολή ή μακρινή πινακίδα
      δεν διαβάζεται. Το email φεύγει ΕΤΣΙ ΚΙ ΑΛΛΙΩΣ, με τη φωτογραφία
      και σήμανση «ΧΩΡΙΣ ΤΗΛΕΦΩΝΟ». Σιωπηλή απόρριψη σημαίνει χαμένο
      lead που κανείς δεν ξέρει ότι χάθηκε.

   ΓΙΑΤΙ ΤΟ AI ΤΡΕΧΕΙ ΕΔΩ ΚΑΙ ΟΧΙ ΣΤΟ MAKE: το prompt και το parsing
   μένουν σε κώδικα μέσα στο git (ίδιο σκεπτικό με valuation.mjs και
   composePrompt() στο photos.mjs). Το σενάριο του Make είναι τότε δύο
   modules — webhook και email — όπως το «Site - Ολοκλήρωση αναζήτησης».

   Μοιράζεται bucket και κλειδί υπογραφής με το photos.mjs (prefix
   `leads/`, διαφορετικό namespace στο HMAC) ώστε το feature να μη
   χρειάζεται νέο R2 bucket. Βλ. docs/quick-leads.md.
   ===================================================================== */

import { json } from "./access.mjs";
import { normPhone, fmtPhone, crmMatches, webLookup, reconcile } from "./phone-lookup.mjs";

/* ------------------------------------------------------------ limits */

const MAX_FILES = 20;                       // μία βόλτα, όχι φωτογράφιση ακινήτου
const MAX_FILE_BYTES = 25 * 1024 * 1024;
/* 30 ημέρες: οι υπογεγραμμένες διευθύνσεις μπαίνουν ως <img> ΜΕΣΑ στο
   email, οπότε πρέπει να δουλεύουν όσο το email έχει νόημα να ανοιχτεί.
   (Στο photos.mjs φτάνουν 6 ώρες — εκεί τις τραβάει το Make μία φορά.) */
const SIGNED_URL_TTL = 30 * 24 * 3600;
const ALLOWED_MIME = new Set([
	"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
]);
const EXT_FOR_MIME = {
	"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
	"image/heic": "heic", "image/heif": "heif",
};

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-3.5-flash";
/* Το Nominatim θέλει αναγνωρίσιμο User-Agent και max 1 κλήση/δευτ. — βλ.
   την πολιτική χρήσης. Ίδια σύμβαση με το accessibility.mjs. */
const NOMINATIM = "https://nominatim.openstreetmap.org";
const UA = "four-walls-leads/1.0 (+https://four-walls.gr)";
const GEOCODE_MAX = 20;                     // πάνω από αυτό, μόνο συντεταγμένες

/* --------------------------------------------------------- AI prompt

   Ό,τι ζητάμε από το μοντέλο ζει εδώ, όχι σε IML μέσα στο Make. Δύο
   πεδία αξίζουν όσο όλα τα υπόλοιπα μαζί:

   - `advertiser`: οι μισές πινακίδες στη Θεσσαλονίκη είναι συναδέλφων.
     Χωρίς αυτό το γραφείο παίρνει τηλέφωνο τον ανταγωνισμό.
   - `is_sign`: φρένο για τη λάθος φωτογραφία (σκέτη πρόσοψη, στραβή
     λήψη). Χωρίς αυτό το μοντέλο «βρίσκει» τηλέφωνα που δεν υπάρχουν. */
const EXTRACT_PROMPT = [
	"You are reading ONE photograph taken in a Greek street by a real-estate consultant. It normally shows a FOR SALE / FOR RENT sign or banner on a building («ΠΩΛΕΙΤΑΙ», «ΕΝΟΙΚΙΑΖΕΤΑΙ», «ΠΩΛΕΙΤΑΙ ΔΙΑΜΕΡΙΣΜΑ», «ΕΝΟΙΚΙΑΖΕΤΑΙ ΚΑΤΑΣΤΗΜΑ»), often handwritten or printed on paper stuck to a window or balcony.",
	"Report ONLY what is actually legible in the photograph. Never guess a digit, never complete a partly hidden phone number, and never infer anything from the look of the building. If a field is not readable, leave it empty — an empty field costs nothing, a wrong phone number costs a phone call to a stranger.",
	"is_sign: true only if the photo really does show a for-sale/for-rent notice. A plain façade, a shop sign, a company van or an unrelated poster is false.",
	"listing_type: sale for ΠΩΛΕΙΤΑΙ/ΠΩΛΟΥΝΤΑΙ, rent for ΕΝΟΙΚΙΑΖΕΤΑΙ/ΕΝΟΙΚΙΑΖΟΝΤΑΙ. If the notice offers both, or you cannot tell, use unknown.",
	"phones: every phone number printed on the sign, EXACTLY as printed (keep the spacing and any prefix). Greek numbers have 10 digits and start with 2 (landline) or 69 (mobile). Include all of them if several are shown.",
	"advertiser: agency if the sign carries a real-estate agency's name, logo, licence number (ΑΜΑ / Α.Μ.Α.), or wording like ΜΕΣΙΤΙΚΟ ΓΡΑΦΕΙΟ / REAL ESTATE / ΚΤΗΜΑΤΟΜΕΣΙΤΙΚΗ. private when it reads as an owner's own notice (usually handwritten, just a phone, often «ΑΠΟ ΙΔΙΩΤΗ» or «ΧΩΡΙΣ ΜΕΣΙΤΗ»). unknown if you cannot tell. Put the agency's name in agency_name when you can read it.",
	"property_type: what is offered, in Greek and in the words of the sign — διαμέρισμα, γκαρσονιέρα, μονοκατοικία, μεζονέτα, κατάστημα, γραφείο, επαγγελματικός χώρος, αποθήκη, οικόπεδο, γκαράζ/θέση στάθμευσης. Empty if the sign does not say.",
	"size_sqm: the area in square metres as a plain number, if printed (τ.μ., τμ, m2). floor: the floor as printed (ισόγειο, 1ος, ημιώροφος…). price: the price as printed, with its currency and any «/μήνα».",
	"street_hint: a street name or building number visible ANYWHERE in the photo — a street plate, a door number, a nearby shop's address. This is the only clue to the address when the photo carries no location data, so read it if it is there.",
	"sign_text: everything legible on the notice, transcribed as one line, in Greek, so a human can check your reading. rooms/extras: anything else useful the sign says (bedrooms, «ΑΝΑΚΑΙΝΙΣΜΕΝΟ», «ΓΩΝΙΑΚΟ», «ΜΕ ΑΣΑΝΣΕΡ», calling hours).",
	"confidence: high if the sign is sharp and fully legible, medium if you had to work at it, low if you are unsure of any digit or the photo is blurred, dark or far away.",
].join("\n");

const EXTRACT_SCHEMA = {
	type: "OBJECT",
	properties: {
		is_sign: { type: "BOOLEAN" },
		listing_type: { type: "STRING", enum: ["sale", "rent", "unknown"] },
		phones: { type: "ARRAY", items: { type: "STRING" } },
		advertiser: { type: "STRING", enum: ["private", "agency", "unknown"] },
		agency_name: { type: "STRING" },
		property_type: { type: "STRING" },
		size_sqm: { type: "STRING" },
		floor: { type: "STRING" },
		price: { type: "STRING" },
		street_hint: { type: "STRING" },
		sign_text: { type: "STRING" },
		extras: { type: "STRING" },
		confidence: { type: "STRING", enum: ["high", "medium", "low"] },
	},
	required: ["is_sign", "listing_type", "phones", "advertiser", "confidence"],
};

/* ------------------------------------------------------ signed URLs */

function b64url(bytes) {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* Ίδιο μυστικό με τις φωτογραφίες (PHOTO_SIGN_KEY) αλλά ΔΙΑΦΟΡΕΤΙΚΟ
   namespace στο μήνυμα: μια υπογραφή για lead δεν ανοίγει ποτέ αρχείο
   του photo pipeline και το αντίστροφο. */
async function hmac(env, message) {
	const key = await crypto.subtle.importKey(
		"raw", new TextEncoder().encode(env.PHOTO_SIGN_KEY),
		{ name: "HMAC", hash: "SHA-256" }, false, ["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return b64url(new Uint8Array(sig));
}

async function signedFileUrl(env, origin, batchId, name) {
	const exp = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL;
	const sig = await hmac(env, `lead/${batchId}/${name}\n${exp}`);
	return `${origin}/api/leads/file/${batchId}/${encodeURIComponent(name)}?exp=${exp}&sig=${sig}`;
}

function safeEqual(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/* --------------------------------------------------------- helpers */

function newBatchId() {
	const b = crypto.getRandomValues(new Uint8Array(16));
	return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const isBatchId = (s) => /^[0-9a-f]{32}$/.test(s);

function sanitizeName(name, mime) {
	let base = String(name || "lead").split(/[\\/]/).pop().slice(0, 80);
	base = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "lead";
	if (!/\.[A-Za-z0-9]+$/.test(base)) base += "." + (EXT_FOR_MIME[mime] || "jpg");
	return base;
}

function esc(s) {
	return String(s == null ? "" : s)
		.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function clip(v, max) {
	const s = String(v == null ? "" : v).trim();
	return s ? s.slice(0, max) : "";
}

const TYPE_LABEL = { sale: "Πώληση", rent: "Ενοικίαση", unknown: "—" };
const ADVERTISER_LABEL = {
	private: "Ιδιώτης", agency: "Μεσιτικό γραφείο",
	business: "Επιχείρηση (όχι μεσιτικό)", unknown: "Άγνωστο",
};
const CONFIDENCE_LABEL = { high: "υψηλή", medium: "μέτρια", low: "χαμηλή" };
/* Πόσο «βαρύ» είναι ένα εύρημα του web όταν μια πινακίδα έχει πολλά
   τηλέφωνα — μεσιτικό νικάει επιχείρηση, επιχείρηση νικάει το τίποτα. */
const WEB_RANK = { agency: 3, business: 2, private: 1 };
const SOURCE_LABEL = {
	device: "στίγμα συσκευής",
	exif: "metadata φωτογραφίας",
	manual: "χειρόγραφη διεύθυνση",
};

/* --------------------------------------------------------- AI call */

function toBase64(buf) {
	const b = new Uint8Array(buf);
	let s = "";
	const CHUNK = 0x8000;                     // apply() σκάει σε μεγάλα arrays
	for (let i = 0; i < b.length; i += CHUNK) {
		s += String.fromCharCode.apply(null, b.subarray(i, i + CHUNK));
	}
	return btoa(s);
}

/* Ένα vision call ανά φωτογραφία, ~0,005 €. responseSchema ώστε η
   απάντηση να είναι εγγυημένα JSON — χωρίς αυτό το parsing γίνεται
   ψάξιμο για αγκύλες μέσα σε πεζό κείμενο. Ποτέ δεν κάνει throw: μία
   αποτυχία δεν πρέπει να ρίξει όλη τη βόλτα. */
async function extractSign(env, bytes, contentType) {
	const model = env.LEADS_GEMINI_MODEL || DEFAULT_MODEL;
	try {
		const res = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
			method: "POST",
			headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
			body: JSON.stringify({
				contents: [{
					parts: [
						{ text: EXTRACT_PROMPT },
						{ inline_data: { mime_type: contentType, data: toBase64(bytes) } },
					],
				}],
				generationConfig: {
					temperature: 0,
					responseMimeType: "application/json",
					responseSchema: EXTRACT_SCHEMA,
				},
			}),
		});
		if (!res.ok) {
			console.warn(`leads: Gemini HTTP ${res.status}`);
			return { error: `HTTP ${res.status}` };
		}
		const body = await res.json();
		const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
		if (!text) return { error: "empty response" };
		return JSON.parse(text);
	} catch (err) {
		console.warn(`leads: extraction failed: ${String(err)}`);
		return { error: String(err).slice(0, 120) };
	}
}

/* --------------------------------------------------- reverse geocode

   Συντεταγμένες δεν διαβάζονται από άνθρωπο — «Φραγκίνη 9» διαβάζεται.
   Ομαδοποιεί σε πλέγμα ~11 m (δύο φωτογραφίες της ίδιας πινακίδας
   παίρνουν ένα μόνο ερώτημα) και σέβεται το όριο 1 κλήση/δευτερόλεπτο
   του Nominatim. Αποτυχία δεν είναι πρόβλημα: μένουν οι συντεταγμένες
   και ο χάρτης. */
async function reverseGeocodeAll(leads) {
	const wanted = new Map();                 // grid key -> [lead, …]
	for (const l of leads) {
		if (l.lat == null || l.lng == null || l.address) continue;
		const key = `${l.lat.toFixed(4)},${l.lng.toFixed(4)}`;
		if (!wanted.has(key)) wanted.set(key, []);
		wanted.get(key).push(l);
	}
	let n = 0;
	for (const [key, group] of wanted) {
		if (++n > GEOCODE_MAX) {
			console.warn(`leads: geocoding capped at ${GEOCODE_MAX}; ${wanted.size - GEOCODE_MAX} points left as coordinates`);
			break;
		}
		if (n > 1) await new Promise((r) => setTimeout(r, 1100));
		const [lat, lng] = key.split(",");
		try {
			const url = `${NOMINATIM}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1&accept-language=el`;
			const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			const a = data?.address || {};
			const street = [a.road, a.house_number].filter(Boolean).join(" ");
			const area = a.suburb || a.neighbourhood || a.city_district || a.town || a.village || a.city || "";
			const label = [street, area].filter(Boolean).join(", ") || data?.display_name || "";
			for (const l of group) {
				l.address = label ? label.slice(0, 200) : "";
				l.address_source = "osm";
				l.area = area || null;
			}
		} catch (err) {
			console.warn(`leads: reverse geocode failed for ${key}: ${String(err)}`);
		}
	}
}

/* ----------------------------------------------------------- email

   Το HTML χτίζεται εδώ (όπως lead-reply.mjs / valuation.mjs) και το Make
   απλώς το στέλνει. Ένα email ΑΝΑ ΒΟΛΤΑ, όχι ανά φωτογραφία: μια
   βραδινή βόλτα αλλιώς γεμίζει το info@ με δεκαπέντε μηνύματα. */

const NAVY = "#16233A", PINK = "#FF1462", LINE = "#eceef2", MUTED = "#6b7280";

function mapsLink(l) {
	if (l.lat != null && l.lng != null) {
		return `https://www.google.com/maps/search/?api=1&query=${l.lat.toFixed(6)},${l.lng.toFixed(6)}`;
	}
	return l.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(l.address)}` : null;
}

/* Η γραμμή κάτω από κάθε τηλέφωνο: τι απάντησαν το CRM και το web. Το
   «δεν βρέθηκε πουθενά» τυπώνεται ΠΡΑΣΙΝΟ, όχι γκρι — για μια πινακίδα
   αυτό σημαίνει «ιδιώτης, δικό μας lead», και είναι το καλύτερο νέο της
   γραμμής. Ο σύνδεσμος της πηγής μπαίνει πάντα, ώστε να μπορεί κάποιος
   να διαψεύσει το μοντέλο σε ένα κλικ. */
function phoneCheck(p) {
	const bits = [];
	if (p.crm) {
		bits.push(`<span style="color:#b45309; font-weight:bold;">ήδη στο CRM:</span> ${esc(p.crm.name || "επαφή")}`);
	}
	const w = p.web;
	if (w) {
		if (w.kind === "agency" || w.kind === "business") {
			const label = w.kind === "agency" ? "μεσιτικό γραφείο" : "επιχείρηση";
			bits.push(`<span style="color:${w.kind === "agency" ? "#b45309" : NAVY}; font-weight:bold;">${label}</span>`
				+ (w.name ? " · " + esc(w.name) : "")
				+ (w.website ? ` · <a href="${esc(w.website)}" style="color:${MUTED};">πηγή</a>` : "")
				+ (w.confidence !== "high" ? ` <span style="color:${MUTED};">(βεβαιότητα ${esc(CONFIDENCE_LABEL[w.confidence] || w.confidence)})</span>` : ""));
		} else if (w.kind === "private") {
			bits.push(`<span style="color:#12855b;">δεν βρέθηκε σε επιχείρηση — μάλλον ιδιώτης</span>`);
		} else {
			bits.push(`<span style="color:${MUTED};">ο έλεγχος δεν κατέληξε</span>`);
		}
	}
	if (!bits.length) return "";
	return `<div style="font-size:12px; color:${MUTED}; margin:2px 0 6px 0; line-height:1.5;">↳ ${bits.join(" · ")}</div>`;
}

function leadCard(l, i) {
	const phones = l.phones || [];
	const flagged = !phones.length;
	const link = mapsLink(l);
	const locText = l.address || (l.lat != null ? `${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}` : "—");

	const rows = [];
	const row = (k, v) => rows.push(
		`<tr><td style="padding:3px 10px 3px 0; font-size:13px; color:${MUTED}; white-space:nowrap; vertical-align:top;">${esc(k)}</td>`
		+ `<td style="padding:3px 0; font-size:13px; color:${NAVY};">${v}</td></tr>`,
	);

	row("Τοποθεσία", (link ? `<a href="${esc(link)}" style="color:${NAVY};">${esc(locText)}</a>` : esc(locText))
		+ `<span style="color:${MUTED};"> · ${esc(SOURCE_LABEL[l.location_source] || "")}`
		+ (l.accuracy ? ` ±${Math.round(l.accuracy)} m` : "") + "</span>");

	if (phones.length) {
		row("Τηλέφωνο", phones.map((p) => `<a href="tel:+30${p.digits}" style="color:${PINK}; font-weight:bold; text-decoration:none;">${esc(p.display)}</a>`
			+ (p.duplicate ? `<span style="color:${MUTED}; font-size:12px;"> (ίδιο με προηγούμενο)</span>` : "")
			+ phoneCheck(p)).join("<br>"));
	}
	row("Είδος", esc(TYPE_LABEL[l.listing_type] || "—")
		+ (l.property_type ? " · " + esc(l.property_type) : ""));
	const who = ADVERTISER_LABEL[l.advertiser] || "Άγνωστο";
	row("Από", (l.advertiser === "agency"
		? `<strong style="color:#b45309;">${esc(who)}</strong>` + (l.agency_name ? " · " + esc(l.agency_name) : "")
		: esc(who)));
	const specs = [l.size_sqm ? l.size_sqm + " τ.μ." : "", l.floor, l.price].filter(Boolean).join(" · ");
	if (specs) row("Στοιχεία", esc(specs));
	if (l.extras) row("Άλλα", esc(l.extras));
	if (l.sign_text) row("Πινακίδα", `<span style="color:${MUTED};">${esc(l.sign_text)}</span>`);
	if (l.taken_at) row("Λήψη", esc(l.taken_at.replace("T", " ")));
	row("Ποιότητα", esc(CONFIDENCE_LABEL[l.confidence] || "—")
		+ (l.is_sign === false ? ` · <strong style="color:#b45309;">δεν φαίνεται πινακίδα</strong>` : ""));

	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${flagged ? "#f0c9a8" : LINE}; border-left:3px solid ${flagged ? "#c2410c" : PINK}; border-radius:6px; margin:0 0 14px 0;">
	<tr><td style="padding:12px 14px;">
		<div style="font-size:15px; font-weight:bold; color:${NAVY}; margin-bottom:8px;">${i + 1}. ${esc(l.address || TYPE_LABEL[l.listing_type] || "Lead")}</div>
		${flagged ? `<div style="background:#fdeee7; border-radius:5px; padding:8px 10px; margin-bottom:9px; font-size:13px; color:#8a2c06;"><strong>ΧΩΡΙΣ ΤΗΛΕΦΩΝΟ</strong> — δες τη φωτογραφία${l.error ? " (η ανάγνωση απέτυχε)" : ""}.</div>` : ""}
		${l.conflict ? `<div style="background:#fdeee7; border-radius:5px; padding:8px 10px; margin-bottom:9px; font-size:13px; color:#8a2c06;"><strong>ΠΡΟΣΟΧΗ</strong> — η πινακίδα δεν γράφει γραφείο, αλλά το τηλέφωνο βγαίνει μεσιτικό.</div>` : ""}
		<table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows.join("\n\t\t")}</table>
		<a href="${esc(l.url)}" style="display:block; margin-top:10px;"><img src="${esc(l.url)}" alt="" width="240" style="width:240px; max-width:100%; border-radius:5px; border:1px solid ${LINE}; display:block;"></a>
	</td></tr>
</table>`;
}

function buildEmail(payload) {
	const { leads, note, submitted_by, count } = payload;
	const withPhone = leads.filter((l) => (l.phones || []).length).length;
	const agencies = leads.filter((l) => l.advertiser === "agency").length;

	const subject = `Νέα leads από πινακίδες — ${count} ${count === 1 ? "φωτογραφία" : "φωτογραφίες"}`
		+ (withPhone < count ? ` (${withPhone} με τηλέφωνο)` : "");

	const known = leads.filter((l) => l.known_contact).length;
	const summary = [
		`${count} ${count === 1 ? "φωτογραφία" : "φωτογραφίες"}`,
		`${withPhone} με τηλέφωνο`,
		agencies ? `${agencies} από μεσιτικό γραφείο` : "",
		known ? `${known} ήδη στο CRM` : "",
	].filter(Boolean).join(" · ");

	const html = `<!doctype html><html lang="el"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0; padding:0; background:#f4f5f7; font-family:Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7; padding:16px 0;">
<tr><td align="center">
	<table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px; width:100%; background:#ffffff; border-radius:8px; overflow:hidden;">
		<tr><td style="background:${NAVY}; padding:15px 20px;"><span style="color:#ffffff; font-size:18px; font-weight:bold; letter-spacing:1.5px;">FOUR WALLS</span><span style="color:${PINK}; font-size:10px; font-weight:bold; letter-spacing:2px;">&nbsp;&nbsp;REAL ESTATE</span></td></tr>
		<tr><td style="padding:18px 20px 6px 20px;">
			<div style="font-size:17px; font-weight:bold; color:${NAVY};">Leads από πινακίδες</div>
			<div style="font-size:13px; color:${MUTED}; margin-top:4px;">${esc(summary)}${submitted_by ? " · " + esc(submitted_by) : ""}</div>
		</td></tr>
		${note ? `<tr><td style="padding:10px 20px 0 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#f7f8fa; border-radius:6px; padding:11px 13px; font-size:13px; color:${NAVY};"><strong>Σημείωση:</strong> ${esc(note)}</td></tr></table></td></tr>` : ""}
		<tr><td style="padding:16px 20px 4px 20px;">
			${leads.map(leadCard).join("\n\t\t\t")}
		</td></tr>
		<tr><td style="border-top:1px solid ${LINE}; padding:14px 20px; font-size:11px; color:#999999; line-height:1.6;">
			Στάλθηκε αυτόματα από τα Έντυπα (Γρήγορο lead). Τα στοιχεία διαβάστηκαν από φωτογραφία με AI — <strong>επιβεβαίωσέ τα πριν την κλήση</strong>.
			Οι φωτογραφίες σβήνονται αυτόματα μετά από 30 ημέρες.
		</td></tr>
	</table>
</td></tr></table>
</body></html>`;

	const text = [
		`Leads από πινακίδες — ${summary}`,
		submitted_by ? `Από: ${submitted_by}` : "",
		note ? `Σημείωση: ${note}` : "",
		"",
		...leads.map((l, i) => [
			`${i + 1}. ${l.address || (l.lat != null ? `${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}` : "χωρίς τοποθεσία")}`,
			`   Τηλ: ${(l.phones || []).map((p) => p.display
				+ (p.crm ? ` [ήδη στο CRM: ${p.crm.name}]` : "")
				+ (p.web?.kind === "agency" ? ` [μεσιτικό${p.web.name ? ": " + p.web.name : ""}]`
					: p.web?.kind === "business" ? ` [επιχείρηση${p.web.name ? ": " + p.web.name : ""}]`
					: p.web?.kind === "private" ? " [δεν βρέθηκε σε επιχείρηση]" : "")).join(", ")
				|| "— ΧΩΡΙΣ ΤΗΛΕΦΩΝΟ, δες τη φωτό"}`,
			l.conflict ? "   ΠΡΟΣΟΧΗ: η πινακίδα δεν γράφει γραφείο, αλλά το τηλέφωνο βγαίνει μεσιτικό." : "",
			`   ${TYPE_LABEL[l.listing_type] || "—"}${l.property_type ? " · " + l.property_type : ""} · ${ADVERTISER_LABEL[l.advertiser]}${l.agency_name ? " (" + l.agency_name + ")" : ""}`,
			l.price || l.size_sqm || l.floor ? `   ${[l.size_sqm ? l.size_sqm + " τ.μ." : "", l.floor, l.price].filter(Boolean).join(" · ")}` : "",
			`   ${l.url}`,
		].filter(Boolean).join("\n")),
	].filter(Boolean).join("\n");

	return { subject, html, text, summary };
}

/* ----------------------------------------------------- API routing

   Όλα εδώ έχουν ήδη περάσει από το Access (worker/index.mjs) — ο
   καλών είναι επώνυμος σύμβουλος. */

export async function handleLeadApi(request, env, url, email) {
	if (!env.PHOTO_BUCKET) {
		console.error("leads: PHOTO_BUCKET (R2) not bound");
		return json({ error: "not_configured" }, 503);
	}
	const parts = url.pathname.split("/").filter(Boolean); // api leads <action> …

	if (request.method === "POST" && parts[2] === "init") {
		return initBatch(request, env, email);
	}
	if (request.method === "PUT" && parts[2] === "upload") {
		return uploadOne(request, env, parts[3], parts[4]);
	}
	if (request.method === "POST" && parts[2] === "finalize") {
		return finalizeBatch(request, env, url, parts[3]);
	}
	return json({ error: "not_found" }, 404);
}

async function initBatch(request, env, email) {
	let body;
	try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }

	const count = Number(body?.count || 0);
	if (!Number.isInteger(count) || count < 1 || count > MAX_FILES) {
		return json({ error: "bad_count", max: MAX_FILES }, 400);
	}
	const batchId = newBatchId();
	await env.PHOTO_BUCKET.put(`leads/${batchId}/meta.json`, JSON.stringify({
		batch_id: batchId,
		created_at: new Date().toISOString(),
		submitted_by: email || null,
		count,
	}), { httpMetadata: { contentType: "application/json" } });
	return json({ ok: true, batch_id: batchId });
}

async function uploadOne(request, env, batchId, seqRaw) {
	if (!isBatchId(batchId)) return json({ error: "bad_batch" }, 400);
	const seq = Number(seqRaw);
	if (!Number.isInteger(seq) || seq < 0 || seq >= MAX_FILES) return json({ error: "bad_seq" }, 400);

	// Μόνο σε batch που άνοιξε το init γράφεται κάτι.
	if (!(await env.PHOTO_BUCKET.head(`leads/${batchId}/meta.json`))) {
		return json({ error: "unknown_batch" }, 404);
	}
	const mime = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
	if (!ALLOWED_MIME.has(mime)) return json({ error: "bad_type", got: mime }, 415);
	if (Number(request.headers.get("Content-Length") || 0) > MAX_FILE_BYTES) {
		return json({ error: "too_large", max: MAX_FILE_BYTES }, 413);
	}
	const bytes = await request.arrayBuffer();
	if (bytes.byteLength === 0) return json({ error: "empty" }, 400);
	if (bytes.byteLength > MAX_FILE_BYTES) return json({ error: "too_large", max: MAX_FILE_BYTES }, 413);

	const safe = sanitizeName(decodeURIComponent(request.headers.get("X-Filename") || ""), mime);
	const name = String(seq).padStart(3, "0") + "-" + safe;
	await env.PHOTO_BUCKET.put(`leads/${batchId}/orig/${name}`, bytes, {
		httpMetadata: { contentType: mime },
	});
	return json({ ok: true, name });
}

/* Τα per-photo στοιχεία τοποθεσίας έρχονται ΕΔΩ (και όχι στο upload) ώστε
   να ταξιδεύουν ως ένα JSON: ελληνικές διευθύνσεις σε HTTP header θέλουν
   encoding, και το R2 customMetadata έχει όριο μεγέθους. */
function cleanPhotoMeta(raw) {
	const lat = Number(raw?.lat), lng = Number(raw?.lng);
	const hasCoords = Number.isFinite(lat) && Number.isFinite(lng)
		&& Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
	const source = ["device", "exif", "manual"].includes(raw?.source) ? raw.source : "manual";
	return {
		seq: Number(raw?.seq),
		lat: hasCoords ? lat : null,
		lng: hasCoords ? lng : null,
		accuracy: Number.isFinite(Number(raw?.accuracy)) ? Number(raw.accuracy) : null,
		location_source: source,
		address: clip(raw?.address, 200) || "",
		address_source: clip(raw?.address, 200) ? "manual" : null,
		taken_at: clip(raw?.taken_at, 40) || null,
		device: clip(raw?.device, 80) || null,
	};
}

async function finalizeBatch(request, env, url, batchId) {
	if (!isBatchId(batchId)) return json({ error: "bad_batch" }, 400);
	if (!env.MAKE_LEADS_WEBHOOK) {
		console.error("leads: MAKE_LEADS_WEBHOOK secret not configured");
		return json({ error: "not_configured" }, 503);
	}
	if (!env.GEMINI_API_KEY) {
		console.error("leads: GEMINI_API_KEY secret not configured");
		return json({ error: "not_configured" }, 503);
	}
	const metaObj = await env.PHOTO_BUCKET.get(`leads/${batchId}/meta.json`);
	if (!metaObj) return json({ error: "unknown_batch" }, 404);
	const meta = await metaObj.json();

	let body;
	try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }
	const note = clip(body?.note, 500);
	const perPhoto = new Map();
	for (const raw of Array.isArray(body?.photos) ? body.photos : []) {
		const m = cleanPhotoMeta(raw);
		if (Number.isInteger(m.seq)) perPhoto.set(m.seq, m);
	}

	// Ό,τι πραγματικά προσγειώθηκε (ο browser μπορεί να έχασε ένα αρχείο).
	const objects = [];
	let cursor;
	do {
		const page = await env.PHOTO_BUCKET.list({ prefix: `leads/${batchId}/orig/`, cursor });
		objects.push(...page.objects);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	if (!objects.length) return json({ error: "no_photos" }, 400);
	objects.sort((a, b) => (a.key < b.key ? -1 : 1));

	// Η εγγύηση της τοποθεσίας, server-side. Λύνεται ΜΟΝΟ πάνω στον δρόμο.
	const missing = objects.filter((o) => {
		const seq = Number(o.key.slice(`leads/${batchId}/orig/`.length).slice(0, 3));
		const m = perPhoto.get(seq);
		return !m || (m.lat == null && !m.address);
	});
	if (missing.length) return json({ error: "no_location", count: missing.length }, 400);

	const origin = url.hostname === "localhost" || url.hostname === "127.0.0.1"
		? url.origin
		: `https://${url.hostname.replace(/^forms\./, "")}`;

	/* Διαβάζουμε + περνάμε από το μοντέλο τέσσερις-τέσσερις: αρκετά
	   παράλληλα ώστε μια βόλτα 12 φωτογραφιών να τελειώνει σε ~15 δευτ.,
	   αρκετά λίγα ώστε να μη χτυπάμε rate limit. */
	const leads = new Array(objects.length);
	const CONC = 4;
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(CONC, objects.length) }, async () => {
		while (next < objects.length) {
			const idx = next++;
			const o = objects[idx];
			const name = o.key.slice(`leads/${batchId}/orig/`.length);
			const seq = Number(name.slice(0, 3));
			const m = perPhoto.get(seq) || cleanPhotoMeta({ seq });
			const contentType = o.httpMetadata?.contentType || "image/jpeg";

			let ai = { error: "not read" };
			try {
				const obj = await env.PHOTO_BUCKET.get(o.key);
				if (obj) ai = await extractSign(env, await obj.arrayBuffer(), contentType);
			} catch (err) {
				console.warn(`leads: could not read ${o.key}: ${String(err)}`);
			}

			const phones = [...new Set((Array.isArray(ai.phones) ? ai.phones : [])
				.map(normPhone).filter(Boolean))]
				.map((d) => ({ digits: d, display: fmtPhone(d) }));

			leads[idx] = {
				name,
				url: await signedFileUrl(env, origin, batchId, name),
				content_type: contentType,
				...m,
				phones,
				is_sign: ai.is_sign !== false,
				listing_type: ["sale", "rent"].includes(ai.listing_type) ? ai.listing_type : "unknown",
				advertiser: ["private", "agency"].includes(ai.advertiser) ? ai.advertiser : "unknown",
				agency_name: clip(ai.agency_name, 120) || null,
				property_type: clip(ai.property_type, 60) || null,
				size_sqm: clip(ai.size_sqm, 20) || null,
				floor: clip(ai.floor, 40) || null,
				price: clip(ai.price, 40) || null,
				street_hint: clip(ai.street_hint, 120) || null,
				sign_text: clip(ai.sign_text, 400) || null,
				extras: clip(ai.extras, 200) || null,
				confidence: ["high", "medium", "low"].includes(ai.confidence) ? ai.confidence : "low",
				error: ai.error || null,
			};
		}
	}));

	/* Το ίδιο τηλέφωνο σε δύο φωτογραφίες είναι ΕΝΑ lead — συνήθως δύο
	   λήψεις της ίδιας πινακίδας. Σημαίνεται αντί να αφαιρεθεί: η δεύτερη
	   φωτογραφία μπορεί να δείχνει κάτι που η πρώτη έκοψε. */
	const seenPhones = new Set();
	for (const l of leads) {
		for (const p of l.phones) {
			p.duplicate = seenPhones.has(p.digits);
			seenPhones.add(p.digits);
		}
	}

	/* Ποιος έχει αυτό το τηλέφωνο; Τρέχει ΜΙΑ φορά ανά μοναδικό νούμερο,
	   όχι ανά φωτογραφία, και πάντα πριν φύγει το email: η γραμματεία
	   πρέπει να ξέρει ΠΡΙΝ σηκώσει το ακουστικό αν μιλάει σε συνάδελφο ή
	   σε δικιά μας επαφή. Το CRM πρώτα (δωρεάν, αυθεντικό)· στο web
	   πηγαίνουν μόνο όσα δεν τα ξέρουμε ήδη. */
	const uniquePhones = [...new Set(leads.flatMap((l) => l.phones.map((p) => p.digits)))];
	const crm = await crmMatches(env, uniquePhones);
	const web = await webLookup(env, uniquePhones.filter((d) => !crm.has(d)));
	for (const l of leads) {
		for (const p of l.phones) {
			p.crm = crm.get(p.digits) || null;
			p.web = web.get(p.digits) || null;
		}
		/* Το τελικό «από ποιον» σταθμίζει πινακίδα και web μαζί — και
		   κρατάει τη διαφωνία, που είναι η πιο χρήσιμη πληροφορία εδώ.
		   Όταν η πινακίδα έχει δύο νούμερα (συνήθως ένα κινητό κι ένα
		   σταθερό), μετράει το ΙΣΧΥΡΟΤΕΡΟ εύρημα, όχι το πρώτο: αν έστω
		   ένα από τα δύο ανήκει σε γραφείο, η πινακίδα είναι γραφείου.
		   Το «δεν βρέθηκε τίποτα» για το κινητό δεν αναιρεί το σταθερό. */
		const strongest = l.phones
			.filter((p) => p.web && p.web.kind !== "unknown")
			.sort((a, b) => (WEB_RANK[b.web.kind] || 0) - (WEB_RANK[a.web.kind] || 0))[0];
		const { verdict, conflict } = reconcile(l.advertiser, strongest?.web);
		l.advertiser = verdict;
		l.conflict = conflict;
		if (!l.agency_name && strongest?.web?.kind === "agency" && strongest.web.name) {
			l.agency_name = strongest.web.name;
		}
		l.known_contact = l.phones.find((p) => p.crm)?.crm || null;
	}

	/* Η χειρόγραφη διεύθυνση υπερισχύει — ο άνθρωπος που στεκόταν εκεί
	   ξέρει καλύτερα από το OSM. Το reverse geocode συμπληρώνει τα υπόλοιπα. */
	await reverseGeocodeAll(leads);
	/* Τελευταίο δίχτυ: πινακίδα χωρίς διεύθυνση αλλά με πινακίδα δρόμου
	   στη φωτογραφία — καλύτερο από σκέτες συντεταγμένες. */
	for (const l of leads) {
		if (!l.address && l.street_hint) {
			l.address = l.street_hint;
			l.address_source = "sign";
		}
	}

	const payload = {
		batch_id: batchId,
		submitted_by: meta.submitted_by,
		submitted_at: new Date().toISOString(),
		count: leads.length,
		note: note || null,
		leads,
	};
	Object.assign(payload, buildEmail(payload));

	const fwd = await fetch(env.MAKE_LEADS_WEBHOOK, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(env.MAKE_LEADS_APIKEY ? { "x-make-apikey": env.MAKE_LEADS_APIKEY } : {}),
		},
		body: JSON.stringify(payload),
	});
	if (!fwd.ok) {
		console.error(`leads: Make forward failed for ${batchId} (HTTP ${fwd.status})`);
		return json({ error: "forward_failed" }, 502);
	}
	console.log(JSON.stringify({
		event: "lead_batch", batch_id: batchId, count: leads.length,
		with_phone: leads.filter((l) => l.phones.length).length,
		agencies: leads.filter((l) => l.advertiser === "agency").length,
		known_contacts: leads.filter((l) => l.known_contact).length,
		conflicts: leads.filter((l) => l.conflict).length,
		by: meta.submitted_by, ts: new Date().toISOString(),
	}));
	return json({
		ok: true,
		count: leads.length,
		with_phone: leads.filter((l) => l.phones.length).length,
		agencies: leads.filter((l) => l.advertiser === "agency").length,
		known_contacts: leads.filter((l) => l.known_contact).length,
	});
}

/* --------------------------------------------------- signed download

   Το ανοίγει το email (Zoho/Gmail image proxy), όχι ο browser του
   συμβούλου — άρα apex host, χωρίς Access, με υπογραφή HMAC αντί για
   cookie. Σερβίρει ΜΟΝΟ originals αυτού του batch· το υπογεγραμμένο
   όνομα δεν περιέχει slash, οπότε δεν βγαίνει σε άλλο prefix. */
export async function serveLeadFile(request, env, url) {
	if (!env.PHOTO_BUCKET || !env.PHOTO_SIGN_KEY) {
		return new Response("Not configured", { status: 503 });
	}
	const m = url.pathname.match(/^\/api\/leads\/file\/([0-9a-f]{32})\/([^/]+)$/);
	if (!m) return new Response("Not Found", { status: 404 });
	const batchId = m[1];
	const name = decodeURIComponent(m[2]);

	const exp = Number(url.searchParams.get("exp") || 0);
	const sig = url.searchParams.get("sig") || "";
	if (!exp || exp < Math.floor(Date.now() / 1000)) {
		return new Response("Link expired", { status: 410 });
	}
	const expected = await hmac(env, `lead/${batchId}/${name}\n${exp}`);
	if (!safeEqual(sig, expected)) return new Response("Forbidden", { status: 403 });

	const obj = await env.PHOTO_BUCKET.get(`leads/${batchId}/orig/${name}`);
	if (!obj) return new Response("Not Found", { status: 404 });
	return new Response(obj.body, {
		headers: {
			"Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
			"Content-Length": String(obj.size),
			"Cache-Control": "private, no-store",
		},
	});
}
