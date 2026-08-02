/* =====================================================================
   Four Walls — ποιος έχει αυτό το τηλέφωνο;
   ---------------------------------------------------------------------
   Πριν πάρει η γραμματεία τηλέφωνο μια πινακίδα (worker/lib/leads.mjs),
   δύο ερωτήσεις θέλουν απάντηση:

     1. Την ξέρουμε ήδη;   -> έλεγχος στο EstatePrime
     2. Είναι μεσιτικό;    -> αναζήτηση στο ανοιχτό web

   ΤΟ ΠΙΟ ΧΡΗΣΙΜΟ ΑΠΟΤΕΛΕΣΜΑ ΕΙΝΑΙ ΤΟ ΑΡΝΗΤΙΚΟ. Ένα κινητό που δεν
   βρίσκεται πουθενά στο web είναι σχεδόν σίγουρα ιδιώτη — δηλαδή ακριβώς
   το lead που θέλουμε. Το «δεν βρέθηκε τίποτα» ΔΕΝ είναι αποτυχία της
   αναζήτησης, είναι η απάντηση· γι' αυτό το prompt το λέει ρητά και το
   email το εμφανίζει ως θετικό εύρημα.

   ΤΙ ΔΕΝ ΚΑΝΟΥΜΕ: δεν υπάρχει δημόσιος αντίστροφος τηλεφωνικός κατάλογος
   για ελληνικούς αριθμούς, και οι crowd-sourced υπηρεσίες τύπου
   Truecaller δεν έχουν νόμιμο public API — μια βάση με ονόματα που
   ανέβασαν τρίτοι από τις επαφές τους δεν είναι πηγή που θέλουμε να
   αγγίξουμε. Ψάχνουμε ΜΟΝΟ το ανοιχτό web, για να απαντήσουμε ΜΟΝΟ στο
   «επιχείρηση ή ιδιώτης, και ποια επιχείρηση» — ο αριθμός είναι ήδη
   δημοσιευμένος από τον ίδιο τον ιδιοκτήτη σε πινακίδα, ακριβώς για να
   τον πάρουν τηλέφωνο γι' αυτό το ακίνητο.

   Το grounding μοτίβο (google_search tool, JSON κομμένο από το κείμενο
   επειδή responseMimeType και tools δεν συνδυάζονται) είναι το ίδιο με το
   area-prices-refresh.mjs. Βλ. docs/pinakides.md.
   ===================================================================== */

import { contactsIndex } from "./crm.mjs";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-3.5-flash";

/* Πόσα νούμερα ερευνώνται ανά βόλτα. Μια βόλτα με περισσότερα από τόσα
   διαφορετικά τηλέφωνα είναι ήδη μια μέρα δουλειάς για τη γραμματεία. */
const MAX_LOOKUPS = 12;
/* Πόσα νούμερα σε μία κλήση. Ένα-ένα είναι ακριβέστερο αλλά αργό· πάνω
   από τέσσερα το μοντέλο αρχίζει να μοιράζει την προσοχή του. */
const CHUNK = 4;
const MAX_PARALLEL = 3;

/* --------------------------------------------------- κανονικοποίηση */

/* Ελληνικά τηλέφωνα: 10 ψηφία, κινητό 69XXXXXXXX, σταθερό 2XXXXXXXXX.
   Καθαρίζει +30 / 0030 / κενά / παύλες / παρενθέσεις. Επιστρέφει null
   όταν αυτό που διαβάστηκε δεν μοιάζει καν με τηλέφωνο — κενό πεδίο δεν
   κοστίζει τίποτα, λάθος νούμερο κοστίζει ένα τηλέφωνο σε άγνωστο. */
export function normPhone(raw) {
	let d = String(raw || "").replace(/[^\d+]/g, "");
	if (d.startsWith("+30")) d = d.slice(3);
	else if (d.startsWith("0030")) d = d.slice(4);
	d = d.replace(/\D/g, "");
	if (/^(69\d{8}|2\d{9})$/.test(d)) return d;
	return null;
}

export function fmtPhone(d) {
	if (!d) return "";
	return d.startsWith("69")
		? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`
		: `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
}

/* ------------------------------------------------------- CRM lookup

   Δωρεάν και ακαριαίο: ο κατάλογος επαφών είναι ήδη στο KV για τους
   pickers των εντύπων. Αν το νούμερο είναι δικιά μας επαφή, η απάντηση
   είναι αυθεντική και δεν χρειάζεται καμία αναζήτηση. */
export async function crmMatches(env, digitsList) {
	const out = new Map();
	if (!digitsList.length) return out;
	let index;
	try {
		index = await contactsIndex(env);
	} catch (err) {
		console.warn(`phone-lookup: CRM index unavailable: ${String(err)}`);
		return out;
	}
	const wanted = new Set(digitsList);
	for (const c of index?.contacts || []) {
		/* `phones` (όλα τα τηλέφωνα) μπήκε μετά· ένα cached index από πριν
		   έχει μόνο το `phone`. Δέξου και τα δύο, αλλιώς ο έλεγχος γυρίζει
		   σιωπηλά κενός μέχρι να λήξει το cache. */
		const numbers = Array.isArray(c.phones) && c.phones.length ? c.phones : [c.phone];
		for (const n of numbers) {
			const d = normPhone(n);
			if (d && wanted.has(d) && !out.has(d)) {
				out.set(d, { id: c.id, name: c.name, isLead: !!c.isLead });
			}
		}
	}
	return out;
}

/* ------------------------------------------------------- web lookup */

const KINDS = new Set(["agency", "business", "private", "unknown"]);

function prompt(numbers) {
	return [
		"You are checking Greek phone numbers that were printed on FOR SALE / FOR RENT signs in Thessaloniki. For each number, search the open web and say whether it belongs to a BUSINESS (and which one) or looks like a PRIVATE individual's number.",
		"",
		"Numbers to check:",
		...numbers.map((d) => `- ${d}  (also written as ${fmtPhone(d)}, +30 ${d})`),
		"",
		"Where Greek businesses publish their numbers: their own website, spitogatos.gr and xe.gr profiles and listings, Google Maps / Google Business, Facebook and Instagram pages, business directories (vrisko.gr, xo.gr), chamber-of-commerce records. A real-estate agency almost always shows its number on several of these.",
		"",
		"HOW TO CLASSIFY:",
		"- agency: the number belongs to a real-estate agency / μεσιτικό γραφείο / κτηματομεσιτική.",
		"- business: the number belongs to some other business (a builder, a shop, a law office, a property-management company).",
		"- private: you searched and found NOTHING that ties this number to a business. This is a completely normal and VERY USEFUL answer — most owners selling their own property have never published their number anywhere. Do not treat it as a failure, and do not keep searching for something to say.",
		"- unknown: you found something but cannot tell whether it really is this number's owner.",
		"",
		"HARD RULES:",
		"- Report a name ONLY if a source you actually found shows THIS EXACT number. Never infer an owner from a similar number, from the area code, or from what a name sounds like.",
		"- A number appearing on an agency's website is not automatically the agency's own: agencies also publish their clients' numbers in listings. If the number is shown as the agency's contact number (header, footer, contact page, Google Maps entry) it is the agency's; if it appears inside one single property advert, say unknown and explain.",
		"- Never invent a website, a company name or a source URL. If you have no source, leave the field empty.",
		"- Greek mobiles start with 69 and are almost never publicly listed unless they belong to a business.",
		"",
		"Answer with ONLY a JSON object, no prose around it:",
		'{"results":[{"phone":"<the 10 digits>","kind":"agency|business|private|unknown","name":"<business name, or empty>","website":"<main source URL, or empty>","evidence":"<one short Greek sentence saying what you found and where, or what you searched and did not find>","confidence":"high|medium|low"}]}',
		"Return one entry for every number given, in the same order.",
	].join("\n");
}

async function lookupChunk(env, numbers) {
	const model = env.LEADS_GEMINI_MODEL || DEFAULT_MODEL;
	const res = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
		method: "POST",
		headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
		body: JSON.stringify({
			contents: [{ role: "user", parts: [{ text: prompt(numbers) }] }],
			// Το grounding ΕΙΝΑΙ το feature. Με tools δεν επιτρέπεται
			// responseMimeType/responseSchema, οπότε το JSON κόβεται από το
			// κείμενο — ίδιο μοτίβο με το area-prices-refresh.mjs.
			tools: [{ google_search: {} }],
			generationConfig: { temperature: 0, maxOutputTokens: 8000 },
		}),
	});
	if (!res.ok) throw new Error(`gemini HTTP ${res.status}`);
	const body = await res.json();
	const cand = body.candidates?.[0];
	const text = (cand?.content?.parts || [])
		.filter((p) => !p.thought && typeof p.text === "string")
		.map((p) => p.text)
		.join("");
	if (!text) throw new Error(`empty response (finishReason ${cand?.finishReason})`);
	const a = text.indexOf("{");
	const b = text.lastIndexOf("}");
	if (a === -1 || b <= a) throw new Error("no JSON in model output");
	return JSON.parse(text.slice(a, b + 1)).results || [];
}

/* Επιστρέφει Map digits -> {kind,name,website,evidence,confidence}.
   Ποτέ δεν κάνει throw: μια αποτυχία της αναζήτησης δεν πρέπει να ρίξει
   τη βόλτα — το email απλώς δεν θα έχει τη γραμμή του ελέγχου. */
export async function webLookup(env, digitsList) {
	const out = new Map();
	if (!digitsList.length || !env.GEMINI_API_KEY) return out;

	const wanted = digitsList.slice(0, MAX_LOOKUPS);
	if (digitsList.length > wanted.length) {
		console.warn(`phone-lookup: capped at ${MAX_LOOKUPS}; ${digitsList.length - wanted.length} numbers not researched`);
	}
	const chunks = [];
	for (let i = 0; i < wanted.length; i += CHUNK) chunks.push(wanted.slice(i, i + CHUNK));

	let next = 0;
	await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, chunks.length) }, async () => {
		while (next < chunks.length) {
			const chunk = chunks[next++];
			try {
				for (const r of await lookupChunk(env, chunk)) {
					const d = normPhone(r?.phone);
					// Μόνο νούμερα που ΕΜΕΙΣ ρωτήσαμε: αν το μοντέλο
					// επιστρέψει κάτι άλλο, δεν το κρατάμε.
					if (!d || !chunk.includes(d) || out.has(d)) continue;
					out.set(d, {
						kind: KINDS.has(r.kind) ? r.kind : "unknown",
						name: String(r.name || "").trim().slice(0, 120),
						website: /^https?:\/\//i.test(r.website || "") ? String(r.website).slice(0, 300) : "",
						evidence: String(r.evidence || "").trim().slice(0, 300),
						confidence: ["high", "medium", "low"].includes(r.confidence) ? r.confidence : "low",
					});
				}
			} catch (err) {
				console.warn(`phone-lookup: chunk failed (${chunk.join(",")}): ${String(err)}`);
			}
		}
	}));
	return out;
}

/* ------------------------------------------------------ η σύγκριση

   Η πινακίδα λέει ένα πράγμα, το web άλλο. Η διαφωνία είναι η πιο
   χρήσιμη πληροφορία που παράγει όλο αυτό:

   - πινακίδα «ιδιώτης» + web «μεσιτικό» -> η πινακίδα δεν το γράφει,
     αλλά ο αριθμός είναι γραφείου. Χωρίς αυτό η γραμματεία παίρνει
     τηλέφωνο συνάδελφο νομίζοντας ότι μιλάει σε ιδιοκτήτη.
   - πινακίδα «μεσιτικό» + web «τίποτα» -> μάλλον όντως γραφείο (το λέει
     η ίδια η πινακίδα), απλώς μικρό ή χωρίς παρουσία στο web.

   Επιστρέφει το τελικό συμπέρασμα ΚΑΙ αν οι δύο πηγές διαφωνούν. */
export function reconcile(signSays, web) {
	const webKind = web?.kind || null;
	if (!webKind || webKind === "unknown") {
		return { verdict: signSays || "unknown", conflict: false };
	}
	const webSaysAgency = webKind === "agency";
	if (webSaysAgency) {
		return { verdict: "agency", conflict: signSays === "private" };
	}
	if (webKind === "business") {
		// Επιχείρηση αλλά όχι μεσιτικό: πιθανότατα ο ίδιος ο ιδιοκτήτης, με
		// το επαγγελματικό του τηλέφωνο. Καλό lead, όχι ανταγωνιστής.
		return { verdict: signSays === "agency" ? "agency" : "business", conflict: false };
	}
	// web: private (δεν βρέθηκε τίποτα)
	return { verdict: signSays === "agency" ? "agency" : "private", conflict: false };
}
