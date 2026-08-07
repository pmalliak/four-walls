/* =====================================================================
   Four Walls — υπογραφή δημόσιων URL (HMAC-SHA256)
   ---------------------------------------------------------------------
   Οσα endpoints ζουν στο apex χωρίς Access (τα κατεβάζει το Make, ο
   image proxy ενός email, ή η γραμματεία από το CRM) δεν έχουν cookie να
   δείξουν. Φρουρός τους είναι μια υπογραφή πάνω στο path συν ένα
   `exp`: το link δουλεύει, δεν μαντεύεται, και λήγει.

   Το κλειδί είναι το PHOTO_SIGN_KEY (πήρε το όνομά του από το πρώτο
   endpoint που το χρειάστηκε, τις φωτογραφίες· υπογράφει πλέον ό,τι
   ταξιδεύει έτσι).
   ===================================================================== */

function b64url(bytes) {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hmac(env, message) {
	const key = await crypto.subtle.importKey(
		"raw", new TextEncoder().encode(env.PHOTO_SIGN_KEY),
		{ name: "HMAC", hash: "SHA-256" }, false, ["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return b64url(new Uint8Array(sig));
}

/* Constant-ish time compare: το id είναι ήδη αμάντευτο, αλλά δεν
   υπάρχει λόγος να διαρρέουν bytes της υπογραφής από το πότε γυρίζει. */
export function safeEqual(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
