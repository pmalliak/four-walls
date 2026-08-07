/* =====================================================================
   Four Walls — το PDF ενός εντύπου αποκτά διεύθυνση
   ---------------------------------------------------------------------
   Το EstatePrime ΔΕΝ δέχεται συνημμένο σε task, και το /files του API
   είναι read-only (το POST /files απαντά 200 με άδειο σώμα και δεν
   γράφει τίποτα, επαληθεύτηκε 2026-08-07, βλ. docs/estateprime-api.md).
   Άρα η υποχρέωση «αρχειοθέτησε αυτό το έντυπο» δεν μπορεί να κουβαλήσει
   το ίδιο το αρχείο: κουβαλάει link.

   Το PDF περνάει έτσι κι αλλιώς από εδώ ως base64 πριν φύγει στο Make,
   οπότε το ακουμπάμε στο R2 στον δρόμο και βάζουμε το `pdf_url` μέσα στο
   payload. Το Make το γράφει στο description του task, η γραμματεία το
   κατεβάζει με ένα κλικ και το ανεβάζει στη σωστή επαφή του CRM.

   Δημόσιο URL με HMAC + λήξη, ίδιο μοντέλο με τις φωτογραφίες: ο
   παραλήπτης δεν έχει cookie του Access, και το link ταξιδεύει μέσα σε
   CRM και email. Ο,τι υπογράφεται εδώ διαβάζεται από το serveFormPdf.
   ===================================================================== */

import { hmac, safeEqual } from "./signing.mjs";

/* Ενενήντα μέρες. Το πρωτότυπο μέσα σε λίγες ώρες κάθεται στο CRM (αυτή
   ακριβώς είναι η δουλειά που ζητά το task) και στα Απεσταλμένα του
   info@ ως συνημμένο· το link είναι σκαλωσιά, όχι αρχείο. Αρκετά μεγάλο
   ώστε ένα task που ξεχάστηκε τον Αύγουστο να ανοίγει ακόμη τον
   Οκτώβριο, αρκετά μικρό ώστε να μη μείνει για πάντα ζωντανή μια
   υπογεγραμμένη σύμβαση πίσω από ένα URL. */
const SIGNED_URL_TTL = 90 * 24 * 60 * 60;

/* Το όνομα μπαίνει αυτούσιο στο URL και στο Content-Disposition, οπότε
   κόβουμε ό,τι θα μπορούσε να βγει από τον φάκελο ή να σπάσει την
   κεφαλίδα. Τα ελληνικά μένουν: το `anathesi_Βασίλειος_….pdf` πρέπει να
   φτάνει αναγνώσιμο στη γραμματεία. */
function safeName(name, form) {
	const clean = String(name || "")
		.replace(/[/\\]/g, "_")
		.replace(/[\r\n\t"]/g, "")
		.trim()
		.slice(0, 120);
	return clean || `${form || "entypo"}.pdf`;
}

function b64ToBytes(b64) {
	const bin = atob(String(b64).replace(/^data:[^,]*,/, ""));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/* Καλείται μέσα στο handleFormSubmit, ΠΡΙΝ την προώθηση στο Make, με το
   hash της υποβολής ως ταυτότητα: το ίδιο έντυπο δίνει το ίδιο path, άρα
   μια επαναποστολή γράφει πάνω του αντί να αφήσει ορφανό αντίγραφο.

   FAIL-OPEN. Καμία αστοχία εδώ δεν εμποδίζει το έντυπο να φύγει: χωρίς
   `pdf_url` το task απλώς δεν έχει κουμπί και η γραμματεία πάει στο
   email, όπως έκανε μέχρι σήμερα. Το αντίθετο (χαμένο έντυπο επειδή
   γκρίνιαξε το R2) θα ήταν πολύ χειρότερο. */
export async function archiveFormPdf(env, payload, hash, origin) {
	if (!payload?.pdf_base64) return null;
	if (!env.PHOTO_BUCKET || !env.PHOTO_SIGN_KEY) {
		console.warn("forms-archive: PHOTO_BUCKET/PHOTO_SIGN_KEY missing, no pdf_url");
		return null;
	}
	try {
		const id = /^[0-9a-f]{32,}$/i.test(String(hash || ""))
			? String(hash).slice(0, 32)
			: crypto.randomUUID().replace(/-/g, "");
		const name = safeName(payload.pdf_filename, payload.form);
		const bytes = b64ToBytes(payload.pdf_base64);

		await env.PHOTO_BUCKET.put(`forms/${id}/${name}`, bytes, {
			httpMetadata: {
				contentType: payload.pdf_mime || "application/pdf",
				contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
			},
			customMetadata: {
				form: String(payload.form || ""),
				submitted_by: String(payload.submitted_by || ""),
				received_at: String(payload.received_at || ""),
			},
		});

		const exp = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL;
		const sig = await hmac(env, `forms/${id}/${name}\n${exp}`);
		const url = `${origin}/api/forms/file/${id}/${encodeURIComponent(name)}?exp=${exp}&sig=${sig}`;
		console.log(`forms-archive: ${payload.form} → forms/${id}/${name} (${bytes.length} bytes)`);
		return url;
	} catch (err) {
		console.warn(`forms-archive: upload failed, form goes out without a link: ${String(err)}`);
		return null;
	}
}

/* GET /api/forms/file/<id>/<name>?exp=&sig=

   Apex, χωρίς Access: το ανοίγει η γραμματεία από το CRM. Το path
   υπογράφεται ολόκληρο και το `name` δεν χωράει κάθετο, οπότε η
   υπογραφή ενός εντύπου δεν ανοίγει άλλο. */
export async function serveFormPdf(request, env, url) {
	if (!env.PHOTO_BUCKET || !env.PHOTO_SIGN_KEY) {
		return new Response("Not configured", { status: 503 });
	}
	const m = url.pathname.match(/^\/api\/forms\/file\/([0-9a-f]{32})\/([^/]+)$/);
	if (!m) return new Response("Not Found", { status: 404 });
	const id = m[1];
	const name = decodeURIComponent(m[2]);

	const exp = Number(url.searchParams.get("exp") || 0);
	const sig = url.searchParams.get("sig") || "";
	if (!exp || exp < Math.floor(Date.now() / 1000)) {
		return new Response("Το link έληξε. Το έντυπο βρίσκεται στο CRM και στα Απεσταλμένα του info@.", {
			status: 410,
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	}
	const expected = await hmac(env, `forms/${id}/${name}\n${exp}`);
	if (!safeEqual(sig, expected)) return new Response("Forbidden", { status: 403 });

	const obj = await env.PHOTO_BUCKET.get(`forms/${id}/${name}`);
	if (!obj) return new Response("Not Found", { status: 404 });
	return new Response(obj.body, {
		headers: {
			"Content-Type": obj.httpMetadata?.contentType || "application/pdf",
			"Content-Length": String(obj.size),
			"Content-Disposition": obj.httpMetadata?.contentDisposition
				|| `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
			// Υπογεγραμμένο έγγραφο πελάτη: κανένα ενδιάμεσο δεν κρατάει αντίγραφο.
			"Cache-Control": "private, no-store",
		},
	});
}
