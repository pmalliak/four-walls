/* =====================================================================
   Four Walls — τι έντυπο στάλθηκε σε ποιον, και ο έλεγχος για διπλά
   ---------------------------------------------------------------------
   Το `forms:sent:<hash>` (worker/lib/forms.mjs) κόβει το ΙΔΙΟ ακριβώς
   έντυπο μέσα σε 48 ώρες. Δεν πιάνει όμως δύο έντυπα που διαφέρουν σε
   κάτι ασήμαντο (μια υπογραφή ξαναγράφτηκε, μια λέξη άλλαξε) και
   καταλήγουν στον ίδιο πελάτη σαν δεύτερο email: για τη μηχανή είναι δύο
   διαφορετικά έγγραφα, για τον παραλήπτη είναι το ίδιο δύο φορές.

   Εδώ κρατάμε μία γραμμή ανά έντυπο που ΟΝΤΩΣ προωθήθηκε στο Make: τι,
   σε ποιον, από ποιον, πότε. Ο φύλακας (worker/lib/dlq-watch.mjs) τη
   διαβάζει κάθε πρωί και αναφέρει ό,τι έφυγε δύο φορές στον ίδιο
   παραλήπτη. Δεν μπλοκάρει τίποτα: ένα έντυπο που έφυγε δεν ξαναγυρίζει,
   και ο άνθρωπος είναι αυτός που θα τηλεφωνήσει στον πελάτη.

   Ενα key ανά ημέρα, TTL 40 ημερών. Το read-modify-write δεν έχει
   κλείδωμα, όπως και το ιστορικό εκτιμήσεων: στους δικούς μας όγκους
   (λίγα έντυπα την ημέρα) το χειρότερο είναι μία γραμμή λιγότερη, ποτέ
   χαλασμένο JSON. Αποτυχία εδώ ΔΕΝ ρίχνει την υποβολή.
   ===================================================================== */

import { json } from "./access.mjs";

const SENT_LOG_PREFIX = "forms:log:";
const SENT_LOG_TTL = 40 * 24 * 3600;

/* Πού κρύβεται το email του πελάτη σε κάθε έντυπο. Ιδια ονόματα πεδίων
   με τα mappings του σεναρίου 6600035 ({{1.data.entoleas_email}} κ.ο.κ.):
   αν αλλάξει το ένα, πρέπει να αλλάξει και το άλλο. Η προσφορά και η
   εκτίμηση προς το γραφείο δεν έχουν παραλήπτη πελάτη, και μένουν με
   κενό `to` (καταγράφονται, αλλά δεν ελέγχονται για διπλά). */
const RECIPIENT_FIELD = {
	anathesi: "entoleas_email",
	ypodeixi: "entoleas_email",
	apodeixi: "katavallon_email",
	katachorisi: "owner_email",
	ektimisi: "client_email",
};

/* Ποιο πεδίο διαβάζει ο άνθρωπος στο email του φύλακα. Πρώτο που υπάρχει. */
const LABEL_FIELDS = {
	anathesi: ["entoleas_onomatepwnymo", "summary"],
	ypodeixi: ["entoleas_onomatepwnymo", "summary"],
	apodeixi: ["katavallon_geniki", "summary"],
	katachorisi: ["owner_name", "address_el", "summary"],
	ektimisi: ["summary"],
	prosfora: ["summary"],
};

function dayKey(d) {
	return SENT_LOG_PREFIX + d.toISOString().slice(0, 10);
}

/* «Μία φορά»: το πρώτο κάλεσμα με ένα κλειδί παίρνει first:true, τα
   επόμενα μέσα στο παράθυρο first:false μαζί με την ώρα του πρώτου.

   Το χρειάζονται όσα email ΔΕΝ περνούν από το /api/forms/submit, δηλαδή
   τα δύο σενάρια Spitogatos: ξεκινούν από mailhook, και ένα μήνυμα που
   ξαναφτάνει (re-delivery, προώθηση, ξαναρύθμιση του hook) στέλνει
   δεύτερη αυτόματη απάντηση στον ίδιο πελάτη.

   Fail-open, όπως και το dedupe των εντύπων: αν το KV δεν απαντήσει,
   στέλνουμε. Μια χαμένη απάντηση σε πελάτη είναι χειρότερη από μια
   διπλή, και ο φύλακας βλέπει τη διπλή το πρωί. */
export async function claimOnce(env, key, ttlSeconds = 48 * 3600) {
	const k = "once:" + String(key).slice(0, 400);
	try {
		const prev = await env.LISTINGS_KV.get(k);
		if (prev) return { first: false, at: prev };
		const now = new Date().toISOString();
		await env.LISTINGS_KV.put(k, now, { expirationTtl: ttlSeconds });
		return { first: true, at: now };
	} catch (err) {
		console.warn(`once: KV unavailable for ${k}, allowing: ${String(err)}`);
		return { first: true, at: null };
	}
}

function pick(data, fields) {
	for (const f of fields || []) {
		const v = data && data[f];
		if (v !== undefined && v !== null && String(v).trim()) return String(v).trim().slice(0, 90);
	}
	return "";
}

/* Καλείται ΜΟΝΟ αφού το Make δεχτεί το έντυπο: ό,τι δεν έφυγε δεν είναι
   απεσταλμένο, και ένα λάθος «ναι» εδώ θα έβγαζε ψεύτικα διπλά. */
export async function logSent(env, payload, hash) {
	try {
		const form = String(payload.form || "");
		const data = payload.data || {};
		const key = dayKey(new Date());
		const entries = JSON.parse((await env.LISTINGS_KV.get(key)) || "[]");
		entries.push({
			ts: payload.received_at || new Date().toISOString(),
			form,
			// Τα έντυπα κρύβουν τον πελάτη μέσα στο data, ό,τι δεν είναι
			// έντυπο (π.χ. η απάντηση σε lead) τον δίνει ρητά.
			to: String(data[RECIPIENT_FIELD[form]] || payload.to || "").trim().toLowerCase(),
			label: pick(data, LABEL_FIELDS[form]) || String(payload.summary || "").slice(0, 90),
			by: String(payload.submitted_by || ""),
			hash: String(hash || "").slice(0, 16),
			forced: payload.force_resend === true || undefined,
		});
		await env.LISTINGS_KV.put(key, JSON.stringify(entries), { expirationTtl: SENT_LOG_TTL });
	} catch (err) {
		console.warn(`forms: sent-log append failed: ${String(err)}`);
	}
}

/* GET /api/once?key=<κλειδί>[&hours=48] -> { first: true|false, at }

   Για σενάρια που στέλνουν σε πελάτη ΧΩΡΙΣ να περνούν από τον Worker: τα
   δύο Spitogatos ξεκινούν από mailhook, οπότε ένα μήνυμα που ξαναφτάνει
   στέλνει δεύτερη φορά το ίδιο email. Το module που στέλνει παίρνει
   φίλτρο «first = true» και σιωπά τη δεύτερη φορά.

   ΓΙΑΤΙ ΧΩΡΙΣ ΚΛΕΙΔΙ: το κλειδί θα ζούσε μέσα στο blueprint, δηλαδή στο
   git, ακριβώς αυτό που αποφεύγουμε παντού αλλού. Το endpoint δεν
   αποκαλύπτει τίποτα (γυρίζει true/false) και δεν στέλνει τίποτα. Το
   χειρότερο που κάνει κάποιος που μαντεύει ένα κλειδί είναι να μη λάβει
   ο πελάτης μια αυτόματη επιβεβαίωση, ενώ η ειδοποίηση στο γραφείο και η
   καταχώριση στο CRM γίνονται κανονικά. Το δεχόμαστε συνειδητά. */
export async function handleOnce(request, env, url) {
	if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
	const key = String(url.searchParams.get("key") || "").trim();
	if (!key || key.length > 300) return json({ error: "bad_key" }, 400);
	const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get("hours")) || 48));
	const claim = await claimOnce(env, key, hours * 3600);
	return json(claim);
}

/* Ολα τα έντυπα των τελευταίων `days` ημερών, νεότερο πρώτο. */
async function recentSends(env, days) {
	const out = [];
	for (let i = 0; i < days; i++) {
		const d = new Date(Date.now() - i * 86400000);
		try {
			const raw = await env.LISTINGS_KV.get(dayKey(d));
			if (raw) out.push(...JSON.parse(raw));
		} catch {
			/* μια χαλασμένη μέρα δεν ακυρώνει τον έλεγχο των υπολοίπων */
		}
	}
	return out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

/* Ιδιο έντυπο, ίδιος παραλήπτης, μέσα σε `windowHours`: ο πελάτης το
   έλαβε δύο φορές. Επιστρέφει μία εγγραφή ανά ζεύγος, με τις ώρες και τα
   δύο, ώστε το email του φύλακα να λέει τι έγινε χωρίς άλλο ψάξιμο.

   Χωρίς email παραλήπτη ΔΕΝ ελέγχουμε: τα εσωτερικά αντίγραφα στο info@
   πάνε πάντα εκεί, και δύο προσφορές την ίδια μέρα είναι φυσιολογικές. */
export async function findDuplicateSends(env, { days = 3, windowHours = 48 } = {}) {
	const sends = await recentSends(env, days);
	const seen = new Map();
	const dupes = [];
	for (const s of sends) {
		if (!s.to || !s.form) continue;
		const k = s.form + "|" + s.to;
		const prev = seen.get(k);
		// Η λίστα είναι νεότερο→παλαιότερο, άρα `prev` είναι το ΝΕΟΤΕΡΟ.
		if (prev) {
			const gapH = (new Date(prev.ts) - new Date(s.ts)) / 3600000;
			if (gapH >= 0 && gapH <= windowHours) {
				dupes.push({
					form: s.form, to: s.to, label: s.label || prev.label,
					first: s.ts, second: prev.ts,
					gapHours: Math.round(gapH * 10) / 10,
					forced: prev.forced === true,
					sameDocument: !!(s.hash && prev.hash && s.hash === prev.hash),
				});
			}
		}
		seen.set(k, s);
	}
	return dupes;
}
