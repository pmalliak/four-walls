/* =====================================================================
   Four Walls — τιμές αγοράς ανά περιοχή (Κεντρική Μακεδονία)
   ---------------------------------------------------------------------
   Ζητούμενες τιμές αγγελιών σε €/τ.μ. (πώληση) και €/τ.μ./μήνα
   (ενοικίαση) για κατοικίες, ανά περιοχή. Τροφοδοτούν την εκτίμηση
   αξίας (worker/lib/valuation.mjs) ως αφετηρία, μαζί με τα πραγματικά
   συγκριτικά του feed.

   ΠΡΟΣΟΧΗ: ζητούμενες τιμές, όχι τιμές συναλλαγής. Το κλείσιμο πέφτει
   συνήθως ~10% χαμηλότερα· αυτό το ξέρει το prompt, όχι ο πίνακας.

   ΚΑΙ ΟΜΩΣ ΕΙΝΑΙ Η ΚΑΛΥΤΕΡΗ ΒΑΣΗ ΠΟΥ ΕΧΟΥΜΕ: οι τιμές συμβολαίων και οι
   αντικειμενικές αξίες είναι συστηματικά χαμηλότερες από την πραγματική
   τιμή κλεισίματος (μέρος του τιμήματος δίνεται εκτός συμβολαίου), οπότε
   δεν χρησιμεύουν ως αφετηρία. Ο κανόνας είναι γραμμένος στο prompt
   (PRICE_BASIS στο valuation.mjs) — μην τον αναιρέσεις εδώ.

   Συντήρηση: χειροκίνητα, με πηγές τα δημόσια στοιχεία των portals
   (Spitogatos «Τιμές ακινήτων» / SPI, xe.gr στατιστικά) και την εικόνα
   του γραφείου. Ενημέρωσε το asOf σε κάθε αλλαγή. Όσο το asOf μένει
   πίσω, τόσο πιο επιφυλακτικό γίνεται το report (βλ. valuation.mjs).
   Μετά από ΚΑΘΕ αλλαγή του πίνακα τρέξε `node tools/area-prices-log.mjs`
   πριν το commit: κρατά τη χρονοσειρά των εγκεκριμένων πινάκων στο
   area-prices-history.json δίπλα (ίδιο commit, βλ. docs/valuation.md).
   ===================================================================== */

export const AREA_PRICES_META = {
	asOf: "2026-07",
	source: "Μηνιαίος έλεγχος με live αναζήτηση (Spitogatos, xe.gr, δείκτες ΤτΕ/SPI), εγκεκριμένος από τον Πάνο 2026-07-30. Επόμενο email ελέγχου: 1η του μήνα.",
	/* Οι δημοσιευμένοι δείκτες του τελευταίου εγκεκριμένου ελέγχου. Δίνουν
	   στην εκτίμηση το πρόσημο της αγοράς (πλαίσιο για σχόλιο/συμβουλή,
	   ΟΧΙ συντελεστή πάνω στα εύρη — βλ. buildDataBlock στο valuation.mjs).
	   Ενημερώνεται μαζί με τον πίνακα σε κάθε έγκριση. */
	trend: "Spitogatos SPI πώλησης: Δήμος Θεσσαλονίκης +3,4%, προάστια +12,8%, πανελλαδικά +6,1% (Β' τρίμηνο 2026)· δείκτης τιμών διαμερισμάτων ΤτΕ Θεσσαλονίκη +6,4% ετησίως (Α' τρίμηνο 2026).",
};

/* Κάθε γραμμή: όνομα περιοχής όπως μιλιέται (το matching είναι χαλαρό,
   χωρίς τόνους/πεζά, βλ. findAreaPrices), εύρος πώλησης €/τ.μ., εύρος
   ενοικίασης €/τ.μ./μήνα. Τα εύρη είναι για «τυπικό» διαμέρισμα της
   περιοχής· παλιά αναξιοποίητα και νεόδμητα πέφτουν έξω από αυτά. */
export const AREA_PRICES = [
	{ area: "Κέντρο Θεσσαλονίκης", saleLow: 2400, saleHigh: 3350, rentLow: 9.5, rentHigh: 13 },
	{ area: "Ανάληψη / Ντεπώ / Φάληρο", saleLow: 2400, saleHigh: 3150, rentLow: 9, rentHigh: 12 },
	{ area: "Τριανδρία", saleLow: 2000, saleHigh: 2650, rentLow: 8.5, rentHigh: 11 },
	{ area: "Τούμπα", saleLow: 1800, saleHigh: 2450, rentLow: 8, rentHigh: 10.5 },
	{ area: "Χαριλάου", saleLow: 2000, saleHigh: 2650, rentLow: 8.5, rentHigh: 11 },
	{ area: "Καλαμαριά", saleLow: 2550, saleHigh: 3350, rentLow: 9, rentHigh: 12.5 },
	{ area: "Πυλαία", saleLow: 2350, saleHigh: 3150, rentLow: 8.5, rentHigh: 11.5 },
	{ area: "Πανόραμα", saleLow: 2450, saleHigh: 3350, rentLow: 8, rentHigh: 11 },
	{ area: "Θέρμη", saleLow: 2150, saleHigh: 2950, rentLow: 8, rentHigh: 10.5 },
	{ area: "Θερμαϊκός (Περαία, Ν. Επιβάτες, Αγ. Τριάδα)", saleLow: 1700, saleHigh: 2450, rentLow: 7, rentHigh: 9.5 },
	{ area: "Εύοσμος", saleLow: 1500, saleHigh: 2050, rentLow: 7, rentHigh: 9 },
	{ area: "Κορδελιό", saleLow: 1300, saleHigh: 1850, rentLow: 6.5, rentHigh: 8.5 },
	{ area: "Αμπελόκηποι", saleLow: 1400, saleHigh: 1950, rentLow: 7, rentHigh: 9 },
	{ area: "Μενεμένη", saleLow: 1100, saleHigh: 1650, rentLow: 6, rentHigh: 8 },
	{ area: "Σταυρούπολη", saleLow: 1400, saleHigh: 1950, rentLow: 7, rentHigh: 9 },
	{ area: "Πολίχνη", saleLow: 1400, saleHigh: 1950, rentLow: 7, rentHigh: 9 },
	{ area: "Νεάπολη", saleLow: 1300, saleHigh: 1850, rentLow: 7, rentHigh: 9 },
	{ area: "Συκιές", saleLow: 1350, saleHigh: 1900, rentLow: 7, rentHigh: 9 },
	{ area: "Ωραιόκαστρο", saleLow: 1600, saleHigh: 2250, rentLow: 7, rentHigh: 9.5 },
	{ area: "Καλλιθέα (Παύλου Μελά)", saleLow: 1300, saleHigh: 1850, rentLow: 6.5, rentHigh: 8.5 },
	{ area: "Λαγκαδάς", saleLow: 950, saleHigh: 1400, rentLow: 5.5, rentHigh: 7.5 },
	{ area: "Ασπροβάλτα / Σταυρός", saleLow: 1300, saleHigh: 1950, rentLow: 6, rentHigh: 8.5 },
	/* Χαλκιδική: έντονη εποχικότητα, οι εξοχικές τιμές τραβάνε το πάνω
	   άκρο και τα ενοίκια δωδεκάμηνου είναι δυσανάλογα χαμηλά. */
	{ area: "Νέα Μουδανιά / Ν. Καλλικράτεια", saleLow: 1600, saleHigh: 2450, rentLow: 6.5, rentHigh: 9 },
	{ area: "Κασσάνδρα Χαλκιδικής", saleLow: 1950, saleHigh: 3100, rentLow: 6, rentHigh: 9 },
	{ area: "Σιθωνία Χαλκιδικής", saleLow: 1950, saleHigh: 3200, rentLow: 6, rentHigh: 9 },
	{ area: "Πολύγυρος", saleLow: 1050, saleHigh: 1600, rentLow: 5, rentHigh: 7 },
	/* Πιερία */
	{ area: "Κατερίνη", saleLow: 1050, saleHigh: 1600, rentLow: 5.5, rentHigh: 7.5 },
	{ area: "Παραλία Κατερίνης / Ολυμπιακή Ακτή", saleLow: 1400, saleHigh: 2150, rentLow: 5.5, rentHigh: 8 },
	{ area: "Λιτόχωρο / Λεπτοκαρυά / Πλαταμώνας", saleLow: 1300, saleHigh: 2050, rentLow: 5.5, rentHigh: 7.5 },
	/* Σέρρες, Ημαθία, Πέλλα, Κιλκίς */
	{ area: "Σέρρες", saleLow: 950, saleHigh: 1400, rentLow: 5, rentHigh: 7 },
	{ area: "Βέροια", saleLow: 850, saleHigh: 1300, rentLow: 5, rentHigh: 7 },
	{ area: "Νάουσα", saleLow: 650, saleHigh: 1100, rentLow: 4.5, rentHigh: 6.5 },
	{ area: "Αλεξάνδρεια Ημαθίας", saleLow: 750, saleHigh: 1200, rentLow: 4.5, rentHigh: 6.5 },
	{ area: "Έδεσσα", saleLow: 750, saleHigh: 1200, rentLow: 4.5, rentHigh: 6.5 },
	{ area: "Γιαννιτσά", saleLow: 850, saleHigh: 1300, rentLow: 5, rentHigh: 7 },
	{ area: "Κιλκίς", saleLow: 750, saleHigh: 1200, rentLow: 4.5, rentHigh: 6.5 },
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
