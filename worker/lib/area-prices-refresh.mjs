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
   αποκλίσεις άνω του 10%.

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

	const email = buildEmail(rows);
	await env.LISTINGS_KV.put(cacheKey, JSON.stringify(email), { expirationTtl: 40 * 24 * 3600 });
	return json(email, 200);
}

async function askGeminiWithSearch(env) {
	const model = env.VALUATION_GEMINI_MODEL || DEFAULT_MODEL;
	const system = `Είσαι αναλυτής της ελληνικής αγοράς ακινήτων. Ερευνάς με αναζήτηση στο web τις ΤΡΕΧΟΥΣΕΣ ζητούμενες τιμές αγγελιών κατοικιών ανά περιοχή — πηγές: Spitogatos «Τιμές ακινήτων» (SPI), xe.gr στατιστικά τιμών, πρόσφατα δημοσιεύματα. Επιστρέφεις ΜΟΝΟ έγκυρο JSON.`;
	const user = `Ο τρέχων πίνακάς μας (ζητούμενες τιμές, €/τ.μ. πώληση και €/τ.μ./μήνα ενοικίαση, για ΤΥΠΙΚΟ διαμέρισμα της περιοχής, ${AREA_PRICES_META.asOf}):

${JSON.stringify(AREA_PRICES)}

Έλεγξε με αναζήτηση τις τρέχουσες τιμές για ΚΑΘΕ περιοχή και επίστρεψε JSON:
{"rows":[{"area":"<ίδιο όνομα με τον πίνακα>","saleLow":0,"saleHigh":0,"rentLow":0,"rentHigh":0,"note":"<κενό, ή 1 σύντομη πρόταση αν άλλαξε κάτι ουσιαστικό ή αν οι πηγές διαφωνούν>","source":"<κύρια πηγή, π.χ. spitogatos.gr>"}],"summary":"2-3 προτάσεις: γενική εικόνα της αγοράς και πού είδες τις μεγαλύτερες μεταβολές"}
Κανόνες: κράτα ΑΚΡΙΒΩΣ τα ονόματα περιοχών του πίνακα, με την ίδια σειρά. Τα εύρη για τυπικό διαμέρισμα — όχι νεόδμητα, όχι αναξιοποίητα. Αν δεν βρίσκεις φρέσκα στοιχεία για μια περιοχή, κράτα τα τρέχοντα νούμερα και γράψε το στο note. Νούμερα χωρίς σύμβολα, στρογγυλεμένα λογικά (πενηντάδες στο €/τ.μ., μισό ευρώ στα ενοίκια).`;

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

function buildEmail(data) {
	const proposed = Array.isArray(data.rows) ? data.rows : [];
	const byArea = new Map(proposed.map((r) => [r.area, r]));
	const today = new Date().toISOString().slice(0, 7);

	let flagged = 0;
	const rowsHtml = AREA_PRICES.map((cur) => {
		const p = byArea.get(cur.area);
		if (!p) return `<tr><td style="padding:6px 8px; font-size:12px; color:#c62828;">${esc(cur.area)} — δεν επιστράφηκε</td></tr>`;
		const dSale = Math.max(Math.abs(pctDiff(cur.saleLow, p.saleLow)), Math.abs(pctDiff(cur.saleHigh, p.saleHigh)));
		const big = dSale >= 10;
		if (big) flagged++;
		const cell = (o, n) => {
			const d = pctDiff(o, n);
			const col = d > 0 ? "#2e9e5b" : (d < 0 ? "#c62828" : "#6b7280");
			return `${o} → <strong>${n}</strong> <span style="color:${col};">(${d > 0 ? "+" : ""}${d}%)</span>`;
		};
		return `<tr${big ? ` style="background:#fff8e6;"` : ""}>
			<td style="padding:6px 8px; border-bottom:1px solid #eceef2; font-size:12px; color:${NAVY};">${big ? "⚠ " : ""}${esc(cur.area)}</td>
			<td style="padding:6px 8px; border-bottom:1px solid #eceef2; font-size:12px; white-space:nowrap;">${cell(cur.saleLow, p.saleLow)} / ${cell(cur.saleHigh, p.saleHigh)}</td>
			<td style="padding:6px 8px; border-bottom:1px solid #eceef2; font-size:12px; white-space:nowrap;">${cell(cur.rentLow, p.rentLow)} / ${cell(cur.rentHigh, p.rentHigh)}</td>
			<td style="padding:6px 8px; border-bottom:1px solid #eceef2; font-size:11px; color:#6b7280;">${esc([p.note, p.source].filter(Boolean).join(" · "))}</td>
		</tr>`;
	}).join("");

	// Έτοιμο για επικόλληση στο area-prices.mjs — ο άνθρωπος αποφασίζει.
	const jsBlock = proposed.map((r) =>
		`\t{ area: ${JSON.stringify(r.area)}, saleLow: ${r.saleLow}, saleHigh: ${r.saleHigh}, rentLow: ${r.rentLow}, rentHigh: ${r.rentHigh} },`
	).join("\n");

	const subject = `Τιμές περιοχών ${today}: ${flagged ? `${flagged} περιοχές με απόκλιση ≥10%` : "χωρίς μεγάλες αλλαγές"}`;

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
	<tr><td style="padding:14px 20px 0;">
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceef2; border-radius:6px;">
			<tr>
				<td style="padding:6px 8px; font-size:11px; font-weight:bold; color:#6b7280;">ΠΕΡΙΟΧΗ</td>
				<td style="padding:6px 8px; font-size:11px; font-weight:bold; color:#6b7280;">ΠΩΛΗΣΗ €/τ.μ. (τώρα → νέο)</td>
				<td style="padding:6px 8px; font-size:11px; font-weight:bold; color:#6b7280;">ΕΝΟΙΚΙΟ €/τ.μ./μ.</td>
				<td style="padding:6px 8px; font-size:11px; font-weight:bold; color:#6b7280;">ΣΗΜΕΙΩΣΗ</td>
			</tr>
			${rowsHtml}
		</table>
	</td></tr>
	<tr><td style="padding:16px 20px 0;">
		<div style="font-size:12px; font-weight:bold; letter-spacing:1px; color:${NAVY}; margin-bottom:6px;">ΓΙΑ ΤΟ area-prices.mjs (αν εγκριθεί)</div>
		<pre style="background:#f7f8fa; border:1px solid #eceef2; border-radius:6px; padding:10px 12px; font-size:11px; line-height:1.5; overflow:auto; margin:0;">${esc(jsBlock)}</pre>
	</td></tr>
	<tr><td style="padding:16px 20px 20px;">
		<div style="border-top:1px solid #eceef2; padding-top:10px; font-size:11px; color:#9aa3af; line-height:1.6;">Αυτόματος μηνιαίος έλεγχος (Gemini + Google Search). Οι τιμές είναι ζητούμενες αγγελιών, όπως τις χρειάζεται η εκτίμηση. Ο πίνακας στο git αλλάζει ΜΟΝΟ με ανθρώπινη έγκριση.</div>
	</td></tr>
</table>
</td></tr></table>
</body></html>`;

	return { subject, html, flagged, proposed_count: proposed.length };
}

function json(obj, status) {
	return new Response(JSON.stringify(obj), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});
}
