/* =====================================================================
   Four Walls · καταγραφή του πίνακα τιμών περιοχών στο ιστορικό
   ---------------------------------------------------------------------
   Ο πίνακας στο worker/lib/area-prices.mjs αντικαθίσταται σε κάθε
   έγκριση του μηνιαίου ελέγχου· το git κρατά μεν κάθε εκδοχή, αλλά όχι
   σε μορφή που διαβάζεται εύκολα ως χρονοσειρά. Αυτό το εργαλείο
   προσθέτει το ΤΡΕΧΟΝ περιεχόμενο του πίνακα (rows + asOf + trend) ως
   εγγραφή στο worker/lib/area-prices-history.json. Τρέξε το στο βήμα
   της έγκρισης, ΜΕΤΑ την ενημέρωση του area-prices.mjs και ΠΡΙΝ το
   commit, ώστε πίνακας και ιστορικό να μπαίνουν στο ίδιο commit:

     node tools/area-prices-log.mjs

   Αν ο πίνακας δεν άλλαξε από την τελευταία εγγραφή (ίδια rows, ίδιο
   asOf, ίδιο trend), δεν γράφει τίποτα, οπότε είναι ακίνδυνο να τρέξει
   δύο φορές.

   ΓΙΑΤΙ ΣΤΟ worker/lib ΚΑΙ ΟΧΙ ΣΤΟ data/: ο φάκελος data/ είναι ολόκληρος
   στο .gitignore (κρατά το generated feed), οπότε εκεί το ιστορικό δεν θα
   έμπαινε ποτέ στο git, δηλαδή δεν θα ήταν ιστορικό. Το worker/ είναι
   tracked και ταυτόχρονα στο .assetsignore, άρα το αρχείο ζει δίπλα στον
   πίνακα που περιγράφει και δεν σερβίρεται ποτέ δημόσια.
   ===================================================================== */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
	AREA_PRICES, AREA_PRICES_META,
	ASSET_PRICES_META, LAND_SHARE, COMMERCIAL_RENTS, YIELDS, AGRI_PRICES,
} from "../worker/lib/area-prices.mjs";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "worker", "lib", "area-prices-history.json");

const db = JSON.parse(readFileSync(file, "utf8"));
if (!Array.isArray(db.entries)) {
	console.error("area-prices-log: το worker/lib/area-prices-history.json δεν έχει entries[], μη αναμενόμενη μορφή, δεν γράφω τίποτα.");
	process.exit(1);
}

/* Το ιστορικό κρατά ΟΛΟΥΣ τους πίνακες που οδηγούν εκτιμήσεις, όχι μόνο
   τις κατοικίες: η γη και τα επαγγελματικά παράγονται μεν από αλγόριθμο,
   αλλά το μερίδιο γης και οι αποδόσεις είναι νούμερα κρίσης — αν αύριο
   μια εκτίμηση φανεί λάθος, πρέπει να ξέρουμε με ποια ίσχυε. */
const snapshot = {
	asOf: AREA_PRICES_META.asOf,
	trend: AREA_PRICES_META.trend || null,
	rows: AREA_PRICES,
	assets: {
		asOf: ASSET_PRICES_META.asOf,
		verified: !!ASSET_PRICES_META.verified,
		landShare: LAND_SHARE,
		commercialRents: COMMERCIAL_RENTS,
		yields: YIELDS,
		agri: AGRI_PRICES,
	},
};

const last = db.entries[db.entries.length - 1];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (last && last.asOf === snapshot.asOf && same(last.trend || null, snapshot.trend)
	&& same(last.rows, snapshot.rows) && same(last.assets || null, snapshot.assets)) {
	console.log("area-prices-log: καμία αλλαγή από την τελευταία εγγραφή, το ιστορικό μένει ως έχει.");
	process.exit(0);
}

// Πόσες περιοχές άλλαξαν νούμερα σε σχέση με την τελευταία εγγραφή
// (μόνο για το μήνυμα· η εγγραφή κρατά ολόκληρο τον πίνακα).
let changed = AREA_PRICES.length;
if (last && Array.isArray(last.rows)) {
	const prev = new Map(last.rows.map((r) => [r.area, r]));
	changed = AREA_PRICES.filter((r) => {
		const p = prev.get(r.area);
		return !p || p.saleLow !== r.saleLow || p.saleHigh !== r.saleHigh
			|| p.rentLow !== r.rentLow || p.rentHigh !== r.rentHigh;
	}).length;
}

db.entries.push({
	recordedAt: new Date().toISOString(),
	source: AREA_PRICES_META.source,
	...snapshot,
});

writeFileSync(file, JSON.stringify(db, null, "\t") + "\n");
console.log(`area-prices-log: γράφτηκε εγγραφή (${AREA_PRICES.length} περιοχές, ${changed} με αλλαγή) στο worker/lib/area-prices-history.json. Μην ξεχάσεις το commit.`);
