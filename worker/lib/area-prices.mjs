/* =====================================================================
   Four Walls — τιμές αγοράς ανά περιοχή (Κεντρική Μακεδονία)
   ---------------------------------------------------------------------
   Ζητούμενες τιμές αγγελιών σε €/τ.μ. (πώληση) και €/τ.μ./μήνα
   (ενοικίαση) για κατοικίες, ανά περιοχή. Τροφοδοτούν την εκτίμηση
   αξίας (worker/lib/valuation.mjs) ως αφετηρία, μαζί με τα πραγματικά
   συγκριτικά του feed.

   ΠΡΟΣΟΧΗ: ζητούμενες τιμές, όχι τιμές συναλλαγής. Το κλείσιμο πέφτει
   συνήθως 5-10% χαμηλότερα· αυτό το ξέρει το prompt, όχι ο πίνακας.

   Συντήρηση: χειροκίνητα, με πηγές τα δημόσια στοιχεία των portals
   (Spitogatos «Τιμές ακινήτων» / SPI, xe.gr στατιστικά) και την εικόνα
   του γραφείου. Ενημέρωσε το asOf σε κάθε αλλαγή. Όσο το asOf μένει
   πίσω, τόσο πιο επιφυλακτικό γίνεται το report (βλ. valuation.mjs).
   ===================================================================== */

export const AREA_PRICES_META = {
	asOf: "2026-07",
	source: "Αρχικό γέμισμα από δημοσιευμένα στοιχεία αγγελιών (Spitogatos, xe.gr) και την εικόνα του γραφείου. Προς επαλήθευση ανά τρίμηνο.",
};

/* Κάθε γραμμή: όνομα περιοχής όπως μιλιέται (το matching είναι χαλαρό,
   χωρίς τόνους/πεζά, βλ. findAreaPrices), εύρος πώλησης €/τ.μ., εύρος
   ενοικίασης €/τ.μ./μήνα. Τα εύρη είναι για «τυπικό» διαμέρισμα της
   περιοχής· παλιά αναξιοποίητα και νεόδμητα πέφτουν έξω από αυτά. */
export const AREA_PRICES = [
	{ area: "Κέντρο Θεσσαλονίκης", saleLow: 2300, saleHigh: 3200, rentLow: 9.0, rentHigh: 12.5 },
	{ area: "Ανάληψη / Ντεπώ / Φάληρο", saleLow: 2300, saleHigh: 3000, rentLow: 8.5, rentHigh: 11.5 },
	{ area: "Τριανδρία", saleLow: 1900, saleHigh: 2500, rentLow: 8.0, rentHigh: 10.5 },
	{ area: "Τούμπα", saleLow: 1700, saleHigh: 2300, rentLow: 7.5, rentHigh: 10.0 },
	{ area: "Χαριλάου", saleLow: 1900, saleHigh: 2500, rentLow: 8.0, rentHigh: 10.5 },
	{ area: "Καλαμαριά", saleLow: 2400, saleHigh: 3200, rentLow: 8.5, rentHigh: 12.0 },
	{ area: "Πυλαία", saleLow: 2200, saleHigh: 3000, rentLow: 8.0, rentHigh: 11.0 },
	{ area: "Πανόραμα", saleLow: 2300, saleHigh: 3200, rentLow: 7.5, rentHigh: 10.5 },
	{ area: "Θέρμη", saleLow: 2000, saleHigh: 2800, rentLow: 7.5, rentHigh: 10.0 },
	{ area: "Θερμαϊκός (Περαία, Ν. Επιβάτες, Αγ. Τριάδα)", saleLow: 1600, saleHigh: 2300, rentLow: 6.5, rentHigh: 9.0 },
	{ area: "Εύοσμος", saleLow: 1400, saleHigh: 1900, rentLow: 6.5, rentHigh: 8.5 },
	{ area: "Κορδελιό", saleLow: 1200, saleHigh: 1700, rentLow: 6.0, rentHigh: 8.0 },
	{ area: "Αμπελόκηποι", saleLow: 1300, saleHigh: 1800, rentLow: 6.5, rentHigh: 8.5 },
	{ area: "Μενεμένη", saleLow: 1000, saleHigh: 1500, rentLow: 5.5, rentHigh: 7.5 },
	{ area: "Σταυρούπολη", saleLow: 1300, saleHigh: 1800, rentLow: 6.5, rentHigh: 8.5 },
	{ area: "Πολίχνη", saleLow: 1300, saleHigh: 1800, rentLow: 6.5, rentHigh: 8.5 },
	{ area: "Νεάπολη", saleLow: 1200, saleHigh: 1700, rentLow: 6.5, rentHigh: 8.5 },
	{ area: "Συκιές", saleLow: 1200, saleHigh: 1700, rentLow: 6.5, rentHigh: 8.5 },
	{ area: "Ωραιόκαστρο", saleLow: 1500, saleHigh: 2100, rentLow: 6.5, rentHigh: 9.0 },
	{ area: "Καλλιθέα (Παύλου Μελά)", saleLow: 1200, saleHigh: 1700, rentLow: 6.0, rentHigh: 8.0 },
	{ area: "Λαγκαδάς", saleLow: 900, saleHigh: 1300, rentLow: 5.0, rentHigh: 7.0 },
	{ area: "Ασπροβάλτα / Σταυρός", saleLow: 1200, saleHigh: 1800, rentLow: 5.5, rentHigh: 8.0 },
	/* Χαλκιδική: έντονη εποχικότητα, οι εξοχικές τιμές τραβάνε το πάνω
	   άκρο και τα ενοίκια δωδεκάμηνου είναι δυσανάλογα χαμηλά. */
	{ area: "Νέα Μουδανιά / Ν. Καλλικράτεια", saleLow: 1500, saleHigh: 2300, rentLow: 6.0, rentHigh: 8.5 },
	{ area: "Κασσάνδρα Χαλκιδικής", saleLow: 1800, saleHigh: 2900, rentLow: 5.5, rentHigh: 8.5 },
	{ area: "Σιθωνία Χαλκιδικής", saleLow: 1800, saleHigh: 3000, rentLow: 5.5, rentHigh: 8.5 },
	{ area: "Πολύγυρος", saleLow: 1000, saleHigh: 1500, rentLow: 4.5, rentHigh: 6.5 },
	/* Πιερία */
	{ area: "Κατερίνη", saleLow: 1000, saleHigh: 1500, rentLow: 5.0, rentHigh: 7.0 },
	{ area: "Παραλία Κατερίνης / Ολυμπιακή Ακτή", saleLow: 1300, saleHigh: 2000, rentLow: 5.0, rentHigh: 7.5 },
	{ area: "Λιτόχωρο / Λεπτοκαρυά / Πλαταμώνας", saleLow: 1200, saleHigh: 1900, rentLow: 5.0, rentHigh: 7.0 },
	/* Σέρρες, Ημαθία, Πέλλα, Κιλκίς */
	{ area: "Σέρρες", saleLow: 900, saleHigh: 1300, rentLow: 4.5, rentHigh: 6.5 },
	{ area: "Βέροια", saleLow: 800, saleHigh: 1200, rentLow: 4.5, rentHigh: 6.5 },
	{ area: "Νάουσα", saleLow: 600, saleHigh: 1000, rentLow: 4.0, rentHigh: 6.0 },
	{ area: "Αλεξάνδρεια Ημαθίας", saleLow: 700, saleHigh: 1100, rentLow: 4.0, rentHigh: 6.0 },
	{ area: "Έδεσσα", saleLow: 700, saleHigh: 1100, rentLow: 4.0, rentHigh: 6.0 },
	{ area: "Γιαννιτσά", saleLow: 800, saleHigh: 1200, rentLow: 4.5, rentHigh: 6.5 },
	{ area: "Κιλκίς", saleLow: 700, saleHigh: 1100, rentLow: 4.0, rentHigh: 6.0 },
];

/* Χαλαρό ταίριασμα ονόματος περιοχής: χωρίς τόνους, πεζά, και αρκεί το
   ένα να περιέχει το άλλο («Ανω Τουμπα» βρίσκει «Τούμπα»). Επιστρέφει
   τη γραμμή ή null· ο caller δίνει ΠΑΝΤΑ και ολόκληρο τον πίνακα στο
   prompt, οπότε ένα null απλώς σημαίνει «διάλεξε εσύ την κοντινότερη». */
export function findAreaPrices(name) {
	const want = norm(name);
	if (!want) return null;
	let best = null;
	for (const row of AREA_PRICES) {
		const have = norm(row.area);
		if (have === want) return row;
		if (!best && (have.includes(want) || want.includes(have.split(" ")[0]))) best = row;
		if (!best) {
			for (const part of have.split(/[\s/(),]+/)) {
				if (part.length > 3 && want.includes(part)) { best = row; break; }
			}
		}
	}
	return best;
}

function norm(s) {
	return String(s || "")
		.toLowerCase()
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.trim();
}
