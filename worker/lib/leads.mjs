/* =====================================================================
   Four Walls — «Πινακίδα»: leads από φωτογραφίες πινακίδων (forms/pinakida.html)
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
   χρειάζεται νέο R2 bucket. Βλ. docs/pinakides.md.
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
/* Πόσες φορές ζητάμε ΤΗΝ ΙΔΙΑ φωτογραφία πριν την παρατήσουμε. Ένα 429
   δεν είναι απάντηση, είναι «ξαναρώτα»: χωρίς επανάληψη μια ολόκληρη
   βόλτα χάνεται σε ένα δευτερόλεπτο (05/08/2026). */
const AI_TRIES = 3;
const AI_BACKOFF_MS = [1500, 6000];         // πριν από την 2η και την 3η
const AI_MAX_WAIT_MS = 20000;               // ταβάνι· η φόρμα περιμένει άνθρωπο
/* Το Nominatim θέλει αναγνωρίσιμο User-Agent και max 1 κλήση/δευτ. — βλ.
   την πολιτική χρήσης. Ίδια σύμβαση με το accessibility.mjs. */
const NOMINATIM = "https://nominatim.openstreetmap.org";
const UA = "four-walls-leads/1.0 (+https://four-walls.gr)";
const GEOCODE_MAX = 20;                     // πάνω από αυτό, μόνο συντεταγμένες

/* --------------------------------------------------------- AI prompt

   Ό,τι ζητάμε από το μοντέλο ζει εδώ, όχι σε IML μέσα στο Make. Τρία
   πεδία αξίζουν όσο όλα τα υπόλοιπα μαζί:

   - `advertiser`: οι μισές πινακίδες στη Θεσσαλονίκη είναι συναδέλφων.
     Χωρίς αυτό το γραφείο παίρνει τηλέφωνο τον ανταγωνισμό.
   - `is_sign`: φρένο για τη λάθος φωτογραφία (σκέτη πρόσοψη, στραβή
     λήψη). Χωρίς αυτό το μοντέλο «βρίσκει» τηλέφωνα που δεν υπάρχουν.
   - `signs[]`: ΜΙΑ φωτογραφία δεν σημαίνει ένα ακίνητο. Δύο χαρτιά στο
     ίδιο μάρμαρο είναι δύο ακίνητα, δύο ιδιοκτήτες, δύο τηλέφωνα — και
     πρέπει να γίνουν δύο επαφές. Όσο το μοντέλο επέστρεφε ένα επίπεδο
     αντικείμενο, τα δύο νούμερα κατέληγαν στην ΙΔΙΑ επαφή και τα τ.μ.
     γίνονταν «24, 25» (πραγματικό, 03/08/2026: 5ος όροφος 24 τ.μ. και
     7ος όροφος 25 τ.μ. «Μαρία», μία επαφή για δύο γραφεία). */
const EXTRACT_PROMPT = [
	"You are reading ONE photograph taken in a Greek street by a real-estate consultant. It normally shows one or more FOR SALE / FOR RENT notices on a building («ΠΩΛΕΙΤΑΙ», «ΕΝΟΙΚΙΑΖΕΤΑΙ», «ΠΩΛΕΙΤΑΙ ΔΙΑΜΕΡΙΣΜΑ», «ΕΝΟΙΚΙΑΖΕΤΑΙ ΚΑΤΑΣΤΗΜΑ»), often handwritten or printed on paper stuck to a window, a wall or a balcony.",
	"Report ONLY what is actually legible in the photograph. Never guess a digit, never complete a partly hidden phone number, and never infer anything from the look of the building. If a field is not readable, leave it empty — an empty field costs nothing, a wrong phone number costs a phone call to a stranger.",
	"is_sign: true if the photo really does show at least one for-sale/for-rent notice. A plain façade, a shop sign, a company van or an unrelated poster is false, and then signs must be an empty array.",
	"ONE PHOTO OFTEN CARRIES SEVERAL SEPARATE NOTICES — two sheets one under the other on the same wall, a row of papers on a shop window, three banners on one balcony. Each separate notice is a DIFFERENT property, with a different owner and a different phone. Return ONE entry in `signs` per separate notice and NEVER merge two of them: «ΕΝΟΙΚΙΑΖΕΤΑΙ … 24 τ.μ. … 6941551511» above «ΕΝΟΙΚΙΑΖΕΤΑΙ … 25 τ.μ. … 6972470928» is two entries, not one entry of «24, 25» with two phones.",
	"Merge into a SINGLE entry only when one notice describes one property, even across levels or with two contact numbers of its own — «17 τ.μ. ισόγειο - 25 τ.μ. υπόγειο» printed on one sheet is one shop on two levels, and a sheet showing both a mobile and a landline is one property with two numbers.",
	"A sheet that carries NO information of its own — a bare «ΕΝΟΙΚΙΑΖΕΤΑΙ» or «ΠΩΛΕΙΤΑΙ» with no phone, no size and no price — sitting next to or above a complete one on the same window or door, is the SAME property announced twice. Do not return it as a second entry. A second entry needs something of its own: its own phone, or its own size, floor or price.",
	"IGNORE ANYTHING THAT IS A REFLECTION IN THE GLASS. Shop windows mirror the street opposite: notices that read backwards, appear behind the glass among cars, people or other buildings, or belong to a different shop in the distance are not on this property. Read only what is stuck on the surface you are looking at.",
	"Order the entries the way they appear: top to bottom, then left to right.",
	"Per entry — listing_type: sale for ΠΩΛΕΙΤΑΙ/ΠΩΛΟΥΝΤΑΙ, rent for ΕΝΟΙΚΙΑΖΕΤΑΙ/ΕΝΟΙΚΙΑΖΟΝΤΑΙ. If that notice offers both, or you cannot tell, use unknown.",
	"phones: every phone number printed on THAT notice, EXACTLY as printed (keep the spacing and any prefix). Greek numbers have 10 digits and start with 2 (landline) or 69 (mobile). Never carry a number over from a neighbouring notice.",
	"advertiser: agency if the notice carries a real-estate agency's name, logo, licence number (ΑΜΑ / Α.Μ.Α.), or wording like ΜΕΣΙΤΙΚΟ ΓΡΑΦΕΙΟ / REAL ESTATE / ΚΤΗΜΑΤΟΜΕΣΙΤΙΚΗ. private when it reads as an owner's own notice (usually handwritten, just a phone, often «ΑΠΟ ΙΔΙΩΤΗ» or «ΧΩΡΙΣ ΜΕΣΙΤΗ»). unknown if you cannot tell. Put the agency's name in agency_name when you can read it.",
	"contact_name: a person's name printed next to the phone («Μαρία», «κ. Παπαδόπουλος», «ΓΙΩΡΓΟΣ»), if there is one. This is who answers the call — leave it empty rather than inventing it.",
	"property_type: what that notice offers, in Greek and in its own words — διαμέρισμα, γκαρσονιέρα, μονοκατοικία, μεζονέτα, κατάστημα, γραφείο, επαγγελματικός χώρος, αποθήκη, οικόπεδο, γκαράζ/θέση στάθμευσης. Empty if it does not say.",
	"size_sqm: that notice's area in square metres as a plain number, if printed (τ.μ., τμ, m2). floor: the floor as printed (ισόγειο, 1ος, 5ο όροφο, ημιώροφος…). price: the price as printed, with its currency and any «/μήνα».",
	"sign_text: everything legible on THAT notice, transcribed as one line, in Greek, so a human can check your reading. extras: anything else useful it says (bedrooms, «ΑΝΑΚΑΙΝΙΣΜΕΝΟ», «ΓΩΝΙΑΚΟ», «ΜΕ ΑΣΑΝΣΕΡ», «AIR CONDITION», calling hours).",
	"confidence: high if that notice is sharp and fully legible, medium if you had to work at it, low if you are unsure of any digit or it is blurred, dark or far away. Judge each notice on its own — a sharp one next to a blurred one keeps its high.",
	"street_hint belongs to the PHOTO, not to a notice: a street name or building number visible ANYWHERE in it — a street plate, a door number, a nearby shop's address. This is the only clue to the address when the photo carries no location data, so read it if it is there.",
].join("\n");

/* Ένα «χαρτί» στον τοίχο. Ό,τι είναι δικό του και μόνο δικό του.

   ΤΟ maxLength ΔΕΝ ΕΙΝΑΙ ΚΑΛΛΩΠΙΣΜΟΣ. Χωρίς αυτό το μοντέλο μπορεί να
   κολλήσει σε βρόχο επανάληψης μέσα σε ένα ελεύθερο πεδίο και να γράφει
   μέχρι να τελειώσουν τα tokens. Πραγματικό, 04/08/2026: σε τρεις στις
   τρεις πινακίδες το `size_sqm` βγήκε
   «55_καθαρά_ή_55_τ.μ._(καθαρά)_-> 55_καθαρά_ή_…» επί 65.000 tokens,
   η γέννηση κόπηκε στο MAX_TOKENS, το JSON έμεινε μισό και ΟΛΗ η
   φωτογραφία έγινε «ΧΩΡΙΣ ΤΗΛΕΦΩΝΟ» — ενώ το τηλέφωνο είχε διαβαστεί
   σωστά στην τρίτη γραμμή της απάντησης. Με τα όρια εδώ ο βρόχος δεν
   έχει πού να τρέξει: ίδιες φωτογραφίες, 225 tokens και καθαρό JSON.
   Τα μήκη είναι τα ίδια με τα clip() παρακάτω — ό,τι θα κοβόταν έτσι κι
   αλλιώς, τώρα δεν γράφεται καν.

   Το propertyOrdering βάζει ΠΡΩΤΑ τα τηλέφωνα: αν ποτέ ξανακοπεί μια
   απάντηση, το salvageJson() σώζει ό,τι προλαβαίνει, και το τηλέφωνο
   είναι το πρώτο που έχει γραφτεί. */
const SIGN_SCHEMA = {
	type: "OBJECT",
	properties: {
		listing_type: { type: "STRING", enum: ["sale", "rent", "unknown"] },
		phones: { type: "ARRAY", items: { type: "STRING", maxLength: 20 }, maxItems: 4 },
		advertiser: { type: "STRING", enum: ["private", "agency", "unknown"] },
		confidence: { type: "STRING", enum: ["high", "medium", "low"] },
		agency_name: { type: "STRING", maxLength: 120 },
		contact_name: { type: "STRING", maxLength: 60 },
		property_type: { type: "STRING", maxLength: 60 },
		size_sqm: { type: "STRING", maxLength: 20 },
		floor: { type: "STRING", maxLength: 40 },
		price: { type: "STRING", maxLength: 40 },
		sign_text: { type: "STRING", maxLength: 400 },
		extras: { type: "STRING", maxLength: 200 },
	},
	propertyOrdering: ["listing_type", "phones", "advertiser", "confidence", "agency_name",
		"contact_name", "property_type", "size_sqm", "floor", "price", "sign_text", "extras"],
	required: ["listing_type", "phones", "advertiser", "confidence"],
};

const EXTRACT_SCHEMA = {
	type: "OBJECT",
	properties: {
		is_sign: { type: "BOOLEAN" },
		signs: { type: "ARRAY", items: SIGN_SCHEMA, maxItems: 8 },
		/* Της φωτογραφίας, όχι της κάθε αγγελίας: η πινακίδα του δρόμου
		   είναι μία όσες αγγελίες κι αν κρέμονται από κάτω. */
		street_hint: { type: "STRING", maxLength: 120 },
	},
	propertyOrdering: ["is_sign", "signs", "street_hint"],
	required: ["is_sign", "signs"],
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

/* Το δίχτυ για κομμένη απάντηση: κλείνει ένα μισοτελειωμένο JSON στο
   τελευταίο σημείο όπου ήταν ακόμη έγκυρο και το κάνει parse. Κόβει
   ΜΟΝΟ σε ολοκληρωμένες τιμές (κλειστό string, κλειστή αγκύλη, κόμμα),
   οπότε ό,τι επιστρέφεται είναι πλήρες: μισογραμμένο τηλέφωνο δεν
   φτάνει ποτέ εδώ. Ό,τι έλειπε μένει undefined και πέφτει στα defaults
   παρακάτω — χαμηλό confidence, άρα δεν περνάει στο CRM μόνο του. */
function salvageJson(text) {
	const stack = [];
	let inStr = false, esc = false, cut = -1, cutStack = null;
	const mark = (i) => { cut = i; cutStack = [...stack]; };
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') {
				inStr = false;
				/* Κλειστό string: τιμή αν δεν ακολουθεί «:» (τότε ήταν κλειδί). */
				const rest = text.slice(i + 1).match(/^\s*(.?)/)[1];
				if (rest !== ":") mark(i + 1);
			}
			continue;
		}
		if (ch === '"') inStr = true;
		else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
		else if (ch === "}" || ch === "]") { stack.pop(); mark(i + 1); }
		else if (ch === ",") mark(i);          // ό,τι προηγήθηκε είχε κλείσει
	}
	if (cut < 0) return null;
	try {
		return JSON.parse(text.slice(0, cut) + cutStack.reverse().join(""));
	} catch {
		return null;
	}
}

/* Το σώμα ενός 429 λέει ΠΟΙΟ όριο έσκασε, και η διάκριση αλλάζει τα
   πάντα: ένα όριο ανά λεπτό περνάει με λίγη αναμονή, ένα ανά ημέρα δεν
   περνάει με τίποτα και η βόλτα πρέπει να το πει καθαρά αντί να
   κατηγορήσει τη φωτογραφία. Ο κώδικας κρατούσε μόνο το status, οπότε
   και οι δύο περιπτώσεις κατέληγαν στο ίδιο σιωπηλό «η ανάγνωση
   απέτυχε» και κανείς δεν μάθαινε ποτέ τι έφταιγε. */
function quotaInfo(body) {
	const details = body?.error?.details || [];
	const find = (t) => details.find((d) => String(d?.["@type"] || "").endsWith(t));
	const violations = find("QuotaFailure")?.violations || [];
	const ids = violations.map((v) => v?.quotaId || v?.subject || "").join(" ");
	const message = String(body?.error?.message || "");
	const secs = Number(String(find("RetryInfo")?.retryDelay || "").replace(/s$/, ""));
	return {
		perDay: /per.?day|PerDay/i.test(`${ids} ${message}`),
		retryMs: secs > 0 ? Math.min(secs * 1000, AI_MAX_WAIT_MS) : 0,
		detail: (ids || message).slice(0, 180),
	};
}

/* Ένα 429 δεν αφορά μία φωτογραφία, αφορά ΟΛΗ τη βόλτα: τα τέσσερα
   παράλληλα calls μοιράζονται το ίδιο quota. Χωρίς κοινή αναμονή το
   πρώτο 429 γίνεται ακαριαία τέσσερα, οι επαναλήψεις καίγονται όλες
   μέσα στο ίδιο δευτερόλεπτο και η βόλτα βγαίνει άδεια — ακριβώς ό,τι
   έγινε στις 05/08/2026 (τρεις φωτογραφίες, τρία 429 στο ίδιο
   δευτερόλεπτο, μηδέν τηλέφωνα). Το gate είναι ένα κοινό ρολόι: όποιος
   φάει πόρτα, σταματάει και τους υπόλοιπους. */
function newRateGate() {
	let until = 0;
	let dayExhausted = false;
	return {
		get dayExhausted() { return dayExhausted; },
		markDay() { dayExhausted = true; },
		backOff(ms) { until = Math.max(until, Date.now() + ms); },
		async wait() {
			const ms = until - Date.now();
			if (ms > 0) await new Promise((r) => setTimeout(r, ms));
		},
	};
}

/* Ένα vision call ανά φωτογραφία, ~0,005 €. responseSchema ώστε η
   απάντηση να είναι εγγυημένα JSON — χωρίς αυτό το parsing γίνεται
   ψάξιμο για αγκύλες μέσα σε πεζό κείμενο. Ποτέ δεν κάνει throw: μία
   αποτυχία δεν πρέπει να ρίξει όλη τη βόλτα. */
async function extractSign(env, bytes, contentType, gate) {
	const model = env.LEADS_GEMINI_MODEL || DEFAULT_MODEL;
	const data = toBase64(bytes);
	let last = { error: "not read" };

	for (let attempt = 0; attempt < AI_TRIES; attempt++) {
		/* Το ημερήσιο όριο δεν ανοίγει με αναμονή: μόλις το δει έστω μία
		   φωτογραφία, οι υπόλοιπες δεν έχουν λόγο να το ξαναζητήσουν. */
		if (gate?.dayExhausted) return { error: "quota exhausted", error_kind: "quota_day" };
		if (attempt > 0) {
			await new Promise((r) => setTimeout(r, AI_BACKOFF_MS[attempt - 1]));
		}
		await gate?.wait();

		try {
			const res = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
				method: "POST",
				headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
				body: JSON.stringify({
					contents: [{
						parts: [
							{ text: EXTRACT_PROMPT },
							{ inline_data: { mime_type: contentType, data } },
						],
					}],
					generationConfig: {
						temperature: 0,
						/* Ταβάνι ζημιάς για τον βρόχο της 04/08/2026 (65.000
						   tokens σε μία φωτογραφία), ΟΧΙ στόχος.

						   ΤΟ THINKING ΜΕΤΡΑΕΙ ΕΔΩ ΜΕΣΑ, και στα 2048 έπνιγε
						   την απάντηση: η σκέψη έτρωγε ~1.980 tokens και στο
						   JSON έμεναν 68. `MAX_TOKENS` με 68 tokens, απάντηση
						   κομμένη στη μέση, και μια φωτογραφία με ΔΥΟ χαρτιά
						   έβγαζε μία πινακίδα — και στις τρεις λήψεις της
						   βόλτας της 05/08/2026. Το salvageJson() έσωζε το
						   πρώτο τηλέφωνο, οπότε το λάθος φαινόταν μόνο ως
						   «η ανάγνωση κόπηκε» και η δεύτερη πινακίδα χανόταν
						   σιωπηλά. Η απάντηση θέλει ~230 tokens· η σκέψη πάνω
						   σε μια πυκνή λήψη θέλει πολλαπλάσια. */
						maxOutputTokens: 8192,
						responseMimeType: "application/json",
						responseSchema: EXTRACT_SCHEMA,
					},
				}),
			});

			if (res.status === 429) {
				const q = quotaInfo(await res.json().catch(() => null));
				console.warn(`leads: Gemini 429 (${q.perDay ? "ημερήσιο" : "ανά λεπτό"}) `
					+ `try ${attempt + 1}/${AI_TRIES}: ${q.detail}`);
				if (q.perDay) {
					gate?.markDay();
					return { error: "quota exhausted", error_kind: "quota_day" };
				}
				/* Το retryDelay του Google όταν υπάρχει, αλλιώς το δικό μας
				   κλιμακωτό backoff — και για ΟΛΟΥΣ, όχι μόνο γι' αυτόν. */
				gate?.backOff(q.retryMs || AI_BACKOFF_MS[Math.min(attempt, AI_BACKOFF_MS.length - 1)]);
				last = { error: "rate limited", error_kind: "quota_minute" };
				continue;
			}
			/* 5xx είναι «ξαναρώτα»· 4xx (λάθος κλειδί, λάθος μοντέλο) δεν
			   φτιάχνεται με επανάληψη και δεν αξίζει την αναμονή. */
			if (!res.ok) {
				console.warn(`leads: Gemini HTTP ${res.status} try ${attempt + 1}/${AI_TRIES}`);
				last = { error: `HTTP ${res.status}`, error_kind: res.status >= 500 ? "upstream" : "call" };
				if (res.status >= 500) continue;
				return last;
			}

			const body = await res.json();
			const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
			if (!text) return { error: "empty response", error_kind: "call" };
			try {
				return JSON.parse(text);
			} catch {
				/* Κομμένη απάντηση: σώζουμε ό,τι προλαβε να γραφτεί αντί να
				   πετάξουμε ολόκληρη τη φωτογραφία. */
				const salvaged = salvageJson(text);
				/* Τα thinking tokens λογαριάζονται ΞΕΧΩΡΙΣΤΑ στο usageMetadata
				   αλλά τρώνε το ΙΔΙΟ maxOutputTokens — χωρίς τα δύο νούμερα
				   δίπλα δίπλα, ένα «MAX_TOKENS με 68 tokens» δεν βγάζει
				   κανένα νόημα και ψάχνεις τον βρόχο εκεί που δεν είναι. */
				console.warn(`leads: truncated JSON (${body?.candidates?.[0]?.finishReason}, `
					+ `${body?.usageMetadata?.candidatesTokenCount} απάντηση `
					+ `+ ${body?.usageMetadata?.thoughtsTokenCount || 0} σκέψη tokens) — `
					+ (salvaged ? "salvaged" : "unusable"));
				if (salvaged) return { ...salvaged, truncated: true };
				return { error: "truncated response", error_kind: "call" };
			}
		} catch (err) {
			console.warn(`leads: extraction failed try ${attempt + 1}/${AI_TRIES}: ${String(err)}`);
			last = { error: String(err).slice(0, 120), error_kind: "call" };
		}
	}
	return last;
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
function phoneCheck(p, crmBase, signSaysAgency) {
	const bits = [];
	if (p.crm) {
		/* Η υπάρχουσα επαφή ανοίγει με ένα κλικ — το `/contacts/view/{id}`
		   είναι ο μόνος σύνδεσμος που δουλεύει· τα `/contacts/{id}` και
		   `/contacts/edit/{id}` γυρίζουν στη λίστα (docs/estateprime-crm-ui.md). */
		const name = esc(p.crm.name || "επαφή");
		bits.push(`<span style="color:#b45309; font-weight:bold;">ήδη στο CRM:</span> `
			+ (crmBase && p.crm.id
				? `<a href="${esc(crmBase)}/contacts/view/${encodeURIComponent(p.crm.id)}" style="color:${NAVY}; font-weight:bold;">${name}</a>`
				: name));
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
			/* Το πράσινο εδώ σημαίνει «καλό lead, σήκωσε το ακουστικό».
			   Όταν όμως η ίδια η πινακίδα γράφει μεσιτικό, το «μάλλον
			   ιδιώτης» δεν είναι απλώς άχρηστο, είναι λάθος οδηγία: το
			   σταθερό της HellasHome τυπώθηκε έτσι στις 04/08/2026, δύο
			   γραμμές κάτω από το «Από: Μεσιτικό γραφείο» της ίδιας
			   κάρτας. Η πινακίδα κερδίζει, και το χρώμα το δείχνει. */
			bits.push(signSaysAgency
				? `<span style="color:${MUTED};">δεν βρέθηκε στο web — η πινακίδα όμως γράφει γραφείο</span>`
				: `<span style="color:#12855b;">δεν βρέθηκε σε επιχείρηση — μάλλον ιδιώτης</span>`);
		} else {
			bits.push(`<span style="color:${MUTED};">ο έλεγχος δεν κατέληξε</span>`);
		}
	}
	if (!bits.length) return "";
	return `<div style="font-size:12px; color:${MUTED}; margin:2px 0 6px 0; line-height:1.5;">↳ ${bits.join(" · ")}</div>`;
}

const isQuota = (l) => l.error_kind === "quota_day" || l.error_kind === "quota_minute";

/* Τρία εντελώς διαφορετικά πράγματα κατέληγαν στο ίδιο «η ανάγνωση
   απέτυχε»: η πινακίδα δεν είχε τηλέφωνο, το μοντέλο δεν το διάβασε, ή
   το μοντέλο δεν ρωτήθηκε ΠΟΤΕ επειδή είχε τελειώσει το quota. Το τρίτο
   διαβάζεται σαν «κακή φωτογραφία» και είναι το χειρότερο ψέμα που
   μπορεί να πει αυτό το email: στις 05/08/2026 ολόκληρη βόλτα με
   πεντακάθαρες πινακίδες βγήκε «0 με τηλέφωνο» ενώ καμία τους δεν είχε
   φτάσει καν στο μοντέλο. */
function noPhoneNote(l) {
	if (isQuota(l)) {
		return "<strong>ΧΩΡΙΣ ΤΗΛΕΦΩΝΟ</strong> — η φωτογραφία <strong>δεν διαβάστηκε ποτέ</strong>: "
			+ "είχε εξαντληθεί το όριο του AI. Δεν φταίει η λήψη, ξαναστείλ' την.";
	}
	if (l.error) return "<strong>ΧΩΡΙΣ ΤΗΛΕΦΩΝΟ</strong> — δες τη φωτογραφία (η ανάγνωση απέτυχε).";
	return "<strong>ΧΩΡΙΣ ΤΗΛΕΦΩΝΟ</strong> — δες τη φωτογραφία.";
}

function leadCard(l, i, crmBase) {
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
			+ phoneCheck(p, crmBase, l.advertiser === "agency")).join("<br>"));
	}
	if (l.contact_name) row("Ζητήστε", `<strong>${esc(l.contact_name)}</strong>`);
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
		+ (l.is_sign === false ? ` · <strong style="color:#b45309;">δεν φαίνεται πινακίδα</strong>` : "")
		+ (l.truncated ? ` · <strong style="color:#b45309;">η ανάγνωση κόπηκε — έλεγξε τη φωτογραφία</strong>` : ""));

	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${flagged ? "#f0c9a8" : LINE}; border-left:3px solid ${flagged ? "#c2410c" : PINK}; border-radius:6px; margin:0 0 14px 0;">
	<tr><td style="padding:12px 14px;">
		<div style="font-size:15px; font-weight:bold; color:${NAVY}; margin-bottom:8px;">${i + 1}. ${esc(l.address || TYPE_LABEL[l.listing_type] || "Lead")}${l.sign_count > 1
			? `<span style="font-size:11px; font-weight:bold; color:#ffffff; background:${PINK}; border-radius:9px; padding:2px 8px; margin-left:7px; white-space:nowrap;">ΠΙΝΑΚΙΔΑ ${l.sign_index + 1}/${l.sign_count}</span>`
			: ""}</div>
		${flagged ? `<div style="background:#fdeee7; border-radius:5px; padding:8px 10px; margin-bottom:9px; font-size:13px; color:#8a2c06;">${noPhoneNote(l)}</div>` : ""}
		${l.conflict ? `<div style="background:#fdeee7; border-radius:5px; padding:8px 10px; margin-bottom:9px; font-size:13px; color:#8a2c06;"><strong>ΠΡΟΣΟΧΗ</strong> — η πινακίδα δεν γράφει γραφείο, αλλά το τηλέφωνο βγαίνει μεσιτικό.</div>` : ""}
		<table role="presentation" cellpadding="0" cellspacing="0" width="100%">${rows.join("\n\t\t")}</table>
		<a href="${esc(l.url)}" style="display:block; margin-top:10px;"><img src="${esc(l.url)}" alt="" width="240" style="width:240px; max-width:100%; border-radius:5px; border:1px solid ${LINE}; display:block;"></a>
	</td></tr>
</table>`;
}

function buildEmail(payload) {
	const { leads, note, submitted_by, count, crm_base: crmBase } = payload;
	const signs = leads.length;
	const withPhone = leads.filter((l) => (l.phones || []).length).length;
	const agencies = leads.filter((l) => l.advertiser === "agency").length;

	const photoWord = count === 1 ? "φωτογραφία" : "φωτογραφίες";
	const signWord = signs === 1 ? "πινακίδα" : "πινακίδες";
	/* Όταν μια βόλτα έχει φωτογραφία με δύο χαρτιά, τα δύο νούμερα
	   διαφέρουν — και το θέμα του email πρέπει να το λέει, αλλιώς η
	   γραμματεία μετράει τρεις κάρτες εκεί που περίμενε δύο. */
	const headline = signs === count
		? `${count} ${photoWord}`
		: `${signs} ${signWord} σε ${count} ${photoWord}`;

	/* Όσες δεν έφτασαν ΠΟΤΕ στο μοντέλο. Μπαίνουν στο θέμα πριν από
	   οτιδήποτε άλλο: ένα «0 με τηλέφωνο» διαβάζεται σαν άκαρπη βόλτα
	   και το email αρχειοθετείται, ενώ στην πραγματικότητα τα leads
	   είναι εκεί και περιμένουν μια δεύτερη αποστολή. */
	const unread = leads.filter(isQuota).length;
	const subject = `Νέα leads από πινακίδες — ${headline}`
		+ (unread
			? ` (${unread} ${unread === 1 ? "αδιάβαστη" : "αδιάβαστες"} — το AI δεν απάντησε)`
			: withPhone < signs ? ` (${withPhone} με τηλέφωνο)` : "");

	const known = leads.filter((l) => l.known_contact).length;
	const summary = [
		headline,
		`${withPhone} με τηλέφωνο`,
		agencies ? `${agencies} από μεσιτικό γραφείο` : "",
		known ? `${known} ήδη στο CRM` : "",
	].filter(Boolean).join(" · ");

	const quotaBanner = unread
		? `<tr><td style="padding:10px 20px 0 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#fdeee7; border-left:3px solid #c2410c; border-radius:6px; padding:11px 13px; font-size:13px; color:#8a2c06;">`
			+ `<strong>${unread} ${unread === 1 ? "φωτογραφία δεν διαβάστηκε" : "φωτογραφίες δεν διαβάστηκαν"}.</strong> `
			+ `Είχε εξαντληθεί το όριο του AI, όχι πρόβλημα των φωτογραφιών. `
			+ `Ξαναστείλτε τις από τα Έντυπα (Πινακίδα) για να διαβαστούν.`
			+ `</td></tr></table></td></tr>`
		: "";

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
		${quotaBanner}
		${note ? `<tr><td style="padding:10px 20px 0 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#f7f8fa; border-radius:6px; padding:11px 13px; font-size:13px; color:${NAVY};"><strong>Σημείωση:</strong> ${esc(note)}</td></tr></table></td></tr>` : ""}
		<tr><td style="padding:16px 20px 4px 20px;">
			${leads.map((l, i) => leadCard(l, i, crmBase)).join("\n\t\t\t")}
		</td></tr>
		<tr><td style="border-top:1px solid ${LINE}; padding:14px 20px; font-size:11px; color:#999999; line-height:1.6;">
			Στάλθηκε αυτόματα από τα Έντυπα (Πινακίδα). Τα στοιχεία διαβάστηκαν από φωτογραφία με AI — <strong>επιβεβαίωσέ τα πριν την κλήση</strong>.
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
			`${i + 1}. ${l.address || (l.lat != null ? `${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}` : "χωρίς τοποθεσία")}`
				+ (l.sign_count > 1 ? ` [πινακίδα ${l.sign_index + 1} από ${l.sign_count} στη φωτογραφία]` : ""),
			l.contact_name ? `   Ζητήστε: ${l.contact_name}` : "",
			`   Τηλ: ${(l.phones || []).map((p) => p.display
				+ (p.crm ? ` [ήδη στο CRM: ${p.crm.name}]` : "")
				+ (p.web?.kind === "agency" ? ` [μεσιτικό${p.web.name ? ": " + p.web.name : ""}]`
					: p.web?.kind === "business" ? ` [επιχείρηση${p.web.name ? ": " + p.web.name : ""}]`
					: p.web?.kind === "private"
						? (l.advertiser === "agency"
							? " [δεν βρέθηκε στο web, αλλά η πινακίδα γράφει γραφείο]"
							: " [δεν βρέθηκε σε επιχείρηση]")
						: "")).join(", ")
				|| (isQuota(l)
					? "— ΔΕΝ ΔΙΑΒΑΣΤΗΚΕ: είχε εξαντληθεί το όριο του AI, ξαναστείλ' τη φωτογραφία"
					: "— ΧΩΡΙΣ ΤΗΛΕΦΩΝΟ, δες τη φωτό")}`,
			l.conflict ? "   ΠΡΟΣΟΧΗ: η πινακίδα δεν γράφει γραφείο, αλλά το τηλέφωνο βγαίνει μεσιτικό." : "",
			`   ${TYPE_LABEL[l.listing_type] || "—"}${l.property_type ? " · " + l.property_type : ""} · ${ADVERTISER_LABEL[l.advertiser]}${l.agency_name ? " (" + l.agency_name + ")" : ""}`,
			l.price || l.size_sqm || l.floor ? `   ${[l.size_sqm ? l.size_sqm + " τ.μ." : "", l.floor, l.price].filter(Boolean).join(" · ")}` : "",
			`   ${l.url}`,
		].filter(Boolean).join("\n")),
	].filter(Boolean).join("\n");

	return { subject, html, text, summary };
}

/* ------------------------------------------------ CRM (γράφει το Make)

   Ο Worker ΔΕΝ γράφει στο EstatePrime: κάθε POST από Worker απαντιέται με
   403 «Access denied» ανεξαρτήτως headers, ενώ το ίδιο POST από το Make
   περνάει (docs/estateprime-api.md). Άρα εδώ ετοιμάζεται μόνο το σώμα και
   το ποστάρει το σενάριο.

   ΓΙΑΤΙ ΕΤΟΙΜΟ JSON ΚΑΙ ΟΧΙ ΠΕΔΙΑ: το Make χτίζει τα bodies ως σκέτο
   κείμενο, οπότε ένα εισαγωγικό ή μια αλλαγή γραμμής μέσα σε τιμή αρκεί
   για να βγει «Invalid JSON» — το ίδιο λάθος κόστισε μέρες στα Spitogatos
   leads. Ένα `JSON.stringify()` εδώ το κλείνει μια για πάντα, και το
   περιεχόμενο μένει σε κώδικα μέσα στο git αντί για IML μέσα στο Make.

   ΠΟΙΑ leads περνάνε: μόνο όσα δεν αφήνουν περιθώριο λάθους. Το
   `DELETE /contacts/{id}` απαντάει 200 ΧΩΡΙΣ να σβήνει, οπότε μια λάθος
   ανάγνωση μένει για πάντα — και μια «ΠΙΝΑΚΙΔΑ» με ένα λάθος ψηφίο δεν
   διορθώνεται ποτέ, γιατί κανείς δεν ξέρει ποιο ήταν το σωστό. */

const CRM = {
	lastName: "ΠΙΝΑΚΙΔΑ",       // σταθερό επώνυμο: κρατάει τα leads μαζί στη
	                             // λίστα και τα κρύβει από τους pickers των
	                             // εντύπων (worker/lib/crm.mjs isSignLead)
	sourceId: 4,                 // «Ενοικιαστήριο/Πωλητήριο» — υπάρχει ήδη
	userId: 1,                   // Αφεντούλα (info@): αυτή κάνει τις κλήσεις
	officeId: 1,
	languageId: 1,
	storeId: 1,
	contactTags: [12, 4, 19],    // ai, make, ΠΙΝΑΚΙΔΑ
	commTags: [15, 5, 20],       // ai, make, ΠΙΝΑΚΙΔΑ — ΑΛΛΟ namespace, άλλα ids
	commChannel: 4,              // «Δια ζώσης»: την πινακίδα την είδαμε στον δρόμο
};

/* Τιμή που θα καταλήξει σε χειρόγραφο JSON body του Make: χωρίς αλλαγές
   γραμμής, χωρίς `"` και χωρίς `\`. Τα τρία αυτά είναι που το σπάνε. */
function makeSafe(v, max) {
	return clip(String(v == null ? "" : v)
		.replace(/[\u0000-\u001F\u007F\\]/g, " ")
		.replace(/"/g, "'")
		.replace(/\s+/g, " "), max);
}

/* Το μόνο σταθερό αναγνωριστικό που θα υπάρξει ποτέ: σε cold call κανείς
   δεν δίνει όνομα. Ίδια σκάλα με του email — διεύθυνση, μετά πινακίδα
   δρόμου, μετά συντεταγμένες. Ποτέ κενό: δέκα επαφές «ΠΙΝΑΚΙΔΑ» χωρίς
   τίποτα δίπλα δεν ξεχωρίζουν μεταξύ τους. */
function crmGivenName(l) {
	if (l.address) return makeSafe(l.address, 90);
	if (l.street_hint) return makeSafe(`${l.street_hint} (από την πινακίδα)`, 90);
	if (l.lat != null && l.lng != null) {
		return makeSafe(`${l.area ? l.area + " " : ""}${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}`, 90);
	}
	return "χωρίς διεύθυνση";
}

/* Τα πέντε φρένα. Ξεχωριστά από το `crmFor()` γιατί τρέχουν ΠΡΙΝ δοθούν
   τα ονόματα: η διάκριση παρακάτω αφορά μόνο όσα θα γραφτούν όντως. */
function crmEligible(l) {
	return l.is_sign !== false          // δεν είναι καν πινακίδα
		&& l.confidence === "high"       // κάθε ψηφίο διαβάστηκε καθαρά
		&& l.advertiser !== "agency"     // συνάδελφος, όχι lead
		&& !l.error
		&& (l.phones || []).some((p) => !p.duplicate);
}

/* Δύο χαρτιά στον ίδιο τοίχο δίνουν δύο leads με ΤΗΝ ΙΔΙΑ διεύθυνση —
   άρα δύο επαφές «Φραγκίνη 5, Λουλουδάδικα ΠΙΝΑΚΙΔΑ» που δεν ξεχωρίζουν
   με τίποτα στη λίστα του CRM. Όποτε συμβαίνει αυτό, το όνομα παίρνει το
   πιο ανθρώπινο διακριτικό που έχει η πινακίδα: πρώτα το όνομα που
   γράφει («Μαρία»), αλλιώς τι είναι και πόσο («γραφείο 25 τ.μ. 7ος»),
   αλλιώς σκέτη αρίθμηση. Οι μονές πινακίδες δεν αλλάζουν καθόλου. */
function assignCrmNames(leads) {
	const groups = new Map();
	for (const l of leads) {
		if (!crmEligible(l)) continue;
		l.crm_given = crmGivenName(l);
		if (!groups.has(l.crm_given)) groups.set(l.crm_given, []);
		groups.get(l.crm_given).push(l);
	}
	for (const [name, group] of groups) {
		if (group.length < 2) continue;
		group.forEach((l, i) => {
			const tag = l.contact_name
				|| [l.property_type, l.size_sqm ? l.size_sqm + " τ.μ." : "", l.floor]
					.filter(Boolean).join(" ")
				|| `πινακίδα ${i + 1}`;
			l.crm_given = makeSafe(`${name} (${tag})`, 90);
		});
	}
}

/* «YYYY-MM-DD HH:mm:ss» σε ώρα Ελλάδας, όπως τη θέλει το
   `communication_date`. Το sv-SE δίνει ακριβώς αυτή τη μορφή. */
function athensStamp(d = new Date()) {
	return new Intl.DateTimeFormat("sv-SE", {
		timeZone: "Europe/Athens", year: "numeric", month: "2-digit", day: "2-digit",
		hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
	}).format(d).replace("T", " ");
}

function crmFor(l, meta) {
	if (!crmEligible(l)) return null;
	/* Διπλό τηλέφωνο μέσα στην ίδια βόλτα = μία επαφή. Χωρίς αυτό η δεύτερη
	   δημιουργία σκάει σε 400 «Phone number is already in use» — σωστά, αλλά
	   γεμίζει το σενάριο με κόκκινα που δεν σημαίνουν τίποτα. */
	const phones = (l.phones || []).filter((p) => !p.duplicate);

	const given = l.crm_given || crmGivenName(l);
	const what = [TYPE_LABEL[l.listing_type], l.property_type].filter((x) => x && x !== "—").join(" ");
	const specs = [l.size_sqm ? l.size_sqm + " τ.μ." : "", l.floor, l.price].filter(Boolean).join(", ");
	const note = makeSafe(`Πινακίδα ${what || ""} · ${given} · ${athensStamp().slice(0, 10)}`, 190);

	/* Το πλήρες σώμα του POST /contacts, έτοιμο να μπει ως raw body. */
	const contact = {
		first_name: given,
		last_name: CRM.lastName,
		is_active: true,        // χωρίς αυτό μπαίνει «Ανενεργό» και ΔΕΝ διορθώνεται από API
		is_lead: true,
		country: "GR",
		language_id: CRM.languageId,
		office_id: CRM.officeId,
		created_by: CRM.userId,
		users: [CRM.userId],
		source_id: CRM.sourceId,
		tags: CRM.contactTags,
		phones: phones.map((p) => ({
			// 69… κινητό, 2… σταθερό — το normPhone εγγυάται ότι είναι ένα από τα δύο
			type: p.digits.startsWith("69") ? "mobile-personal" : "land-home",
			number: "+30" + p.digits,   // E.164 υποχρεωτικά, αλλιώς 400
			notes: note,
		})),
	};

	/* Το σχόλιο της επικοινωνίας είναι το ΜΟΝΟ σημείο που κρατάει την
	   ιστορία: το contact-level `notes` δεν επιστρέφεται καν από το read
	   model, ενώ το `comments` της επικοινωνίας κάνει round-trip. */
	const web = phones.find((p) => p.web && p.web.kind !== "unknown")?.web;
	const comments = makeSafe([
		`Πινακίδα ${what || "—"}${specs ? " (" + specs + ")" : ""}`,
		given,
		l.contact_name ? `Ζητήστε: ${l.contact_name}` : "",
		phones.map((p) => p.display).join(" / "),
		l.sign_text ? `Κείμενο πινακίδας: ${l.sign_text}` : "",
		l.extras ? `Άλλα: ${l.extras}` : "",
		web?.kind === "private" ? "Έλεγχος web: δεν βρέθηκε σε επιχείρηση, μάλλον ιδιώτης"
			: web?.kind === "business" ? `Έλεγχος web: επιχείρηση${web.name ? " " + web.name : ""}` : "",
		/* Ποια από τις πινακίδες της φωτογραφίας είναι — αλλιώς ο επόμενος
		   που ανοίγει τη φωτό βλέπει δύο χαρτιά και δεν ξέρει ποιο. */
		l.sign_count > 1 ? `Πινακίδα ${l.sign_index + 1} από ${l.sign_count} σε αυτή τη φωτογραφία` : "",
		l.taken_at ? `Λήψη: ${l.taken_at}` : "",
		meta.submitted_by ? `Καταγραφή: ${meta.submitted_by}` : "",
		`Φωτογραφία (ισχύει 30 ημέρες): ${l.url}`,
	].filter(Boolean).join(" · "), 900);

	/* Η υποχρέωση που γεννά μια πινακίδα: κάποιος πρέπει να πάρει αυτό το
	   τηλέφωνο. Το κείμενο γράφεται εδώ, όπου υπάρχουν διεύθυνση, τύπος και
	   τιμή, κι όχι με formula μέσα στο Make. Το description του EstatePrime
	   δέχεται HTML, οπότε η φωτογραφία μπαίνει ως σύνδεσμος. */
	const callNumber = (phones.find((p) => p.digits.startsWith("69")) || phones[0]);
	const taskTitle = makeSafe(
		`Πινακίδα: κάλεσε ${callNumber.display}${given && given !== "—" ? " · " + given : ""}`, 190);
	const taskBody = makeSafe([
		`<p><b>${what || "Πινακίδα"}</b>${specs ? " (" + specs + ")" : ""}<br>`,
		`${given}<br>`,
		`Τηλέφωνο: ${phones.map((p) => p.display).join(" / ")}`,
		l.contact_name ? `<br>Ζητήστε: ${l.contact_name}` : "",
		l.sign_text ? `<br>Πινακίδα: ${l.sign_text}` : "",
		`</p><p><a href='${l.url}'>Δες τη φωτογραφία</a> (ισχύει 30 ημέρες)</p>`,
	].filter(Boolean).join(""), 1500);

	return {
		/* Ό,τι χρειάζεται το Make για να ψάξει πρώτα — η μοναδικότητα του
		   τηλεφώνου στο CRM είναι το dedupe, ο Worker απλώς δίνει το κλειδί.
		   Προτιμάται το ΚΙΝΗΤΟ όταν η πινακίδα έχει δύο νούμερα: το σταθερό
		   μπορεί να είναι της πολυκατοικίας ή του μαγαζιού από κάτω και να
		   ταιριάξει σε λάθος επαφή· το 69άρι είναι ενός ανθρώπου. */
		search: callNumber.digits,
		task_title: taskTitle,
		task_body: taskBody,
		known_contact_id: phones.find((p) => p.crm)?.crm?.id ?? null,
		contact_json: JSON.stringify(contact),
		comments,
		communication_date: athensStamp(),
		channel: CRM.commChannel,
		user_id: CRM.userId,
		store_id: CRM.storeId,
		tags_json: JSON.stringify(CRM.commTags),
	};
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
	const perPhotoLeads = new Array(objects.length);
	const CONC = 4;
	/* Κοινό για ΟΛΕΣ τις φωτογραφίες της βόλτας: το quota είναι ένα. */
	const gate = newRateGate();
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
				if (obj) ai = await extractSign(env, await obj.arrayBuffer(), contentType, gate);
			} catch (err) {
				console.warn(`leads: could not read ${o.key}: ${String(err)}`);
			}

			/* Ό,τι ανήκει στη ΦΩΤΟΓΡΑΦΙΑ και το μοιράζονται όλες οι πινακίδες
			   της: αρχείο, τοποθεσία, ώρα λήψης, πινακίδα δρόμου. */
			const base = {
				name,
				url: await signedFileUrl(env, origin, batchId, name),
				content_type: contentType,
				...m,
				street_hint: clip(ai.street_hint, 120) || null,
				is_sign: ai.is_sign !== false,
				error: ai.error || null,
				/* Ξεχωριστό από το `error`: το email πρέπει να λέει «δεν
				   διαβάστηκε ΠΟΤΕ» και όχι «η φωτογραφία δεν διαβάζεται»,
				   αλλιώς ο σύμβουλος νομίζει ότι φταίει η λήψη του και
				   δεν ξαναστέλνει μια πεντακάθαρη πινακίδα. */
				error_kind: ai.error_kind || null,
				truncated: ai.truncated === true,
			};

			/* Χωρίς πινακίδα (ή με σφάλμα ανάγνωσης) μένει ΕΝΑ κενό lead: η
			   φωτογραφία πρέπει να φτάσει στο email έτσι κι αλλιώς, με τη
			   σήμανση «ΧΩΡΙΣ ΤΗΛΕΦΩΝΟ» — σιωπηλή απόρριψη σημαίνει χαμένο
			   lead που κανείς δεν ξέρει ότι χάθηκε. */
			const signs = Array.isArray(ai.signs) && ai.signs.length ? ai.signs : [{}];
			perPhotoLeads[idx] = signs.map((s, si) => ({
				...base,
				sign_index: si,
				sign_count: signs.length,
				phones: [...new Set((Array.isArray(s.phones) ? s.phones : [])
					.map(normPhone).filter(Boolean))]
					.map((d) => ({ digits: d, display: fmtPhone(d) })),
				listing_type: ["sale", "rent"].includes(s.listing_type) ? s.listing_type : "unknown",
				advertiser: ["private", "agency"].includes(s.advertiser) ? s.advertiser : "unknown",
				agency_name: clip(s.agency_name, 120) || null,
				contact_name: clip(s.contact_name, 60) || null,
				property_type: clip(s.property_type, 60) || null,
				size_sqm: clip(s.size_sqm, 20) || null,
				floor: clip(s.floor, 40) || null,
				price: clip(s.price, 40) || null,
				sign_text: clip(s.sign_text, 400) || null,
				extras: clip(s.extras, 200) || null,
				confidence: ["high", "medium", "low"].includes(s.confidence) ? s.confidence : "low",
			}));
		}
	}));
	/* Από εδώ και κάτω η μονάδα είναι η ΠΙΝΑΚΙΔΑ, όχι η φωτογραφία: το
	   dedupe των τηλεφώνων, ο έλεγχος «ποιος το έχει», το reverse geocode
	   και η εγγραφή στο CRM δουλεύουν όλα ανά πινακίδα. */
	const leads = perPhotoLeads.flat();
	const photoCount = objects.length;

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
	/* Ό,τι έχει ήδη διαβάσει το vision πάει μαζί με το νούμερο: το web
	   lookup έβλεπε δέκα γυμνά ψηφία και απαντούσε «μάλλον ιδιώτης» για
	   ένα τηλέφωνο τυπωμένο κάτω από «HellasHome REAL ESTATE SERVICES»
	   (04/08/2026). Η πινακίδα είναι η ισχυρότερη πηγή που έχουμε και
	   δεν υπήρχε λόγος να την κρύβουμε από το μοντέλο. */
	const signContext = new Map();
	for (const l of leads) {
		for (const p of l.phones) {
			if (signContext.has(p.digits)) continue;
			const hint = clip([l.agency_name, l.sign_text].filter(Boolean).join(" · "), 300);
			if (hint) signContext.set(p.digits, hint);
		}
	}
	const web = await webLookup(env, uniquePhones.filter((d) => !crm.has(d)), signContext);
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

	/* Τελευταίο, γιατί χρειάζεται τη διεύθυνση: το όνομα της επαφής ΕΙΝΑΙ η
	   διεύθυνση. Όσα δεν περνάνε το φίλτρο παίρνουν `crm: null` και μένουν
	   μόνο στο email — εκεί αποφασίζει άνθρωπος. */
	assignCrmNames(leads);
	for (const l of leads) l.crm = crmFor(l, meta);
	const crmReady = leads.filter((l) => l.crm);

	const payload = {
		batch_id: batchId,
		submitted_by: meta.submitted_by,
		submitted_at: new Date().toISOString(),
		/* `count` = φωτογραφίες, `signs` = πινακίδες. Δεν είναι πια το ίδιο
		   νούμερο: ένα χαρτί δίπλα στο άλλο δίνει δύο leads από μία λήψη. */
		count: photoCount,
		signs: leads.length,
		note: note || null,
		/* Το σενάριο δουλεύει ΑΥΤΗ τη λίστα, όχι το `leads` — έτσι δεν
		   χρειάζεται filter module μέσα στο Make, και ό,τι δεν πέρασε τον
		   έλεγχο δεν φτάνει καν εκεί. Κενή λίστα = καμία εγγραφή στο CRM. */
		crm: crmReady.map((l) => l.crm),
		crm_count: crmReady.length,
		/* Για τους συνδέσμους «άνοιξε την επαφή» μέσα στο email. Η νέα
		   επαφή δεν έχει ακόμη id εδώ (τη φτιάχνει το Make μετά), αλλά
		   όποια ΥΠΑΡΧΕΙ ήδη ανοίγει με ένα κλικ. */
		crm_base: env.ESTATEPRIME_SUBDOMAIN
			? `https://${env.ESTATEPRIME_SUBDOMAIN}.estateprime.gr`
			: null,
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
		event: "lead_batch", batch_id: batchId, count: photoCount, signs: leads.length,
		multi_sign: perPhotoLeads.filter((g) => g.length > 1).length,
		with_phone: leads.filter((l) => l.phones.length).length,
		agencies: leads.filter((l) => l.advertiser === "agency").length,
		known_contacts: leads.filter((l) => l.known_contact).length,
		conflicts: leads.filter((l) => l.conflict).length,
		crm_ready: crmReady.length,
		by: meta.submitted_by, ts: new Date().toISOString(),
	}));
	return json({
		ok: true,
		count: photoCount,
		signs: leads.length,
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
