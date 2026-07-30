/* =====================================================================
   Four Walls — εκτίμηση αξίας ακινήτου (AI, δύο περάσματα)
   ---------------------------------------------------------------------
   Ο Μάνος συμπληρώνει το έντυπο «Εκτίμηση» στο forms PWA (προαιρετικά
   διαλέγει ακίνητο από το CRM). Το submit περνάει από το
   /api/forms/submit, που ΠΡΙΝ προωθήσει στο Make αποθηκεύει το payload
   στο KV με ένα τυχαίο ref (worker/lib/forms.mjs). Το Make μετά καλεί:

     GET /api/valuation?ref=<uuid>          -> { subject, html, text }
     GET /api/valuation?ref=<uuid>&format=html   (προεπισκόπηση στον browser)

   και στέλνει το html με email στο γραφείο. Η βαριά δουλειά (μερική
   συμπλήρωση από το feed, συγκριτικά, τιμές περιοχών, δύο περάσματα
   Claude, HTML report) γίνεται εδώ, σε κώδικα μέσα στο git, όχι σε IML.

   ΓΙΑΤΙ ref ΚΑΙ ΟΧΙ ΣΚΕΤΟ ENDPOINT: κάθε κλήση κοστίζει χρήματα (δύο
   κλήσεις Anthropic API). Το ref είναι τυχαίο UUID που ζει μόνο στο KV
   και στο Make, με TTL 2 ημερών, και το αποτέλεσμα κασάρεται ανά ref:
   τα retries του Make (και τα replays από το DLQ) ΔΕΝ ξαναχρεώνουν AI.

   ΔΕΝ ΕΙΝΑΙ ΠΙΣΤΟΠΟΙΗΜΕΝΗ ΕΚΤΙΜΗΣΗ: το report το λέει ρητά. Είναι
   εργαλείο για να πηγαίνει ο σύμβουλος διαβασμένος στη συζήτηση
   τιμολόγησης, όχι έκθεση για τράπεζα ή δικαστήριο.

   Θέλει ΕΝΑ από τα δύο secrets (wrangler secret put):
   - ANTHROPIC_API_KEY: Claude, VALUATION_MODEL (default claude-opus-5).
   - GEMINI_API_KEY: Gemini, VALUATION_GEMINI_MODEL (default
     gemini-3.5-flash). Το ίδιο κλειδί με το Make connection του
     photo-enhance (AI Studio, με billing).
   Αν υπάρχουν και τα δύο, προτιμάται το Claude.
   ===================================================================== */

import { AREA_PRICES, AREA_PRICES_META, findAreaPrices } from "./area-prices.mjs";
import { renderDocPdf } from "./pdfrender.mjs";

/* KV keys — το request γράφεται από forms.mjs, το result από εδώ. */
export const VALUATION_REQ_PREFIX = "valuation:req:";
const VALUATION_RES_PREFIX = "valuation:res:";
/* Το «2» επίτηδες: τα πρώτα PDF είχαν κατά λάθος τη σχεδίαση του email
   (Arial, στενή κολόνα) αντί για το χάρτινο design των εντύπων. Νέο
   πρόθεμα ώστε τα παλιά κασαρισμένα να αγνοηθούν και να λήξουν μόνα τους. */
const VALUATION_PDF_PREFIX = "valuation:pdf2:";
export const VALUATION_TTL_SECONDS = 2 * 24 * 3600;

const FEED_KEY = "listings.json"; // ίδιο με FEED_KEY στο worker/index.mjs
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-opus-5";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

/* ctx: για το ctx.waitUntil. ΚΡΙΣΙΜΟ σε κινητό — ο υπολογισμός θέλει 25-45
   δευτερόλεπτα, και όταν κλειδώσει η οθόνη ή πάει η εφαρμογή στο background
   το fetch πεθαίνει. Χωρίς waitUntil, το Cloudflare ακυρώνει τον Worker μαζί
   με τον client και ΔΕΝ γράφεται ποτέ αποτέλεσμα: ο σύμβουλος έχει πληρώσει
   δύο κλήσεις AI για το τίποτα. Με waitUntil η δουλειά τελειώνει και μπαίνει
   στο KV, οπότε το επόμενο fetch τη βρίσκει έτοιμη και δωρεάν. */
export async function handleValuation(request, env, url, ctx) {
	if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
	if (!env.ANTHROPIC_API_KEY && !env.GEMINI_API_KEY) {
		console.error("valuation: neither ANTHROPIC_API_KEY nor GEMINI_API_KEY is configured");
		return json({ error: "not_configured" }, 503);
	}

	const ref = String(url.searchParams.get("ref") || "").trim();
	if (!/^[0-9a-f-]{16,64}$/i.test(ref)) return json({ error: "bad_ref" }, 400);
	const wantsHtml = url.searchParams.get("format") === "html";
	const wantsPdf = url.searchParams.get("pdf") === "1";

	// Idempotent: το ίδιο ref δίνει πάντα το ίδιο report, χωρίς νέο κόστος.
	const cached = await env.LISTINGS_KV.get(VALUATION_RES_PREFIX + ref);
	if (cached) return respond(await withPdf(env, ref, JSON.parse(cached), wantsPdf), wantsHtml);

	const rawReq = await env.LISTINGS_KV.get(VALUATION_REQ_PREFIX + ref);
	if (!rawReq) return json({ error: "unknown_ref" }, 404);
	const payload = JSON.parse(rawReq);

	let feed = [];
	try {
		const rawFeed = await env.LISTINGS_KV.get(FEED_KEY);
		feed = rawFeed ? (JSON.parse(rawFeed).listings || []) : [];
	} catch (err) {
		console.warn(`valuation: feed unavailable, continuing without comps: ${String(err)}`);
	}

	const prop = mergeProperty(feed, payload.data || {});
	const comps = pickComps(feed, prop);
	const stats = areaStats(feed, prop);
	const priceRow = findAreaPrices(prop.areaName);

	const dataBlock = buildDataBlock(prop, comps, stats, priceRow);

	// Πέρασμα 1: η εκτίμηση. Πέρασμα 2: αυστηρός έλεγχος της εκτίμησης
	// (αριθμητική, σύγκριση με συγκριτικά και εύρη περιοχής, υπερβολές).
	// Μια αποτυχία εδώ (AI down, κακό JSON) γυρίζει καθαρό 502 ώστε το
	// Make να τη δει ως σφάλμα και να παρκάρει το bundle στο DLQ.
	//
	// Όλη η ακριβή δουλειά μπαίνει σε ΕΝΑ promise που δηλώνεται στο
	// ctx.waitUntil ΠΡΙΝ το await: αν ο client φύγει (κλείδωμα οθόνης,
	// background), το promise συνεχίζει και γράφει στο KV. Το επόμενο fetch
	// βρίσκει το report έτοιμο αντί να ξαναπληρώσει δύο κλήσεις AI.
	const work = (async () => {
		const draft = await askAI(env, PASS1_SYSTEM, dataBlock + "\n\n" + PASS1_ASK);
		const draftJson = extractJson(draft);
		const final = await askAI(
			env,
			PASS2_SYSTEM,
			dataBlock + "\n\nΗ ΕΚΤΙΜΗΣΗ ΠΡΟΣ ΕΛΕΓΧΟ (JSON):\n" + JSON.stringify(draftJson) + "\n\n" + PASS2_ASK,
		);
		const result = renderReport(prop, comps, stats, priceRow, extractJson(final), payload);
		await env.LISTINGS_KV.put(VALUATION_RES_PREFIX + ref, JSON.stringify(result), {
			expirationTtl: 7 * 24 * 3600,
		});
		return result;
	})();
	if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(work);

	let result;
	try {
		result = await work;
	} catch (err) {
		console.error(`valuation: AI failed for ref ${ref}: ${String(err)}`);
		return json({ error: "valuation_failed", detail: String(err).slice(0, 200) }, 502);
	}
	return respond(await withPdf(env, ref, result, wantsPdf), wantsHtml);
}

/* Το PDF της ΠΛΗΡΟΥΣ αναφοράς, με πραγματικό κείμενο (Browser Rendering,
   ίδια διαδρομή με τα άλλα έντυπα). Φτιάχνεται ΜΟΝΟ όταν ζητηθεί με
   ?pdf=1: το ζητά το Make για να το επισυνάψει στο email του γραφείου,
   ώστε η γραμματεία να το αρχειοθετεί στα έγγραφα του πελάτη. Η φόρμα
   ΔΕΝ το ζητά — θα περίμενε άσκοπα τα δευτερόλεπτα του rendering.
   Κασάρεται χωριστά ανά ref, οπότε ένα retry του Make δεν ξαναπληρώνει.
   Fail-open: αν το rendering αποτύχει, το email φεύγει κανονικά με το
   HTML μέσα του και απλώς χωρίς συνημμένο. */
async function withPdf(env, ref, result, wantsPdf) {
	if (!wantsPdf) return result;
	const key = VALUATION_PDF_PREFIX + ref;
	let b64 = await env.LISTINGS_KV.get(key);
	if (!b64) {
		try {
			// ΟΧΙ το result.html: εκείνο είναι το email. Το PDF που
			// αρχειοθετεί η γραμματεία θέλει τη χάρτινη γλώσσα των εντύπων.
			b64 = await renderDocPdf(env, renderPrintHtml(result));
		} catch (err) {
			console.warn(`valuation: report PDF render failed for ${ref}: ${String(err)}`);
		}
		if (b64) await env.LISTINGS_KV.put(key, b64, { expirationTtl: 7 * 24 * 3600 });
	}
	if (!b64) return result;
	const code = (result.prop && result.prop.listingCode) || "";
	return {
		...result,
		pdf_base64: b64,
		pdf_filename: `ektimisi-${code || "akinito"}.pdf`,
	};
}

function respond(result, wantsHtml) {
	if (wantsHtml) {
		return new Response(result.html, {
			headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" },
		});
	}
	return json(result, 200);
}

function json(obj, status) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}

/* ------------------------------------------------------------------ */
/* Δεδομένα: συγχώνευση φόρμας + feed, συγκριτικά, στατιστικά περιοχής  */
/* ------------------------------------------------------------------ */

/* Η φόρμα στέλνει flat strings (κενά όταν δεν συμπληρώθηκαν). Αν έχει
   διαλεχτεί ακίνητο από το CRM, το feed δίνει ό,τι λείπει· ό,τι έγραψε
   ο σύμβουλος υπερισχύει πάντα, γιατί αυτός είδε το ακίνητο. */
function mergeProperty(feed, d) {
	const fromFeed = (() => {
		const id = String(d.listing_id || "").trim();
		const code = String(d.listing_code || "").trim();
		if (!id && !code) return null;
		return feed.find((l) => (id && String(l.id) === id) || (code && String(l.code) === code)) || null;
	})();
	const f = fromFeed || {};
	const loc = f.location || {};
	const pick = (formVal, feedVal) => {
		const s = String(formVal == null ? "" : formVal).trim();
		return s !== "" ? s : (feedVal == null ? "" : String(feedVal));
	};
	return {
		listingCode: pick(d.listing_code, f.code),
		fromCrm: !!fromFeed,
		purpose: String(d.purpose || "both"), // sale | rent | both
		category: pick(d.category, f.category) || "residential",
		subcategory: pick(d.subcategory, f.subcategory),
		areaName: pick(d.area_name, loc.area || loc.neighbourhood),
		address: pick(d.address, loc.address),
		size: num(pick(d.size, f.area)),
		floor: pick(d.floor, f.floor),
		bedrooms: num(pick(d.bedrooms, f.bedrooms)),
		bathrooms: num(pick(d.bathrooms, f.bathrooms)),
		yearBuilt: num(pick(d.year_built, f.yearBuilt)),
		yearRenovated: num(pick(d.year_renovated, f.yearRenovated)),
		energyClass: pick(d.energy_class, f.energyClass),
		condition: pick(d.condition, f.condition),
		heating: pick(d.heating, f.heating),
		elevator: String(d.elevator || "").trim(),      // ναι | όχι | ""
		parking: pick(d.parking, f.parking ? "ναι" : ""),
		storage: String(d.storage || "").trim(),
		view: pick(d.view, (f.view || []).join(", ")),
		orientation: String(d.orientation || "").trim(),
		balconies: String(d.balconies || "").trim(),
		askingPrice: num(pick(d.asking_price_num || d.asking_price, f.price)),
		monthlyMaintenance: num(pick("", f.monthlyMaintenance)),
		notes: String(d.notes || "").trim(),
	};
}

function num(v) {
	const n = Number(String(v == null ? "" : v).replace(/\./g, "").replace(",", "."));
	return Number.isFinite(n) && n > 0 ? n : null;
}

/* Συγκριτικά από το ίδιο μας το χαρτοφυλάκιο: ίδια κατηγορία, ίδια
   περιοχή (χαλαρό ταίριασμα), μέγεθος ±40%, με τιμή. Το δικό του
   ακίνητο (ίδιος κωδικός) εξαιρείται. */
function pickComps(feed, prop) {
	const wantArea = normName(prop.areaName);
	const bySize = (l) => Math.abs((l.area || 0) - (prop.size || 0));
	const match = (l, transaction) =>
		l.transaction === transaction &&
		l.category === prop.category &&
		l.price > 0 && l.area > 0 &&
		String(l.code) !== String(prop.listingCode) &&
		(!wantArea || areaOf(l).includes(wantArea) || wantArea.includes(areaOf(l))) &&
		(!prop.size || (l.area > prop.size * 0.6 && l.area < prop.size * 1.4));
	const sale = feed.filter((l) => match(l, "sale")).sort((a, b) => bySize(a) - bySize(b)).slice(0, 8);
	const rent = feed.filter((l) => match(l, "rent")).sort((a, b) => bySize(a) - bySize(b)).slice(0, 5);
	return { sale, rent };
}

function areaOf(l) {
	return normName((l.location && (l.location.area || l.location.neighbourhood)) || "");
}

function normName(s) {
	return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

/* Διάμεσος €/τ.μ. στην περιοχή από ΟΛΟ το ενεργό στοκ μας (όχι μόνο τα
   στενά συγκριτικά), ώστε το prompt να ξέρει και το γενικό επίπεδο. */
function areaStats(feed, prop) {
	const wantArea = normName(prop.areaName);
	const psm = (transaction) => {
		const xs = feed
			.filter((l) => l.transaction === transaction && l.category === prop.category
				&& l.price > 0 && l.area > 0
				&& (!wantArea || areaOf(l).includes(wantArea) || wantArea.includes(areaOf(l))))
			.map((l) => l.price / l.area)
			.sort((a, b) => a - b);
		if (!xs.length) return null;
		return { median: xs[Math.floor(xs.length / 2)], count: xs.length };
	};
	return { sale: psm("sale"), rent: psm("rent") };
}

/* ------------------------------------------------------------------ */
/* Prompts                                                              */
/* ------------------------------------------------------------------ */

/* ΠΟΙΕΣ ΤΙΜΕΣ ΜΕΤΡΑΝΕ: το μοντέλο, αφημένο μόνο του, τραβάει προς τα κάτω
   επικαλούμενο τιμές συμβολαίων / αντικειμενικές αξίες. Στην ελληνική
   αγορά ένα μέρος του τιμήματος δίνεται εκτός συμβολαίου, άρα τα ποσά
   αυτά είναι συστηματικά ΧΑΜΗΛΟΤΕΡΑ από την πραγματική τιμή κλεισίματος
   και δεν είναι ένδειξη αγοραίας αξίας. Η μόνη αξιόπιστη βάση είναι οι
   ζητούμενες τιμές των πλατφορμών (πίνακας περιοχών + συγκριτικά μας),
   λίγο φουσκωμένες, μείον ~10% για το παζάρι μέχρι το κλείσιμο. Ο κανόνας
   επαναλαμβάνεται και στα δύο περάσματα — το δεύτερο είναι που «διορθώνει»
   και θα ξανακατέβαζε το νούμερο αν δεν τον ήξερε. */
const PRICE_BASIS = `ΒΑΣΗ ΤΙΜΩΝ (κανόνας του γραφείου, δεσμευτικός): αφετηρία σου είναι ΠΑΝΤΑ οι ΖΗΤΟΥΜΕΝΕΣ τιμές αγγελιών — ο πίνακας περιοχών και τα συγκριτικά του χαρτοφυλακίου μας — μειωμένες περίπου 10% για το τυπικό παζάρι μέχρι το κλείσιμο. ΜΗΝ αγκυρώνεσαι σε τιμές συμβολαίων, αντικειμενικές αξίες, τιμές ζώνης της εφορίας ή στοιχεία μεταβιβάσεων: στην ελληνική αγορά ένα μέρος του τιμήματος δίνεται εκτός συμβολαίου, οπότε τα ποσά αυτά είναι συστηματικά ΧΑΜΗΛΟΤΕΡΑ από την πραγματική τιμή κλεισίματος και ΔΕΝ αποτελούν ένδειξη αγοραίας αξίας. Μην τα χρησιμοποιείς ως αιτιολόγηση χαμηλότερης εκτίμησης και μην τα αναφέρεις στα κείμενα.`;

const PASS1_SYSTEM = `Είσαι έμπειρος εκτιμητής ακινήτων με 25 χρόνια στην αγορά της Θεσσαλονίκης και της υπόλοιπης Κεντρικής Μακεδονίας (Χαλκιδική, Πιερία, Σέρρες, Ημαθία, Πέλλα, Κιλκίς). Δουλεύεις για το μεσιτικό γραφείο Four Walls. Κάνεις ενδεικτικές εκτιμήσεις αγοραίας αξίας για εσωτερική χρήση του γραφείου, με τη μέθοδο των συγκριτικών στοιχείων: ξεκινάς από την τιμή ζώνης της περιοχής (€/τ.μ.), την προσαρμόζεις με τεκμηριωμένες προσαυξήσεις/απομειώσεις ανά χαρακτηριστικό, και διασταυρώνεις με τα συγκριτικά. ${PRICE_BASIS} Είσαι συντηρητικός στη διατύπωση αλλά όχι ηττοπαθής στο νούμερο: καλύτερα στενό ρεαλιστικό εύρος παρά εντυπωσιακά νούμερα, και ποτέ τιμή που δεν στέκει δίπλα στις ζητούμενες της περιοχής. Απαντάς ΜΟΝΟ με έγκυρο JSON, χωρίς markdown, χωρίς σχόλια εκτός JSON.`;

const PASS1_ASK = `Δώσε την εκτίμηση ως JSON ακριβώς με αυτό το σχήμα (αριθμοί χωρίς σύμβολα και χωρίς διαχωριστικά χιλιάδων):
{
 "headline": "μία πρόταση με το συμπέρασμα",
 "base_eur_per_sqm": 0,
 "adjustments": [ { "factor": "π.χ. Όροφος (4ος με θέα)", "pct": 5, "reason": "σύντομη αιτιολόγηση" } ],
 "eur_per_sqm": 0,
 "value_low": 0, "value_mid": 0, "value_high": 0,
 "rent_low": 0, "rent_mid": 0, "rent_high": 0,
 "gross_yield_pct": 0,
 "market_comment": "2-4 προτάσεις για την τοπική αγορά και τη ζήτηση για αυτό το είδος ακινήτου",
 "comps_comment": "1-3 προτάσεις για το τι δείχνουν τα συγκριτικά και πόσο αξιόπιστα είναι εδώ",
 "asking_comment": "αν δόθηκε ζητούμενη/επιθυμητή τιμή, 1-2 προτάσεις σύγκρισης με την εκτίμηση, αλλιώς κενό",
 "confidence": "υψηλή | μέτρια | χαμηλή",
 "confidence_reason": "γιατί",
 "missing_info": [ "τι στοιχείο θα έσφιγγε την εκτίμηση" ],
 "advice": "2-3 προτάσεις προς τον σύμβουλο για τη συζήτηση τιμολόγησης με τον ιδιοκτήτη"
}
Κανόνες: value_mid = eur_per_sqm × εμβαδόν (στρογγύλεμα σε χιλιάδες). Το εύρος low-high ρεαλιστικό, συνήθως ±5-10% γύρω από το mid. Το gross_yield_pct = ετήσιο ενοίκιο mid / value_mid × 100, με ένα δεκαδικό. Κάθε adjustment με pct από -20 έως +20 και πραγματική αιτιολόγηση· μην απαριθμείς ό,τι δεν επηρεάζει. Αν λείπουν κρίσιμα στοιχεία, πλάτυνε το εύρος και πες το στο confidence_reason.`;

const PASS2_SYSTEM = `Είσαι ο αυστηρός ελεγκτής εκτιμήσεων ενός μεσιτικού γραφείου που δραστηριοποιείται σε όλη την Κεντρική Μακεδονία. Παίρνεις τα δεδομένα ενός ακινήτου και μια έτοιμη εκτίμηση σε JSON, και την ελέγχεις: (1) αριθμητική συνέπεια (base × προσαρμογές ≈ €/τ.μ., €/τ.μ. × εμβαδόν ≈ value_mid, απόδοση σωστά υπολογισμένη), (2) συμφωνία με τα συγκριτικά και το εύρος της περιοχής (αποκλίσεις άνω του 15% από τη διάμεσο θέλουν ρητή αιτιολόγηση ή διόρθωση), (3) υπερβολές και αοριστίες στα κείμενα, (4) τη ΒΑΣΗ ΤΙΜΩΝ παρακάτω. ${PRICE_BASIS} Αν η εκτίμηση που ελέγχεις κάθεται πολύ χαμηλότερα από τις ζητούμενες τιμές της περιοχής χωρίς χαρακτηριστικό του ακινήτου να το δικαιολογεί, ή αν κάπου επικαλείται συμβόλαια/αντικειμενικές αξίες, ανέβασέ τη στη σωστή βάση και γράψε το στο review_notes. Διορθώνεις ό,τι δεν στέκει και επιστρέφεις το ΤΕΛΙΚΟ JSON στο ΙΔΙΟ σχήμα, με ένα επιπλέον πεδίο "review_notes": τι άλλαξες και γιατί (κενό αν τίποτα). Απαντάς ΜΟΝΟ με έγκυρο JSON.`;

const PASS2_ASK = `Έλεγξε, διόρθωσε όπου χρειάζεται, και επίστρεψε το τελικό JSON (ίδιο σχήμα, συν "review_notes").`;

function buildDataBlock(prop, comps, stats, priceRow) {
	const lines = [];
	lines.push("ΤΟ ΑΚΙΝΗΤΟ ΠΡΟΣ ΕΚΤΙΜΗΣΗ:");
	lines.push(JSON.stringify({
		κατηγορία: prop.category, είδος: prop.subcategory || null,
		περιοχή: prop.areaName || null, διεύθυνση: prop.address || null,
		εμβαδόν_τμ: prop.size, όροφος: prop.floor || null,
		υπνοδωμάτια: prop.bedrooms, μπάνια: prop.bathrooms,
		έτος_κατασκευής: prop.yearBuilt, έτος_ανακαίνισης: prop.yearRenovated,
		ενεργειακή_κλάση: prop.energyClass || null, κατάσταση: prop.condition || null,
		θέρμανση: prop.heating || null, ασανσέρ: prop.elevator || null,
		πάρκινγκ: prop.parking || null, αποθήκη: prop.storage || null,
		θέα: prop.view || null, προσανατολισμός: prop.orientation || null,
		μπαλκόνια_τμ: prop.balconies || null,
		κοινόχρηστα_μήνα: prop.monthlyMaintenance,
		ζητούμενη_ή_επιθυμητή_τιμή: prop.askingPrice,
		παρατηρήσεις_συμβούλου: prop.notes || null,
	}));
	lines.push("");
	lines.push(`ΤΙΜΕΣ ΠΕΡΙΟΧΩΝ (ζητούμενες, €/τ.μ. πώληση και €/τ.μ./μήνα ενοικίαση, ${AREA_PRICES_META.asOf}):`);
	if (priceRow) lines.push("Κοντινότερη περιοχή του πίνακα: " + JSON.stringify(priceRow));
	lines.push(JSON.stringify(AREA_PRICES));
	lines.push(`Πηγή πίνακα: ${AREA_PRICES_META.source}`);
	lines.push("");
	const compRow = (l) => ({
		κωδικός: l.code, περιοχή: (l.location || {}).area || null,
		είδος: l.subcategory || null, τμ: l.area, τιμή: l.price,
		ανά_τμ: Math.round(l.price / l.area), όροφος: l.floor || null,
		έτος: l.yearBuilt || null, ενεργειακή: l.energyClass || null,
		κατάσταση: l.condition || null,
	});
	lines.push(`ΣΥΓΚΡΙΤΙΚΑ ΠΩΛΗΣΗΣ ΑΠΟ ΤΟ ΧΑΡΤΟΦΥΛΑΚΙΟ ΜΑΣ (${comps.sale.length}):`);
	lines.push(JSON.stringify(comps.sale.map(compRow)));
	lines.push(`ΣΥΓΚΡΙΤΙΚΑ ΕΝΟΙΚΙΑΣΗΣ (${comps.rent.length}):`);
	lines.push(JSON.stringify(comps.rent.map(compRow)));
	if (stats.sale) lines.push(`Διάμεσος ζητούμενη €/τ.μ. πώλησης στο ενεργό στοκ μας για την περιοχή: ${Math.round(stats.sale.median)} (${stats.sale.count} ακίνητα).`);
	if (stats.rent) lines.push(`Διάμεσος ζητούμενη €/τ.μ./μήνα ενοικίασης: ${stats.rent.median.toFixed(1)} (${stats.rent.count} ακίνητα).`);
	return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* AI providers (Claude αν υπάρχει κλειδί, αλλιώς Gemini)               */
/* ------------------------------------------------------------------ */

function askAI(env, system, user) {
	return env.ANTHROPIC_API_KEY ? askClaude(env, system, user) : askGemini(env, system, user);
}

async function askGemini(env, system, user) {
	const model = env.VALUATION_GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
	const res = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
		method: "POST",
		headers: {
			"x-goog-api-key": env.GEMINI_API_KEY,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			system_instruction: { parts: [{ text: system }] },
			contents: [{ role: "user", parts: [{ text: user }] }],
			// responseMimeType: το Gemini επιστρέφει εγγυημένα σκέτο JSON,
			// που είναι ακριβώς ό,τι περιμένει το extractJson.
			// ΠΡΟΣΟΧΗ στο maxOutputTokens: στο 3.5 Flash είναι κοινός
			// κουμπαράς για τη «σκέψη» ΚΑΙ το JSON. Στα 8000 που είχαμε, ένα
			// πιο απαιτητικό system prompt (βλ. PRICE_BASIS) έτρωγε τον χώρο
			// σκεπτόμενο και το JSON γύριζε κομμένο στη μέση.
			generationConfig: { maxOutputTokens: 24000, responseMimeType: "application/json" },
		}),
	});
	if (!res.ok) {
		const detail = (await res.text()).slice(0, 300);
		throw new Error(`gemini HTTP ${res.status}: ${detail}`);
	}
	const body = await res.json();
	const cand = body.candidates?.[0];
	// Η απάντηση μπορεί να έρθει σπασμένη σε πολλά parts (και με κομμάτια
	// «σκέψης» με p.thought=true). Κρατάμε μόνο το καθαρό κείμενο και το
	// ενώνουμε ΧΩΡΙΣ διαχωριστικό: ένα "\n" στη μέση ενός string literal
	// χαλάει το JSON.
	const text = (cand?.content?.parts || [])
		.filter((p) => !p.thought && typeof p.text === "string")
		.map((p) => p.text)
		.join("");
	if (!text) throw new Error(`gemini: empty response (finishReason ${cand?.finishReason})`);
	// Κομμένη απάντηση: λέγε το με το όνομά του. Αλλιώς το μισό JSON φτάνει
	// στο extractJson, που κόβει ως το ΤΕΛΕΥΤΑΙΟ «}» — δηλαδή το κλείσιμο
	// ενός στοιχείου μέσα σε array — και βγάζει ακατάληπτο SyntaxError.
	if (cand.finishReason === "MAX_TOKENS") {
		throw new Error(`gemini: response truncated at maxOutputTokens (${text.length} chars)`);
	}
	return text;
}

async function askClaude(env, system, user) {
	const res = await fetch(ANTHROPIC_URL, {
		method: "POST",
		headers: {
			"x-api-key": env.ANTHROPIC_API_KEY,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: env.VALUATION_MODEL || DEFAULT_MODEL,
			// Στο Opus 5 το thinking είναι ενεργό από προεπιλογή και μετράει
			// ΜΕΣΑ στο max_tokens, οπότε το όριο θέλει αέρα πάνω από το JSON —
			// ακριβώς η παγίδα που έκοβε το Gemini στα 8000 (βλ. askGemini).
			max_tokens: 24000,
			output_config: { effort: "medium" },
			system,
			messages: [{ role: "user", content: user }],
		}),
	});
	if (!res.ok) {
		const detail = (await res.text()).slice(0, 300);
		throw new Error(`anthropic HTTP ${res.status}: ${detail}`);
	}
	const body = await res.json();
	if (body.stop_reason === "refusal") {
		throw new Error("anthropic refusal (stop_reason)");
	}
	// Ίδιος λόγος με το Gemini: κομμένη απάντηση θέλει καθαρό σφάλμα, όχι
	// μισό JSON που σκάει αργότερα σαν SyntaxError.
	if (body.stop_reason === "max_tokens") {
		throw new Error("anthropic: response truncated at max_tokens");
	}
	return (body.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

/* Το μοντέλο απαντά με σκέτο JSON, αλλά αν τυλίξει fences ή βάλει μια
   πρόταση πριν, κρατάμε ό,τι βρίσκεται από το πρώτο { ως το τελευταίο }. */
function extractJson(s) {
	const a = s.indexOf("{");
	const b = s.lastIndexOf("}");
	if (a === -1 || b <= a) throw new Error("valuation: no JSON in model output");
	try {
		return JSON.parse(s.slice(a, b + 1));
	} catch (err) {
		// Το πρόβλημα φαίνεται μόνο με το πραγματικό κείμενο μπροστά σου.
		console.error(`valuation: bad JSON (${s.length} chars): ${s.slice(0, 400)}`);
		throw err;
	}
}

/* ------------------------------------------------------------------ */
/* Report (HTML email, ίδια σχεδίαση με το lead-reply)                  */
/* ------------------------------------------------------------------ */

const NAVY = "#16233A";
const PINK = "#FF1462";

function esc(s) {
	return String(s == null ? "" : s)
		.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function eur(n) {
	if (!Number.isFinite(Number(n))) return "";
	return "€" + String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function renderReport(prop, comps, stats, priceRow, v, payload) {
	const identity = [
		prop.subcategory || labelCategory(prop.category),
		prop.size ? `${prop.size} τ.μ.` : "",
		prop.areaName,
		prop.listingCode ? `κωδ. ${prop.listingCode}` : "",
	].filter(Boolean).join(" · ");

	const subject = `ΕΚΤΙΜΗΣΗ · ${identity}`;

	const adjRows = (Array.isArray(v.adjustments) ? v.adjustments : []).map((a) => {
		const pct = Number(a.pct) || 0;
		const sign = pct > 0 ? "+" : "";
		const color = pct > 0 ? "#2e9e5b" : (pct < 0 ? "#c62828" : "#6b7280");
		return `<tr>
			<td style="padding:7px 10px; border-bottom:1px solid #eceef2; font-size:13px; color:${NAVY};">${esc(a.factor)}</td>
			<td style="padding:7px 10px; border-bottom:1px solid #eceef2; font-size:13px; font-weight:bold; color:${color}; white-space:nowrap; text-align:right;">${sign}${esc(String(pct).replace(".", ","))}%</td>
			<td style="padding:7px 10px; border-bottom:1px solid #eceef2; font-size:12px; color:#6b7280;">${esc(a.reason)}</td>
		</tr>`;
	}).join("");

	const compRows = comps.sale.map((l) => `<tr>
		<td style="padding:6px 10px; border-bottom:1px solid #eceef2; font-size:12px; color:${NAVY};">${esc(l.code || "")}</td>
		<td style="padding:6px 10px; border-bottom:1px solid #eceef2; font-size:12px; color:${NAVY};">${esc(l.subcategory || "")} ${esc((l.location || {}).area || "")}</td>
		<td style="padding:6px 10px; border-bottom:1px solid #eceef2; font-size:12px; text-align:right;">${l.area} τ.μ.</td>
		<td style="padding:6px 10px; border-bottom:1px solid #eceef2; font-size:12px; text-align:right; font-weight:bold;">${eur(l.price)}</td>
		<td style="padding:6px 10px; border-bottom:1px solid #eceef2; font-size:12px; text-align:right; color:#6b7280;">${eur(l.price / l.area)}/τ.μ.</td>
	</tr>`).join("");

	const missing = (Array.isArray(v.missing_info) ? v.missing_info : []).filter(Boolean);
	const propFacts = [
		["Είδος", prop.subcategory || labelCategory(prop.category)],
		["Περιοχή", prop.areaName], ["Διεύθυνση", prop.address],
		["Εμβαδόν", prop.size ? `${prop.size} τ.μ.` : ""], ["Όροφος", prop.floor],
		["Υ/Δ · Μπάνια", [prop.bedrooms, prop.bathrooms].filter(Boolean).join(" · ")],
		["Έτος", [prop.yearBuilt, prop.yearRenovated ? `ανακ. ${prop.yearRenovated}` : ""].filter(Boolean).join(" · ")],
		["Ενεργειακή", prop.energyClass], ["Κατάσταση", prop.condition],
		["Θέρμανση", prop.heating], ["Ασανσέρ", prop.elevator],
		["Πάρκινγκ", prop.parking], ["Αποθήκη", prop.storage],
		["Θέα", prop.view], ["Προσανατολισμός", prop.orientation],
		["Ζητούμενη/επιθυμητή τιμή", prop.askingPrice ? eur(prop.askingPrice) : ""],
	].filter(([, val]) => val).map(([k, val]) =>
		`<tr><td style="padding:4px 10px; font-size:12px; color:#6b7280; white-space:nowrap;">${esc(k)}</td><td style="padding:4px 10px; font-size:12px; color:${NAVY};">${esc(val)}</td></tr>`).join("");

	const wantsSale = prop.purpose !== "rent";
	const wantsRent = prop.purpose !== "sale";

	const html = `<!doctype html><html lang="el"><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0; padding:0; background:#f4f5f7; font-family:Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7; padding:16px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:100%; background:#ffffff; border-radius:8px; overflow:hidden;">
	<tr><td style="background:${NAVY}; padding:15px 20px;"><span style="color:#ffffff; font-size:18px; font-weight:bold; letter-spacing:1.5px;">FOUR WALLS</span><span style="color:${PINK}; font-size:10px; font-weight:bold; letter-spacing:2px;">&nbsp;&nbsp;REAL ESTATE</span></td></tr>
	<tr><td style="height:3px; background:${PINK};"></td></tr>
	<tr><td style="padding:20px 20px 6px;">
		<div style="font-size:11px; font-weight:bold; letter-spacing:1.5px; color:${PINK};">ΕΚΤΙΜΗΣΗ ΑΞΙΑΣ</div>
		<div style="font-size:17px; font-weight:bold; color:${NAVY}; margin-top:4px;">${esc(identity)}</div>
		${v.headline ? `<div style="font-size:13px; color:#444; margin-top:8px; line-height:1.55;">${esc(v.headline)}</div>` : ""}
	</td></tr>
	${wantsSale ? `<tr><td style="padding:12px 20px 0;">
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
			<td style="background:#fdf2f6; border:1px solid ${PINK}; border-radius:8px; padding:14px 16px;">
				<div style="font-size:11px; font-weight:bold; letter-spacing:1px; color:#6b7280;">ΕΚΤΙΜΩΜΕΝΗ ΑΞΙΑ ΠΩΛΗΣΗΣ</div>
				<div style="font-size:26px; font-weight:bold; color:${PINK}; margin-top:2px;">${eur(v.value_mid)}</div>
				<div style="font-size:13px; color:${NAVY}; margin-top:2px;">εύρος ${eur(v.value_low)} έως ${eur(v.value_high)} · ${eur(v.eur_per_sqm)}/τ.μ.</div>
			</td>
		</tr></table>
	</td></tr>` : ""}
	${wantsRent ? `<tr><td style="padding:10px 20px 0;">
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
			<td style="background:#f4f7fb; border:1px solid #c9d4e4; border-radius:8px; padding:12px 16px;">
				<div style="font-size:11px; font-weight:bold; letter-spacing:1px; color:#6b7280;">ΕΚΤΙΜΩΜΕΝΟ ΜΙΣΘΩΜΑ</div>
				<div style="font-size:19px; font-weight:bold; color:${NAVY}; margin-top:2px;">${eur(v.rent_mid)}/μήνα <span style="font-weight:normal; font-size:13px; color:#6b7280;">(εύρος ${eur(v.rent_low)} έως ${eur(v.rent_high)})</span></div>
				${Number(v.gross_yield_pct) ? `<div style="font-size:12.5px; color:#6b7280; margin-top:2px;">Μικτή απόδοση ~${esc(String(v.gross_yield_pct).replace(".", ","))}% στην εκτιμώμενη αξία</div>` : ""}
			</td>
		</tr></table>
	</td></tr>` : ""}
	${prop.askingPrice && v.asking_comment ? `<tr><td style="padding:12px 20px 0;">
		<div style="background:#f7f8fa; border-left:3px solid ${PINK}; border-radius:6px; padding:10px 14px; font-size:13px; line-height:1.55; color:${NAVY};"><strong>Σε σχέση με τη ζητούμενη (${eur(prop.askingPrice)}):</strong> ${esc(v.asking_comment)}</div>
	</td></tr>` : ""}
	${adjRows ? `<tr><td style="padding:18px 20px 0;">
		<div style="font-size:12px; font-weight:bold; letter-spacing:1px; color:${NAVY}; margin-bottom:6px;">ΠΩΣ ΒΓΗΚΕ ΤΟ ΝΟΥΜΕΡΟ</div>
		<div style="font-size:12.5px; color:#444; margin-bottom:6px;">Αφετηρία ${eur(v.base_eur_per_sqm)}/τ.μ. για την περιοχή, με τις εξής προσαρμογές:</div>
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceef2; border-radius:6px;">${adjRows}</table>
	</td></tr>` : ""}
	${compRows ? `<tr><td style="padding:18px 20px 0;">
		<div style="font-size:12px; font-weight:bold; letter-spacing:1px; color:${NAVY}; margin-bottom:6px;">ΣΥΓΚΡΙΤΙΚΑ ΑΠΟ ΤΟ ΧΑΡΤΟΦΥΛΑΚΙΟ ΜΑΣ</div>
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceef2; border-radius:6px;">${compRows}</table>
		${v.comps_comment ? `<div style="font-size:12px; color:#6b7280; margin-top:6px; line-height:1.5;">${esc(v.comps_comment)}</div>` : ""}
	</td></tr>` : ""}
	${v.market_comment ? `<tr><td style="padding:18px 20px 0;">
		<div style="font-size:12px; font-weight:bold; letter-spacing:1px; color:${NAVY}; margin-bottom:6px;">Η ΑΓΟΡΑ</div>
		<div style="font-size:13px; color:#444; line-height:1.6;">${esc(v.market_comment)}</div>
	</td></tr>` : ""}
	<tr><td style="padding:18px 20px 0;">
		<div style="font-size:12px; font-weight:bold; letter-spacing:1px; color:${NAVY}; margin-bottom:6px;">ΒΕΒΑΙΟΤΗΤΑ: ${esc(String(v.confidence || "").toUpperCase())}</div>
		<div style="font-size:12.5px; color:#444; line-height:1.55;">${esc(v.confidence_reason || "")}</div>
		${missing.length ? `<div style="font-size:12px; color:#6b7280; margin-top:6px;">Θα βοηθούσε να ξέρουμε: ${esc(missing.join(" · "))}</div>` : ""}
	</td></tr>
	${v.advice ? `<tr><td style="padding:14px 20px 0;">
		<div style="background:#f2f9f4; border-left:3px solid #2e9e5b; border-radius:6px; padding:10px 14px; font-size:13px; line-height:1.55; color:${NAVY};"><strong>Για τη συζήτηση με τον ιδιοκτήτη:</strong> ${esc(v.advice)}</div>
	</td></tr>` : ""}
	${propFacts ? `<tr><td style="padding:18px 20px 0;">
		<div style="font-size:12px; font-weight:bold; letter-spacing:1px; color:${NAVY}; margin-bottom:6px;">ΤΑ ΣΤΟΙΧΕΙΑ ΠΟΥ ΔΟΘΗΚΑΝ${prop.fromCrm ? " (συμπληρωμένα και από το CRM)" : ""}</div>
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceef2; border-radius:6px;">${propFacts}</table>
		${prop.notes ? `<div style="font-size:12px; color:#6b7280; margin-top:6px;">Παρατηρήσεις: ${esc(prop.notes)}</div>` : ""}
	</td></tr>` : ""}
	${v.review_notes ? `<tr><td style="padding:14px 20px 0;">
		<div style="font-size:11.5px; color:#9aa3af; line-height:1.5;">Δεύτερο πέρασμα ελέγχου: ${esc(v.review_notes)}</div>
	</td></tr>` : ""}
	<tr><td style="padding:18px 20px 20px;">
		<div style="border-top:1px solid #eceef2; padding-top:12px; font-size:11px; color:#9aa3af; line-height:1.6;">Ενδεικτική εκτίμηση αγοραίας αξίας για εσωτερική χρήση του γραφείου, με βάση ζητούμενες τιμές αγγελιών (${esc(AREA_PRICES_META.asOf)}) και τα συγκριτικά του χαρτοφυλακίου μας. Δεν αποτελεί πιστοποιημένη έκθεση εκτίμησης.${payload.submitted_by ? ` Υποβλήθηκε από ${esc(payload.submitted_by)}.` : ""}</div>
	</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

	const text = [
		subject,
		v.headline || "",
		wantsSale ? `Αξία πώλησης: ${eur(v.value_mid)} (εύρος ${eur(v.value_low)} έως ${eur(v.value_high)}, ${eur(v.eur_per_sqm)}/τ.μ.)` : "",
		wantsRent ? `Μίσθωμα: ${eur(v.rent_mid)}/μήνα (εύρος ${eur(v.rent_low)} έως ${eur(v.rent_high)})` : "",
		`Βεβαιότητα: ${v.confidence || ""}. ${v.confidence_reason || ""}`,
	].filter(Boolean).join("\n");

	return {
		subject, html, text,
		// Για την προβολή μέσα στη φόρμα (ektimisi.html): το τελικό JSON
		// του μοντέλου, τα στοιχεία του ακινήτου και τα συγκριτικά. Το
		// Make αγνοεί αυτά τα πεδία.
		v, prop,
		comps: comps.sale.map((l) => ({
			code: l.code, area: (l.location || {}).area, sqm: l.area, price: l.price,
		})),
	};
}

function labelCategory(c) {
	return { residential: "Κατοικία", commercial: "Επαγγελματικό", land: "Οικόπεδο" }[c] || "Ακίνητο";
}

/* ------------------------------------------------------------------ */
/* Έντυπο για το αρχείο (PDF στο info@)                                 */
/* ------------------------------------------------------------------ */

/* Η ΙΔΙΑ αναφορά με το email, αλλά στη χάρτινη γλώσσα των εντύπων
   (Manrope, navy/ροζ, wordmark) — αυτό αρχειοθετεί η γραμματεία στα
   έγγραφα του πελάτη, δίπλα σε αναθέσεις και αποδείξεις. Χτίζεται ΜΟΝΟ
   από όσα κουβαλά το κασαρισμένο result (subject, v, prop, comps), ώστε
   να δουλεύει και για εκτιμήσεις που υπάρχουν ήδη στο KV. Η ημερομηνία
   είναι της εκτύπωσης, όπως και στα άλλα έντυπα. */
const DOC_NAVY = "#1C3457";
const DOC_PINK = "#FF0062";

function renderPrintHtml(result) {
	const v = result.v || {};
	const p = result.prop || {};
	const comps = Array.isArray(result.comps) ? result.comps : [];
	const identity = String(result.subject || "").replace(/^ΕΚΤΙΜΗΣΗ · /, "");
	const wantsSale = p.purpose !== "rent";
	const wantsRent = p.purpose !== "sale";
	const dateStr = new Date().toLocaleDateString("el-GR", { timeZone: "Europe/Athens" });

	const adj = (Array.isArray(v.adjustments) ? v.adjustments : []).map((a) => {
		const pct = Number(a.pct) || 0;
		return `<tr><td>${esc(a.factor)}</td><td class="${pct >= 0 ? "pos" : "neg"}">${pct > 0 ? "+" : ""}${esc(String(pct).replace(".", ","))}%</td><td class="mut">${esc(a.reason)}</td></tr>`;
	}).join("");

	const compRows = comps.map((c) => `<tr>
		<td>${esc((c.code ? c.code + " · " : "") + (c.area || ""))}</td>
		<td class="num">${c.sqm ? esc(String(c.sqm)) + " τ.μ." : ""}</td>
		<td class="num"><strong>${eur(c.price)}</strong></td>
		<td class="num mut">${c.sqm && c.price ? eur(Math.round(c.price / c.sqm)) + "/τ.μ." : ""}</td>
	</tr>`).join("");

	const facts = [
		["Είδος", p.subcategory || labelCategory(p.category)],
		["Περιοχή", p.areaName], ["Διεύθυνση", p.address],
		["Εμβαδόν", p.size ? `${p.size} τ.μ.` : ""], ["Όροφος", p.floor],
		["Υ/Δ · Μπάνια", [p.bedrooms, p.bathrooms].filter(Boolean).join(" · ")],
		["Έτος", [p.yearBuilt, p.yearRenovated ? `ανακ. ${p.yearRenovated}` : ""].filter(Boolean).join(" · ")],
		["Ενεργειακή", p.energyClass], ["Κατάσταση", p.condition],
		["Θέρμανση", p.heating], ["Ασανσέρ", p.elevator],
		["Πάρκινγκ", p.parking], ["Αποθήκη", p.storage],
		["Θέα", p.view], ["Προσανατολισμός", p.orientation],
		["Ζητούμενη/επιθυμητή τιμή", p.askingPrice ? eur(p.askingPrice) : ""],
	].filter(([, val]) => val).map(([k, val]) =>
		`<tr><td class="mut" style="white-space:nowrap;">${esc(k)}</td><td>${esc(val)}</td></tr>`).join("");

	const missing = (Array.isArray(v.missing_info) ? v.missing_info : []).filter(Boolean);

	return `<!doctype html><html lang="el"><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
@media print{@page{size:A4;margin:10mm 10mm 12mm}}
html,body{background:#fff;margin:0;padding:0;}
body{font-family:'Manrope','Segoe UI',Arial,sans-serif;color:#242a33;font-size:13.5px;line-height:1.55;}
.doc{padding:0 3mm;}
.hd{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid ${DOC_NAVY};padding-bottom:9px;position:relative;}
.hd::after{content:"";position:absolute;left:0;bottom:-2px;width:150px;height:2px;background:${DOC_PINK};}
.wm .n{font-weight:800;font-size:19px;letter-spacing:.13em;color:${DOC_NAVY};line-height:1;}
.wm .s{font-weight:700;font-size:7px;letter-spacing:.42em;color:${DOC_PINK};margin-top:4px;}
.co{text-align:right;font-size:10px;color:#6b7280;line-height:1.6;}
h1{font-weight:800;font-size:18px;color:${DOC_NAVY};margin:14px 0 0;}
.accent{width:60px;height:4px;background:${DOC_PINK};border-radius:2px;margin:8px 0 10px;}
h2{font-size:12px;font-weight:800;letter-spacing:.05em;color:${DOC_NAVY};margin:16px 0 6px;}
p{margin:0 0 7px;}
.mut{color:#6b7280;font-size:12px;}
.bigval{background:#fdf2f7;border:1px solid ${DOC_PINK};border-radius:10px;padding:12px 15px;margin:10px 0 8px;}
.bigval .l{font-size:10.5px;font-weight:800;letter-spacing:.08em;color:#6b7280;}
.bigval .v{font-size:27px;font-weight:800;color:${DOC_PINK};line-height:1.25;}
.bigval .r{font-size:12.5px;color:${DOC_NAVY};}
.rentval{background:#f4f7fb;border:1px solid #c9d4e4;border-radius:10px;padding:11px 15px;margin:0 0 8px;}
.rentval .l{font-size:10.5px;font-weight:800;letter-spacing:.08em;color:#6b7280;}
.rentval .r{font-size:14px;font-weight:700;color:${DOC_NAVY};}
.rentval .y{font-size:12px;color:#6b7280;}
table{width:100%;border-collapse:collapse;font-size:12.5px;border:1px solid #eceef2;}
td{padding:6px 8px;border-bottom:1px solid #eceef2;vertical-align:top;}
tr:last-child td{border-bottom:none;}
td.pos{color:#12855b;font-weight:700;white-space:nowrap;text-align:right;}
td.neg{color:#b3261e;font-weight:700;white-space:nowrap;text-align:right;}
td.num{text-align:right;white-space:nowrap;}
.note{background:#f2f9f4;border-left:3px solid #12855b;border-radius:6px;padding:9px 12px;margin:10px 0;}
.disc{border-top:1px solid #eceef2;margin-top:14px;padding-top:9px;font-size:10.5px;color:#9aa3af;line-height:1.6;}
</style></head><body><div class="doc">
	<div class="hd">
		<div class="wm"><div class="n">FOUR WALLS</div><div class="s">REAL ESTATE</div></div>
		<div class="co"><div>ΕΚΤΙΜΗΣΗ ΑΞΙΑΣ</div><div>${esc(dateStr)}</div></div>
	</div>
	<h1>${esc(identity)}</h1>
	<div class="accent"></div>
	${v.headline ? `<p>${esc(v.headline)}</p>` : ""}
	${wantsSale ? `<div class="bigval">
		<div class="l">ΕΚΤΙΜΩΜΕΝΗ ΑΞΙΑ ΠΩΛΗΣΗΣ</div>
		<div class="v">${eur(v.value_mid)}</div>
		<div class="r">εύρος ${eur(v.value_low)} έως ${eur(v.value_high)} · ${eur(v.eur_per_sqm)}/τ.μ.</div>
	</div>` : ""}
	${wantsRent && v.rent_mid ? `<div class="rentval">
		<div class="l">ΕΚΤΙΜΩΜΕΝΟ ΜΙΣΘΩΜΑ</div>
		<div class="r">${eur(v.rent_mid)}/μήνα (εύρος ${eur(v.rent_low)} έως ${eur(v.rent_high)})</div>
		${Number(v.gross_yield_pct) ? `<div class="y">Μικτή απόδοση ~${esc(String(v.gross_yield_pct).replace(".", ","))}% στην εκτιμώμενη αξία</div>` : ""}
	</div>` : ""}
	${p.askingPrice && v.asking_comment ? `<h2>ΣΕ ΣΧΕΣΗ ΜΕ ΤΗ ΖΗΤΟΥΜΕΝΗ (${eur(p.askingPrice)})</h2><p>${esc(v.asking_comment)}</p>` : ""}
	${adj ? `<h2>ΠΩΣ ΒΓΗΚΕ ΤΟ ΝΟΥΜΕΡΟ · ΑΦΕΤΗΡΙΑ ${eur(v.base_eur_per_sqm)}/τ.μ.</h2><table>${adj}</table>` : ""}
	${compRows ? `<h2>ΣΥΓΚΡΙΤΙΚΑ ΑΠΟ ΤΟ ΧΑΡΤΟΦΥΛΑΚΙΟ ΜΑΣ</h2><table>${compRows}</table>
		${v.comps_comment ? `<p class="mut" style="margin-top:6px;">${esc(v.comps_comment)}</p>` : ""}` : ""}
	${v.market_comment ? `<h2>Η ΑΓΟΡΑ</h2><p>${esc(v.market_comment)}</p>` : ""}
	<h2>ΒΕΒΑΙΟΤΗΤΑ: ${esc(String(v.confidence || "").toUpperCase())}</h2>
	${v.confidence_reason ? `<p>${esc(v.confidence_reason)}</p>` : ""}
	${missing.length ? `<p class="mut">Θα βοηθούσε να ξέρουμε: ${esc(missing.join(" · "))}</p>` : ""}
	${v.advice ? `<div class="note"><strong>Για τη συζήτηση με τον ιδιοκτήτη:</strong> ${esc(v.advice)}</div>` : ""}
	${facts ? `<h2>ΤΑ ΣΤΟΙΧΕΙΑ ΠΟΥ ΔΟΘΗΚΑΝ${p.fromCrm ? " (ΣΥΜΠΛΗΡΩΜΕΝΑ ΚΑΙ ΑΠΟ ΤΟ CRM)" : ""}</h2><table>${facts}</table>
		${p.notes ? `<p class="mut" style="margin-top:6px;">Παρατηρήσεις: ${esc(p.notes)}</p>` : ""}` : ""}
	${v.review_notes ? `<p class="mut" style="margin-top:10px;">Δεύτερο πέρασμα ελέγχου: ${esc(v.review_notes)}</p>` : ""}
	<div class="disc">Ενδεικτική εκτίμηση αγοραίας αξίας για εσωτερική χρήση του γραφείου, με βάση ζητούμενες τιμές αγγελιών (${esc(AREA_PRICES_META.asOf)}) και τα συγκριτικά του χαρτοφυλακίου μας. Δεν αποτελεί πιστοποιημένη έκθεση εκτίμησης. Four Walls Real Estate · four-walls.gr</div>
</div></body></html>`;
}
