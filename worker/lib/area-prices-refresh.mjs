/* =====================================================================
   Four Walls — μηνιαίο φρεσκάρισμα του πίνακα τιμών περιοχών
   ---------------------------------------------------------------------
   Ο πίνακας του area-prices.mjs είναι το πιο αδύναμο δεδομένο της
   εκτίμησης: χειροποίητος, με ημερομηνία. Το Make (σενάριο «Εκτίμηση —
   φρεσκάρισμα τιμών») καλεί μία φορά τον μήνα:

     GET /api/area-prices-refresh?key=<WEBHOOK_KEY>

   και στέλνει το αποτέλεσμα με email στον Πάνο. Η βαριά δουλειά γίνεται
   εδώ: Gemini ΜΕ google_search grounding ερευνά τις τρέχουσες ζητούμενες
   τιμές ανά περιοχή (Spitogatos «Τιμές ακινήτων», xe.gr στατιστικά) και
   επιστρέφει τον προτεινόμενο πίνακα δίπλα στον τρέχοντα, με σημαία στις
   αποκλίσεις (10% στην πώληση, 15% στο ενοίκιο). Δίπλα, ως μάρτυρες
   τάσης, ζητούνται οι δημοσιευμένοι δείκτες: Spitogatos SPI πώλησης και
   ενοικίασης, ΤτΕ Θεσσαλονίκης (και νεόδμητα/παλαιά), υποδείκτης
   ενοικίων ΕΛΣΤΑΤ, και προαιρετικά Μητρώο ΑΑΔΕ ή φρέσκια έκθεση αγοράς
   (μόνο ως τάση, ποτέ ως βάση τιμών, βλ. PRICE_BASIS στο valuation.mjs).

   ΕΠΙΤΗΔΕΣ ΔΕΝ ΓΡΑΦΕΙ ΠΟΥΘΕΝΑ: τα νούμερα αυτά οδηγούν εκτιμήσεις που
   φτάνουν σε ιδιοκτήτες, οπότε η αλλαγή περνά από ανθρώπινο μάτι. Το
   email περιέχει έτοιμο το JS block για το area-prices.mjs — ο Πάνος το
   εγκρίνει και το εφαρμόζει (ή το ζητά από τον Claude), commit, deploy.

   Auth: ΚΑΜΙΑ — αντί για μυστικό (που θα έπρεπε να μπει στο blueprint
   του Make, δηλαδή στο git), το αποτέλεσμα κασάρεται ΑΝΑ ΜΗΝΑ στο KV.
   Η κατάχρηση φράσσεται έτσι σε ~μία κλήση Gemini τον μήνα, τα retries
   του Make σερβίρονται δωρεάν, και το περιεχόμενο είναι ούτως ή άλλως
   δημόσια στοιχεία αγοράς.
   ===================================================================== */

import { AREA_PRICES, AREA_PRICES_META } from "./area-prices.mjs";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-3.5-flash";
const CACHE_PREFIX = "area-prices-refresh:";

export async function handleAreaPricesRefresh(request, env) {
	if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
	if (!env.GEMINI_API_KEY) return json({ error: "not_configured" }, 503);

	const month = new Date().toISOString().slice(0, 7);
	const cacheKey = CACHE_PREFIX + month;
	const cached = await env.LISTINGS_KV.get(cacheKey);
	if (cached) return json(JSON.parse(cached), 200);

	let rows;
	try {
		rows = await askGeminiWithSearch(env);
	} catch (err) {
		console.error(`area-prices-refresh: ${String(err)}`);
		return json({ error: "refresh_failed", detail: String(err).slice(0, 200) }, 502);
	}

	// Ο ανεξάρτητος μάρτυρας: η διάμεσος του ΔΙΚΟΥ ΜΑΣ ενεργού στοκ ανά
	// περιοχή, €/τ.μ. για πώληση και €/τ.μ./μήνα για ενοικίαση. Ο Πάνος
	// δεν μπορεί να επαληθεύσει 36 περιοχές με το χέρι — το email
	// συγκρίνει μόνο του την πρόταση με ό,τι πουλάμε και νοικιάζουμε
	// πραγματικά, και του δείχνει πού να κοιτάξει.
	const stock = await feedMedians(env);

	const email = buildEmail(rows, stock);
	await env.LISTINGS_KV.put(cacheKey, JSON.stringify(email), { expirationTtl: 40 * 24 * 3600 });
	return json(email, 200);
}

const FEED_KEY = "listings.json"; // ίδιο με τον worker/index.mjs

async function feedMedians(env) {
	let feed = [];
	try {
		const raw = await env.LISTINGS_KV.get(FEED_KEY);
		feed = raw ? (JSON.parse(raw).listings || []) : [];
	} catch (err) {
		console.warn(`area-prices-refresh: feed unavailable: ${String(err)}`);
	}
	const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
	const medianOf = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
	const out = {};
	for (const row of AREA_PRICES) {
		const want = norm(row.area.split("(")[0].split("/")[0]);
		const inArea = feed
			.filter((l) => l.category === "residential" && l.price > 0 && l.area > 0)
			.filter((l) => {
				const a = norm((l.location && (l.location.area || l.location.neighbourhood)) || "");
				return a && (a.includes(want) || want.includes(a));
			});
		const sale = inArea.filter((l) => l.transaction === "sale").map((l) => l.price / l.area);
		const rent = inArea.filter((l) => l.transaction === "rent").map((l) => l.price / l.area);
		const entry = {};
		if (sale.length) entry.sale = { median: Math.round(medianOf(sale)), n: sale.length };
		// Τα ενοίκια είναι μονοψήφια €/τ.μ./μήνα — ένα δεκαδικό, αλλιώς η
		// στρογγυλοποίηση κρύβει όλη την πληροφορία.
		if (rent.length) entry.rent = { median: Math.round(medianOf(rent) * 10) / 10, n: rent.length };
		if (entry.sale || entry.rent) out[row.area] = entry;
	}
	return out;
}

async function askGeminiWithSearch(env) {
	const model = env.VALUATION_GEMINI_MODEL || DEFAULT_MODEL;
	const system = `Είσαι αναλυτής της ελληνικής αγοράς ακινήτων. Ερευνάς με αναζήτηση στο web τις ΤΡΕΧΟΥΣΕΣ ζητούμενες τιμές αγγελιών κατοικιών ανά περιοχή — πηγές: Spitogatos «Τιμές ακινήτων» (SPI), xe.gr στατιστικά τιμών, πρόσφατα δημοσιεύματα. Επιστρέφεις ΜΟΝΟ έγκυρο JSON.`;
	const user = `Ο τρέχων πίνακάς μας (ζητούμενες τιμές, €/τ.μ. πώληση και €/τ.μ./μήνα ενοικίαση, για ΤΥΠΙΚΟ διαμέρισμα της περιοχής, ${AREA_PRICES_META.asOf}):

${JSON.stringify(AREA_PRICES)}

Έλεγξε με αναζήτηση τις τρέχουσες τιμές για ΚΑΘΕ περιοχή και επίστρεψε JSON:
{"rows":[{"area":"<ίδιο όνομα με τον πίνακα>","saleLow":0,"saleHigh":0,"rentLow":0,"rentHigh":0,"note":"<κενό, ή 1 σύντομη πρόταση αν άλλαξε κάτι ουσιαστικό ή αν οι πηγές διαφωνούν>","source":"<κύρια πηγή, π.χ. spitogatos.gr>"}],
"indices":[{"name":"<π.χ. Spitogatos SPI Θεσσαλονίκη ή Δείκτης τιμών διαμερισμάτων ΤτΕ Θεσσαλονίκη>","change":"<π.χ. +7,7% ετησίως>","period":"<π.χ. Β' τρίμηνο 2026>","source":"<πηγή>"}],
"summary":"2-3 προτάσεις: γενική εικόνα της αγοράς και πού είδες τις μεγαλύτερες μεταβολές"}
Κανόνες: κράτα ΑΚΡΙΒΩΣ τα ονόματα περιοχών του πίνακα, με την ίδια σειρά. Τα εύρη για τυπικό διαμέρισμα — όχι νεόδμητα, όχι αναξιοποίητα. Αν δεν βρίσκεις φρέσκα στοιχεία για μια περιοχή, κράτα τα τρέχοντα νούμερα και γράψε το στο note. Νούμερα χωρίς σύμβολα, στρογγυλεμένα λογικά (πενηντάδες στο €/τ.μ., μισό ευρώ στα ενοίκια).
Για το "indices": βρες τους πιο πρόσφατους ΔΗΜΟΣΙΕΥΜΕΝΟΥΣ δείκτες ως ελέγχους τάσης, μία γραμμή ο καθένας:
1. Spitogatos SPI πώλησης: πανελλαδικός, Δήμος Θεσσαλονίκης, και προάστια/περιφέρεια Θεσσαλονίκης.
2. Spitogatos SPI ενοικίασης: Δήμος Θεσσαλονίκης και πανελλαδικός.
3. Δείκτης τιμών διαμερισμάτων της Τράπεζας της Ελλάδος για τη Θεσσαλονίκη, και τη διάσπαση νεόδμητα/παλαιά αν έχει δημοσιευτεί.
4. ΕΛΣΤΑΤ: ο υποδείκτης ενοικίων του ΔΤΚ (ετήσια μεταβολή), ως ανεξάρτητος μάρτυρας για τα ενοίκια.
5. Προαιρετικά, έως 2 γραμμές ακόμη: στοιχεία από το Μητρώο Αξιών Μεταβιβάσεων της ΑΑΔΕ (valuemaps.gov.gr) ή πρόσφατη έκθεση της αγοράς (Geoaxis, RE/MAX, Cerved, ετήσια Spitogatos) με στοιχεία Θεσσαλονίκης, όχι παλαιότερη από 6 μήνες. Προσοχή: οι δηλωμένες αξίες μεταβιβάσεων είναι συστηματικά χαμηλότερες από τις πραγματικές τιμές κλεισίματος, γι' αυτό χρησιμοποίησέ τες ΜΟΝΟ ως ένδειξη τάσης ή κάτω όριο, ποτέ ως βάση τιμών.
Κανόνες για τους δείκτες: μόνο δημοσιευμένα νούμερα, πάντα με περίοδο αναφοράς και πηγή. Αν κάποιον δεν τον βρίσκεις φρέσκο, παράλειψέ τον, ΜΗΝ επινοήσεις τιμή. Αν κάποια πρότασή σου στα rows κινείται ΑΝΤΙΘΕΤΑ στο πρόσημο των δεικτών (οι πωλήσεις κόντρα στους δείκτες πώλησης, τα ενοίκια κόντρα στους δείκτες ενοικίασης), γράψε το ρητά στο note της περιοχής.`;

	const res = await fetch(`${GEMINI_URL}/${model}:generateContent`, {
		method: "POST",
		headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
		body: JSON.stringify({
			system_instruction: { parts: [{ text: system }] },
			contents: [{ role: "user", parts: [{ text: user }] }],
			// google_search: το grounding είναι όλο το νόημα εδώ. ΔΕΝ βάζουμε
			// responseMimeType — δεν συνδυάζεται με tools· κόβουμε το JSON
			// από το κείμενο όπως στο extractJson της εκτίμησης.
			tools: [{ google_search: {} }],
			generationConfig: { maxOutputTokens: 32000 },
		}),
	});
	if (!res.ok) throw new Error(`gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
	const body = await res.json();
	const cand = body.candidates?.[0];
	const text = (cand?.content?.parts || [])
		.filter((p) => !p.thought && typeof p.text === "string")
		.map((p) => p.text)
		.join("");
	if (!text) throw new Error(`gemini: empty response (finishReason ${cand?.finishReason})`);
	if (cand.finishReason === "MAX_TOKENS") throw new Error("gemini: truncated at maxOutputTokens");
	const a = text.indexOf("{");
	const b = text.lastIndexOf("}");
	if (a === -1 || b <= a) throw new Error("no JSON in model output");
	return JSON.parse(text.slice(a, b + 1));
}

/* ------------------------------------------------------------------ */

const NAVY = "#16233A";
const PINK = "#FF1462";

function esc(s) {
	return String(s == null ? "" : s)
		.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pctDiff(oldV, newV) {
	if (!oldV || !newV) return 0;
	return Math.round(((newV - oldV) / oldV) * 100);
}

function buildEmail(data, stock) {
	const proposed = Array.isArray(data.rows) ? data.rows : [];
	const byArea = new Map(proposed.map((r) => [r.area, r]));
	const today = new Date().toISOString().slice(0, 7);
	stock = stock || {};

	const cell = (o, n) => {
		const d = pctDiff(o, n);
		const col = d > 0 ? "#2e9e5b" : (d < 0 ? "#c62828" : "#6b7280");
		return `${o} → <strong>${n}</strong> <span style="color:${col};">(${d > 0 ? "+" : ""}${d}%)</span>`;
	};

	// Χωρίζουμε σε «θέλουν το μάτι σου» και «μικρές μεταβολές»: κανείς δεν
	// ελέγχει 36 περιοχές τον μήνα, και δεν χρειάζεται — οι μικρές κινήσεις
	// μετακινούν ελάχιστα μια εκτίμηση. Κατώφλια: 10% στην πώληση, 15% στο
	// ενοίκιο (τα ενοίκια είναι μικρά νούμερα και η στρογγυλοποίηση μισού
	// ευρώ δίνει εύκολα ψεύτικα «άλματα» 10%).
	const verdictFor = (s, low, high, label, unit) => {
		if (!s) return `<span style="color:#6b7280;">Κανένα δικό μας ακίνητο (${label}) εκεί, κρίνε με την εικόνα της αγοράς.</span>`;
		if (s.median >= low * 0.9 && s.median <= high * 1.1) {
			return `<span style="color:#2e9e5b;"><strong>Συμφωνεί με το στοκ μας (${label})</strong>: διάμεσος ${s.median} ${unit} από ${s.n} αγγελίες.</span>`;
		}
		return `<span style="color:#c62828;"><strong>❗ Το στοκ μας δείχνει αλλού (${label})</strong>: διάμεσος ${s.median} ${unit} από ${s.n} αγγελίες. Μην το εγκρίνεις χωρίς δεύτερη ματιά.</span>`;
	};
	const flaggedRows = [];
	const calmRows = [];
	for (const cur of AREA_PRICES) {
		const p = byArea.get(cur.area);
		if (!p) {
			flaggedRows.push(`<tr><td colspan="4" style="padding:6px 8px; font-size:12px; color:#c62828;">${esc(cur.area)} — δεν επιστράφηκε από τον έλεγχο</td></tr>`);
			continue;
		}
		const dSale = Math.max(Math.abs(pctDiff(cur.saleLow, p.saleLow)), Math.abs(pctDiff(cur.saleHigh, p.saleHigh)));
		const dRent = Math.max(Math.abs(pctDiff(cur.rentLow, p.rentLow)), Math.abs(pctDiff(cur.rentHigh, p.rentHigh)));
		if (dSale < 10 && dRent < 15) {
			calmRows.push(`<tr>
				<td style="padding:5px 8px; border-bottom:1px solid #eceef2; font-size:11.5px; color:${NAVY};">${esc(cur.area)}</td>
				<td style="padding:5px 8px; border-bottom:1px solid #eceef2; font-size:11.5px; white-space:nowrap;">${cell(cur.saleLow, p.saleLow)} / ${cell(cur.saleHigh, p.saleHigh)}</td>
				<td style="padding:5px 8px; border-bottom:1px solid #eceef2; font-size:11.5px; white-space:nowrap;">${cell(cur.rentLow, p.rentLow)} / ${cell(cur.rentHigh, p.rentHigh)}</td>
			</tr>`);
			continue;
		}
		// Η ετυμηγορία του στοκ μας: αν έχουμε δικές μας αγγελίες στην
		// περιοχή, η διάμεσός τους είναι ο πιο έμπιστος μάρτυρας που
		// έχουμε. Μία γραμμή ανά σκέλος που ξεπέρασε το κατώφλι του.
		const s = stock[cur.area] || {};
		const verdicts = [];
		if (dSale >= 10) verdicts.push(verdictFor(s.sale, p.saleLow, p.saleHigh, "πώληση", "€/τ.μ."));
		if (dRent >= 15) verdicts.push(verdictFor(s.rent, p.rentLow, p.rentHigh, "ενοίκιο", "€/τ.μ./μήνα"));
		const verdict = verdicts.join("<br>");
		flaggedRows.push(`<tr style="background:#fff8e6;">
			<td style="padding:7px 8px; border-bottom:1px solid #eceef2; font-size:12px; color:${NAVY};"><strong>${esc(cur.area)}</strong></td>
			<td style="padding:7px 8px; border-bottom:1px solid #eceef2; font-size:12px; white-space:nowrap;">${cell(cur.saleLow, p.saleLow)} / ${cell(cur.saleHigh, p.saleHigh)}</td>
			<td style="padding:7px 8px; border-bottom:1px solid #eceef2; font-size:12px; white-space:nowrap;">${cell(cur.rentLow, p.rentLow)} / ${cell(cur.rentHigh, p.rentHigh)}</td>
			<td style="padding:7px 8px; border-bottom:1px solid #eceef2; font-size:11.5px; line-height:1.5;">${verdict}<br><span style="color:#6b7280;">${esc([p.note, p.source].filter(Boolean).join(" · "))}</span></td>
		</tr>`);
	}
	const flagged = flaggedRows.length;

	// Έτοιμο για επικόλληση στο area-prices.mjs — ο άνθρωπος αποφασίζει.
	const jsBlock = proposed.map((r) =>
		`\t{ area: ${JSON.stringify(r.area)}, saleLow: ${r.saleLow}, saleHigh: ${r.saleHigh}, rentLow: ${r.rentLow}, rentHigh: ${r.rentHigh} },`
	).join("\n");
	// Η ίδια έγκριση ανανεώνει και το AREA_PRICES_META.trend: οι δείκτες
	// του email γίνονται μία έτοιμη γραμμή, ώστε η εκτίμηση να ξέρει το
	// πρόσημο της αγοράς χωρίς δεύτερο χέρι.
	const trendLine = (Array.isArray(data.indices) ? data.indices : [])
		.map((ix) => [ix.name, ix.change, ix.period ? `(${ix.period})` : ""].filter(Boolean).join(" "))
		.join("· ");

	const subject = `Τιμές περιοχών ${today}: ${flagged ? `${flagged} περιοχές θέλουν το μάτι σου` : "χωρίς μεγάλες αλλαγές"}`;

	const html = `<!doctype html><html lang="el"><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0; padding:0; background:#f4f5f7; font-family:Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7; padding:16px 0;"><tr><td align="center">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px; width:100%; background:#ffffff; border-radius:8px; overflow:hidden;">
	<tr><td style="background:${NAVY}; padding:15px 20px;"><span style="color:#ffffff; font-size:18px; font-weight:bold; letter-spacing:1.5px;">FOUR WALLS</span><span style="color:${PINK}; font-size:10px; font-weight:bold; letter-spacing:2px;">&nbsp;&nbsp;REAL ESTATE</span></td></tr>
	<tr><td style="height:3px; background:${PINK};"></td></tr>
	<tr><td style="padding:20px 20px 6px;">
		<div style="font-size:11px; font-weight:bold; letter-spacing:1.5px; color:${PINK};">ΤΙΜΕΣ ΠΕΡΙΟΧΩΝ — ΜΗΝΙΑΙΟΣ ΕΛΕΓΧΟΣ</div>
		<div style="font-size:16px; font-weight:bold; color:${NAVY}; margin-top:4px;">${esc(subject)}</div>
		${data.summary ? `<div style="font-size:13px; color:#444; margin-top:8px; line-height:1.55;">${esc(data.summary)}</div>` : ""}
		<div style="font-size:12px; color:#6b7280; margin-top:8px;">Τρέχων πίνακας: ${esc(AREA_PRICES_META.asOf)}. Τίποτα δεν έχει αλλάξει μόνο του — για να εφαρμοστεί, πες στον Claude «εφάρμοσε τον νέο πίνακα τιμών από το email» ή επικόλλησε το block από κάτω στο <code>worker/lib/area-prices.mjs</code>.</div>
	</td></tr>
	${Array.isArray(data.indices) && data.indices.length ? `<tr><td style="padding:14px 20px 0;">
		<div style="font-size:12px; font-weight:bold; letter-spacing:1px; color:${NAVY}; margin-bottom:6px;">ΕΠΙΣΗΜΟΙ ΔΕΙΚΤΕΣ — ΤΟ ΜΕΤΡΟ ΤΗΣ ΤΑΣΗΣ</div>
		${data.indices.map((ix) => `<div style="font-size:12.5px; color:#444; line-height:1.7;">• <strong>${esc(ix.name)}</strong>: ${esc(ix.change)} (${esc(ix.period)}) <span style="color:#9aa3af;">· ${esc(ix.source)}</span></div>`).join("")}
		<div style="font-size:11.5px; color:#6b7280; margin-top:4px;">Πρόταση που πάει κόντρα σε αυτό το πρόσημο χωρίς εξήγηση = ύποπτη.</div>
	</td></tr>` : ""}
	<tr><td style="padding:14px 20px 0;">
		<div style="background:#f4f7fb; border:1px solid #c9d4e4; border-radius:8px; padding:12px 16px; font-size:12.5px; color:${NAVY}; line-height:1.7;">
			<strong>Πώς το ελέγχεις σε 2 λεπτά:</strong><br>
			1. Κοίτα ΜΟΝΟ τον πρώτο πίνακα — οι υπόλοιπες περιοχές κινήθηκαν κάτω από τα κατώφλια (10% πώληση, 15% ενοίκιο) και δεν αλλάζουν ουσιαστικά καμία εκτίμηση.<br>
			2. Για κάθε γραμμή: η ετυμηγορία δίπλα συγκρίνει την πρόταση με το <strong>δικό μας ενεργό στοκ</strong>. Πράσινο = συμφωνούν. ❗ = διαφωνούν, μην εγκρίνεις στα τυφλά.<br>
			3. Όπου δεν έχουμε στοκ, ρώτα τον εαυτό σου: «ταιριάζει με ό,τι βλέπουμε στην πιάτσα;» — αυτό αρκεί.<br>
			Η έγκριση δεν είναι όλα-ή-τίποτα: μπορείς να πεις «εφάρμοσε όλα εκτός από τη Χ».
		</div>
	</td></tr>
	${flagged ? `<tr><td style="padding:14px 20px 0;">
		<div style="font-size:12px; font-weight:bold; letter-spacing:1px; color:${NAVY}; margin-bottom:6px;">ΘΕΛΟΥΝ ΤΟ ΜΑΤΙ ΣΟΥ (${flagged})</div>
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f0d48a; border-radius:6px;">
			<tr>
				<td style="padding:6px 8px; font-size:11px; font-weight:bold; color:#6b7280;">ΠΕΡΙΟΧΗ</td>
				<td style="padding:6px 8px; font-size:11px; font-weight:bold; color:#6b7280;">ΠΩΛΗΣΗ €/τ.μ. (τώρα → νέο)</td>
				<td style="padding:6px 8px; font-size:11px; font-weight:bold; color:#6b7280;">ΕΝΟΙΚΙΟ €/τ.μ./μ.</td>
				<td style="padding:6px 8px; font-size:11px; font-weight:bold; color:#6b7280;">ΕΤΥΜΗΓΟΡΙΑ &amp; ΠΗΓΗ</td>
			</tr>
			${flaggedRows.join("")}
		</table>
	</td></tr>` : `<tr><td style="padding:14px 20px 0;">
		<div style="background:#f2f9f4; border:1px solid #bfe3cc; border-radius:8px; padding:12px 16px; font-size:13px; color:${NAVY};">Καμία περιοχή δεν κινήθηκε πάνω από 10% — ήσυχος μήνας, δεν χρειάζεται καμιά ενέργεια.</div>
	</td></tr>`}
	<tr><td style="padding:14px 20px 0;">
		<div style="font-size:12px; font-weight:bold; letter-spacing:1px; color:#6b7280; margin-bottom:6px;">ΜΙΚΡΕΣ ΜΕΤΑΒΟΛΕΣ (&lt;10% — για την εικόνα, όχι για έλεγχο)</div>
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceef2; border-radius:6px;">
			${calmRows.join("")}
		</table>
	</td></tr>
	<tr><td style="padding:16px 20px 0;">
		<div style="font-size:12px; font-weight:bold; letter-spacing:1px; color:${NAVY}; margin-bottom:6px;">ΓΙΑ ΤΟ area-prices.mjs (αν εγκριθεί)</div>
		<pre style="background:#f7f8fa; border:1px solid #eceef2; border-radius:6px; padding:10px 12px; font-size:11px; line-height:1.5; overflow:auto; margin:0;">${esc(jsBlock)}${trendLine ? esc(`\n\n// και στο AREA_PRICES_META:\ntrend: ${JSON.stringify(trendLine)},`) : ""}</pre>
	</td></tr>
	<tr><td style="padding:16px 20px 20px;">
		<div style="border-top:1px solid #eceef2; padding-top:10px; font-size:11px; color:#9aa3af; line-height:1.6;">Αυτόματος μηνιαίος έλεγχος (Gemini + Google Search). Οι τιμές είναι ζητούμενες αγγελιών, όπως τις χρειάζεται η εκτίμηση. Ο πίνακας στο git αλλάζει ΜΟΝΟ με ανθρώπινη έγκριση.</div>
	</td></tr>
</table>
</td></tr></table>
</body></html>`;

	// Τα rows (και οι δείκτες/τάση) μπαίνουν και στο cached αντικείμενο
	// ώστε το «εφάρμοσε τον πίνακα από το email» να διαβάζει δομημένα
	// δεδομένα από το KV αντί να κάνει parsing στο HTML.
	return { subject, html, flagged, proposed_count: proposed.length, rows: proposed, indices: Array.isArray(data.indices) ? data.indices : [], trend: trendLine };
}

function json(obj, status) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}
