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
   και στο Make, με TTL 7 ημερών, και το αποτέλεσμα κασάρεται ανά ref:
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

import {
	AREA_PRICES, AREA_PRICES_META, findAreaPrices,
	ASSET_PRICES_META, landPricePerBuildableSqm, commercialPrices, agriPrices, zoneOf, zoneLabel, YIELDS,
} from "./area-prices.mjs";
import { RENOVATION_COSTS, RENOVATION_COSTS_META } from "./renovation-costs.mjs";
import { renderDocPdf } from "./pdfrender.mjs";
import { apiConfig } from "./estateprime.mjs";
import { subcategoryLabel, canonicalUrl } from "./seo.mjs";

/* KV keys — το request γράφεται από forms.mjs, το result από εδώ. */
export const VALUATION_REQ_PREFIX = "valuation:req:";

/* Η ΕΚΔΟΣΗ ΤΗΣ ΑΝΑΦΟΡΑΣ, μέσα στα κλειδιά του cache. Το report και το PDF
   κασάρονται ανά ref για μέρες, οπότε ένα deploy που αλλάζει τη ΜΟΡΦΗ τους
   δεν αρκεί: η εκτίμηση υπολογίζεται στο βήμα 1 και το «Αποστολή στο info@»
   στέλνει ό,τι είχε κασαριστεί τότε, όσο αργότερα κι αν πατηθεί. Στις
   02/08/2026 έφυγε έτσι εκτίμηση ενοικίασης της 31/07 με τα συγκριτικά
   πώλησης που είχαν ήδη διορθωθεί, και με PDF που έγραφε 31/7.

   ΑΥΞΗΣΕ ΤΟ όποτε αλλάζει το renderReport, το renderPrintHtml ή τα prompts:
   τα παλιά κλειδιά αγνοούνται και λήγουν μόνα τους, και ό,τι ξανασταλεί
   ΞΑΝΑΥΠΟΛΟΓΙΖΕΤΑΙ με τον νέο κώδικα. Κοστίζει δύο κλήσεις AI ανά τέτοιο
   resend, άρα όχι για αλλαγές που δεν φαίνονται στο χαρτί. Το «3» ήταν το
   επόμενο νούμερο μετά το valuation:pdf2:, που είχε μπει μόνο του για τον
   ίδιο λόγο (τα πρώτα PDF έβγαιναν με τη σχεδίαση του email)· το «4» είναι
   η χρωματισμένη βεβαιότητα (02/08/2026), που φαίνεται στο χαρτί. */
const REPORT_VERSION = 4;
const VALUATION_RES_PREFIX = `valuation:res${REPORT_VERSION}:`;
const VALUATION_PDF_PREFIX = `valuation:pdf${REPORT_VERSION}:`;

/* Μόνιμο ιστορικό εκτιμήσεων: ένα KV key ανά μήνα, ΧΩΡΙΣ TTL — βλ.
   logValuation παρακάτω. */
const VALUATION_LOG_PREFIX = "valuation:log:";

/* Ένα TTL για το αίτημα ΚΑΙ για τα κασαρισμένα. Το αίτημα ζούσε 2 μέρες
   και το report 7: μετά από αύξηση του REPORT_VERSION ένα resend μέσα σε
   αυτό το κενό θα ξαναϋπολόγιζε, δεν θα έβρισκε το αίτημα και θα έσκαγε με
   unknown_ref (404 → το bundle στο DLQ). Τώρα λήγουν μαζί.

   ΕΝΑ ΕΤΟΣ, όχι 7 μέρες: ο λόγος του μικρού TTL ήταν ο όγκος, και ο όγκος
   δεν υπάρχει. Το report είναι ~60 KB κείμενο, δηλαδή λίγες δεκάδες MB τον
   χρόνο στους ρυθμούς μας, μέσα στο δωρεάν 1 GB του KV. Με 7 μέρες ο
   σύνδεσμος «report» του ιστορικού ήταν νεκρός σχεδόν πάντα: η γραμμή
   έμενε για πάντα και το κείμενο που την εξηγεί χανόταν σε μια βδομάδα. */
export const VALUATION_TTL_SECONDS = 365 * 24 * 3600;

/* Το PDF είναι base64 και ζυγίζει 10-20 φορές το report, χωρίς να το
   χρειάζεται κανείς αργότερα: το ζητά μόνο το Make τη στιγμή της
   αποστολής, λεπτά μετά τον υπολογισμό. Ό,τι σπάνια ξαναζητηθεί
   ξαναφτιάχνεται από το report, χωρίς AI. */
const VALUATION_PDF_TTL_SECONDS = 7 * 24 * 3600;

const FEED_KEY = "listings.json"; // ίδιο με FEED_KEY στο worker/index.mjs
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-opus-5";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

/* Χαμηλή, όχι μηδενική: το μηδέν κολλάει τα μοντέλα σε επαναλαμβανόμενες
   διατυπώσεις και βλάπτει τα κείμενα, ενώ τα νούμερα σταθεροποιούνται ήδη
   πολύ πριν φτάσουμε εκεί. */
const VALUATION_TEMPERATURE = 0.2;

/* ΠΟΥ ΤΡΕΧΟΥΜΕ ΤΟ ΠΡΩΤΟ ΠΕΡΑΣΜΑ ΠΟΛΛΕΣ ΦΟΡΕΣ: στη γη. Είναι το μόνο
   είδος χωρίς συγκριτικά και με πίνακα πρώτης έκδοσης, δηλαδή εκεί που η
   διασπορά του μοντέλου είναι μεγαλύτερη. Τα δείγματα τρέχουν ΠΑΡΑΛΛΗΛΑ
   (ίδιος χρόνος αναμονής, τριπλάσιο κόστος πρώτου περάσματος — δηλαδή
   λίγα λεπτά του ευρώ) και κρατάμε το ΔΙΑΜΕΣΟ, όχι τον μέσο όρο: ένα
   ακραίο δείγμα δεν παρασύρει τη διάμεσο. */
const SAMPLED_PROFILES = new Set(["plot", "parcel"]);
const PASS1_SAMPLES = 3;

/* ctx: για το ctx.waitUntil. ΚΡΙΣΙΜΟ σε κινητό — ο υπολογισμός θέλει 25-45
   δευτερόλεπτα, και όταν κλειδώσει η οθόνη ή πάει η εφαρμογή στο background
   το fetch πεθαίνει. Χωρίς waitUntil, το Cloudflare ακυρώνει τον Worker μαζί
   με τον client και ΔΕΝ γράφεται ποτέ αποτέλεσμα: ο σύμβουλος έχει πληρώσει
   δύο κλήσεις AI για το τίποτα. Με waitUntil η δουλειά τελειώνει και μπαίνει
   στο KV, οπότε το επόμενο fetch τη βρίσκει έτοιμη και δωρεάν. */
export async function handleValuation(request, env, url, ctx) {
	if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

	const ref = String(url.searchParams.get("ref") || "").trim();
	if (!/^[0-9a-f-]{16,64}$/i.test(ref)) return json({ error: "bad_ref" }, 400);
	const wantsHtml = url.searchParams.get("format") === "html";
	const wantsPdf = url.searchParams.get("pdf") === "1";
	const cacheOnly = url.searchParams.get("cached") === "1";

	// Idempotent: το ίδιο ref δίνει πάντα το ίδιο report, χωρίς νέο κόστος.
	const cached = await env.LISTINGS_KV.get(VALUATION_RES_PREFIX + ref);
	if (cached) return respond(await withPdf(env, ref, JSON.parse(cached), wantsPdf), wantsHtml);

	/* ΜΟΝΟ ό,τι υπάρχει έτοιμο (ο σύνδεσμος του ιστορικού). Ένα ref μηνών
	   πίσω δεν επιτρέπεται να ξαναπεράσει από το AI: θα χρέωνε δύο κλήσεις
	   με ένα κλικ και, χειρότερα, θα έβγαζε ΑΛΛΑ νούμερα από αυτά που
	   στάλθηκαν τότε (νέος πίνακας τιμών, άλλο στοκ συγκριτικών). Τα
	   νούμερα εκείνης της ημέρας τα κρατά η γραμμή του ιστορικού. */
	if (cacheOnly) {
		const old = await readAnyVersion(env, ref);
		return old ? respond(old, wantsHtml) : expiredReport(ref, wantsHtml);
	}

	if (!env.ANTHROPIC_API_KEY && !env.GEMINI_API_KEY) {
		console.error("valuation: neither ANTHROPIC_API_KEY nor GEMINI_API_KEY is configured");
		return json({ error: "not_configured" }, 503);
	}

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
	// Οι προσφορές του ίδιου του ακινήτου, ζωντανά από το CRM: πρέπει να
	// είναι φρέσκες τη στιγμή της συζήτησης, γι' αυτό δεν περνούν από το
	// feed. Αποτυχία ή άδειο δεν σταματά τίποτα.
	const offers = await fetchOffers(env, prop.listingId);

	const dataBlock = buildDataBlock(prop, comps, stats, priceRow, offers);

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
		const { draft, spread } = await firstPass(env, prop, dataBlock);
		const v = await askJson(
			env,
			PASS2_SYSTEM,
			dataBlock + spread + "\n\nΗ ΕΚΤΙΜΗΣΗ ΠΡΟΣ ΕΛΕΓΧΟ (JSON):\n" + JSON.stringify(draft) + "\n\n" + PASS2_ASK,
		);
		// Το φρένο τρέχει ΜΕΤΑ τον ελεγκτή: είναι το τελευταίο δίχτυ, και
		// είναι σε κώδικα επίτηδες — τα prompts ξεχνιούνται, ο κώδικας όχι.
		landSanityCheck(prop, v);
		const result = renderReport(prop, comps, stats, priceRow, v, payload, offers);
		await env.LISTINGS_KV.put(VALUATION_RES_PREFIX + ref, JSON.stringify(result), {
			expirationTtl: VALUATION_TTL_SECONDS,
		});
		await logValuation(env, ref, prop, v, payload);
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

/* Το ιστορικό διαβάζει ΚΑΙ τις παλιότερες εκδόσεις του κλειδιού. Το
   REPORT_VERSION ανεβαίνει για να μη σταλεί ξανά παλιά ΜΟΡΦΗ σε νέο email,
   όχι για να σβήσει το αρχείο: το κείμενο που κασαρίστηκε με την έκδοση 3
   είναι ακριβώς αυτό που έλαβε ο πελάτης, και είναι το μόνο σωστό να δείξει
   ο σύνδεσμος «report». Χωρίς αυτό, κάθε bump άδειαζε το ιστορικό μονομιάς:
   στις 02/08/2026 η έκδοση πήγε 3 → 5 μέσα σε μια μέρα και όλοι οι
   σύνδεσμοι έλεγαν «δεν είναι πια διαθέσιμο».

   Τα gets τρέχουν παράλληλα και μόνο σε αυτό το μονοπάτι (ανάγνωση από το
   ιστορικό), ποτέ στη ροή της αποστολής. Το «valuation:res:» χωρίς νούμερο
   είναι η πρώτη έκδοση που υπήρξε ποτέ. */
async function readAnyVersion(env, ref) {
	const keys = [];
	for (let v = REPORT_VERSION - 1; v >= 2; v--) keys.push(`valuation:res${v}:${ref}`);
	keys.push(`valuation:res:${ref}`);
	const raws = await Promise.all(keys.map((k) => env.LISTINGS_KV.get(k)));
	const hit = raws.find(Boolean); // η σειρά είναι νεότερη → παλαιότερη
	if (!hit) return null;
	try {
		return JSON.parse(hit);
	} catch (err) {
		console.warn(`valuation: unreadable legacy report for ${ref}: ${String(err)}`);
		return null;
	}
}

/* Η απάντηση του «report» όταν το πλήρες κείμενο δεν υπάρχει πια: παλιά
   εκτίμηση (πάνω από έναν χρόνο) ή εκτίμηση που υπολογίστηκε με παλιότερο
   REPORT_VERSION. Σελίδα, όχι σκέτο 404, γιατί την ανοίγει άνθρωπος από το
   ιστορικό, και λέει πού είναι τα νούμερα. */
function expiredReport(ref, wantsHtml) {
	if (!wantsHtml) return json({ error: "expired_report", ref }, 404);
	const html = `<!doctype html><html lang="el"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Το report δεν είναι πια διαθέσιμο</title></head>
<body style="margin:0; padding:40px 16px; background:#f4f5f7; font-family:Arial,sans-serif;">
<div style="max-width:520px; margin:0 auto; background:#ffffff; border-radius:8px; padding:22px;">
	<div style="font-size:11px; font-weight:bold; letter-spacing:1.5px; color:${PINK};">ΕΚΤΙΜΗΣΗ</div>
	<div style="font-size:17px; font-weight:bold; color:${NAVY}; margin:4px 0 10px;">Το πλήρες report δεν είναι πια διαθέσιμο</div>
	<div style="font-size:13.5px; color:#374151; line-height:1.7;">Τα νούμερα της εκτίμησης (εύρος αξίας, €/τ.μ., μίσθωμα, βεβαιότητα) μένουν για πάντα στη γραμμή του ιστορικού. Το πλήρες κείμενο κρατιέται έναν χρόνο, και δεν ξαναϋπολογίζεται εδώ: μια νέα εκτίμηση σήμερα θα έδινε άλλα νούμερα από αυτά που στάλθηκαν τότε.</div>
	<div style="font-size:13.5px; margin-top:16px;"><a href="/api/valuation-log" style="color:${PINK};">Επιστροφή στο ιστορικό εκτιμήσεων</a></div>
</div>
</body></html>`;
	return new Response(html, {
		status: 404,
		headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" },
	});
}

/* ΠΡΩΤΟ ΠΕΡΑΣΜΑ — ένα δείγμα, ή τρία και η διάμεσος στη γη.
   Η διασπορά ΔΕΝ πετιέται: μπαίνει στο δεύτερο πέρασμα ως δεδομένο. Αν
   τρία ανεξάρτητα δείγματα με τα ΙΔΙΑ στοιχεία απέχουν 20%, αυτό είναι
   μέτρηση της αβεβαιότητας του ίδιου του μοντέλου, και ο ελεγκτής πρέπει
   να την περάσει στο εύρος και στη βεβαιότητα αντί να την αγνοήσει. */
async function firstPass(env, prop, dataBlock) {
	const ask = () => askJson(env, PASS1_SYSTEM, dataBlock + "\n\n" + PASS1_ASK, { search: true });
	if (!SAMPLED_PROFILES.has(prop.profile)) return { draft: await ask(), spread: "" };

	// Παράλληλα: ο σύμβουλος περιμένει τον ίδιο χρόνο με ένα δείγμα.
	// Ένα δείγμα που σκάει δεν ρίχνει την εκτίμηση — αρκεί ένα να ζήσει.
	const settled = await Promise.allSettled(Array.from({ length: PASS1_SAMPLES }, ask));
	const drafts = settled.filter((s) => s.status === "fulfilled").map((s) => s.value)
		.filter((d) => Number(d && d.value_mid) > 0);
	if (!drafts.length) {
		const firstErr = settled.find((s) => s.status === "rejected");
		throw firstErr ? firstErr.reason : new Error("first pass produced no usable draft");
	}
	drafts.sort((a, b) => Number(a.value_mid) - Number(b.value_mid));
	const draft = drafts[Math.floor(drafts.length / 2)];
	const lo = Number(drafts[0].value_mid);
	const hi = Number(drafts[drafts.length - 1].value_mid);
	const spreadPct = lo > 0 ? Math.round(((hi - lo) / lo) * 100) : 0;
	console.log(`valuation: ${drafts.length} δείγματα πρώτου περάσματος, διασπορά ${spreadPct}%, διάμεσος ${draft.value_mid}`);
	if (drafts.length < 2 || spreadPct < 8) return { draft, spread: "" };
	return {
		draft,
		spread: `\n\nΔΙΑΣΠΟΡΑ ΑΝΕΞΑΡΤΗΤΩΝ ΕΚΤΙΜΗΣΕΩΝ: το πρώτο πέρασμα έτρεξε ${drafts.length} φορές με ΤΑ ΙΔΙΑ ακριβώς δεδομένα και έδωσε ${drafts.map((d) => Math.round(d.value_mid)).join(", ")} (διαφορά ${spreadPct}%). Σου δίνεται η ΔΙΑΜΕΣΟΣ. Αυτή η διασπορά είναι μέτρηση της πραγματικής αβεβαιότητας για το συγκεκριμένο ακίνητο: φρόντισε το εύρος low-high να την καλύπτει και η βεβαιότητα να μην είναι υψηλή όταν ξεπερνά το 15%.`,
	};
}

/* ΝΤΕΤΕΡΜΙΝΙΣΤΙΚΟ ΦΡΕΝΟ ΓΙΑ ΤΗ ΓΗ.
   Η άγκυρα (€/τ.μ. δόμησης της περιοχής) υπάρχει ήδη στο prompt, αλλά ένα
   prompt είναι παράκληση. Εδώ ελέγχουμε σε κώδικα ότι το τελικό νούμερο
   κάθεται μέσα σε λογικό πολλαπλάσιο της άγκυρας. Δεν ΔΙΟΡΘΩΝΟΥΜΕ την
   τιμή — δεν ξέρουμε αν φταίει το μοντέλο ή ο πίνακας, και μια σιωπηλή
   διόρθωση θα έκρυβε και τα δύο. Κατεβάζουμε τη βεβαιότητα, το γράφουμε
   στο review_notes και βγάζει αίρεση: ο σύμβουλος πρέπει να το δει. */
const LAND_SANITY_LOW = 0.5;
const LAND_SANITY_HIGH = 2;

function landSanityCheck(prop, v) {
	if (!SAMPLED_PROFILES.has(prop.profile) || !v) return;
	const anchor = landPricePerBuildableSqm(prop.areaName);
	if (!anchor || !prop.size || !prop.buildFactor) return;
	const buildable = prop.size * prop.buildFactor;
	const perBuildable = Number(v.eur_per_buildable_sqm) > 0
		? Number(v.eur_per_buildable_sqm)
		: (Number(v.value_mid) > 0 ? Number(v.value_mid) / buildable : 0);
	if (!(perBuildable > 0)) return;

	const floor = anchor.low * LAND_SANITY_LOW;
	const ceil = anchor.high * LAND_SANITY_HIGH;
	if (perBuildable >= floor && perBuildable <= ceil) return;

	const where = perBuildable < floor ? "ΧΑΜΗΛΟΤΕΡΑ" : "ΨΗΛΟΤΕΡΑ";
	const note = `Αυτόματος έλεγχος: η εκτίμηση αντιστοιχεί σε ${Math.round(perBuildable)} €/τ.μ. δόμησης, πολύ ${where} από το εύρος της περιοχής (${anchor.low}-${anchor.high}). Είτε το ακίνητο έχει κάτι που δεν αποτυπώθηκε, είτε ο πίνακας τιμών γης χρειάζεται επικαιροποίηση — θέλει ανθρώπινο μάτι πριν σταλεί.`;
	console.warn(`valuation: land sanity check failed (${Math.round(perBuildable)} vs ${anchor.low}-${anchor.high} €/τ.μ. δόμησης)`);
	v.confidence = "χαμηλή";
	v.review_notes = [v.review_notes, note].filter(Boolean).join(" ");
	v.caveats = [...(Array.isArray(v.caveats) ? v.caveats : []), note];
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
		if (b64) await env.LISTINGS_KV.put(key, b64, { expirationTtl: VALUATION_PDF_TTL_SECONDS });
	}
	if (!b64) return result;
	return {
		...result,
		pdf_base64: b64,
		pdf_filename: valuationPdfName(result.prop),
	};
}

/* Το όνομα του συνημμένου. Χωρίς κωδικό CRM (εκτίμηση με το χέρι) το
   παλιό «ektimisi-akinito.pdf» ήταν ίδιο για κάθε πελάτη: η γραμματεία
   κατέβαζε δύο εκτιμήσεις στον ίδιο φάκελο και η δεύτερη γινόταν
   «ektimisi-akinito (1).pdf». Ίδια λογική με τα υπόλοιπα έντυπα
   (anathesi_Papadopoulos_2026-07-31.pdf): ΤΙ ακίνητο, ΠΟΤΕ. Το
   «anafora» ξεχωρίζει την πλήρη αναφορά του γραφείου από το έγγραφο
   του ιδιοκτήτη (four-walls_ektimisi_…, φτιάχνεται στη φόρμα), γιατί
   το γραφείο λαμβάνει και τα δύο: το email στον ιδιοκτήτη έχει bcc. */
function valuationPdfName(prop) {
	const p = prop || {};
	const who = fileSlug([
		p.listingCode ? `kod${p.listingCode}` : "",
		p.address || "",
		p.areaName || "",
	]);
	return `ektimisi_anafora_${who || "akinito"}_${athensDate()}.pdf`;
}

/* Ημερομηνία Ελλάδας, όχι UTC: μια εκτίμηση στις 11 το βράδυ δεν
   πρέπει να αρχειοθετηθεί με τη χθεσινή ημερομηνία. Με δίχτυ: ένα
   όνομα αρχείου δεν επιτρέπεται να ρίξει μια εκτίμηση που πληρώθηκε. */
function athensDate() {
	try {
		return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Athens" });
	} catch (err) {
		return new Date().toISOString().slice(0, 10);
	}
}

const GREEKLISH = {
	α: "a", ά: "a", β: "v", γ: "g", δ: "d", ε: "e", έ: "e", ζ: "z", η: "i",
	ή: "i", θ: "th", ι: "i", ί: "i", ϊ: "i", ΐ: "i", κ: "k", λ: "l", μ: "m",
	ν: "n", ξ: "x", ο: "o", ό: "o", π: "p", ρ: "r", σ: "s", ς: "s", τ: "t",
	υ: "y", ύ: "y", ϋ: "y", ΰ: "y", φ: "f", χ: "ch", ψ: "ps", ω: "o", ώ: "o",
};

/* Greeklish + μόνο [A-Za-z0-9_]: ελληνικοί χαρακτήρες σε όνομα
   συνημμένου ταξιδεύουν σε mail clients και Windows shares άσχημα. */
function fileSlug(parts, max = 44) {
	return parts
		.filter(Boolean)
		.join(" ")
		.split("")
		.map((c) => {
			const low = c.toLowerCase();
			const t = GREEKLISH[low];
			if (t == null) return c;
			return c === low ? t : t.charAt(0).toUpperCase() + t.slice(1);
		})
		.join("")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.slice(0, max)
		.replace(/^_+|_+$/g, "");
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
/* Μόνιμο ιστορικό εκτιμήσεων                                          */
/* ------------------------------------------------------------------ */

/* Το report στο KV λήγει σε έναν χρόνο, και email υπάρχει μόνο αν πατήθηκε
   «Αποστολή στο info@» — χωρίς αυτό εδώ, σε λίγους μήνες κανείς δεν
   ξέρει τι εκτιμήσαμε και πόσο. Μία συμπυκνωμένη γραμμή ανά εκτίμηση,
   σε ένα key ανά μήνα, χωρίς TTL: αρκεί για το «τι εκτιμήσαμε το Χ;»
   και, αργότερα, για βαθμονόμηση απέναντι σε πραγματικές τιμές εντολής
   και κλεισίματος. Το price_table λέει ΠΟΙΟΣ πίνακας περιοχών ίσχυε.

   Αποτυχία εδώ ΔΕΝ ρίχνει την εκτίμηση (try/catch): το ιστορικό είναι
   δευτερεύον. Το read-modify-write δεν έχει κλείδωμα — δύο ταυτόχρονες
   εκτιμήσεις μπορεί να χάσουν τη μία γραμμή· στους δικούς μας όγκους
   (λίγες τον μήνα) το δεχόμαστε, το χειρότερο είναι μία γραμμή
   λιγότερη, ποτέ χαλασμένο JSON. */
async function logValuation(env, ref, prop, v, payload) {
	try {
		const key = VALUATION_LOG_PREFIX + new Date().toISOString().slice(0, 7);
		const entries = JSON.parse((await env.LISTINGS_KV.get(key)) || "[]");
		if (entries.some((e) => e.ref === ref)) return;
		entries.push({
			ts: new Date().toISOString(),
			ref,
			by: String(payload.submitted_by || ""),
			code: prop.listingCode || "",
			// Το id της καρτέλας του CRM, για τον σύνδεσμο του ιστορικού. Ο
			// κωδικός δεν αρκεί: η καρτέλα ανοίγει με id, και το feed (που
			// τα αντιστοιχεί) κρατά μόνο τα ενεργά.
			id: prop.listingId || "",
			category: prop.category,
			kind: prop.subcategory || "",
			// Ποιο προφίλ και ποια μέθοδος: όταν μαζευτούν πραγματικές τιμές
			// εντολής/κλεισίματος, η βαθμονόμηση θα γίνει ΑΝΑ ΕΙΔΟΣ — ένα
			// συνολικό σφάλμα πάνω σε διαμερίσματα και οικόπεδα μαζί δεν λέει τίποτα.
			profile: prop.profile || "",
			method: v.method || "",
			area: prop.areaName || "",
			address: prop.address || "",
			sqm: prop.size,
			purpose: prop.purpose,
			asking: prop.askingPrice,
			eur_per_sqm: v.eur_per_sqm,
			value_low: v.value_low,
			value_mid: v.value_mid,
			value_high: v.value_high,
			rent_mid: v.rent_mid,
			yield_pct: v.gross_yield_pct,
			confidence: normConfidence(v.confidence),
			renovation_gain: v.renovation ? (v.renovation.net_gain ?? null) : null,
			price_table: AREA_PRICES_META.asOf,
		});
		await env.LISTINGS_KV.put(key, JSON.stringify(entries));
	} catch (err) {
		console.warn(`valuation: history append failed for ${ref}: ${String(err)}`);
	}
}

/* GET /api/valuation-log[?month=YYYY-MM][&format=json] — το ιστορικό σε
   πίνακα, ένας μήνας τη φορά. Δρομολογείται ΜΟΝΟ στο forms hostname
   πίσω από το Cloudflare Access (worker/index.mjs): κάθε γραμμή είναι
   διεύθυνση και νούμερα πελάτη. */
export async function handleValuationLog(request, env, url) {
	if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
	const current = new Date().toISOString().slice(0, 7);
	const month = String(url.searchParams.get("month") || current);
	if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: "bad_month" }, 400);

	let entries = [];
	try {
		entries = JSON.parse((await env.LISTINGS_KV.get(VALUATION_LOG_PREFIX + month)) || "[]");
	} catch { /* χαλασμένο key: δείξε άδειο μήνα, όχι 500 */ }
	entries.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

	if (url.searchParams.get("format") === "json") {
		return json({ month, count: entries.length, entries }, 200);
	}

	// Ποιοι μήνες έχουν ιστορικό: ένα key ανά μήνα, το list αρκεί.
	let months = [];
	try {
		months = (await env.LISTINGS_KV.list({ prefix: VALUATION_LOG_PREFIX }))
			.keys.map((k) => k.name.slice(VALUATION_LOG_PREFIX.length));
	} catch { /* χωρίς δείκτη μηνών η σελίδα παραμένει χρήσιμη */ }
	if (!months.includes(month)) months.push(month);
	months.sort().reverse();

	/* Το feed δίνει τους δύο συνδέσμους κάθε γραμμής. Το CRM id, γιατί οι
	   γραμμές πριν τις 02/08/2026 κρατούσαν μόνο κωδικό και η καρτέλα
	   ανοίγει με id. Και το «είναι ακόμα δικό μας»: το feed έχει μόνο τα
	   ενεργά, άρα ό,τι βρίσκεται εκεί έχει σελίδα στο site. Ένα ακίνητο
	   που πουλήθηκε ή αποσύρθηκε θα έδινε 404. Αποτυχία εδώ δεν ρίχνει τη
	   σελίδα, απλώς μένουν λιγότεροι σύνδεσμοι. */
	const byCode = new Map();
	try {
		const rawFeed = await env.LISTINGS_KV.get(FEED_KEY);
		for (const l of (rawFeed ? JSON.parse(rawFeed).listings || [] : [])) {
			if (l && l.code) byCode.set(String(l.code), l);
		}
	} catch (err) {
		console.warn(`valuation-log: feed unavailable, links reduced: ${String(err)}`);
	}
	const crmBase = `https://${env.ESTATEPRIME_SUBDOMAIN || "fourwalls"}.estateprime.gr`;

	const monthLabel = (m) => {
		const [y, mo] = m.split("-");
		const names = ["Ιανουάριος", "Φεβρουάριος", "Μάρτιος", "Απρίλιος", "Μάιος", "Ιούνιος",
			"Ιούλιος", "Αύγουστος", "Σεπτέμβριος", "Οκτώβριος", "Νοέμβριος", "Δεκέμβριος"];
		return `${names[Number(mo) - 1] || mo} ${y}`;
	};
	const nav = months.map((m) => m === month
		? `<span style="font-weight:bold; color:${NAVY};">${esc(monthLabel(m))}</span>`
		: `<a href="/api/valuation-log?month=${esc(m)}" style="color:${PINK};">${esc(monthLabel(m))}</a>`
	).join(" · ");

	const rows = entries.map((e) => {
		// Και ώρα, όχι μόνο ημέρα: δύο εκτιμήσεις του ίδιου ακινήτου την
		// ίδια μέρα (π.χ. πριν και μετά από διόρθωση στοιχείων) αλλιώς
		// ξεχωρίζουν μόνο από τη σειρά τους. Ώρα Ελλάδας, το ts είναι UTC.
		const at = e.ts ? new Date(e.ts) : null;
		const when = at ? at.toLocaleDateString("el-GR", { timeZone: "Europe/Athens" }) : "";
		const time = at
			// hour12:false ρητά, γιατί το el-GR default βγάζει «09:45 μ.μ.».
			? at.toLocaleTimeString("el-GR", { timeZone: "Europe/Athens", hour: "2-digit", minute: "2-digit", hour12: false })
			: "";
		// labelKind και εδώ: οι εγγραφές πριν τη διόρθωση κρατούν slug.
		const what = [labelKind(e.kind, e.category) || labelCategory(e.category), e.code ? `κωδ. ${e.code}` : "", e.area, e.address]
			.filter(Boolean).join(" · ");
		const live = e.code ? byCode.get(String(e.code)) : null;
		const crmId = e.id || (live ? live.id : "");
		const link = (href, label) => `<a href="${esc(href)}" target="_blank" rel="noopener" style="color:${PINK}; text-decoration:none;">${label}</a>`;
		const links = [
			link(`/api/valuation?ref=${encodeURIComponent(e.ref)}&format=html&cached=1`, "report"),
			crmId ? link(`${crmBase}/listings/view/${encodeURIComponent(crmId)}`, "CRM") : "",
			live ? link(canonicalUrl(live), "σελίδα") : "",
		].filter(Boolean).join(`<span style="color:#d5d9e0;"> · </span>`);
		const sale = e.value_mid
			? `<strong>${eur(e.value_mid)}</strong> <span style="color:#6b7280;">(${eur(e.value_low)} έως ${eur(e.value_high)})</span>`
			: "";
		return `<tr>
			<td style="padding:7px 10px; border-bottom:1px solid #eceef2; font-size:12px; white-space:nowrap;">${esc(when)}<div style="font-size:11px; color:#9aa3af;">${esc(time)}</div></td>
			<td style="padding:7px 10px; border-bottom:1px solid #eceef2; font-size:12px; color:${NAVY};">${esc(what)}</td>
			<td style="padding:7px 10px; border-bottom:1px solid #eceef2; font-size:12px; text-align:right;">${e.sqm ? esc(String(e.sqm)) + " τ.μ." : ""}</td>
			<td style="padding:7px 10px; border-bottom:1px solid #eceef2; font-size:12px; white-space:nowrap;">${sale}</td>
			<td style="padding:7px 10px; border-bottom:1px solid #eceef2; font-size:12px; text-align:right; color:#6b7280;">${e.eur_per_sqm ? eur(e.eur_per_sqm) + "/τ.μ." : ""}</td>
			<td style="padding:7px 10px; border-bottom:1px solid #eceef2; font-size:12px; white-space:nowrap;">${e.rent_mid ? eur(e.rent_mid) + "/μήνα" : ""}</td>
			<td style="padding:7px 10px; border-bottom:1px solid #eceef2; font-size:12px;">${e.confidence ? confChip(e.confidence) : ""}</td>
			<td style="padding:7px 10px; border-bottom:1px solid #eceef2; font-size:12px; color:#6b7280;">${esc(e.by || "")}</td>
			<td style="padding:7px 10px; border-bottom:1px solid #eceef2; font-size:12px; white-space:nowrap;">${links}</td>
		</tr>`;
	}).join("");

	/* Το λογότυπο γυρίζει στα Έντυπα: η σελίδα ανοίγει από τη φόρμα της
	   εκτίμησης και ο μόνος δρόμος πίσω ήταν το back του browser. Στο
	   forms.* η PWA ΕΙΝΑΙ η ρίζα (rewrite στο worker/index.mjs), ενώ στο
	   localhost του `wrangler dev` κάθεται στο /forms/. */
	const formsHome = url.hostname.startsWith("forms.") ? "/" : "/forms/";

	const html = `<!doctype html><html lang="el"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Ιστορικό εκτιμήσεων · ${esc(month)}</title></head>
<body style="margin:0; padding:24px 12px; background:#f4f5f7; font-family:Arial,sans-serif;">
<div style="max-width:1000px; margin:0 auto; background:#ffffff; border-radius:8px; overflow:hidden;">
	<div style="background:${NAVY}; padding:15px 20px;"><a href="${formsHome}" title="Έντυπα Four Walls" style="text-decoration:none;"><span style="color:#ffffff; font-size:18px; font-weight:bold; letter-spacing:1.5px;">FOUR WALLS</span><span style="color:${PINK}; font-size:10px; font-weight:bold; letter-spacing:2px;">&nbsp;&nbsp;REAL ESTATE</span></a></div>
	<div style="height:3px; background:${PINK};"></div>
	<div style="padding:20px;">
		<div style="font-size:11px; font-weight:bold; letter-spacing:1.5px; color:${PINK};">ΙΣΤΟΡΙΚΟ ΕΚΤΙΜΗΣΕΩΝ</div>
		<div style="font-size:17px; font-weight:bold; color:${NAVY}; margin:4px 0 10px;">${esc(monthLabel(month))} · ${entries.length} ${entries.length === 1 ? "εκτίμηση" : "εκτιμήσεις"}</div>
		<div style="font-size:12.5px; color:#6b7280; margin-bottom:14px;">${nav}</div>
		${entries.length ? `<div style="overflow-x:auto;"><table cellpadding="0" cellspacing="0" style="width:100%; border-collapse:collapse; border:1px solid #eceef2; border-radius:6px;">
			<tr>
				<td style="padding:7px 10px; font-size:11px; font-weight:bold; color:#6b7280;">ΗΜ/ΝΙΑ</td>
				<td style="padding:7px 10px; font-size:11px; font-weight:bold; color:#6b7280;">ΑΚΙΝΗΤΟ</td>
				<td style="padding:7px 10px; font-size:11px; font-weight:bold; color:#6b7280; text-align:right;">ΕΜΒΑΔΟΝ</td>
				<td style="padding:7px 10px; font-size:11px; font-weight:bold; color:#6b7280;">ΑΞΙΑ ΠΩΛΗΣΗΣ</td>
				<td style="padding:7px 10px; font-size:11px; font-weight:bold; color:#6b7280; text-align:right;">ΑΝΑ τ.μ.</td>
				<td style="padding:7px 10px; font-size:11px; font-weight:bold; color:#6b7280;">ΜΙΣΘΩΜΑ</td>
				<td style="padding:7px 10px; font-size:11px; font-weight:bold; color:#6b7280;">ΒΕΒΑΙΟΤΗΤΑ</td>
				<td style="padding:7px 10px; font-size:11px; font-weight:bold; color:#6b7280;">ΑΠΟ</td>
				<td style="padding:7px 10px; font-size:11px; font-weight:bold; color:#6b7280;"></td>
			</tr>
			${rows}
		</table></div>` : `<div style="background:#f4f7fb; border:1px solid #c9d4e4; border-radius:8px; padding:12px 16px; font-size:13px; color:${NAVY};">Καμία εκτίμηση αυτόν τον μήνα.</div>`}
		<div style="font-size:11px; color:#9aa3af; margin-top:14px; line-height:1.6;">Το «report» ανοίγει το πλήρες κείμενο όπως στάλθηκε τότε (κρατιέται έναν χρόνο, δεν ξαναϋπολογίζεται)· οι γραμμές του ιστορικού μένουν για πάντα. Το «CRM» ανοίγει την καρτέλα του ακινήτου, η «σελίδα» τη δημόσια σελίδα του, μόνο για ακίνητα που είναι αυτή τη στιγμή στο στοκ μας. Πρόσβαση με JSON: <code>/api/valuation-log?month=${esc(month)}&amp;format=json</code>.</div>
	</div>
</div>
</body></html>`;
	return new Response(html, {
		headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" },
	});
}

/* ------------------------------------------------------------------ */
/* Δεδομένα: συγχώνευση φόρμας + feed, συγκριτικά, στατιστικά περιοχής  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Προφίλ ανά είδος ακινήτου                                           */
/* ------------------------------------------------------------------ */

/* Ένα διαμέρισμα, ένα οικόπεδο και μια αποθήκη ΔΕΝ εκτιμώνται με τα ίδια
   στοιχεία ούτε με την ίδια μέθοδο. Το προφίλ ορίζει και τα δύο: ποια
   πεδία φτάνουν στο μοντέλο (PROFILE_FIELDS) και ποια μέθοδο ακολουθεί
   (METHOD_BRIEF). Το ίδιο λεξιλόγιο υπάρχει στη φόρμα (PROFILE στο
   forms/ektimisi.html) — αν αλλάξει το ένα, αλλάζει και το άλλο.
   Δέχεται και τις ελληνικές ετικέτες της φόρμας και τα slugs του CRM,
   γιατί μια εκτίμηση μπορεί να ξεκινήσει και από τα δύο. */
const PROFILE_OF = {
	"Διαμέρισμα": "apartment", "Studio / Γκαρσονιέρα": "apartment",
	"Μεζονέτα": "house", "Μονοκατοικία": "house",
	"Βίλα / Εξοχική κατοικία": "villa",
	"Πολυκατοικία / Κτίριο": "building",
	"Γραφείο": "office", "Κατάστημα": "retail",
	"Αποθήκη": "industrial", "Βιοτεχνικός / Βιομηχανικός χώρος": "industrial",
	"Θέση στάθμευσης": "parking",
	"Οικόπεδο": "plot", "Αγροτεμάχιο": "parcel",
	apartment: "apartment", studio: "apartment", loft: "apartment",
	maisonette: "house", detached: "house", house: "house", farmhouse: "house",
	villa: "villa",
	residential_building: "building", apartment_complex: "building",
	commercial_building: "building",
	office: "office", store: "retail", shop: "retail", hall: "retail",
	warehouse: "industrial", industrial_space: "industrial", craft_space: "industrial",
	parking: "parking",
	plot: "plot", land: "plot", field: "parcel", parcel: "parcel",
};

const PROFILE_BY_CATEGORY = { residential: "apartment", commercial: "office", land: "plot" };

function profileOf(kind, category) {
	const raw = String(kind || "").trim();
	return PROFILE_OF[raw] || PROFILE_OF[raw.toLowerCase()]
		|| PROFILE_BY_CATEGORY[category] || "apartment";
}

/* Ποια πεδία αφορούν ποιο είδος. Δεν είναι καλλωπισμός του report: ένα
   «ασανσέρ: —» ή μια «ενεργειακή κλάση» πάνω από ένα οικόπεδο είναι
   θόρυβος που το μοντέλο προσπαθεί να ερμηνεύσει, και το feed μπορεί να
   τα φέρει ακόμη κι όταν η φόρμα δεν τα έστειλε. Τα νομικά (LEGAL_FIELDS)
   μπαίνουν πάντα, σε κάθε είδος. */
const PROFILE_FIELDS = {
	apartment: "floor bedrooms bathrooms yearBuilt yearRenovated energyClass condition heating elevator parking storage balconies orientation view pool seaDistanceM metroDistanceM monthlyMaintenance",
	house: "bedrooms bathrooms levels yearBuilt yearRenovated energyClass condition heating parking storage balconies orientation view basementSqm gardenSqm pool seaDistanceM metroDistanceM corner plotSqm plotStatus buildFactor remainingBuildSqm frontageM ownershipForm constraints",
	building: "bathrooms levels units yearBuilt yearRenovated energyClass condition heating elevator parkingSpots view basementSqm pool metroDistanceM corner plotSqm plotStatus buildFactor coveragePct remainingBuildSqm monthlyMaintenance",
	office: "floor bathrooms yearBuilt yearRenovated energyClass condition heating elevator parkingSpots metroDistanceM buildingGrade layout monthlyMaintenance",
	retail: "floor bathrooms yearBuilt yearRenovated energyClass condition heating elevator parkingSpots basementSqm metroDistanceM shopFrontM depthM patariSqm ceilingHeightM commerciality foodUse corner monthlyMaintenance",
	industrial: "bathrooms yearBuilt yearRenovated condition parkingSpots basementSqm ceilingHeightM clearHeightM officeSqm loadingDock truckAccess threePhase crane highwayKm corner plotSqm plotStatus buildFactor frontageM roadType landUse",
	parking: "floor yearBuilt condition spotType accessEase",
	plot: "seaDistanceM metroDistanceM corner plotStatus buildable buildFactor coveragePct remainingBuildSqm frontageM roadType shape slope landUse existingBuildSqm constraints utilities",
	parcel: "seaDistanceM corner plotStatus buildable buildFactor coveragePct frontageM roadType shape slope landUse existingBuildSqm irrigation crop constraints utilities",
};
PROFILE_FIELDS.villa = PROFILE_FIELDS.house;

/* Η βραχυχρόνια αφορά μόνο ό,τι νοικιάζεται σε επισκέπτες. */
const STR_PROFILES = new Set(["apartment", "house", "villa", "building"]);

/* Πού δεν ανακαινίζεται τίποτα: ούτε πίνακας κόστους στο prompt, ούτε
   σκέλος «ΜΕ ΑΝΑΚΑΙΝΙΣΗ» στο report. */
const NO_RENOVATION = new Set(["plot", "parcel", "parking"]);

const LEGAL_FIELDS = "legality buildingId titles rights usufructAge burdens tenancy currentRent leaseEnd owners";

/* Ένα λεξικό, τρεις χρήσεις: το ελληνικό κλειδί που βλέπει το μοντέλο, η
   ετικέτα του πίνακα «τα στοιχεία που δόθηκαν», και η μονάδα. */
const FIELD_META = {
	floor: ["όροφος", "Όροφος"],
	bedrooms: ["υπνοδωμάτια", "Υπνοδωμάτια"],
	bathrooms: ["μπάνια_wc", "Μπάνια / WC"],
	levels: ["επίπεδα_κτίσματος", "Επίπεδα"],
	units: ["αυτοτελείς_μονάδες", "Αυτοτελείς μονάδες"],
	yearBuilt: ["έτος_κατασκευής", "Έτος κατασκευής"],
	yearRenovated: ["έτος_ανακαίνισης", "Έτος ανακαίνισης"],
	energyClass: ["ενεργειακή_κλάση", "Ενεργειακή"],
	condition: ["κατάσταση", "Κατάσταση"],
	heating: ["θέρμανση", "Θέρμανση"],
	elevator: ["ασανσέρ", "Ασανσέρ"],
	parking: ["πάρκινγκ", "Πάρκινγκ"],
	parkingSpots: ["θέσεις_στάθμευσης", "Θέσεις στάθμευσης"],
	storage: ["αποθήκη", "Αποθήκη"],
	balconies: ["μπαλκόνια_τμ", "Μπαλκόνια", " τ.μ."],
	orientation: ["προσανατολισμός", "Προσανατολισμός"],
	view: ["θέα", "Θέα"],
	basementSqm: ["υπόγειο_τμ", "Υπόγειο", " τ.μ."],
	gardenSqm: ["κήπος_τμ", "Κήπος / αυλή", " τ.μ."],
	pool: ["πισίνα", "Πισίνα"],
	seaDistanceM: ["απόσταση_θάλασσας_μ", "Απόσταση από θάλασσα", " μ."],
	metroDistanceM: ["απόσταση_στάσης_μετρό_μ", "Απόσταση από μετρό", " μ."],
	monthlyMaintenance: ["κοινόχρηστα_μήνα", "Κοινόχρηστα", " €/μήνα"],
	corner: ["γωνιακό", "Γωνιακό"],
	// κατάστημα
	shopFrontM: ["μέτρα_βιτρίνας", "Μέτρα βιτρίνας", " μ."],
	depthM: ["βάθος_μ", "Βάθος", " μ."],
	patariSqm: ["πατάρι_τμ", "Πατάρι", " τ.μ."],
	ceilingHeightM: ["ύψος_χώρου_μ", "Ύψος χώρου", " μ."],
	commerciality: ["εμπορικότητα_δρόμου", "Εμπορικότητα δρόμου"],
	foodUse: ["υγειονομικού_ενδιαφέροντος", "Υγειονομικού ενδιαφέροντος"],
	// γραφείο
	buildingGrade: ["κατηγορία_κτιρίου", "Κατηγορία κτιρίου"],
	layout: ["διαρρύθμιση", "Διαρρύθμιση"],
	// αποθήκη / βιοτεχνικό
	clearHeightM: ["ελεύθερο_ύψος_μ", "Ελεύθερο ύψος", " μ."],
	officeSqm: ["γραφεία_εντός_τμ", "Γραφεία εντός", " τ.μ."],
	loadingDock: ["ράμπα_φορτοεκφόρτωσης", "Ράμπα"],
	truckAccess: ["πρόσβαση_νταλίκας", "Πρόσβαση νταλίκας"],
	threePhase: ["τριφασικό_ρεύμα", "Τριφασικό"],
	crane: ["γερανογέφυρα", "Γερανογέφυρα"],
	highwayKm: ["απόσταση_εθνικής_χλμ", "Απόσταση από εθνική", " χλμ."],
	// θέση στάθμευσης
	spotType: ["τύπος_θέσης", "Τύπος θέσης"],
	accessEase: ["ευκολία_πρόσβασης", "Ευκολία πρόσβασης"],
	// γη
	plotSqm: ["οικόπεδο_τμ", "Οικόπεδο", " τ.μ."],
	plotStatus: ["πολεοδομικό_καθεστώς", "Πολεοδομικό καθεστώς"],
	buildable: ["άρτιο_και_οικοδομήσιμο", "Άρτιο & οικοδομήσιμο"],
	buildFactor: ["συντελεστής_δόμησης", "Συντελεστής δόμησης"],
	coveragePct: ["κάλυψη_ποσοστό", "Κάλυψη", "%"],
	remainingBuildSqm: ["υπόλοιπο_δόμησης_τμ", "Υπόλοιπο δόμησης", " τ.μ."],
	frontageM: ["πρόσωπο_σε_δρόμο_μ", "Πρόσωπο σε δρόμο", " μ."],
	roadType: ["είδος_δρόμου", "Είδος δρόμου"],
	shape: ["σχήμα", "Σχήμα"],
	slope: ["κλίση", "Κλίση"],
	landUse: ["χρήσεις_γης", "Χρήσεις γης"],
	existingBuildSqm: ["υπάρχον_κτίσμα_τμ", "Υπάρχον κτίσμα", " τ.μ."],
	irrigation: ["άρδευση", "Άρδευση"],
	crop: ["καλλιέργεια", "Καλλιέργεια"],
	ownershipForm: ["μορφή_ιδιοκτησίας", "Μορφή ιδιοκτησίας"],
	constraints: ["δεσμεύσεις", "Δεσμεύσεις"],
	utilities: ["δίκτυα", "Δίκτυα"],
	// νομικά
	legality: ["πολεοδομική_νομιμότητα", "Πολεοδομική νομιμότητα"],
	buildingId: ["ηλεκτρονική_ταυτότητα_κτιρίου", "Ταυτότητα κτιρίου"],
	titles: ["τίτλοι_κτηματολόγιο", "Τίτλοι / Κτηματολόγιο"],
	rights: ["δικαίωμα_προς_πώληση", "Δικαίωμα"],
	usufructAge: ["ηλικία_επικαρπωτή", "Ηλικία επικαρπωτή"],
	burdens: ["βάρη", "Βάρη"],
	tenancy: ["κατοχή", "Κατοχή"],
	currentRent: ["τρέχον_μίσθωμα_μήνα", "Τρέχον μίσθωμα", " €/μήνα"],
	leaseEnd: ["λήξη_μίσθωσης", "Λήξη μίσθωσης"],
	owners: ["ιδιοκτησία", "Ιδιοκτησία"],
	strStatus: ["βραχυχρόνια_μίσθωση", "Βραχυχρόνια μίσθωση"],
};

/* Τι σημαίνει «εμβαδόν» για το κάθε είδος. Σε κατάστημα είναι ΤΟΥ
   ΙΣΟΓΕΙΟΥ: πατάρι και υπόγειο έρχονται χωριστά επίτηδες, γιατί δεν
   αξίζουν όσο το ισόγειο και ανάγονται. */
const SIZE_KEY = {
	plot: "εμβαδόν_γης_τμ", parcel: "εμβαδόν_γης_τμ",
	retail: "εμβαδόν_ισογείου_τμ", building: "συνολικό_εμβαδόν_κτιρίου_τμ",
	industrial: "εμβαδόν_κτίσματος_τμ", parking: "εμβαδόν_θέσης_τμ",
};

const SIZE_LABEL = {
	plot: "Εμβαδόν οικοπέδου", parcel: "Εμβαδόν αγροτεμαχίου",
	retail: "Εμβαδόν ισογείου", building: "Συνολικό εμβαδόν",
	industrial: "Εμβαδόν κτίσματος", parking: "Εμβαδόν θέσης",
};

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
	// Checkboxes του CRM: το άδειο σημαίνει «Όχι», όχι «άγνωστο». Ισχύει
	// μόνο όταν το ακίνητο ήρθε από το feed — σε χειροκίνητη φόρμα το κενό
	// παραμένει πραγματικά άγνωστο.
	const feats = Array.isArray(f.features) ? f.features : null;
	const featYesNo = (test) => (feats ? (feats.some(test) ? "Ναι" : "Όχι") : "");
	const category = pick(d.category, f.category) || "residential";
	const purpose = String(d.purpose || "both"); // sale | rent | both
	/* Η τιμή του feed είναι η ζητούμενη ΤΗΣ ΑΓΓΕΛΙΑΣ: σε ακίνητο πώλησης
	   τίμημα, σε ακίνητο ενοικίασης μίσθωμα. Όταν η εκτίμηση ζητά το άλλο
	   σκέλος, η τιμή αυτή δεν είναι «ζητούμενη» για ό,τι εκτιμάμε — κενό
	   είναι καλύτερο από ένα «σε σχέση με τη ζητούμενη €180.000» κάτω από
	   μίσθωμα €920/μήνα. Ό,τι έγραψε ο σύμβουλος υπερισχύει, όπως πάντα. */
	const feedIsRent = f.transaction === "rent";
	const feedAsking = (purpose === "rent" && !feedIsRent) || (purpose === "sale" && feedIsRent) ? "" : f.price;
	const rawKind = pick(d.subcategory, f.subcategory);
	const profile = String(d.profile || "").trim() || profileOf(rawKind, category);
	/* Δεκαδικά όπως ο ΣΔ («0,8») ή τα μέτρα βιτρίνας («5,5»): το num()
	   πετάει τις τελείες ως διαχωριστικά χιλιάδων, οπότε θα διάβαζε το
	   «1.5» ως 15. Αυτά έρχονται αυτούσια από τη φόρμα. */
	const dec = (v) => {
		const n = Number(String(v == null ? "" : v).trim().replace(",", "."));
		return Number.isFinite(n) && n > 0 ? n : null;
	};
	const str = (v) => String(v == null ? "" : v).trim() || "";
	return {
		profile,
		listingCode: pick(d.listing_code, f.code),
		listingId: fromFeed ? String(fromFeed.id) : null, // για το GET /offers
		fromCrm: !!fromFeed,
		purpose,
		category,
		subcategory: labelKind(pick(d.subcategory, f.subcategory), category),
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
		elevator: pick(d.elevator, featYesNo((s) => s === "has_elevator")),
		parking: pick(d.parking, f.parking != null ? (f.parking > 0 ? "Ναι" : "Όχι") : ""),
		storage: pick(d.storage, featYesNo((s) => s === "has_storage_room" || s === "has_storage")),
		view: pick(d.view, (f.view || []).join(", ")),
		orientation: String(d.orientation || "").trim(),
		// Οδηγοί αξίας εξοχικών (Χαλκιδική/Πιερία): χωρίς αυτά το μοντέλο
		// αγκυρώνει στο «τυπικό διαμέρισμα» του πίνακα και βγαίνει χαμηλό.
		seaDistanceM: num(d.sea_distance_m),
		plotSqm: num(d.plot_sqm),
		// Πισίνα με slug δεν ξέρουμε αν είναι κοινόχρηστη/ιδιωτική — «Ναι»
		// σκέτο· χωρίς slug σε ακίνητο του CRM, βέβαιο «Όχι».
		pool: pick(d.pool, featYesNo((s) => /pool/i.test(s))),
		balconies: String(d.balconies || "").trim(),
		// Μετρημένος οδηγός αξίας στη Θεσσαλονίκη, όχι εντύπωση — βλ. METRO_RULE.
		metroDistanceM: num(d.metro_distance_m),
		// Κατοικία με οικόπεδο και κτίριο
		levels: num(d.levels),
		units: num(d.units),
		basementSqm: num(d.basement_sqm),
		gardenSqm: num(d.garden_sqm),
		ownershipForm: str(d.ownership_form),
		// Γη: εδώ κρίνεται η εκτίμηση οικοπέδου/αγροτεμαχίου
		plotStatus: str(d.plot_status),
		buildable: str(d.buildable),
		buildFactor: dec(d.build_factor),
		coveragePct: num(d.coverage_pct),
		remainingBuildSqm: num(d.remaining_build_sqm),
		frontageM: dec(d.frontage_m),
		roadType: str(d.road_type),
		corner: str(d.corner),
		shape: str(d.shape),
		slope: str(d.slope),
		landUse: str(d.land_use),
		existingBuildSqm: num(d.existing_build_sqm),
		irrigation: str(d.irrigation),
		crop: str(d.crop),
		constraints: str(d.constraints),
		utilities: str(d.utilities),
		// Κατάστημα: το ισόγειο, το πατάρι και το υπόγειο ΔΕΝ είναι το ίδιο τ.μ.
		shopFrontM: dec(d.shop_front_m),
		depthM: dec(d.depth_m),
		patariSqm: num(d.patari_sqm),
		ceilingHeightM: dec(d.ceiling_height_m),
		commerciality: str(d.commerciality),
		foodUse: str(d.food_use),
		// Γραφείο
		buildingGrade: str(d.building_grade),
		layout: str(d.layout),
		parkingSpots: num(pick(d.parking_spots, f.parking)),
		// Αποθήκη / βιοτεχνικός χώρος
		clearHeightM: dec(d.clear_height_m),
		officeSqm: num(d.office_sqm),
		loadingDock: str(d.loading_dock),
		truckAccess: str(d.truck_access),
		threePhase: str(d.three_phase),
		crane: str(d.crane),
		highwayKm: dec(d.highway_km),
		// Θέση στάθμευσης
		spotType: str(d.spot_type),
		accessEase: str(d.access_ease),
		// Νομικά / πολεοδομικά — αλλάζουν την εκτίμηση περισσότερο από
		// κάθε φυσικό χαρακτηριστικό, βλ. LEGAL_RULES.
		legality: str(d.legality),
		buildingId: str(d.building_id),
		titles: str(d.titles),
		rights: str(d.rights),
		usufructAge: num(d.usufruct_age),
		burdens: str(d.burdens),
		tenancy: str(d.tenancy),
		currentRent: num(d.current_rent),
		leaseEnd: str(d.lease_end),
		owners: str(d.owners),
		strStatus: str(d.str_status),
		// Τι ήξερε ο σύμβουλος ότι δεν ξέρει: μπαίνει στο prompt ώστε η
		// βεβαιότητα να πέσει εκεί που πρέπει, αντί να το κρύψει το μοντέλο.
		missingCritical: str(d.missing_critical),
		askingPrice: num(pick(d.asking_price_num || d.asking_price, feedAsking)),
		monthlyMaintenance: num(pick("", f.monthlyMaintenance)),
		// Πόσο κάθεται στην αγορά με τη ΣΗΜΕΡΙΝΗ ζητούμενη. Μόνο για
		// ακίνητα του CRM: σε εκτίμηση με το χέρι δεν υπάρχει αγγελία.
		daysOnMarket: daysSince(f.listedAt),
		notes: String(d.notes || "").trim(),
	};
}

function num(v) {
	const n = Number(String(v == null ? "" : v).replace(/\./g, "").replace(",", "."));
	return Number.isFinite(n) && n > 0 ? n : null;
}

/* ΟΙ ΠΡΟΣΦΟΡΕΣ — το μόνο δεδομένο για το τι ΔΙΝΕΙ ο αγοραστής
   ------------------------------------------------------------------
   Όλα τα υπόλοιπα εδώ (πίνακας περιοχών, συγκριτικά, δείκτες) είναι
   ΖΗΤΟΥΜΕΝΕΣ τιμές. Η προσφορά είναι η άλλη πλευρά του τραπεζιού, και
   μια δεκτή προσφορά είναι πρακτικά τιμή κλεισίματος.

   Το γράψιμο ξεκίνησε στο CRM τη Δευτέρα 03/08/2026, οπότε στην αρχή οι
   περισσότερες κλήσεις γυρίζουν άδειο· αυτό είναι φυσιολογικό, όχι
   σφάλμα. Το σχήμα του Offer ΔΕΝ είναι τεκμηριωμένο (το OpenAPI είναι
   κομμένο πριν από αυτό), γι' αυτό διαβάζουμε κάθε πεδίο με πολλαπλά
   πιθανά ονόματα και κρατάμε ό,τι βγάζει νόημα. Όταν μπουν τα πρώτα
   πραγματικά δεδομένα, κοίτα τα logs («valuation: offers …») και
   στένεψε τα ονόματα. */
const OFFERS_TIMEOUT_MS = 4000;

async function fetchOffers(env, listingId) {
	if (!listingId) return [];
	let cfg;
	try {
		cfg = apiConfig(env);
	} catch {
		return []; // χωρίς κλειδιά CRM η εκτίμηση συνεχίζει κανονικά
	}
	try {
		const res = await fetch(`${cfg.base}/offers?listing_id=${encodeURIComponent(listingId)}`, {
			headers: cfg.headers,
			signal: AbortSignal.timeout(OFFERS_TIMEOUT_MS),
		});
		if (!res.ok) {
			console.warn(`valuation: offers HTTP ${res.status} for listing ${listingId}`);
			return [];
		}
		const body = await res.json();
		const rows = Array.isArray(body.data) ? body.data : [];
		// Το φίλτρο listing_id είναι body param στο spec· αν ο server το
		// αγνοήσει στο query string θα γυρίσει ΟΛΕΣ τις προσφορές, οπότε
		// ξαναφιλτράρουμε εδώ. Καλύτερα καμία προσφορά παρά ξένες.
		const mine = rows.filter((o) => {
			const id = o.listing_id ?? o.listingId ?? (o.listing && o.listing.id);
			return id == null || String(id) === String(listingId);
		});
		console.log(`valuation: offers for listing ${listingId}: ${mine.length} από ${rows.length}`);
		return mine.map(normalizeOffer).filter((o) => o.amount);
	} catch (err) {
		console.warn(`valuation: offers unavailable: ${String(err).slice(0, 160)}`);
		return [];
	}
}

/* Άγνωστο σχήμα, γνωστά νοήματα: ποσό, πότε, σε τι κατάσταση. */
function normalizeOffer(o) {
	const firstNum = (...keys) => {
		for (const k of keys) {
			const n = Number(o[k]);
			if (Number.isFinite(n) && n > 0) return n;
		}
		return null;
	};
	const firstStr = (...keys) => {
		for (const k of keys) {
			const s = String(o[k] == null ? "" : o[k]).trim();
			if (s) return s;
		}
		return null;
	};
	return {
		amount: firstNum("amount", "price", "offer_price", "offer_amount", "value"),
		status: firstStr("status", "offer_status", "state"),
		date: firstStr("date_created", "created_at", "date", "date_offer"),
		rounds: Array.isArray(o.rounds) ? o.rounds.length : null,
	};
}

const OFFER_STATUS_EL = {
	draft: "πρόχειρη",
	submitted: "υποβλήθηκε",
	under_negotiation: "σε διαπραγμάτευση",
	accepted: "ΕΓΙΝΕ ΔΕΚΤΗ",
	rejected: "απορρίφθηκε",
	withdrawn: "αποσύρθηκε",
};

/* Μέρες από μια ημερομηνία του EstatePrime («YYYY-MM-DD HH:MM:SS»,
   Europe/Athens). Το κενό γίνεται "T" γιατί αλλιώς το parsing είναι
   implementation-defined. Μελλοντική ή άκυρη ημερομηνία → null. */
function daysSince(raw) {
	const s = String(raw || "").trim();
	if (!s) return null;
	const t = Date.parse(s.replace(" ", "T"));
	if (!Number.isFinite(t)) return null;
	const days = Math.floor((Date.now() - t) / 86400000);
	return days >= 0 ? days : null;
}

/* Συγκριτικά από το ίδιο μας το χαρτοφυλάκιο: ίδια κατηγορία, ίδια
   περιοχή (χαλαρό ταίριασμα), μέγεθος ±40%, με τιμή. Το δικό του
   ακίνητο (ίδιος κωδικός) εξαιρείται. */
function pickComps(feed, prop) {
	const wantArea = normName(prop.areaName);
	const bySize = (l) => Math.abs((l.area || 0) - (prop.size || 0));
	/* Το εύρος μεγέθους: σε γη τα εμβαδά απλώνονται πολύ περισσότερο από
	   ό,τι στα κτίσματα, και ±40% θα άφηνε κάθε οικόπεδο χωρίς συγκριτικά. */
	const wide = prop.profile === "plot" || prop.profile === "parcel";
	const lo = wide ? 0.4 : 0.6;
	const hi = wide ? 2.5 : 1.4;
	const base = (l, transaction) =>
		l.transaction === transaction &&
		l.price > 0 && l.area > 0 &&
		String(l.code) !== String(prop.listingCode) &&
		(!wantArea || areaOf(l).includes(wantArea) || wantArea.includes(areaOf(l))) &&
		(!prop.size || (l.area > prop.size * lo && l.area < prop.size * hi));
	/* ΠΡΩΤΑ ΙΔΙΟ ΕΙΔΟΣ, ΟΧΙ ΙΔΙΑ ΚΑΤΗΓΟΡΙΑ: η κατηγορία «commercial»
	   βάζει στο ίδιο τραπέζι ένα κατάστημα σε εμπορικό δρόμο και μια
	   αποθήκη σε ΒΙΠΑ, και η «land» ένα οικόπεδο με ένα αγροτεμάχιο. Το
	   €/τ.μ. τους δεν έχει καμία σχέση. Αν το ίδιο είδος δεν δίνει
	   τίποτα, πέφτουμε στην κατηγορία — αλλά το δηλώνουμε στο prompt. */
	const sameKind = (l) => profileOf(l.subcategory, l.category) === prop.profile;
	const sameCat = (l) => l.category === prop.category;
	const take = (transaction, n, test) =>
		feed.filter((l) => base(l, transaction) && test(l)).sort((a, b) => bySize(a) - bySize(b)).slice(0, n);
	let sale = take("sale", 8, sameKind);
	let rent = take("rent", 5, sameKind);
	const loose = !sale.length && !rent.length;
	if (loose) {
		sale = take("sale", 8, sameCat);
		rent = take("rent", 5, sameCat);
	}
	return { sale, rent, loose };
}

/* Ποια συγκριτικά ΤΥΠΩΝΟΝΤΑΙ: αυτά της πράξης που ζητήθηκε. Το prompt
   παίρνει και τα δύο σκέλη (η απόδοση θέλει και αξία και ενοίκιο), το
   έγγραφο όχι — σε εκτίμηση ενοικίασης, τιμές πώλησης €180.000 κάτω από
   ένα μίσθωμα €920/μήνα διαβάζονται ως λάθος, και δίκαια. Το `transaction`
   ταξιδεύει μαζί με κάθε γραμμή, ώστε και τα τρία renderers (email, έντυπο,
   PWA) να βάζουν τις σωστές μονάδες. */
function docComps(comps, purpose) {
	const row = (l, transaction) => ({
		transaction,
		code: l.code, kind: labelKind(l.subcategory, l.category),
		area: (l.location || {}).area, sqm: l.area, price: l.price,
	});
	return [
		...(purpose === "rent" ? [] : comps.sale.map((l) => row(l, "sale"))),
		...(purpose === "sale" ? [] : comps.rent.map((l) => row(l, "rent"))),
	];
}

/* Οι γραμμές σε πίνακες, με τον τίτλο τους. Γραμμή χωρίς `transaction`
   (εκτίμηση που κάθεται ήδη στο KV από πριν) μετράει ως πώληση, όπως ήταν. */
function compGroups(rows) {
	const of = (t) => (Array.isArray(rows) ? rows : []).filter((r) => (r.transaction === "rent") === (t === "rent"));
	return [
		{ transaction: "sale", title: "ΣΥΓΚΡΙΤΙΚΑ ΠΩΛΗΣΗΣ ΑΠΟ ΤΟ ΧΑΡΤΟΦΥΛΑΚΙΟ ΜΑΣ", rows: of("sale") },
		{ transaction: "rent", title: "ΣΥΓΚΡΙΤΙΚΑ ΕΝΟΙΚΙΑΣΗΣ ΑΠΟ ΤΟ ΧΑΡΤΟΦΥΛΑΚΙΟ ΜΑΣ", rows: of("rent") },
	].filter((g) => g.rows.length);
}

function compPrice(price, transaction) {
	return transaction === "rent" ? `${eur(price)}/μήνα` : eur(price);
}

/* Στην πώληση το €/τ.μ. είναι ακέραιος (€2.700). Στο ενοίκιο όχι: 11,5 και
   11 €/τ.μ./μήνα απέχουν 5%, και το στρογγύλεμα κρύβει τη διαφορά. */
function compPerSqm(price, sqm, transaction) {
	if (!price || !sqm) return "";
	return transaction === "rent"
		? `€${(price / sqm).toFixed(1).replace(".", ",")}/τ.μ./μήνα`
		: `${eur(price / sqm)}/τ.μ.`;
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
const PRICE_BASIS = `ΒΑΣΗ ΤΙΜΩΝ (κανόνας του γραφείου, δεσμευτικός): αφετηρία σου είναι ΠΑΝΤΑ οι ΖΗΤΟΥΜΕΝΕΣ τιμές αγγελιών — ο πίνακας περιοχών και τα συγκριτικά του χαρτοφυλακίου μας — μειωμένες περίπου 10% για το τυπικό παζάρι μέχρι το κλείσιμο. Η μείωση αυτή εφαρμόζεται ΜΙΑ φορά, μέσα στη βάση €/τ.μ. που διαλέγεις: ΜΗΝ προσθέτεις ξεχωριστή προσαρμογή για «περιθώριο διαπραγμάτευσης» ή «παζάρι» στον πίνακα προσαρμογών — θα μετρούσε δύο φορές. ΜΗΝ αγκυρώνεσαι σε τιμές συμβολαίων, αντικειμενικές αξίες, τιμές ζώνης της εφορίας ή στοιχεία μεταβιβάσεων: στην ελληνική αγορά ένα μέρος του τιμήματος δίνεται εκτός συμβολαίου, οπότε τα ποσά αυτά είναι συστηματικά ΧΑΜΗΛΟΤΕΡΑ από την πραγματική τιμή κλεισίματος και ΔΕΝ αποτελούν ένδειξη αγοραίας αξίας. Μην τα χρησιμοποιείς ως αιτιολόγηση χαμηλότερης εκτίμησης και μην τα αναφέρεις στα κείμενα.

ΠΑΡΑΘΕΡΙΣΤΙΚΑ ΑΚΙΝΗΤΑ: τα εύρη του πίνακα περιοχών περιγράφουν το ΤΥΠΙΚΟ ακίνητο της περιοχής. Σε παραθεριστικές περιοχές (Χαλκιδική, παραλιακή Πιερία, Ασπροβάλτα κ.λπ.) ένα εξοχικό κοντά στη θάλασσα (κάτω από ~300 μ.), με κήπο/οικόπεδο, πισίνα ή άριστη κατάσταση, πιάνει ΣΥΣΤΗΜΑΤΙΚΑ τιμές πάνω από το άνω άκρο του πίνακα — πρώτη γραμμή και premium ανακαινίσεις μπορούν να το ξεπεράσουν κατά 50% ή και περισσότερο. Το ταβάνι του πίνακα ΔΕΝ είναι ταβάνι της εκτίμησης: τεκμηρίωσε τη βάση σου από τα χαρακτηριστικά. Αν λείπουν τα κρίσιμα στοιχεία (απόσταση από θάλασσα, οικόπεδο, πισίνα), μην υποθέσεις το φθηνό σενάριο — πλάτυνε το εύρος προς τα ΠΑΝΩ και γράψε στο missing_info τι θα έσφιγγε το νούμερο.`;

const PASS1_SYSTEM = `Είσαι έμπειρος εκτιμητής ακινήτων με 25 χρόνια στην αγορά της Θεσσαλονίκης και της υπόλοιπης Κεντρικής Μακεδονίας (Χαλκιδική, Πιερία, Σέρρες, Ημαθία, Πέλλα, Κιλκίς). Δουλεύεις για το μεσιτικό γραφείο Four Walls. Κάνεις ενδεικτικές εκτιμήσεις αγοραίας αξίας για εσωτερική χρήση του γραφείου, με τη μέθοδο των συγκριτικών στοιχείων: ξεκινάς από την τιμή ζώνης της περιοχής (€/τ.μ.), την προσαρμόζεις με τεκμηριωμένες προσαυξήσεις/απομειώσεις ανά χαρακτηριστικό, και διασταυρώνεις με τα συγκριτικά.

ΕΧΕΙΣ ΕΡΓΑΛΕΙΟ ΑΝΑΖΗΤΗΣΗΣ — ΧΡΗΣΙΜΟΠΟΙΗΣΕ ΤΟ: πριν κλειδώσεις τη βάση €/τ.μ., ψάξε τις ΤΡΕΧΟΥΣΕΣ ζητούμενες τιμές για το συγκεκριμένο είδος ακινήτου στη συγκεκριμένη περιοχή (π.χ. «τιμές πώλησης διαμερισμάτων <περιοχή> spitogatos») — ειδικά όταν τα συγκριτικά του χαρτοφυλακίου μας είναι λίγα ή καθόλου. Ό,τι βρεις είναι πρόσθετα συγκριτικά: στάθμισέ τα μαζί με τον πίνακα και το χαρτοφυλάκιο, και ανάφερε στο comps_comment τι έδειξε η αγορά αυτή τη στιγμή. Μην αντιγράφεις τυφλά μεμονωμένες ακραίες αγγελίες.

${PRICE_BASIS} Είσαι συντηρητικός στη διατύπωση αλλά όχι ηττοπαθής στο νούμερο: καλύτερα στενό ρεαλιστικό εύρος παρά εντυπωσιακά νούμερα, και ποτέ τιμή που δεν στέκει δίπλα στις ζητούμενες της περιοχής. Η τελική σου απάντηση είναι ΜΟΝΟ έγκυρο JSON, χωρίς markdown, χωρίς σχόλια εκτός JSON.`;

const PASS1_ASK = `Δώσε την εκτίμηση ως JSON ακριβώς με αυτό το σχήμα (αριθμοί χωρίς σύμβολα και χωρίς διαχωριστικά χιλιάδων):
{
 "headline": "μία πρόταση με το συμπέρασμα",
 "method": "ποια μέθοδος χρησιμοποιήθηκε, 3-8 λέξεις (π.χ. «συγκριτικά στοιχεία», «αξία ανά δομήσιμο τ.μ.», «κεφαλαιοποίηση μισθώματος», «συγκριτικά με κατώφλι την αξία της γης»)",
 "base_eur_per_sqm": 0,
 "adjustments": [ { "factor": "π.χ. Όροφος (4ος με θέα)", "pct": 5, "reason": "σύντομη αιτιολόγηση" } ],
 "eur_per_sqm": 0,
 "buildable_sqm": 0,
 "eur_per_buildable_sqm": 0,
 "value_low": 0, "value_mid": 0, "value_high": 0,
 "rent_low": 0, "rent_mid": 0, "rent_high": 0,
 "gross_yield_pct": 0,
 "market_comment": "2-4 προτάσεις για την τοπική αγορά και τη ζήτηση για αυτό το είδος ακινήτου",
 "comps_comment": "1-3 προτάσεις για το τι δείχνουν τα συγκριτικά και πόσο αξιόπιστα είναι εδώ",
 "asking_comment": "αν δόθηκε ζητούμενη/επιθυμητή τιμή, 1-2 προτάσεις σύγκρισης με την εκτίμηση, αλλιώς κενό",
 "confidence": "υψηλή | μέτρια | χαμηλή",
 "confidence_reason": "γιατί",
 "missing_info": [ "τι στοιχείο θα έσφιγγε την εκτίμηση" ],
 "caveats": [ "αίρεση ή κόκκινη σημαία που κρέμεται πάνω από την εκτίμηση, π.χ. «η τιμή ισχύει εφόσον τακτοποιηθούν τα αυθαίρετα»" ],
 "advice": "2-3 προτάσεις προς τον σύμβουλο για τη συζήτηση τιμολόγησης με τον ιδιοκτήτη",
 "renovation": {
  "scope": "ποια κλίμακα από τον πίνακα ανακαίνισης και τι περιλαμβάνει, 1 πρόταση",
  "cost_low": 0, "cost_high": 0,
  "value_after_low": 0, "value_after_mid": 0, "value_after_high": 0,
  "rent_after_mid": 0,
  "net_gain": 0,
  "comment": "1-2 προτάσεις: αξίζει ή όχι και γιατί"
 }
}
Κανόνες: value_mid = eur_per_sqm × εμβαδόν (στρογγύλεμα σε χιλιάδες). Το εύρος low-high ρεαλιστικό, συνήθως ±5-10% γύρω από το mid. Το gross_yield_pct = ετήσιο ενοίκιο mid / value_mid × 100, με ένα δεκαδικό. Κάθε adjustment με pct από -20 έως +20 και πραγματική αιτιολόγηση· μην απαριθμείς ό,τι δεν επηρεάζει. Αν λείπουν κρίσιμα στοιχεία, πλάτυνε το εύρος και πες το στο confidence_reason.
Το "method" λέει στον αναγνώστη ΠΩΣ βγήκε το νούμερο — γράψε τη μέθοδο που όντως ακολούθησες για ΑΥΤΟ το είδος ακινήτου, όχι «συγκριτικά» ως αυτόματη απάντηση.
Για ΓΗ (οικόπεδο, αγροτεμάχιο): συμπλήρωσε "buildable_sqm" (εμβαδόν γης × συντελεστή δόμησης) και "eur_per_buildable_sqm" (η αξία ανά ΔΟΜΗΣΙΜΟ τ.μ., που είναι και η πραγματική σου βάση). Το "eur_per_sqm" μένει η αξία ανά τ.μ. ΓΗΣ, ώστε να διαβάζεται μαζί με τα συγκριτικά. Χωρίς γνωστό συντελεστή δόμησης βάλε 0 και στα δύο και εξήγησέ το. Για κάθε άλλο είδος βάλε 0 και στα δύο.
Τα "caveats" είναι ΑΙΡΕΣΕΙΣ, όχι επιφυλάξεις γενικής χρήσης: μπαίνουν μόνο όταν κάτι συγκεκριμένο κρέμεται πάνω από τη μεταβίβαση ή την ίδια την εκτίμηση (αυθαίρετο χωρίς τακτοποίηση, μη οικοδομήσιμο ή αμφίβολης αρτιότητας γήπεδο, ψιλή κυριότητα, κατειλημμένο ακίνητο, κατάσχεση, δασικός χαρακτήρας, εκκρεμείς τίτλοι). Άδειος πίνακας όταν δεν υπάρχει τίποτα τέτοιο — μη γεμίζεις με «οι τιμές είναι ενδεικτικές», αυτό το λέει ήδη το έντυπο.
Σε ΓΗ (οικόπεδο, αγροτεμάχιο) και σε θέση στάθμευσης, όταν ΔΕΝ ζητήθηκε εκτίμηση ενοικίασης, βάλε rent_low, rent_mid, rent_high και gross_yield_pct **στο 0**. Μην κατασκευάσεις μίσθωμα για να «γεμίσει» το σχήμα: ένα αδόμητο οικόπεδο δεν έχει αγορά μίσθωσης, και μια «απόδοση 1,5%» δεν σημαίνει τίποτα — ταξιδεύει όμως στο ιστορικό εκτιμήσεων ως θόρυβος.
Το "confidence" παίρνει ΑΚΡΙΒΩΣ μία από τις τρεις λέξεις: "υψηλή", "μέτρια", "χαμηλή". Όχι συνώνυμα.
Για το "renovation": σε ΓΗ (οικόπεδο, αγροτεμάχιο) και σε θέση στάθμευσης βάλε πάντα null — δεν ανακαινίζεται τίποτα.
Για το "renovation": αν το ακίνητο είναι ήδη άριστο/πλήρως ανακαινισμένο ή μια ανακαίνιση δεν θα άλλαζε ουσιαστικά την αξία, βάλε "renovation": null (σκέτο null, όχι αντικείμενο). Το κόστος χτίζεται από τον πίνακα ανακαίνισης σε ΔΥΟ μέρη: (α) perSqm εύρος × εμβαδόν για τις εργασίες που κλιμακώνουν με τα τ.μ., ΣΥΝ (β) τα fixed ανά τεμάχιο — το μπάνιο ΕΠΙ ΤΟΝ ΑΡΙΘΜΟ ΤΩΝ ΜΠΑΝΙΩΝ του ακινήτου, η κουζίνα μία φορά αν η κλίμακα την περιλαμβάνει. Δύο μπάνια σημαίνουν σχεδόν διπλάσιο κόστος μπάνιων, όσα τ.μ. κι αν έχει το ακίνητο. Γράψε στο scope τι μέτρησες (π.χ. «μερική: δάπεδα/βαφές 120 τ.μ. + 2 μπάνια + κουζίνα»), σε φυσικά ελληνικά: ΜΗΝ αντιγράφεις σε κανένα κείμενο εσωτερικά ονόματα πεδίων του πίνακα όπως perSqm ή fixed, είναι ονόματα για τον υπολογισμό, όχι λέξεις για τον αναγνώστη. Στρογγύλεμα σε χιλιάδες. Το value_after τεκμηριωμένο από ανακαινισμένα/νεόδμητα επίπεδα της περιοχής — ΠΟΤΕ πάνω από νεόδμητο. net_gain = value_after_mid − value_mid − μέσο cost. Αν το όφελος είναι αρνητικό ή οριακό, γράψ' το ευθέως στο comment — ΜΗΝ προτείνεις ανακαίνιση που δεν αποδίδει.`;

const PASS2_SYSTEM = `Είσαι ο αυστηρός ελεγκτής εκτιμήσεων ενός μεσιτικού γραφείου που δραστηριοποιείται σε όλη την Κεντρική Μακεδονία. Παίρνεις τα δεδομένα ενός ακινήτου και μια έτοιμη εκτίμηση σε JSON, και την ελέγχεις: (1) αριθμητική συνέπεια (base × προσαρμογές ≈ €/τ.μ., €/τ.μ. × εμβαδόν ≈ value_mid, απόδοση σωστά υπολογισμένη), (2) συμφωνία με τα συγκριτικά και το εύρος της περιοχής (αποκλίσεις άνω του 15% από τη διάμεσο θέλουν ρητή αιτιολόγηση ή διόρθωση), (3) υπερβολές, αοριστίες και εσωτερικά ονόματα πεδίων στα κείμενα (perSqm, fixed κ.λπ. είναι ονόματα του πίνακα κόστους, όχι λέξεις για τον αναγνώστη· τα κείμενα σε φυσικά ελληνικά), (4) τη ΒΑΣΗ ΤΙΜΩΝ παρακάτω, (5) αν υπάρχει renovation: κόστος = perSqm × εμβαδόν + fixed ανά τεμάχιο (μπάνιο × αριθμό μπάνιων, κουζίνα) σύμφωνα με τον πίνακα ανακαίνισης, value_after όχι πάνω από νεόδμητο της περιοχής, net_gain = value_after_mid − value_mid − μέσο κόστος. ${PRICE_BASIS} Αν η εκτίμηση που ελέγχεις κάθεται πολύ χαμηλότερα από τις ζητούμενες τιμές της περιοχής χωρίς χαρακτηριστικό του ακινήτου να το δικαιολογεί, ή αν κάπου επικαλείται συμβόλαια/αντικειμενικές αξίες, ανέβασέ τη στη σωστή βάση και γράψε το στο review_notes. (6) ΟΤΙ ΕΦΑΡΜΟΣΤΗΚΕ Η ΣΩΣΤΗ ΜΕΘΟΔΟΣ ΓΙΑ ΤΟ ΕΙΔΟΣ — αυτό είναι το πιο συχνό σοβαρό λάθος. Διάβασε τη «ΜΕΘΟΔΟΣ» στα δεδομένα και έλεγξε ότι ακολουθήθηκε: γη αποτιμάται ανά ΔΟΜΗΣΙΜΟ τετραγωνικό (εμβαδόν × ΣΔ) και όχι με €/τ.μ. κατοικίας· μη άρτιο ή αμφίβολης αρτιότητας γήπεδο δεν τιμολογείται σαν άρτιο· μονοκατοικία δεν βγαίνει κάτω από την αξία του οικοπέδου της· κατάστημα δεν αθροίζει ισόγειο με πατάρι και υπόγειο· επαγγελματικό ακίνητο θέλει και έλεγχο με κεφαλαιοποίηση μισθώματος· αποθήκη δεν τιμολογείται σε €/τ.μ. κατοικίας. Αν χρησιμοποιήθηκε λάθος μέθοδος, ΞΑΝΑΚΑΝΕ τον υπολογισμό με τη σωστή και γράψε το στο review_notes.
(7) ΤΑ ΝΟΜΙΚΑ ως αιρέσεις και όχι ως ποσοστά, σύμφωνα με τους κανόνες των δεδομένων: αν υπάρχει αυθαίρετο χωρίς τακτοποίηση, ψιλή κυριότητα, κατειλημμένο, κατάσχεση, δασικός χαρακτήρας ή εκκρεμείς τίτλοι και ΔΕΝ υπάρχει αντίστοιχο caveat, πρόσθεσέ το.
(8) ΟΤΙ ΤΑ ΚΕΙΜΕΝΑ ΔΕΝ ΜΙΛΟΥΝ ΓΙΑ ΠΕΔΙΑ ΠΟΥ ΔΕΝ ΥΠΑΡΧΟΥΝ σε αυτό το είδος (όροφος ή ασανσέρ σε οικόπεδο, ενεργειακή κλάση σε αγροτεμάχιο): σβήσ' τα.
Διορθώνεις ό,τι δεν στέκει και επιστρέφεις το ΤΕΛΙΚΟ JSON στο ΙΔΙΟ σχήμα, με ένα επιπλέον πεδίο "review_notes": τι άλλαξες και γιατί (κενό αν τίποτα). Απαντάς ΜΟΝΟ με έγκυρο JSON.`;

const PASS2_ASK = `Έλεγξε, διόρθωσε όπου χρειάζεται, και επίστρεψε το τελικό JSON (ίδιο σχήμα, συν "review_notes").`;

/* ΤΙ ΖΗΤΕΙΤΑΙ (πώληση, ενοικίαση ή και τα δύο) — το επιλέγει ο σύμβουλος
   στη φόρμα και ΚΑΘΟΡΙΖΕΙ ΤΙ ΤΥΠΩΝΕΤΑΙ: σε «μόνο ενοικίαση» η αναφορά δεν
   δείχνει καθόλου αξία πώλησης. Χωρίς αυτή την ενημέρωση το μοντέλο έγραφε
   κείμενα πώλησης κάτω από ένα μίσθωμα, και διάβαζε τη ζητούμενη τιμή ως
   τίμημα ενώ ήταν €/μήνα. Και τα δύο σκέλη ζητούνται πάντα ως νούμερα,
   γιατί η μικτή απόδοση θέλει και αξία και ενοίκιο. */
const PURPOSE_BRIEF = {
	both: `ΤΙ ΖΗΤΕΙΤΑΙ: εκτίμηση ΚΑΙ για πώληση ΚΑΙ για ενοικίαση, και τα δύο τυπώνονται στην αναφορά. Η «ζητούμενη_ή_επιθυμητή_τιμή», αν υπάρχει, είναι τίμημα ΠΩΛΗΣΗΣ.`,
	sale: `ΤΙ ΖΗΤΕΙΤΑΙ: εκτίμηση ΠΩΛΗΣΗΣ. Η αναφορά δείχνει την αξία πώλησης, ΟΧΙ το μίσθωμα: τα rent_* συμπλήρωσέ τα μόνο για να βγει η μικτή απόδοση και μην τα σχολιάζεις. Η «ζητούμενη_ή_επιθυμητή_τιμή» είναι τίμημα πώλησης. Όλα τα κείμενα (market_comment, comps_comment, asking_comment, advice, confidence_reason) μιλούν για την αγορά ΠΩΛΗΣΗΣ, και το comps_comment για τα ΣΥΓΚΡΙΤΙΚΑ ΠΩΛΗΣΗΣ, τα μόνα που τυπώνονται.`,
	rent: `ΤΙ ΖΗΤΕΙΤΑΙ: εκτίμηση ΕΝΟΙΚΙΑΣΗΣ. Η αναφορά δείχνει το μηνιαίο μίσθωμα, ΟΧΙ την αξία πώλησης: τα value_* συμπλήρωσέ τα κανονικά (τα χρειάζεται η μικτή απόδοση) αλλά μην τα σχολιάζεις πουθενά ως ζητούμενο του πελάτη. Η «ζητούμενη_ή_επιθυμητή_τιμή», αν υπάρχει, είναι ΜΗΝΙΑΙΟ ΜΙΣΘΩΜΑ σε €/μήνα, όχι τίμημα — το asking_comment τη συγκρίνει με το rent_mid. Όλα τα κείμενα (market_comment, comps_comment, asking_comment, advice, confidence_reason) μιλούν για την αγορά ΕΝΟΙΚΙΑΣΗΣ: ζήτηση ενοικιαστών, χρόνος μίσθωσης, τι πιάνει το ακίνητο τον μήνα. Στα συγκριτικά βάρυνε τα ΣΥΓΚΡΙΤΙΚΑ ΕΝΟΙΚΙΑΣΗΣ (μόνο αυτά τυπώνονται) και τον πίνακα €/τ.μ./μήνα· αν είναι λίγα ή κανένα, πες το ρητά στο comps_comment και στήριξε το νούμερο στον πίνακα και στην αναζήτηση, όχι στις τιμές πώλησης.`,
};

/* ΜΕΘΟΔΟΣ ΑΝΑ ΕΙΔΟΣ — ο λόγος που υπάρχουν τα προφίλ
   ------------------------------------------------------------------
   Μέχρι τώρα κάθε ακίνητο περνούσε από την ίδια μέθοδο: βάση €/τ.μ. της
   περιοχής επί το εμβαδόν. Για διαμέρισμα είναι σωστή. Για οικόπεδο
   είναι ΛΑΘΟΣ — η αξία της γης βγαίνει από τα ΔΟΜΗΣΙΜΑ τετραγωνικά
   (εμβαδόν × ΣΔ), και ένα μη άρτιο γήπεδο αξίζει κλάσμα του άρτιου. Για
   μισθωμένο επαγγελματικό είναι ελλιπής: εκεί αγοράζεται η απόδοση. */
const METHOD_BRIEF = {
	apartment: `ΜΕΘΟΔΟΣ — ΣΥΓΚΡΙΤΙΚΑ ΣΤΟΙΧΕΙΑ: βάση €/τ.μ. της περιοχής για το είδος, προσαρμογές ανά χαρακτηριστικό, διασταύρωση με τα συγκριτικά. Βαραίνουν: όροφος σε συνδυασμό με ασανσέρ (4ος χωρίς ασανσέρ είναι σοβαρή απομείωση, ρετιρέ με θέα προσαύξηση), προσανατολισμός/διαμπερές, κατάσταση και έτος, ενεργειακή κλάση, μπαλκόνια, θέα, θόρυβος.`,

	house: `ΜΕΘΟΔΟΣ — ΣΥΓΚΡΙΤΙΚΑ ΜΕ ΚΑΤΩΦΛΙ ΤΗΝ ΑΞΙΑ ΤΗΣ ΓΗΣ. Κάνε ΚΑΙ ΤΑ ΔΥΟ και πάρε το μεγαλύτερο:
(α) συγκριτικά κατοικιών €/τ.μ. κτίσματος, και
(β) αξία γης = οικόπεδο_τμ × συντελεστής_δόμησης × €/τ.μ. ΔΟΜΗΣΗΣ της περιοχής, μείον κόστος κατεδάφισης αν το κτίσμα είναι για κατεδάφιση.
ΚΑΝΟΝΑΣ: μονοκατοικία ή μεζονέτα ΔΕΝ μπορεί να αξίζει λιγότερο από το οικόπεδό της. Σε παλιό κτίσμα πάνω σε καλό οικόπεδο η αγορά πληρώνει τη ΓΗ — αν βγει έτσι, πες το ρητά στο comps_comment και στο advice, γιατί αλλάζει και τον αγοραστή (κατασκευαστής αντί για οικογένεια).
ΥΠΟΛΟΙΠΟ ΔΟΜΗΣΗΣ: τετραγωνικά που χτίζονται ακόμα είναι πραγματική αξία (επέκταση ή δεύτερη κατοικία) — μέτρησέ τα ως χωριστή θετική προσαρμογή, με λογική τιμή γης ανά δομήσιμο τ.μ., ΟΧΙ ως τιμή έτοιμου κτίσματος.
ΜΟΡΦΗ ΙΔΙΟΚΤΗΣΙΑΣ: αυτοτελές οικόπεδο αξίζει περισσότερο από κάθετη ιδιοκτησία, και η κάθετη περισσότερο από οριζόντια σε συγκρότημα (εκεί ο ιδιοκτήτης δεν ελέγχει τη γη ούτε το υπόλοιπο δόμησης).
ΔΕΝ ΥΠΑΡΧΟΥΝ ΕΔΩ: όροφος, ασανσέρ, κοινόχρηστα. Μην τα ζητήσεις και μην τα σχολιάσεις.`,

	villa: `ΜΕΘΟΔΟΣ — ΣΥΓΚΡΙΤΙΚΑ ΠΑΡΑΘΕΡΙΣΤΙΚΩΝ, ΜΕ ΚΑΤΩΦΛΙ ΤΗΝ ΑΞΙΑ ΤΗΣ ΓΗΣ (όπως στη μονοκατοικία: το ακίνητο δεν αξίζει λιγότερο από το οικόπεδό του).
Η ΙΕΡΑΡΧΙΑ ΤΩΝ ΟΔΗΓΩΝ ΕΙΝΑΙ ΑΛΛΗ ΑΠΟ ΤΗΣ ΠΟΛΗΣ: πρώτα απόσταση και θέα προς τη θάλασσα, μετά οικόπεδο και πισίνα, μετά κατάσταση, και πολύ πιο πίσω τα υπνοδωμάτια. Πρώτη σειρά ή θέα θάλασσας δικαιολογεί προσαύξηση που σε αστικό ακίνητο θα ήταν υπερβολική.
ΕΠΟΧΙΚΟΤΗΤΑ: το «μίσθωμα» ενός εξοχικού δεν είναι μηνιαίο δωδεκάμηνο. Αν ζητηθεί ενοικίαση, υπολόγισε ρεαλιστικά με βάση τη σεζόν και πες τη βάση σου.`,

	building: `ΜΕΘΟΔΟΣ — ΔΙΠΛΗ: (α) ΕΙΣΟΔΗΜΑΤΟΣ, κεφαλαιοποίηση του ΣΥΝΟΛΙΚΟΥ ρεαλιστικού μισθώματος όλων των μονάδων με απόδοση της αγοράς για την περιοχή και το είδος, και (β) ΑΘΡΟΙΣΜΑ ΜΟΝΑΔΩΝ, τι θα έπιανε κάθε διαμέρισμα/χώρος χωριστά, μείον έκπτωση χονδρικής 10-20% γιατί ο αγοραστής ενός ολόκληρου κτιρίου δεν πληρώνει λιανικές τιμές.
Διασταύρωσε τα δύο, εξήγησε τη διαφορά, και έλεγξε ΚΑΙ την αξία της γης με το υπόλοιπο δόμησης: σε κεντρικό οικόπεδο ένα παλιό κτίριο μπορεί να αξίζει ως ΓΗ ΓΙΑ ΑΝΑΠΤΥΞΗ περισσότερο από ό,τι ως εισόδημα.
Το ποσοστό πληρότητας και το αν οι μισθώσεις είναι κάτω από την αγορά είναι κρίσιμα: μια χαμηλή μίσθωση με μακρά διάρκεια κουβαλιέται στον αγοραστή.`,

	office: `ΜΕΘΟΔΟΣ — ΣΥΓΚΡΙΤΙΚΑ ΚΑΙ ΕΙΣΟΔΗΜΑΤΟΣ ΜΑΖΙ. Το γραφείο αγοράζεται ως απόδοση: υπολόγισε ρεαλιστικό μίσθωμα €/τ.μ./μήνα, κεφαλαιοποίησε με απόδοση της αγοράς, και διασταύρωσε με τα συγκριτικά πώλησης.
ΒΑΡΑΙΝΟΥΝ: η κατηγορία του κτιρίου (νεόδμητο υψηλών προδιαγραφών έναντι παλαιού χωρίς αναβάθμιση — η διαφορά μισθώματος είναι της τάξης του διπλάσιου), οι ΘΕΣΕΙΣ ΣΤΑΘΜΕΥΣΗΣ (σε κεντρικό γραφείο είναι από τα πρώτα κριτήρια του μισθωτή), η πρόσβαση σε ΜΜΜ, η διαρρύθμιση, ο κλιματισμός, η ενεργειακή κλάση.
Ο ΟΡΟΦΟΣ ΔΕΝ ΔΙΑΒΑΖΕΤΑΙ ΟΠΩΣ ΣΤΗΝ ΚΑΤΟΙΚΙΑ: για γραφείο ο υψηλός όροφος με ασανσέρ και θέα είναι πλεονέκτημα, το ισόγειο ουδέτερο, το ημιυπόγειο σοβαρή απομείωση.`,

	retail: `ΜΕΘΟΔΟΣ — ΕΙΣΟΔΗΜΑΤΟΣ ΠΡΩΤΑ, ΣΥΓΚΡΙΤΙΚΑ ΔΕΥΤΕΡΑ. Το κατάστημα αποτιμάται από το μίσθωμα που πιάνει: ρεαλιστικό μίσθωμα → κεφαλαιοποίηση με απόδοση της αγοράς → διασταύρωση με συγκριτικά πώλησης.
ΑΝΑΓΩΓΗ ΕΠΙΦΑΝΕΙΩΝ — ΥΠΟΧΡΕΩΤΙΚΗ, ΜΗΝ ΤΑ ΑΘΡΟΙΣΕΙΣ: το ισόγειο μετράει 100%, το πατάρι περίπου 50%, το υπόγειο περίπου 30-50% ανάλογα με το αν είναι αυτοτελές και προσβάσιμο. Υπολόγισε «ισοδύναμα τ.μ. ισογείου», βγάλε την αξία πάνω σε αυτά, και ΓΡΑΨΕ στο comps_comment ποια αναγωγή χρησιμοποίησες. Το €/τ.μ. που θα δηλώσεις αφορά το ΙΣΟΓΕΙΟ.
ΤΑ ΜΕΤΡΑ ΤΗΣ ΒΙΤΡΙΝΑΣ ΚΑΙ Η ΕΜΠΟΡΙΚΟΤΗΤΑ ΤΟΥ ΔΡΟΜΟΥ ΚΑΝΟΥΝ ΤΗ ΔΙΑΦΟΡΑ, ΟΧΙ ΤΑ ΤΕΤΡΑΓΩΝΙΚΑ: δύο καταστήματα 80 τ.μ. στον ίδιο δρόμο, το ένα με 4 μ. βιτρίνα και βάθος 20 μ. και το άλλο με 10 μ. βιτρίνα και βάθος 8 μ., δεν αξίζουν το ίδιο — το δεύτερο σαφώς περισσότερο. Μεγάλο βάθος με στενή βιτρίνα είναι απομείωση. Γωνιακό με δύο όψεις είναι προσαύξηση.
Το αν σηκώνει χρήση υγειονομικού ενδιαφέροντος (άδεια, καμινάδα, απορροφητήρας) ανοίγει ή κλείνει ολόκληρη κατηγορία μισθωτών και μετράει στην τιμή.`,

	industrial: `ΜΕΘΟΔΟΣ — ΕΙΣΟΔΗΜΑΤΟΣ ΚΑΙ ΚΟΣΤΟΥΣ ΑΝΤΙΚΑΤΑΣΤΑΣΗΣ. Τα €/τ.μ. κατοικίας ΔΕΝ ισχύουν εδώ, ούτε καν ως τάξη μεγέθους: η αποθήκη και ο βιοτεχνικός χώρος τιμολογούνται πολύ χαμηλότερα ανά τ.μ. και κρίνονται από τη λειτουργικότητα.
ΒΑΡΑΙΝΟΥΝ, ΜΕ ΑΥΤΗ ΤΗ ΣΕΙΡΑ: ελεύθερο ύψος (κάτω από ~6 μ. αποκλείει σύγχρονη ραφιέρα και κόβει την τιμή, πάνω από ~10 μ. είναι premium), πρόσβαση νταλίκας και ράμπα φορτοεκφόρτωσης, απόσταση από εθνική/κόμβο, εμβαδόν οικοπέδου και ελιγμοί, τριφασικό ρεύμα και εγκατεστημένη ισχύς, γερανογέφυρα, ποσοστό γραφείων.
ΘΕΣΜΙΚΟ ΠΛΑΙΣΙΟ: μέσα σε ΒΙΠΕ/ΒΙΠΑ/ΒΙΟΠΑ η χρήση είναι εξασφαλισμένη και αυτό αξίζει· εκτός σχεδίου με αμφίβολες χρήσεις γης ή χωρίς άδεια λειτουργίας, απομείωσε και γράψ' το στα missing_info.
ΤΟ ΟΙΚΟΠΕΔΟ ΕΙΝΑΙ ΜΕΓΑΛΟ ΜΕΡΟΣ ΤΗΣ ΑΞΙΑΣ: σε βιομηχανικό ακίνητο συχνά η γη αξίζει περισσότερο από το κτίσμα. Υπολόγισε και τα δύο.`,

	parking: `ΜΕΘΟΔΟΣ — ΣΥΓΚΡΙΤΙΚΑ ΑΝΑ ΘΕΣΗ, ΟΧΙ ΑΝΑ ΤΕΤΡΑΓΩΝΙΚΟ. Η θέση στάθμευσης πωλείται και νοικιάζεται ΩΣ ΜΟΝΑΔΑ: δώσε τιμή για τη θέση και μόνο δευτερευόντως αναγωγή σε €/τ.μ.
ΒΑΡΑΙΝΟΥΝ: η περιοχή και η στενότητα σε στάθμευση (σε πυκνό κέντρο χωρίς παρκινγκ η αξία πολλαπλασιάζεται), κλειστό γκαράζ έναντι ανοιχτής θέσης, ευκολία μανούβρας, αν συνοδεύει διαμέρισμα ή πωλείται αυτοτελώς.
Το εύρος είναι εξ ορισμού πλατύτερο: πες το στη βεβαιότητα.`,

	plot: `ΜΕΘΟΔΟΣ — ΑΞΙΑ ΑΝΑ ΔΟΜΗΣΙΜΟ ΤΕΤΡΑΓΩΝΙΚΟ (υπολειμματική / αντιπαροχής), ΟΧΙ ανά τετραγωνικό γης.
1. ΔΟΜΗΣΙΜΑ = εμβαδόν_γης × συντελεστής_δόμησης. Αυτό είναι το προϊόν που αγοράζεται. Υπολόγισέ το και δήλωσέ το.
2. ΑΞΙΑ = δομήσιμα × €/τ.μ. δόμησης της περιοχής. Χοντρικός έλεγχος: η αξία της γης σε αστική περιοχή κινείται συνήθως στο 15-30% της τιμής πώλησης του τελειωμένου κτίσματος — υψηλότερα σε ακριβές, χαμηλότερα σε φθηνές περιοχές. Αν το νούμερό σου βγαίνει έξω από αυτό, ξαναδές το.
3. ΑΡΤΙΟΤΗΤΑ ΕΙΝΑΙ ΔΙΑΚΟΠΤΗΣ, ΟΧΙ ΠΟΣΟΣΤΟ: μη άρτιο ή μη οικοδομήσιμο οικόπεδο αξίζει ΚΛΑΣΜΑ του άρτιου (τυπικά 30-60%), γιατί αγοράζεται μόνο από όμορο ιδιοκτήτη ή για τακτοποίηση. Αν είναι «Άγνωστο», ΜΗΝ το υποθέσεις άρτιο: δώσε την εκτίμηση υπό αίρεση και βάλ' το πρώτο στα missing_info και στα caveats.
4. ΤΟ ΠΡΟΣΩΠΟ ΚΑΙ ΤΟ ΣΧΗΜΑ: μεγάλο πρόσωπο σε εμπορικό δρόμο ανεβάζει, ακανόνιστο σχήμα ρίχνει τυπικά 10-15% γιατί χάνεται δόμηση, γωνιακό ανεβάζει.
5. ΧΡΗΣΕΙΣ ΓΗΣ: εμπορική ή τουριστική χρήση αξίζει περισσότερο από αμιγή κατοικία στο ίδιο σημείο.
6. ΔΕΣΜΕΥΣΕΙΣ (δασικό/αναδασωτέα, αρχαιολογία, ρέμα, απαλλοτρίωση, αιγιαλός, Natura, διατηρητέο): δεν είναι προσαρμογή −5%. Απαντούν στο αν χτίζεται. Δασικός χαρακτήρας ή αναδασωτέα μηδενίζει πρακτικά την οικοδομική αξία· διατηρητέο κτίσμα ρίχνει κατακόρυφα την αξία της γης γιατί δεν επιτρέπει νέα ανέγερση. Γράψ' τα στα caveats.
7. ΥΠΑΡΧΟΝ ΚΤΙΣΜΑ για κατεδάφιση είναι ΚΟΣΤΟΣ, όχι αξία: αφαίρεσέ το.
ΔΕΝ ΥΠΑΡΧΟΥΝ ΕΔΩ: ενεργειακή κλάση, θέρμανση, όροφος, ασανσέρ, ανακαίνιση. Μην τα αναφέρεις. Η «κατάσταση» της γης είναι το καθεστώς της, όχι η διακόσμηση.
ΕΝΟΙΚΙΟ: αδόμητο οικόπεδο σπάνια έχει αγορά μίσθωσης. Αν δεν ζητήθηκε ρητά ενοικίαση, μην κατασκευάσεις μίσθωμα — δώσε τα rent_* συντηρητικά και μην τα σχολιάσεις.`,

	parcel: `ΜΕΘΟΔΟΣ — ΟΠΩΣ ΤΟ ΟΙΚΟΠΕΔΟ (αξία ανά δομήσιμο τ.μ.) ΑΛΛΑ ΜΕ ΤΟΥΣ ΚΑΝΟΝΕΣ ΤΗΣ ΕΚΤΟΣ ΣΧΕΔΙΟΥ ΔΟΜΗΣΗΣ, όπου η οικοδομησιμότητα είναι ΤΟ παν:
- Κανόνας: άρτιο εκτός σχεδίου είναι το γήπεδο των 4 στρεμμάτων με πρόσωπο τουλάχιστον 25 μ. σε ΚΟΙΝΟΧΡΗΣΤΟ δρόμο. Παλαιότερες παρεκκλίσεις (2.000 τ.μ. πριν το 1978, 1.200 τ.μ. πριν το 1964, 750 τ.μ. πριν το 1962) ισχύουν μόνο για γήπεδα που δημιουργήθηκαν πριν από τις αντίστοιχες ημερομηνίες.
- ΠΡΟΣΟΧΗ, ΤΟ ΠΙΟ ΣΥΧΝΟ ΛΑΘΟΣ: ΑΓΡΟΤΙΚΟΣ ΔΡΟΜΟΣ ΔΕΝ ΕΙΝΑΙ ΚΟΙΝΟΧΡΗΣΤΟΣ. Πρόσωπο μόνο σε αγροτικό δρόμο, ή καθόλου πρόσβαση, σημαίνει ότι δεν βγαίνει άδεια — η αξία πέφτει σε επίπεδα καθαρά αγροτικής γης. Πες το ευθέως.
- Χωρίς οικοδομησιμότητα η αποτίμηση είναι ΑΓΡΟΤΙΚΗ: αξία καλλιεργήσιμης γης, όπου μετράνε άρδευση (γεώτρηση ή δίκτυο), είδος καλλιέργειας, κλίση και πρόσβαση. Τα €/τ.μ. αστικής γης δεν έχουν καμία σχέση.
- ΠΑΡΑΘΑΛΑΣΣΙΑ: σε Χαλκιδική και παραλιακή Πιερία η απόσταση από τη θάλασσα και η θέα κυριαρχούν· η πρώτη σειρά είναι άλλη αγορά από το ίδιο στρέμμα 800 μ. πιο πίσω.
- Δασικός χαρακτήρας, αναδασωτέα, αιγιαλός, Natura, ρέμα και αρχαιολογία απαντούν στο αν χτίζεται — caveats, όχι ποσοστά.
ΔΕΝ ΥΠΑΡΧΟΥΝ ΕΔΩ: ενεργειακή κλάση, θέρμανση, όροφος, ασανσέρ, ανακαίνιση.`,
};

/* ΝΟΜΙΚΑ ΚΑΙ ΠΟΛΕΟΔΟΜΙΚΑ — αλλάζουν την εκτίμηση περισσότερο από κάθε
   φυσικό χαρακτηριστικό, και το μοντέλο αφημένο μόνο του τα περνάει ως
   άλλη μια γραμμή ±5% στον πίνακα προσαρμογών. Δεν είναι αυτό: το
   αυθαίρετο χωρίς τακτοποίηση ΔΕΝ ΜΕΤΑΒΙΒΑΖΕΤΑΙ, δηλαδή η εκτίμηση
   δίνεται υπό αίρεση. */
const LEGAL_RULES = `ΝΟΜΙΚΑ ΚΑΙ ΠΟΛΕΟΔΟΜΙΚΑ — ΠΩΣ ΔΙΑΒΑΖΟΝΤΑΙ (κρίσιμο, ισχύει για κάθε είδος):
- ΑΥΘΑΙΡΕΤΑ ΧΩΡΙΣ ΤΑΚΤΟΠΟΙΗΣΗ: δεν συντάσσεται συμβόλαιο μεταβίβασης. Αυτό ΔΕΝ είναι προσαρμογή ποσοστού — είναι ΑΙΡΕΣΗ πάνω σε ολόκληρη την εκτίμηση. Δώσε την αξία «ως τακτοποιημένο», βάλε στα caveats ότι ισχύει υπό την τακτοποίηση, και ανάφερε στο advice ότι το κόστος και ο χρόνος της τακτοποίησης πέφτουν στη διαπραγμάτευση (η προθεσμία τακτοποίησης λήγει 31/03/2028). Τακτοποιημένο ακίνητο είναι μεταβιβάσιμο: μην το τιμωρήσεις σαν αυθαίρετο, το πολύ μικρή απομείωση αν η τακτοποίηση αφορά μεγάλη επιφάνεια.
- ΗΛΕΚΤΡΟΝΙΚΗ ΤΑΥΤΟΤΗΤΑ ΚΤΙΡΙΟΥ: απαιτείται για τη μεταβίβαση. Αν λείπει, είναι χρόνος και κόστος πριν το συμβόλαιο, όχι απομείωση αξίας — γράψ' το στο advice.
- ΨΙΛΗ ΚΥΡΙΟΤΗΤΑ (με επικαρπία τρίτου): ΔΕΝ είναι πλήρης κυριότητα και δεν αξίζει όσο αυτή. Ο αγοραστής δεν έχει χρήση ούτε εισόδημα όσο ζει ο επικαρπωτής. Απομείωσε ουσιαστικά και ανάλογα με την ηλικία του επικαρπωτή (όσο νεότερος, τόσο μεγαλύτερη η απομείωση) και δήλωσε ρητά ότι η τιμή αφορά ψιλή κυριότητα. Σκέτη επικαρπία είναι ακόμη πιο ειδική αγορά.
- ΒΑΡΗ: υποθήκη ή προσημείωση συνήθως εξοφλείται στο συμβόλαιο και δεν αλλάζει την αξία — είναι διαδικασία. Κατάσχεση ή πλειστηριασμός όμως αλλάζει την αγορά και το τίμημα: caveat και προσοχή στο advice.
- ΜΙΣΘΩΜΕΝΟ: η μίσθωση κουβαλιέται στον αγοραστή. Μίσθωμα ΚΑΤΩ από το αγοραίο με μακρά διάρκεια είναι πραγματική απομείωση για τον αγοραστή-χρήστη (και το αντίστροφο για τον επενδυτή: εξασφαλισμένη απόδοση). Σύγκρινε το τρέχον_μίσθωμα με το δικό σου rent_mid και σχολίασέ το. ΚΑΤΕΙΛΗΜΜΕΝΟ ΧΩΡΙΣ ΜΙΣΘΩΣΗ είναι σοβαρό πρόβλημα: μεγάλη απομείωση και caveat.
- ΤΙΤΛΟΙ / ΚΤΗΜΑΤΟΛΟΓΙΟ σε εκκρεμότητα ή ασυμφωνία, και ΚΛΗΡΟΝΟΜΙΑ ΣΕ ΕΚΚΡΕΜΟΤΗΤΑ: καθυστερούν ή μπλοκάρουν τη μεταβίβαση. Caveat και σημείωση στο advice, όχι κόψιμο της αξίας.
- ΣΥΓΚΥΡΙΟΤΗΤΑ: πολλοί ιδιοκτήτες σημαίνει δυσκολότερη πώληση και συχνά χαμηλότερο πραγματικό τίμημα. Μικρή απομείωση και αναφορά στο advice.
- ΚΕΝΟ ΠΕΔΙΟ ΣΗΜΑΙΝΕΙ ΑΓΝΩΣΤΟ, ΟΧΙ ΚΑΘΑΡΟ. Μην υποθέσεις ούτε το καλό ούτε το κακό σενάριο: πες στα missing_info τι πρέπει να ελεγχθεί.`;

/* Μετρημένος οδηγός αξίας στη Θεσσαλονίκη μετά τη λειτουργία του μετρό
   (έρευνα Cerved 2020-2024), όχι εντύπωση. Μπαίνει μόνο όταν έχει νόημα. */
const METRO_RULE = `ΕΓΓΥΤΗΤΑ ΣΕ ΣΤΑΣΗ ΜΕΤΡΟ ΘΕΣΣΑΛΟΝΙΚΗΣ (μετρημένο, μη το υπερβάλεις και μη το αγνοήσεις):
- ΚΑΤΟΙΚΙΑ: το premium είναι μέγιστο έως ~150 μ. από τη στάση και σβήνει προοδευτικά πέρα από ~350 μ. Τα παλαιότερα διαμερίσματα (δεκαετίες 1970-80) γύρω από τις στάσεις ανατιμήθηκαν περισσότερο από τον μέσο όρο του δήμου, γιατί από εκεί ξεκινούσαν χαμηλότερα.
- ΓΡΑΦΕΙΑ: ζώνη επιρροής ~350 μ., με σημαντική άνοδο μισθωμάτων στους κεντρικούς άξονες.
- ΛΙΑΝΙΚΗ: η ζώνη είναι ΣΤΕΝΟΤΕΡΗ, ~250 μ., και η αγορά ΔΕΝ επικύρωσε τις αυξήσεις που ζήτησαν οι ιδιοκτήτες — υπάρχουν κενά καταστήματα μέσα στη ζώνη επιρροής. Μην προσθέσεις premium λιανικής μόνο και μόνο επειδή υπάρχει στάση κοντά.
- Οι εμπορικοί άξονες που απέχουν πάνω από ~500 μ. (π.χ. Τσιμισκή, Μητροπόλεως) κινούνται ανεξάρτητα από το μετρό.
- Κενή απόσταση σημαίνει ότι δεν δόθηκε, όχι ότι δεν υπάρχει στάση: μην το χρησιμοποιήσεις ως αρνητικό.`;

/* Πραγματικός κανόνας από 01/07/2026 που αντιστρέφει τη διαίσθηση: στην
   1η Δημοτική Κοινότητα Θεσσαλονίκης η ΜΕΤΑΒΙΒΑΣΗ διαγράφει το ΑΜΑ και
   ο αγοραστής δεν μπορεί να το ξαναγράψει όσο ισχύει η αναστολή. */
const STR_RULE = `ΒΡΑΧΥΧΡΟΝΙΑ ΜΙΣΘΩΣΗ — ΠΡΟΣΟΧΗ, ΑΝΤΙΘΕΤΑ ΑΠΟ ΤΟ ΔΙΑΙΣΘΗΤΙΚΟ: στην 1η Δημοτική Κοινότητα του Δήμου Θεσσαλονίκης (ιστορικό κέντρο) ισχύει από 01/07/2026 αναστολή νέων εγγραφών στο Μητρώο Βραχυχρόνιας Διαμονής, και το ακίνητο ΔΙΑΓΡΑΦΕΤΑΙ από το Μητρώο όταν μεταβιβαστεί: ο αγοραστής ΔΕΝ μπορεί να το ξαναγράψει όσο ισχύει η αναστολή. Άρα «έτοιμο Airbnb με εισόδημα» στο κέντρο ΔΕΝ μεταβιβάζεται ως τέτοιο και ΔΕΝ δικαιολογεί προσαύξηση για τον αγοραστή — αν κάτι, περιορίζει τους επενδυτές-αγοραστές. Εκτός ζώνης αναστολής η καταλληλότητα για βραχυχρόνια είναι κανονικά θετικό στοιχείο. Αν το ακίνητο δεν είναι στο κέντρο της Θεσσαλονίκης, κρίνε το κανονικά και μην αναφέρεις την αναστολή.`;

/* Ό,τι δεν ξέρει ο σύμβουλος πρέπει να το ξέρει το μοντέλο ότι δεν το
   ξέρει — αλλιώς γεμίζει το κενό με το τυπικό σενάριο και βγάζει υψηλή
   βεβαιότητα πάνω σε μαντεψιά. */
const MISSING_RULE = `ΟΤΑΝ ΛΕΙΠΟΥΝ ΤΑ ΚΡΙΣΙΜΑ ΣΤΟΙΧΕΙΑ ΤΟΥ ΕΙΔΟΥΣ: μην τα υποθέσεις σιωπηλά. Πλάτυνε το εύρος low-high, ρίξε τη βεβαιότητα, γράψε στο confidence_reason ΤΙ λείπει, και βάλε στα missing_info το συγκεκριμένο στοιχείο που θα έσφιγγε το νούμερο. Μια ειλικρινής εκτίμηση με πλατύ εύρος είναι χρήσιμη· ένα στενό εύρος πάνω σε μαντεψιά είναι επικίνδυνο.`;

/* Το ΤΙ σημαίνει «εμβαδόν» και ΠΟΙΑ πεδία υπάρχουν καν αλλάζουν ανά
   είδος — γι' αυτό το αντικείμενο χτίζεται από το προφίλ και όχι με
   σταθερή λίστα. Κενά πεδία δεν στέλνονται καθόλου: το «ασανσέρ: null»
   πάνω από ένα οικόπεδο είναι θόρυβος που το μοντέλο προσπαθεί να
   ερμηνεύσει. */
function propertyForPrompt(prop) {
	const out = {
		κατηγορία: prop.category,
		είδος: prop.subcategory || null,
		περιοχή: prop.areaName || null,
		διεύθυνση: prop.address || null,
	};
	out[SIZE_KEY[prop.profile] || "εμβαδόν_τμ"] = prop.size;
	const keys = ((PROFILE_FIELDS[prop.profile] || PROFILE_FIELDS.apartment) + " " + LEGAL_FIELDS
		+ (STR_PROFILES.has(prop.profile) ? " strStatus" : "")).split(" ");
	for (const key of keys) {
		const meta = FIELD_META[key];
		const v = prop[key];
		if (!meta || v == null || v === "") continue;
		out[meta[0]] = v;
	}
	out.ζητούμενη_ή_επιθυμητή_τιμή = prop.askingPrice;
	out.μέρες_στην_αγορά = prop.daysOnMarket;
	out.παρατηρήσεις_συμβούλου = prop.notes || null;
	if (prop.missingCritical) out.ΔΕΝ_ΤΑ_ΓΝΩΡΙΖΕ_Ο_ΣΥΜΒΟΥΛΟΣ = prop.missingCritical;
	return out;
}

/* Η ΑΓΚΥΡΑ ΤΟΥ ΕΙΔΟΥΣ — ό,τι αντιστοιχεί στον πίνακα περιοχών, αλλά για
   γη και επαγγελματικά. Και τα δύο είναι ΠΑΡΑΓΩΓΑ (βλ. area-prices.mjs):
   η γη από την τιμή κατοικίας επί το μερίδιο γης, η τιμή επαγγελματικού
   από το μίσθωμα και την απόδοση. Επιστρέφει "" όταν δεν αναγνωρίζεται
   η περιοχή — τότε το μοντέλο ξέρει ότι δεν έχει άγκυρα, που είναι
   ειλικρινέστερο από ένα νούμερο χωρίς προέλευση. */
function assetAnchor(prop) {
	const unverified = ASSET_PRICES_META.verified
		? ""
		: ` ΠΡΟΣΟΧΗ: ο πίνακας αυτός είναι στην ΠΡΩΤΗ του έκδοση (${ASSET_PRICES_META.asOf}) και ΔΕΝ έχει ακόμη επαληθευτεί με τον μηνιαίο έλεγχο. Χρησιμοποίησέ τον ως αφετηρία, δώσε ΠΛΑΤΥΤΕΡΟ εύρος από ό,τι θα έδινες σε κατοικία, και ρίξε ανάλογα τη βεβαιότητα.`;

	if (prop.profile === "plot" || prop.profile === "parcel") {
		const land = landPricePerBuildableSqm(prop.areaName);
		const agri = agriPrices(prop.areaName);
		const out = [];
		if (land) {
			out.push(`ΑΞΙΑ ΓΗΣ ΣΤΗΝ ΠΕΡΙΟΧΗ — Η ΒΑΣΗ ΣΟΥ: ${land.low}-${land.high} € ΑΝΑ ΔΟΜΗΣΙΜΟ τ.μ. (ζώνη «${zoneLabel(land.zone)}»).`);
			out.push(`Πώς βγήκε: ${land.basis} ${land.sharePct}. Είναι η υπολειμματική μέθοδος ανάποδα — η γη αξίζει γνωστό κλάσμα της τιμής του τελειωμένου κτίσματος, οπότε το νούμερο κουμπώνει εξ ορισμού με τις τιμές κατοικίας της ίδιας περιοχής.`);
			out.push(`ΧΡΗΣΗ: αξία = εμβαδόν γης × συντελεστή δόμησης × αυτό το €/τ.μ. δόμησης. Διάλεξε μέσα στο εύρος με βάση πρόσωπο, σχήμα, γωνιακό, χρήσεις γης και κλίση. Χωρίς γνωστό συντελεστή δόμησης δεν μπορείς να το εφαρμόσεις — πες το ρητά και δώσε πολύ πλατύ εύρος.`);
		} else {
			out.push("ΑΞΙΑ ΓΗΣ ΣΤΗΝ ΠΕΡΙΟΧΗ: δεν αναγνωρίστηκε η περιοχή στον πίνακα, οπότε ΔΕΝ έχεις άγκυρα. Στηρίξου στην αναζήτηση και στα συγκριτικά, και ρίξε τη βεβαιότητα.");
		}
		if (agri) {
			out.push(`ΑΓΡΟΤΙΚΗ ΓΗ, νομός ${agri.prefecture} (ΜΟΝΟ αν το γήπεδο ΔΕΝ είναι οικοδομήσιμο): ξερικό ${agri.dryLow}-${agri.dryHigh} €/στρέμμα, ποτιστικό ${agri.irrigatedLow}-${agri.irrigatedHigh} €/στρέμμα. Εκεί μετράνε άρδευση, καλλιέργεια, κλίση και πρόσβαση — όχι ο συντελεστής δόμησης. Παραθαλάσσια γη με θέα είναι ΑΛΛΗ αγορά και δεν καλύπτεται από αυτά τα εύρη: κρίνε τη με την απόσταση από τη θάλασσα.`);
		}
		return [...out, unverified.trim()].filter(Boolean).join("\n");
	}

	if (prop.profile === "retail" || prop.profile === "office" || prop.profile === "industrial") {
		const c = commercialPrices(prop.areaName, prop.profile);
		if (!c) return "";
		const kindLabel = { retail: "καταστημάτων", office: "γραφείων", industrial: "αποθηκών / βιοτεχνικών χώρων" }[prop.profile];
		return [
			`ΑΓΟΡΑ ${grUpper(kindLabel)} ΣΤΗ ΖΩΝΗ «${zoneLabel(c.zone)}» — Η ΒΑΣΗ ΣΟΥ:`,
			`- Μίσθωμα τυπικού ακινήτου: ${String(c.rentLow).replace(".", ",")}-${String(c.rentHigh).replace(".", ",")} €/τ.μ./μήνα.`,
			`- Μικτή απόδοση αγοράς: ${String(c.yieldLow).replace(".", ",")}-${String(c.yieldHigh).replace(".", ",")}%.`,
			`- Τιμή πώλησης που προκύπτει: ${c.saleLow}-${c.saleHigh} €/τ.μ. (ετήσιο μίσθωμα / απόδοση).`,
			`ΧΡΗΣΗ: ξεκίνα από το ΜΙΣΘΩΜΑ — αυτό παρατηρείται στην αγορά, η τιμή πώλησης επαγγελματικού είναι σπάνιο και θορυβώδες γεγονός. Προσάρμοσε το μίσθωμα με τα χαρακτηριστικά του ακινήτου, μετά κεφαλαιοποίησε με απόδοση μέσα στο παραπάνω εύρος (χειρότερο ακίνητο = ΥΨΗΛΟΤΕΡΗ απόδοση = χαμηλότερη τιμή). Το «τυπικό» της ζώνης ΔΕΝ είναι πρώτη γραμμή κεντρικού εμπορικού δρόμου: εκεί τα μισθώματα είναι πολλαπλάσια και το δείχνεις με προσαρμογή, όχι αγνοώντας τον πίνακα.`,
			unverified.trim(),
		].filter(Boolean).join("\n");
	}

	if (prop.profile === "building") {
		const c = commercialPrices(prop.areaName, "office");
		const zone = zoneOf(prop.areaName);
		const land = landPricePerBuildableSqm(prop.areaName);
		const out = [`ΑΠΟΔΟΣΕΙΣ ΓΙΑ ΤΗΝ ΚΕΦΑΛΑΙΟΠΟΙΗΣΗ (ζώνη «${zoneLabel(zone)}»): κατοικία ${yieldText(zone, "residential")}, επαγγελματικοί χώροι ${c ? `${String(c.yieldLow).replace(".", ",")}-${String(c.yieldHigh).replace(".", ",")}%` : "—"}. Χρησιμοποίησε το εύρος ανάλογα με την πληρότητα και την ποιότητα των μισθώσεων.`];
		if (land) out.push(`ΑΞΙΑ ΓΗΣ ΓΙΑ ΤΟΝ ΕΛΕΓΧΟ ΑΝΑΠΤΥΞΗΣ: ${land.low}-${land.high} € ανά δομήσιμο τ.μ. Σε κεντρικό οικόπεδο, παλιό κτίριο μπορεί να αξίζει ως ΓΗ περισσότερο από ό,τι ως εισόδημα — έλεγξέ το.`);
		return [...out, unverified.trim()].filter(Boolean).join("\n");
	}

	return "";
}

/* Η απόδοση της ζώνης για ένα είδος, ως κείμενο με ελληνικό δεκαδικό. */
function yieldText(zone, kind) {
	const y = (YIELDS[kind] || {})[zone];
	return y ? `${String(y.low).replace(".", ",")}-${String(y.high).replace(".", ",")}%` : "—";
}

function buildDataBlock(prop, comps, stats, priceRow, offers) {
	const lines = [];
	lines.push(PURPOSE_BRIEF[prop.purpose] || PURPOSE_BRIEF.both);
	lines.push("");
	lines.push(METHOD_BRIEF[prop.profile] || METHOD_BRIEF.apartment);
	lines.push("");
	lines.push("ΤΟ ΑΚΙΝΗΤΟ ΠΡΟΣ ΕΚΤΙΜΗΣΗ:");
	lines.push(JSON.stringify(propertyForPrompt(prop)));
	lines.push("");
	lines.push(LEGAL_RULES);
	if (prop.missingCritical) {
		lines.push("");
		lines.push(MISSING_RULE);
	}
	if (prop.metroDistanceM || /θεσσαλον/i.test(prop.areaName || "")) {
		lines.push("");
		lines.push(METRO_RULE);
	}
	if (STR_PROFILES.has(prop.profile)) {
		lines.push("");
		lines.push(STR_RULE);
	}
	lines.push("");
	lines.push(`ΤΙΜΕΣ ΠΕΡΙΟΧΩΝ (ζητούμενες, €/τ.μ. πώληση και €/τ.μ./μήνα ενοικίαση, ${AREA_PRICES_META.asOf}):`);
	if (priceRow) lines.push("Κοντινότερη περιοχή του πίνακα: " + JSON.stringify(priceRow));
	lines.push(JSON.stringify(AREA_PRICES));
	lines.push(`Πηγή πίνακα: ${AREA_PRICES_META.source}`);
	/* Ο πίνακας είναι ΚΑΤΟΙΚΙΩΝ (βλ. area-prices.mjs). Χωρίς αυτή τη
	   γραμμή το μοντέλο τον χρησιμοποιούσε ως βάση €/τ.μ. και για
	   οικόπεδο, κατάστημα ή αποθήκη — δηλαδή έβγαζε αξία γης σε τιμές
	   έτοιμου διαμερίσματος. */
	if (prop.profile !== "apartment" && prop.profile !== "house" && prop.profile !== "villa" && prop.profile !== "building") {
		lines.push("ΠΡΟΣΟΧΗ ΣΤΗ ΧΡΗΣΗ ΤΟΥ ΠΙΝΑΚΑ: τα εύρη αφορούν ΚΑΤΟΙΚΙΕΣ (τυπικό διαμέρισμα της περιοχής). Το ακίνητο που εκτιμάς ΔΕΝ είναι κατοικία, οπότε ο πίνακας ΔΕΝ είναι η βάση σου — είναι μόνο δείκτης του γενικού επιπέδου τιμών της περιοχής. Η βάση σου είναι ο πίνακας του είδους σου παρακάτω.");
	}
	const anchor = assetAnchor(prop);
	if (anchor) {
		lines.push("");
		lines.push(anchor);
	}
	if (AREA_PRICES_META.trend) {
		lines.push(`ΤΑΣΗ ΑΓΟΡΑΣ (δημοσιευμένοι δείκτες): ${AREA_PRICES_META.trend}`);
		lines.push("Χρήση της τάσης: πλαισίωσε με αυτήν το market_comment και το advice (σε ανοδική αγορά η υποτιμολόγηση χαρίζει αξία του ιδιοκτήτη· σε πτωτική, το φουσκωμένο ζητούμενο παλιώνει την αγγελία). ΜΗΝ την εφαρμόσεις ως πρόσθετο συντελεστή πάνω στη βάση, στα εύρη ή στις προσαρμογές: οι τρέχουσες ζητούμενες τιμές την ενσωματώνουν ήδη, θα μετρούσες το ίδιο πράγμα δύο φορές.");
	}
	lines.push("");
	const compRow = (l) => ({
		κωδικός: l.code, περιοχή: (l.location || {}).area || null,
		είδος: labelKind(l.subcategory, l.category) || null, τμ: l.area, τιμή: l.price,
		ανά_τμ: Math.round(l.price / l.area), όροφος: l.floor || null,
		έτος: l.yearBuilt || null, ενεργειακή: l.energyClass || null,
		κατάσταση: l.condition || null,
		μέρες_στην_αγορά: daysSince(l.listedAt),
	});
	/* Σε γη και σε θέση στάθμευσης δεν ανακαινίζεται τίποτα: ο πίνακας
	   κόστους είναι σκέτος θόρυβος (και tokens) που το μοντέλο μπαίνει
	   στον πειρασμό να χρησιμοποιήσει. */
	if (!NO_RENOVATION.has(prop.profile)) {
		lines.push(`ΕΝΔΕΙΚΤΙΚΑ ΚΟΣΤΗ ΑΝΑΚΑΙΝΙΣΗΣ (€/τ.μ., ${RENOVATION_COSTS_META.asOf} — ${RENOVATION_COSTS_META.source}):`);
		lines.push(JSON.stringify(RENOVATION_COSTS));
		lines.push("");
	}
	lines.push(`ΣΥΓΚΡΙΤΙΚΑ ΠΩΛΗΣΗΣ ΑΠΟ ΤΟ ΧΑΡΤΟΦΥΛΑΚΙΟ ΜΑΣ (${comps.sale.length}):`);
	lines.push(JSON.stringify(comps.sale.map(compRow)));
	lines.push(`ΣΥΓΚΡΙΤΙΚΑ ΕΝΟΙΚΙΑΣΗΣ (${comps.rent.length}):`);
	lines.push(JSON.stringify(comps.rent.map(compRow)));
	if (comps.loose && (comps.sale.length || comps.rent.length)) {
		lines.push("ΠΡΟΣΟΧΗ: δεν βρέθηκε ΚΑΝΕΝΑ συγκριτικό ίδιου είδους στην περιοχή, οπότε τα παραπάνω είναι απλώς ίδιας κατηγορίας (π.χ. κατάστημα δίπλα σε αποθήκη, ή οικόπεδο δίπλα σε αγροτεμάχιο). Το €/τ.μ. τους ΔΕΝ είναι συγκρίσιμο — χρησιμοποίησέ τα μόνο ως ένδειξη επιπέδου περιοχής, στηρίξου στην αναζήτηση, και πες το στο comps_comment και στη βεβαιότητα.");
	} else if (!comps.sale.length && !comps.rent.length) {
		lines.push("ΔΕΝ ΥΠΑΡΧΟΥΝ ΣΥΓΚΡΙΤΙΚΑ ΣΤΟ ΧΑΡΤΟΦΥΛΑΚΙΟ ΜΑΣ για αυτό το είδος στην περιοχή. Στηρίξου στην αναζήτηση και στη μέθοδο του είδους, δήλωσέ το στο comps_comment και ρίξε ανάλογα τη βεβαιότητα.");
	}
	if (stats.sale) lines.push(`Διάμεσος ζητούμενη €/τ.μ. πώλησης στο ενεργό στοκ μας για την περιοχή: ${Math.round(stats.sale.median)} (${stats.sale.count} ακίνητα).`);
	if (stats.rent) lines.push(`Διάμεσος ζητούμενη €/τ.μ./μήνα ενοικίασης: ${stats.rent.median.toFixed(1)} (${stats.rent.count} ακίνητα).`);
	const offerRows = Array.isArray(offers) ? offers : [];
	if (offerRows.length) {
		const ask = prop.askingPrice;
		lines.push("");
		lines.push(`ΠΡΑΓΜΑΤΙΚΕΣ ΠΡΟΣΦΟΡΕΣ ΓΙΑ ΑΥΤΟ ΤΟ ΑΚΙΝΗΤΟ (${offerRows.length}):`);
		lines.push(JSON.stringify(offerRows.map((o) => ({
			ποσό: o.amount,
			απόσταση_από_ζητούμενη: ask && o.amount ? `${Math.round(((o.amount - ask) / ask) * 100)}%` : null,
			κατάσταση: OFFER_STATUS_EL[o.status] || o.status || null,
			πριν_μέρες: daysSince(o.date),
			γύροι_διαπραγμάτευσης: o.rounds,
		}))));
		lines.push(`ΠΩΣ ΔΙΑΒΑΖΟΝΤΑΙ ΟΙ ΠΡΟΣΦΟΡΕΣ — προσοχή, είναι το ΙΣΧΥΡΟΤΕΡΟ και το πιο επικίνδυνο δεδομένο εδώ:
- Είναι το ΜΟΝΟ στοιχείο που δείχνει τι ΔΙΝΕΙ ο αγοραστής· όλα τα άλλα (πίνακας, συγκριτικά, δείκτες) είναι ΖΗΤΟΥΜΕΝΕΣ τιμές. Μια προσφορά «ΕΓΙΝΕ ΔΕΚΤΗ» είναι πρακτικά τιμή κλεισίματος: βάρυνέ τη ΠΑΝΩ ΑΠΟ ΟΛΑ τα άλλα και πες το στο comps_comment.
- ΜΙΑ μεμονωμένη χαμηλή προσφορά ΔΕΝ είναι η αξία. Οι αγοραστές ψαρεύουν, και μια προσφορά μείον 30% δείχνει τι δοκίμασε κάποιος, όχι τι αξίζει το ακίνητο. Μην κατεβάσεις την εκτίμηση σε μία απορριφθείσα προσφορά.
- ΤΟ ΜΟΤΙΒΟ ΜΕΤΡΑΕΙ, ΟΧΙ Η ΜΕΜΟΝΩΜΕΝΗ: πολλές ανεξάρτητες προσφορές που μαζεύονται γύρω από το ίδιο επίπεδο, σε ακίνητο που κάθεται καιρό, είναι ισχυρή ένδειξη ότι η αγορά τιμολογεί εκεί. Τότε ναι, φέρε την εκτίμηση προς τα εκεί και γράψε το ρητά στο confidence_reason.
- Απορριφθείσα ή αποσυρμένη σημαίνει ότι ο ΙΔΙΟΚΤΗΤΗΣ δεν δέχτηκε, όχι ότι η αξία είναι εκεί. Πρόχειρη προσφορά αγνοείται.
- Στο advice: αν υπάρχουν προσφορές, ο σύμβουλος πάει στη συζήτηση με πραγματικά νούμερα στο χέρι. Πες του πώς να τα χρησιμοποιήσει.`);
	} else if (prop.fromCrm) {
		lines.push("");
		lines.push("ΠΡΟΣΦΟΡΕΣ ΓΙΑ ΑΥΤΟ ΤΟ ΑΚΙΝΗΤΟ: καμία καταγεγραμμένη. ΠΡΟΣΟΧΗ: η καταγραφή προσφορών στο CRM ξεκίνησε στις 03/08/2026, οπότε το κενό ΔΕΝ σημαίνει «κανείς δεν έδειξε ενδιαφέρον» — μην το χρησιμοποιήσεις ως αρνητικό επιχείρημα ούτε το αναφέρεις στο report.");
	}
	lines.push("");
	lines.push(`ΠΩΣ ΔΙΑΒΑΖΕΤΑΙ ΤΟ «μέρες_στην_αγορά» (πόσο καιρό είναι καταχωρισμένο, με τη σημερινή ζητούμενη):
- Είναι ΖΩΝΤΑΝΗ ΑΠΑΝΤΗΣΗ ΤΗΣ ΑΓΟΡΑΣ, το μόνο δεδομένο εδώ που δείχνει τι ΔΕΝ δέχτηκε ο αγοραστής. Ακίνητο που κάθεται πολύ (πάνω από ~180 μέρες για κατοικία) με ζητούμενη πάνω από την εκτίμησή σου επιβεβαιώνει την εκτίμηση: η αγορά την έχει ήδη απορρίψει. Γράψ' το στο advice ως επιχείρημα προς τον ιδιοκτήτη («το ακίνητο είναι X μήνες στην αγορά χωρίς να κλείσει, αυτό μας το λέει η ίδια η αγορά»), ΟΧΙ ως κατηγορία εναντίον του.
- ΔΕΝ μειώνει την αξία από μόνο του. Ο χρόνος δείχνει ότι η ΖΗΤΟΥΜΕΝΗ είναι ψηλά, όχι ότι το ακίνητο αξίζει λιγότερο. Μην κόψεις την εκτίμηση επειδή κάθεται· κόψε την επειδή το λένε τα συγκριτικά και τα χαρακτηριστικά.
- ΣΤΑΘΜΙΣΗ ΣΥΓΚΡΙΤΙΚΩΝ: ένα συγκριτικό που κάθεται πολλούς μήνες αποδεικνύει μόνο ότι κάποιος ΖΗΤΑΕΙ αυτή την τιμή, όχι ότι η αγορά τη δίνει. Βάρυνε περισσότερο τα φρέσκα (κάτω από ~90 μέρες) και ανάφερέ το στο comps_comment όταν τα ακριβά συγκριτικά είναι και τα πιο λιμνασμένα.
- Λίγες μέρες δεν σημαίνει τίποτα: πολύ φρέσκια αγγελία δεν έχει προλάβει να δοκιμαστεί. Κενό (null) σημαίνει ότι δεν είναι δικό μας καταχωρισμένο ακίνητο, αγνόησέ το.`);
	return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* AI providers (Claude αν υπάρχει κλειδί, αλλιώς Gemini)               */
/* ------------------------------------------------------------------ */

/* opts.search: δίνει στο μοντέλο εργαλείο web search. Το χρησιμοποιεί ΜΟΝΟ
   το πρώτο πέρασμα, για να δει τις τρέχουσες αγγελίες της συγκεκριμένης
   περιοχής — αντισταθμίζει το μικρό μας στοκ εκεί που δεν έχουμε
   συγκριτικά. Ο ελεγκτής (πέρασμα 2) δουλεύει πάνω σε ό,τι βρέθηκε. */
/* ΠΟΙΟΣ PROVIDER — ΡΗΤΑ, ΟΧΙ ΣΙΩΠΗΡΑ
   Ήταν «αν υπάρχει κλειδί Anthropic, Claude». Δηλαδή τη μέρα που θα
   έμπαινε κλειδί Anthropic στον Worker για οποιονδήποτε ΑΛΛΟ λόγο, η
   εκτίμηση θα γυρνούσε μόνη της σε Claude και το κόστος ανά report θα
   τριπλασιαζόταν — χωρίς να το ζητήσει και χωρίς να το δει κανείς,
   γιατί τίποτα δεν θα έσπαγε. Τώρα: `VALUATION_PROVIDER` (gemini |
   claude) το αποφασίζει· χωρίς αυτό προτιμάται το Gemini όταν υπάρχει
   κλειδί του, που είναι ό,τι τρέχει σήμερα. Η μετάβαση σε Claude είναι
   απόφαση, όχι παρενέργεια. */
function askAI(env, system, user, opts) {
	const wanted = String(env.VALUATION_PROVIDER || "").trim().toLowerCase();
	if (wanted === "claude") {
		if (env.ANTHROPIC_API_KEY) return askClaude(env, system, user, opts);
		console.warn("valuation: VALUATION_PROVIDER=claude but no ANTHROPIC_API_KEY, falling back to Gemini");
		return askGemini(env, system, user, opts);
	}
	if (wanted === "gemini") {
		if (env.GEMINI_API_KEY) return askGemini(env, system, user, opts);
		console.warn("valuation: VALUATION_PROVIDER=gemini but no GEMINI_API_KEY, falling back to Claude");
		return askClaude(env, system, user, opts);
	}
	return env.GEMINI_API_KEY ? askGemini(env, system, user, opts) : askClaude(env, system, user, opts);
}

/* Κλήση + parsing με ΕΝΑ retry. Τα μοντέλα αποτυγχάνουν σποραδικά
   (κομμένο/άκυρο JSON, 5xx) και μια δεύτερη προσπάθεια συνήθως περνά·
   το κόστος είναι φραγμένο (το πολύ 2× ανά πέρασμα) ενώ ένα 502 στη
   φόρμα σημαίνει ο σύμβουλος ξαναπατά το κουμπί = ίδια χρέωση ΚΑΙ
   χαμένος χρόνος. Σφάλμα και στις δύο = πραγματικό πρόβλημα, 502. */
async function askJson(env, system, user, opts) {
	let lastErr;
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			return extractJson(await askAI(env, system, user, opts));
		} catch (err) {
			lastErr = err;
			console.warn(`valuation: attempt ${attempt} failed: ${String(err).slice(0, 160)}`);
		}
	}
	throw lastErr;
}

async function askGemini(env, system, user, opts) {
	const model = env.VALUATION_GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
	const search = !!(opts && opts.search);
	const res = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
		method: "POST",
		headers: {
			"x-goog-api-key": env.GEMINI_API_KEY,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			system_instruction: { parts: [{ text: system }] },
			contents: [{ role: "user", parts: [{ text: user }] }],
			// responseMimeType: εγγυημένο σκέτο JSON — αλλά ΔΕΝ συνδυάζεται
			// με tools, οπότε το πέρασμα-με-αναζήτηση βασίζεται στο
			// extractJson. ΠΡΟΣΟΧΗ στο maxOutputTokens: στο 3.5 Flash είναι
			// κοινός κουμπαράς για τη «σκέψη» ΚΑΙ το JSON — στα 8000 που
			// είχαμε, το JSON γύριζε κομμένο στη μέση.
			...(search ? { tools: [{ google_search: {} }] } : {}),
			generationConfig: {
				maxOutputTokens: 32000,
				/* ΝΤΕΤΕΡΜΙΝΙΣΜΟΣ, ΟΧΙ ΕΜΠΝΕΥΣΗ. Χωρίς temperature το Flash
				   τρέχει στο προεπιλεγμένο 1,0 — δηλαδή δειγματοληψία σαν να
				   γράφει κείμενο. Στις πρώτες πραγματικές δοκιμές το ίδιο
				   ακίνητο έδωσε 612.000 και 684.000 σε δύο εκτελέσεις (±12%)
				   με ΤΑ ΙΔΙΑ δεδομένα. Μια εκτίμηση δεν επιτρέπεται να
				   αλλάζει επειδή ξαναπατήθηκε το κουμπί. */
				temperature: VALUATION_TEMPERATURE,
				...(search ? {} : { responseMimeType: "application/json" }),
			},
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

async function askClaude(env, system, user, opts) {
	const search = !!(opts && opts.search);
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
			// Ίδιος λόγος με το Gemini: η εκτίμηση θέλει σταθερότητα, όχι ποικιλία.
			temperature: VALUATION_TEMPERATURE,
			// Web search: server-side tool, τρέχει στην Anthropic — καμία
			// αλλαγή στον βρόχο μας. Το max_uses κρατά κόστος/χρόνο φραγμένα.
			...(search ? { tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }] } : {}),
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

/* Ελληνικά κεφαλαία ΧΩΡΙΣ τόνους (κανόνας του repo). Το σκέτο
   toUpperCase() κρατά τον τόνο («υψηλή» → «ΥΨΗΛΉ») — λάθος. */
/* Η βεβαιότητα είναι enum τριών λέξεων, αλλά τα μοντέλα γράφουν και
   συνώνυμα («μέση» αντί «μέτρια») — φάνηκε στις πραγματικές δοκιμές.
   Το κανονικοποιούμε ΕΔΩ και όχι μόνο στο prompt: το ιστορικό
   εκτιμήσεων φιλτράρεται σε αυτή τη λέξη, και δύο ορθογραφίες για το
   ίδιο πράγμα το κάνουν άχρηστο. Άγνωστη τιμή περνά αυτούσια. */
const CONFIDENCE_ALIAS = {
	"μέση": "μέτρια", "μεσαία": "μέτρια", "μετρια": "μέτρια", "μέτρια": "μέτρια",
	"υψηλή": "υψηλή", "υψηλη": "υψηλή", "μεγάλη": "υψηλή",
	"χαμηλή": "χαμηλή", "χαμηλη": "χαμηλή", "μικρή": "χαμηλή",
};

function normConfidence(s) {
	const key = String(s == null ? "" : s).trim().toLowerCase();
	return CONFIDENCE_ALIAS[key] || String(s == null ? "" : s).trim();
}

function grUpper(s) {
	return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

/* Η βεβαιότητα με ΧΡΩΜΑ, όχι μόνο με λέξη. Το report διαβάζεται στο
   κινητό ανάμεσα σε δύο ραντεβού: μια «χαμηλή» γραμμένη με τα ίδια
   μαύρα γράμματα όπως η «υψηλή» δεν διαβάζεται, και το νούμερο ταξιδεύει
   σαν να ήταν σίγουρο. Τα ίδια τρία χρώματα σε email, PDF, φόρμα και
   ιστορικό (ο δίδυμος πίνακας CONF_STYLE στο forms/ektimisi.html).
   Άγνωστη λέξη → γκρι, ποτέ πράσινο: το αδιάγνωστο δεν είναι καλό νέο. */
const CONFIDENCE_STYLE = {
	"υψηλή": { fill: "#12855b", bg: "#f2f9f4", border: "#b7dfc5", steps: 3 },
	"μέτρια": { fill: "#b26a00", bg: "#fff8e8", border: "#f0d3a0", steps: 2 },
	"χαμηλή": { fill: "#c62828", bg: "#fff4f6", border: "#f2b8c6", steps: 1 },
};
const CONFIDENCE_UNKNOWN = { fill: "#6b7280", bg: "#f7f8fa", border: "#e3e6eb", steps: 0 };

function confStyle(conf) {
	return CONFIDENCE_STYLE[normConfidence(conf)] || CONFIDENCE_UNKNOWN;
}

/* Το χρώμα το βλέπει μόνο όποιος το βλέπει: σε ασπρόμαυρη εκτύπωση, και
   σε ματιά που δεν ξεχωρίζει κόκκινο από πράσινο (~8% των αντρών), τρία
   γεμάτα τετραγωνάκια έναντι ενός λένε την ίδια ιστορία χωρίς χρώμα.
   Πίνακας και όχι div/span: είναι το μόνο που στοιχίζεται παντού σε
   Outlook και Gmail. */
function confPill(conf) {
	const cs = confStyle(conf);
	const word = grUpper(normConfidence(conf)) || "ΑΓΝΩΣΤΗ";
	// Το χρώμα στο div και όχι στο td: το κελί τεντώνεται στο ύψος της
	// γραμμής (όσο η πινακίδα) και θα έβγαζε τετράγωνα αντί για μπάρες.
	const seg = (on) => `<td width="20" valign="middle" style="font-size:0; line-height:0;"><div style="height:5px; background:${on ? cs.fill : "#dfe3e8"}; border-radius:3px; font-size:0; line-height:0;">&nbsp;</div></td>`;
	return `<table role="presentation" cellpadding="0" cellspacing="0"><tr>
		<td style="background:${cs.fill}; border-radius:11px; padding:3px 11px; font-size:12px; font-weight:bold; letter-spacing:1px; color:#ffffff; white-space:nowrap;">${esc(word)}</td>
		<td width="12"></td>
		${[0, 1, 2].map((i) => seg(i < cs.steps)).join(`<td width="3"></td>`)}
	</tr></table>`;
}

/* Η ίδια πινακίδα σε μία γραμμή, για τον πίνακα του ιστορικού. */
function confChip(conf) {
	const cs = confStyle(conf);
	const word = grUpper(normConfidence(conf)) || "—";
	return `<span style="display:inline-block; background:${cs.fill}; border-radius:10px; padding:2px 9px; font-size:11px; font-weight:bold; letter-spacing:.5px; color:#ffffff; white-space:nowrap;">${esc(word)}</span>`;
}

function eur(n) {
	if (!Number.isFinite(Number(n))) return "";
	return "€" + String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/* «Τα στοιχεία που δόθηκαν», ανά προφίλ. Ίδια σειρά και ίδιες ετικέτες
   με ό,τι διάβασε το μοντέλο — ο σύμβουλος πρέπει να μπορεί να ελέγξει
   με τι δουλεύτηκε το νούμερο. */
function factRows(prop) {
	const rows = [
		["Είδος", prop.subcategory || labelCategory(prop.category)],
		["Περιοχή", prop.areaName], ["Διεύθυνση", prop.address],
		[SIZE_LABEL[prop.profile] || "Εμβαδόν", prop.size ? `${prop.size} τ.μ.` : ""],
	];
	const keys = ((PROFILE_FIELDS[prop.profile] || PROFILE_FIELDS.apartment) + " " + LEGAL_FIELDS
		+ (STR_PROFILES.has(prop.profile) ? " strStatus" : "")).split(" ");
	for (const key of keys) {
		const meta = FIELD_META[key];
		const value = prop[key];
		if (!meta || value == null || value === "") continue;
		rows.push([meta[1], `${value}${meta[2] || ""}`]);
	}
	rows.push(["Ζητούμενη/επιθυμητή τιμή", prop.askingPrice ? eur(prop.askingPrice) : ""]);
	return rows;
}

function renderReport(prop, comps, stats, priceRow, v, payload, offers) {
	const identity = [
		prop.subcategory || labelCategory(prop.category),
		prop.size ? `${prop.size} τ.μ.` : "",
		prop.areaName,
		prop.listingCode ? `κωδ. ${prop.listingCode}` : "",
	].filter(Boolean).join(" · ");

	const subject = `ΕΚΤΙΜΗΣΗ · ${identity}`;

	/* Σε γη το «€/τ.μ.» χωρίς προσδιορισμό είναι διφορούμενο και μπερδεύει
	   ακριβώς εκεί που κρίνεται η εκτίμηση: το ένα είναι ανά τ.μ. γης, το
	   άλλο ανά δομήσιμο τ.μ., και διαφέρουν όσο ο συντελεστής δόμησης. */
	const isLand = prop.profile === "plot" || prop.profile === "parcel";
	const perSqmLabel = isLand ? "/τ.μ. γης" : "/τ.μ.";
	const buildableNote = isLand && Number(v.eur_per_buildable_sqm)
		? ` · ${eur(v.eur_per_buildable_sqm)}/τ.μ. δόμησης${Number(v.buildable_sqm) ? ` (${Math.round(v.buildable_sqm)} τ.μ. δομήσιμα)` : ""}`
		: "";

	/* ΑΙΡΕΣΕΙΣ: ό,τι κρέμεται πάνω από τη μεταβίβαση ή την ίδια την τιμή
	   (αυθαίρετο χωρίς τακτοποίηση, μη οικοδομήσιμο γήπεδο, ψιλή
	   κυριότητα). Μπαίνουν ΑΜΕΣΩΣ κάτω από το νούμερο, όχι στο υποσέλιδο:
	   το νούμερο δεν πρέπει να ταξιδεύει χωρίς αυτές. Στο έγγραφο του
	   ιδιοκτήτη δεν τυπώνονται — τη συζήτηση την ανοίγει ο σύμβουλος. */
	const caveats = (Array.isArray(v.caveats) ? v.caveats : []).filter(Boolean);

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

	// Ένας πίνακας ανά πράξη, μόνο για ό,τι τυπώνεται (docComps): πώληση,
	// ενοικίαση, ή και τα δύο χωριστά.
	const docRows = docComps(comps, prop.purpose);
	const compSections = compGroups(docRows).map((g) => `<tr><td style="padding:18px 20px 0;">
		<div style="font-size:12px; font-weight:bold; letter-spacing:1px; color:${NAVY}; margin-bottom:6px;">${g.title}</div>
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceef2; border-radius:6px;">${g.rows.map((c) => `<tr>
			<td style="padding:6px 10px; border-bottom:1px solid #eceef2; font-size:12px; color:${NAVY};">${esc(c.code || "")}</td>
			<td style="padding:6px 10px; border-bottom:1px solid #eceef2; font-size:12px; color:${NAVY};">${esc([c.kind, c.area].filter(Boolean).join(", "))}</td>
			<td style="padding:6px 10px; border-bottom:1px solid #eceef2; font-size:12px; text-align:right;">${c.sqm} τ.μ.</td>
			<td style="padding:6px 10px; border-bottom:1px solid #eceef2; font-size:12px; text-align:right; font-weight:bold;">${compPrice(c.price, g.transaction)}</td>
			<td style="padding:6px 10px; border-bottom:1px solid #eceef2; font-size:12px; text-align:right; color:#6b7280;">${compPerSqm(c.price, c.sqm, g.transaction)}</td>
		</tr>`).join("")}</table>
	</td></tr>`).join("");

	// Οι προσφορές μπαίνουν ΜΟΝΟ στην αναφορά γραφείου. Ο σύμβουλος πρέπει
	// να τις έχει μπροστά του με νούμερα, όχι μόνο μέσα σε μια πρόταση του
	// μοντέλου· το έγγραφο του ιδιοκτήτη μένει καθαρό (buildClientDoc).
	const offerRows = (Array.isArray(offers) ? offers : []).map((o) => {
		const diff = prop.askingPrice && o.amount
			? Math.round(((o.amount - prop.askingPrice) / prop.askingPrice) * 100)
			: null;
		const accepted = o.status === "accepted";
		const days = daysSince(o.date);
		return `<tr${accepted ? ' style="background:#f2f9f4;"' : ""}>
			<td style="padding:6px 10px; border-bottom:1px solid #eceef2; font-size:12px; text-align:right; font-weight:bold; color:${NAVY};">${eur(o.amount)}</td>
			<td style="padding:6px 10px; border-bottom:1px solid #eceef2; font-size:12px; text-align:right; color:${diff == null ? "#6b7280" : (diff < 0 ? "#c62828" : "#2e9e5b")};">${diff == null ? "" : (diff > 0 ? "+" : "") + diff + "%"}</td>
			<td style="padding:6px 10px; border-bottom:1px solid #eceef2; font-size:12px; color:${accepted ? "#2e9e5b" : NAVY};">${accepted ? "<strong>" : ""}${esc(OFFER_STATUS_EL[o.status] || o.status || "")}${accepted ? "</strong>" : ""}</td>
			<td style="padding:6px 10px; border-bottom:1px solid #eceef2; font-size:12px; color:#6b7280;">${days == null ? "" : `πριν ${days} μέρες`}${o.rounds > 1 ? ` · ${o.rounds} γύροι` : ""}</td>
		</tr>`;
	}).join("");

	const missing = (Array.isArray(v.missing_info) ? v.missing_info : []).filter(Boolean);
	/* Ο πίνακας των στοιχείων ακολουθεί το ΠΡΟΦΙΛ, όπως και η φόρμα: κάτω
	   από ένα οικόπεδο δεν τυπώνεται «Ασανσέρ», και κάτω από ένα κατάστημα
	   τυπώνονται τα μέτρα της βιτρίνας. Ίδια πηγή (PROFILE_FIELDS +
	   FIELD_META) με το prompt, ώστε report και εκτίμηση να μη διαφωνούν. */
	const propFacts = factRows(prop)
		.filter(([, val]) => val).map(([k, val]) =>
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
				<div style="font-size:13px; color:${NAVY}; margin-top:2px;">εύρος ${eur(v.value_low)} έως ${eur(v.value_high)} · ${eur(v.eur_per_sqm)}${perSqmLabel}${buildableNote}</div>
			</td>
		</tr></table>
	</td></tr>` : ""}
	${caveats.length ? `<tr><td style="padding:12px 20px 0;">
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
			<td style="background:#fff4f6; border:1px solid #f2b8c6; border-left:3px solid #c62828; border-radius:8px; padding:11px 14px;">
				<div style="font-size:11px; font-weight:bold; letter-spacing:1px; color:#c62828;">ΥΠΟ ΑΙΡΕΣΗ</div>
				<div style="font-size:12.5px; color:${NAVY}; line-height:1.6; margin-top:3px;">${caveats.map((c) => `• ${esc(c)}`).join("<br>")}</div>
			</td>
		</tr></table>
	</td></tr>` : ""}
	${wantsRent ? `<tr><td style="padding:10px 20px 0;">
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
			<td style="background:#f4f7fb; border:1px solid #c9d4e4; border-radius:8px; padding:12px 16px;">
				<div style="font-size:11px; font-weight:bold; letter-spacing:1px; color:#6b7280;">ΕΚΤΙΜΩΜΕΝΟ ΜΙΣΘΩΜΑ</div>
				<div style="font-size:19px; font-weight:bold; color:${NAVY}; margin-top:2px;">${eur(v.rent_mid)}/μήνα <span style="font-weight:normal; font-size:13px; color:#6b7280;">(εύρος ${eur(v.rent_low)} έως ${eur(v.rent_high)})</span></div>
				${Number(v.gross_yield_pct) ? `<div style="font-size:12.5px; color:#6b7280; margin-top:2px;">Μικτή απόδοση ~${esc(String(v.gross_yield_pct).replace(".", ","))}% ${wantsSale ? "στην εκτιμώμενη αξία" : `σε εκτιμώμενη αξία ${eur(v.value_mid)}`}</div>` : ""}
			</td>
		</tr></table>
	</td></tr>` : ""}
	${prop.askingPrice && v.asking_comment ? `<tr><td style="padding:12px 20px 0;">
		<div style="background:#f7f8fa; border-left:3px solid ${PINK}; border-radius:6px; padding:10px 14px; font-size:13px; line-height:1.55; color:${NAVY};"><strong>Σε σχέση με τη ζητούμενη (${eur(prop.askingPrice)}${wantsSale ? "" : "/μήνα"}):</strong> ${esc(v.asking_comment)}</div>
	</td></tr>` : ""}
	${adjRows ? `<tr><td style="padding:18px 20px 0;">
		<div style="font-size:12px; font-weight:bold; letter-spacing:1px; color:${NAVY}; margin-bottom:6px;">ΠΩΣ ΒΓΗΚΕ ΤΟ ΝΟΥΜΕΡΟ${v.method ? ` · ${esc(grUpper(v.method))}` : ""}</div>
		<div style="font-size:12.5px; color:#444; margin-bottom:6px;">Αφετηρία ${eur(v.base_eur_per_sqm)}${perSqmLabel} ${wantsSale ? "για την περιοχή" : "αξίας για την περιοχή (από εκεί βγαίνει το μίσθωμα, με την απόδοση)"}, με τις εξής προσαρμογές:</div>
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceef2; border-radius:6px;">${adjRows}</table>
	</td></tr>` : ""}
	${offerRows ? `<tr><td style="padding:18px 20px 0;">
		<div style="font-size:12px; font-weight:bold; letter-spacing:1px; color:${NAVY}; margin-bottom:6px;">ΠΡΑΓΜΑΤΙΚΕΣ ΠΡΟΣΦΟΡΕΣ ΓΙΑ ΤΟ ΑΚΙΝΗΤΟ</div>
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceef2; border-radius:6px;">
			<tr>
				<td style="padding:6px 10px; font-size:11px; font-weight:bold; color:#6b7280; text-align:right;">ΠΟΣΟ</td>
				<td style="padding:6px 10px; font-size:11px; font-weight:bold; color:#6b7280; text-align:right;">ΑΠΟ ΖΗΤΟΥΜΕΝΗ</td>
				<td style="padding:6px 10px; font-size:11px; font-weight:bold; color:#6b7280;">ΚΑΤΑΣΤΑΣΗ</td>
				<td style="padding:6px 10px; font-size:11px; font-weight:bold; color:#6b7280;">ΠΟΤΕ</td>
			</tr>
			${offerRows}
		</table>
		<div style="font-size:11.5px; color:#6b7280; margin-top:6px; line-height:1.5;">Το μόνο στοιχείο εδώ που δείχνει τι <strong>δίνει</strong> ο αγοραστής· όλα τα υπόλοιπα είναι ζητούμενες τιμές. Μία χαμηλή προσφορά είναι ψάρεμα, πολλές γύρω από το ίδιο επίπεδο είναι η απάντηση της αγοράς.</div>
	</td></tr>` : ""}
	${compSections}
	${v.comps_comment ? `<tr><td style="padding:${compSections ? "6px" : "18px"} 20px 0;">
		${compSections ? "" : `<div style="font-size:12px; font-weight:bold; letter-spacing:1px; color:${NAVY}; margin-bottom:6px;">ΤΙ ΔΕΙΧΝΟΥΝ ΤΑ ΣΥΓΚΡΙΤΙΚΑ</div>`}
		<div style="font-size:12px; color:#6b7280; line-height:1.5;">${esc(v.comps_comment)}</div>
	</td></tr>` : ""}
	${v.market_comment ? `<tr><td style="padding:18px 20px 0;">
		<div style="font-size:12px; font-weight:bold; letter-spacing:1px; color:${NAVY}; margin-bottom:6px;">Η ΑΓΟΡΑ</div>
		<div style="font-size:13px; color:#444; line-height:1.6;">${esc(v.market_comment)}</div>
	</td></tr>` : ""}
	<tr><td style="padding:18px 20px 0;">
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
			<td style="background:${confStyle(v.confidence).bg}; border:1px solid ${confStyle(v.confidence).border}; border-left:3px solid ${confStyle(v.confidence).fill}; border-radius:8px; padding:11px 14px;">
				<div style="font-size:11px; font-weight:bold; letter-spacing:1px; color:#6b7280; margin-bottom:6px;">ΒΕΒΑΙΟΤΗΤΑ ΕΚΤΙΜΗΣΗΣ</div>
				${confPill(v.confidence)}
				<div style="font-size:12.5px; color:#444; line-height:1.55; margin-top:8px;">${esc(v.confidence_reason || "")}</div>
				${missing.length ? `<div style="font-size:12px; color:#6b7280; margin-top:6px;">Θα βοηθούσε να ξέρουμε: ${esc(missing.join(" · "))}</div>` : ""}
			</td>
		</tr></table>
	</td></tr>
	${v.advice ? `<tr><td style="padding:14px 20px 0;">
		<div style="background:#f2f9f4; border-left:3px solid #2e9e5b; border-radius:6px; padding:10px 14px; font-size:13px; line-height:1.55; color:${NAVY};"><strong>Για τη συζήτηση με τον ιδιοκτήτη:</strong> ${esc(v.advice)}</div>
	</td></tr>` : ""}
	${v.renovation ? `<tr><td style="padding:18px 20px 0;">
		<div style="font-size:12px; font-weight:bold; letter-spacing:1px; color:${NAVY}; margin-bottom:6px;">ΜΕ ΑΝΑΚΑΙΝΙΣΗ</div>
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
			<td style="background:#f9f5ff; border:1px solid #cdb9ec; border-radius:8px; padding:12px 14px;">
				<div style="font-size:10.5px; font-weight:bold; letter-spacing:1px; color:#6b7280;">ΤΙ ΠΕΡΙΛΑΜΒΑΝΕΙ</div>
				<div style="font-size:12.5px; color:${NAVY}; line-height:1.55; margin:2px 0 10px;">${esc(v.renovation.scope)}</div>
				<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
					<td width="33%" style="background:#ffffff; border:1px solid #e2d7f5; border-radius:8px; padding:9px 11px; vertical-align:top;">
						<div style="font-size:10px; font-weight:bold; letter-spacing:1px; color:#6b7280;">ΚΟΣΤΟΣ</div>
						<div style="font-size:15px; font-weight:bold; color:${NAVY}; margin-top:2px;">${eur(v.renovation.cost_low)} – ${eur(v.renovation.cost_high)}</div>
						<div style="font-size:10.5px; color:#6b7280; margin-top:2px;">από τα συνεργεία μας</div>
					</td>
					<td width="8"></td>
					<td width="33%" style="background:#ffffff; border:1px solid #e2d7f5; border-radius:8px; padding:9px 11px; vertical-align:top;">
						<div style="font-size:10px; font-weight:bold; letter-spacing:1px; color:#6b7280;">ΑΞΙΑ ΜΕΤΑ</div>
						<div style="font-size:15px; font-weight:bold; color:${NAVY}; margin-top:2px;">${eur(v.renovation.value_after_mid)}</div>
						<div style="font-size:10.5px; color:#6b7280; margin-top:2px;">από ${eur(v.value_mid)} σήμερα · εύρος ${eur(v.renovation.value_after_low)}–${eur(v.renovation.value_after_high)}</div>
					</td>
					<td width="8"></td>
					<td width="33%" style="background:#ffffff; border:1px solid #e2d7f5; border-radius:8px; padding:9px 11px; vertical-align:top;">
						<div style="font-size:10px; font-weight:bold; letter-spacing:1px; color:#6b7280;">ΚΑΘΑΡΟ ΟΦΕΛΟΣ</div>
						<div style="font-size:15px; font-weight:bold; color:${Number(v.renovation.net_gain) > 0 ? "#2e9e5b" : "#c62828"}; margin-top:2px;">${Number(v.renovation.net_gain) > 0 ? "+" : ""}${eur(v.renovation.net_gain)}</div>
						<div style="font-size:10.5px; color:#6b7280; margin-top:2px;">μετά την αφαίρεση του κόστους</div>
					</td>
				</tr></table>
				${Number(v.renovation.rent_after_mid) ? `<div style="font-size:12px; color:${NAVY}; margin-top:8px;">Μίσθωμα μετά: ~${eur(v.renovation.rent_after_mid)}/μήνα</div>` : ""}
				${v.renovation.comment ? `<div style="font-size:12px; color:#6b7280; margin-top:6px; line-height:1.5;">${esc(v.renovation.comment)}</div>` : ""}
				<div style="font-size:11px; color:#9aa3af; margin-top:6px;">Τα κόστη είναι ενδεικτικά — τα συνεργαζόμενα συνεργεία μας δίνουν κανονική προσφορά.</div>
			</td>
		</tr></table>
	</td></tr>` : ""}
	${propFacts ? `<tr><td style="padding:18px 20px 0;">
		<div style="font-size:12px; font-weight:bold; letter-spacing:1px; color:${NAVY}; margin-bottom:6px;">ΤΑ ΣΤΟΙΧΕΙΑ ΠΟΥ ΔΟΘΗΚΑΝ${prop.fromCrm ? " (ΣΥΜΠΛΗΡΩΜΕΝΑ ΚΑΙ ΑΠΟ ΤΟ CRM)" : ""}</div>
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
		wantsSale ? `Αξία πώλησης: ${eur(v.value_mid)} (εύρος ${eur(v.value_low)} έως ${eur(v.value_high)}, ${eur(v.eur_per_sqm)}${perSqmLabel})` : "",
		caveats.length ? `Υπό αίρεση: ${caveats.join(" · ")}` : "",
		wantsRent ? `Μίσθωμα: ${eur(v.rent_mid)}/μήνα (εύρος ${eur(v.rent_low)} έως ${eur(v.rent_high)})` : "",
		`Βεβαιότητα: ${v.confidence || ""}. ${v.confidence_reason || ""}`,
	].filter(Boolean).join("\n");

	return {
		subject, html, text,
		// Για την προβολή μέσα στη φόρμα (ektimisi.html): το τελικό JSON
		// του μοντέλου, τα στοιχεία του ακινήτου και τα συγκριτικά. Το
		// Make αγνοεί αυτά τα πεδία.
		v, prop,
		comps: docRows,
	};
}

function labelCategory(c) {
	return { residential: "Κατοικία", commercial: "Επαγγελματικό", land: "Οικόπεδο" }[c] || "Ακίνητο";
}

/* Το είδος ΠΑΝΤΑ σε ελληνική ετικέτα. Φόρμα, feed και CRM δίνουν slug
   («apartment»), που δεν έχει θέση σε ελληνικό report: ούτε στο θέμα του
   email, ούτε στα συγκριτικά, ούτε στο prompt του μοντέλου. Ο ίδιος
   χάρτης με τις σελίδες ακινήτων (seo.mjs)· ό,τι δεν είναι slug περνάει
   ως έχει, οπότε παλιά πρόχειρα με ελληνικό είδος δεν χαλάνε. */
function labelKind(subcategory, category) {
	return subcategoryLabel({ subcategory: subcategory || "", category: category || "" });
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

	const compSections = compGroups(comps).map((g) => `<h2>${g.title}</h2><table>${g.rows.map((c) => `<tr>
		<td>${esc((c.code ? c.code + " · " : "") + [c.kind, c.area].filter(Boolean).join(", "))}</td>
		<td class="num">${c.sqm ? esc(String(c.sqm)) + " τ.μ." : ""}</td>
		<td class="num"><strong>${compPrice(c.price, g.transaction)}</strong></td>
		<td class="num mut">${compPerSqm(c.price, c.sqm, g.transaction)}</td>
	</tr>`).join("")}</table>`).join("");

	const facts = factRows(p).filter(([, val]) => val).map(([k, val]) =>
		`<tr><td class="mut" style="white-space:nowrap;">${esc(k)}</td><td>${esc(val)}</td></tr>`).join("");

	const missing = (Array.isArray(v.missing_info) ? v.missing_info : []).filter(Boolean);
	const caveats = (Array.isArray(v.caveats) ? v.caveats : []).filter(Boolean);
	const isLand = p.profile === "plot" || p.profile === "parcel";
	const perSqmLabel = isLand ? "/τ.μ. γης" : "/τ.μ.";
	const buildableNote = isLand && Number(v.eur_per_buildable_sqm)
		? ` · ${eur(v.eur_per_buildable_sqm)}/τ.μ. δόμησης${Number(v.buildable_sqm) ? ` (${Math.round(v.buildable_sqm)} τ.μ. δομήσιμα)` : ""}`
		: "";

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
/* Οι αιρέσεις πάνε αμέσως κάτω από το νούμερο, όχι στο υποσέλιδο: το
   νούμερο δεν επιτρέπεται να ταξιδέψει χωρίς αυτές. */
.caveat{background:#fff4f6;border:1px solid #f2b8c6;border-left:3px solid #c62828;border-radius:8px;padding:10px 13px;margin:0 0 8px;font-size:12.5px;line-height:1.6;color:${DOC_NAVY};}
.caveat .l{font-size:10.5px;font-weight:800;letter-spacing:.08em;color:#c62828;margin-bottom:2px;}
/* Βεβαιότητα: χρώμα + τρία τετραγωνάκια. Τα χρώματα μπαίνουν inline ανά
   επίπεδο (confStyle)· εδώ μένει ό,τι δεν αλλάζει. Τα τετραγωνάκια για
   να διαβάζεται και τυπωμένο ασπρόμαυρο. */
.conf{border:1px solid #e3e6eb;border-left:3px solid #6b7280;border-radius:8px;padding:10px 13px;margin:10px 0 8px;}
.conf .l{font-size:10.5px;font-weight:800;letter-spacing:.08em;color:#6b7280;margin-bottom:5px;}
.conf .pill{display:inline-block;color:#fff;font-size:11.5px;font-weight:800;letter-spacing:.08em;padding:3px 11px;border-radius:11px;}
.conf .meter{display:inline-block;margin-left:10px;vertical-align:1px;}
.conf .meter i{display:inline-block;width:20px;height:5px;border-radius:3px;background:#dfe3e8;margin-left:3px;}
.conf p{margin:7px 0 0;}
.renov{background:#f9f5ff;border:1px solid #cdb9ec;border-radius:10px;padding:12px 15px;margin:0 0 8px;}
.renov .lbl{font-size:10.5px;font-weight:800;letter-spacing:.08em;color:#6b7280;}
.renov .scope{font-size:12.5px;margin:2px 0 10px;line-height:1.5;}
.renov .stats{display:flex;gap:8px;}
.renov .st{flex:1;background:#fff;border:1px solid #e2d7f5;border-radius:8px;padding:8px 11px;}
.renov .st .v{font-size:15px;font-weight:800;color:${DOC_NAVY};line-height:1.3;white-space:nowrap;}
.renov .st .s{font-size:10.5px;color:#6b7280;margin-top:2px;line-height:1.4;}
.renov .st.gain .v{color:#12855b;}
.renov .st.gainneg .v{color:#b3261e;}
.renov .aftrent{font-size:12px;color:${DOC_NAVY};margin-top:8px;}
.renov .cm{font-size:12px;color:#6b7280;margin-top:6px;line-height:1.5;}
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
		<div class="r">εύρος ${eur(v.value_low)} έως ${eur(v.value_high)} · ${eur(v.eur_per_sqm)}${perSqmLabel}${buildableNote}</div>
	</div>` : ""}
	${caveats.length ? `<div class="caveat">
		<div class="l">ΥΠΟ ΑΙΡΕΣΗ</div>
		<div>${caveats.map((c) => `• ${esc(c)}`).join("<br>")}</div>
	</div>` : ""}
	${wantsRent && v.rent_mid ? `<div class="rentval">
		<div class="l">ΕΚΤΙΜΩΜΕΝΟ ΜΙΣΘΩΜΑ</div>
		<div class="r">${eur(v.rent_mid)}/μήνα (εύρος ${eur(v.rent_low)} έως ${eur(v.rent_high)})</div>
		${Number(v.gross_yield_pct) ? `<div class="y">Μικτή απόδοση ~${esc(String(v.gross_yield_pct).replace(".", ","))}% ${wantsSale ? "στην εκτιμώμενη αξία" : `σε εκτιμώμενη αξία ${eur(v.value_mid)}`}</div>` : ""}
	</div>` : ""}
	${p.askingPrice && v.asking_comment ? `<h2>ΣΕ ΣΧΕΣΗ ΜΕ ΤΗ ΖΗΤΟΥΜΕΝΗ (${eur(p.askingPrice)}${wantsSale ? "" : "/μήνα"})</h2><p>${esc(v.asking_comment)}</p>` : ""}
	${adj ? `<h2>ΠΩΣ ΒΓΗΚΕ ΤΟ ΝΟΥΜΕΡΟ${v.method ? ` · ${esc(grUpper(v.method))}` : ""} · ΑΦΕΤΗΡΙΑ ${eur(v.base_eur_per_sqm)}${perSqmLabel}${wantsSale ? "" : " ΑΞΙΑΣ"}</h2><table>${adj}</table>` : ""}
	${compSections || (v.comps_comment ? "<h2>ΤΙ ΔΕΙΧΝΟΥΝ ΤΑ ΣΥΓΚΡΙΤΙΚΑ</h2>" : "")}
	${v.comps_comment ? `<p class="mut" style="margin-top:6px;">${esc(v.comps_comment)}</p>` : ""}
	${v.market_comment ? `<h2>Η ΑΓΟΡΑ</h2><p>${esc(v.market_comment)}</p>` : ""}
	<div class="conf" style="background:${confStyle(v.confidence).bg}; border-color:${confStyle(v.confidence).border}; border-left-color:${confStyle(v.confidence).fill};">
		<div class="l">ΒΕΒΑΙΟΤΗΤΑ ΕΚΤΙΜΗΣΗΣ</div>
		<span class="pill" style="background:${confStyle(v.confidence).fill};">${esc(grUpper(normConfidence(v.confidence)) || "ΑΓΝΩΣΤΗ")}</span>
		<span class="meter">${[0, 1, 2].map((i) => `<i${i < confStyle(v.confidence).steps ? ` style="background:${confStyle(v.confidence).fill};"` : ""}></i>`).join("")}</span>
		${v.confidence_reason ? `<p>${esc(v.confidence_reason)}</p>` : ""}
		${missing.length ? `<p class="mut">Θα βοηθούσε να ξέρουμε: ${esc(missing.join(" · "))}</p>` : ""}
	</div>
	${v.advice ? `<div class="note"><strong>Για τη συζήτηση με τον ιδιοκτήτη:</strong> ${esc(v.advice)}</div>` : ""}
	${v.renovation ? `<h2>ΜΕ ΑΝΑΚΑΙΝΙΣΗ</h2>
	<div class="renov">
		<div class="lbl">ΤΙ ΠΕΡΙΛΑΜΒΑΝΕΙ</div>
		<div class="scope">${esc(v.renovation.scope)}</div>
		<div class="stats">
			<div class="st"><div class="lbl">ΚΟΣΤΟΣ</div><div class="v">${eur(v.renovation.cost_low)} – ${eur(v.renovation.cost_high)}</div><div class="s">από τα συνεργεία μας</div></div>
			<div class="st"><div class="lbl">ΑΞΙΑ ΜΕΤΑ</div><div class="v">${eur(v.renovation.value_after_mid)}</div><div class="s">από ${eur(v.value_mid)} σήμερα · εύρος ${eur(v.renovation.value_after_low)}–${eur(v.renovation.value_after_high)}</div></div>
			<div class="st ${Number(v.renovation.net_gain) > 0 ? "gain" : "gainneg"}"><div class="lbl">ΚΑΘΑΡΟ ΟΦΕΛΟΣ</div><div class="v">${Number(v.renovation.net_gain) > 0 ? "+" : ""}${eur(v.renovation.net_gain)}</div><div class="s">μετά την αφαίρεση του κόστους</div></div>
		</div>
		${Number(v.renovation.rent_after_mid) ? `<div class="aftrent">Μίσθωμα μετά: ~${eur(v.renovation.rent_after_mid)}/μήνα</div>` : ""}
		${v.renovation.comment ? `<div class="cm">${esc(v.renovation.comment)}</div>` : ""}
		<div class="cm">Τα κόστη είναι ενδεικτικά — τα συνεργαζόμενα συνεργεία μας δίνουν κανονική προσφορά.</div>
	</div>` : ""}
	${facts ? `<h2>ΤΑ ΣΤΟΙΧΕΙΑ ΠΟΥ ΔΟΘΗΚΑΝ${p.fromCrm ? " (ΣΥΜΠΛΗΡΩΜΕΝΑ ΚΑΙ ΑΠΟ ΤΟ CRM)" : ""}</h2><table>${facts}</table>
		${p.notes ? `<p class="mut" style="margin-top:6px;">Παρατηρήσεις: ${esc(p.notes)}</p>` : ""}` : ""}
	${v.review_notes ? `<p class="mut" style="margin-top:10px;">Δεύτερο πέρασμα ελέγχου: ${esc(v.review_notes)}</p>` : ""}
	<div class="disc">Ενδεικτική εκτίμηση αγοραίας αξίας για εσωτερική χρήση του γραφείου, με βάση ζητούμενες τιμές αγγελιών (${esc(AREA_PRICES_META.asOf)}) και τα συγκριτικά του χαρτοφυλακίου μας. Δεν αποτελεί πιστοποιημένη έκθεση εκτίμησης. Four Walls Real Estate · four-walls.gr</div>
</div></body></html>`;
}
