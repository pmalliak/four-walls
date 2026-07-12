/* =====================================================================
   Four Walls — page metadata registry (single source of truth for SEO)
   ---------------------------------------------------------------------
   Consumed by BOTH:
     - tools/sync-partials.js  — stamps each page's <head> block (title,
       description, canonical, Open Graph / Twitter tags) between
       <!-- FW:HEAD --> markers. Edit HERE, then re-run the sync.
     - worker/lib/seo.mjs      — builds sitemap.xml from the same list.

   Per-page fields:
     path           canonical path on the production origin ("/" for the
                    home page, "/properties", …). null = never canonical
                    (404 page).
     title          exact <title> / og:title text.
     description    meta + og description (aim for 120–160 chars, Greek).
     workerManaged  true = the Worker injects canonical/OG/JSON-LD per
                    request (listing detail page) — the static head gets
                    only title + description so the two never duplicate.
     sitemap        false = keep out of sitemap.xml (shells, error pages).
   ===================================================================== */

export const SITE = {
	origin: "https://four-walls.gr",
	name: "Four Walls Real Estate",
	locale: "el_GR",
	/* Shared social-preview image (og:image / twitter:image), root-relative. */
	ogImage: "/images/assets/ogg.fw.png",
};

export const PAGES_META = {
	"index.html": {
		path: "/",
		title: "Four Walls Real Estate · Μεσιτικό γραφείο Θεσσαλονίκης",
		description: "Four Walls Real Estate — Μεσιτικό γραφείο στη Θεσσαλονίκη. Αγορά, πώληση, ενοικίαση, εκτίμηση και διαχείριση ακινήτων.",
	},
	"properties.html": {
		path: "/properties",
		title: "Ακίνητα προς πώληση & ενοικίαση | Four Walls",
		description: "Όλα τα διαθέσιμα ακίνητα της Four Walls στη Θεσσαλονίκη — διαμερίσματα, μονοκατοικίες, επαγγελματικοί χώροι και οικόπεδα, για αγορά ή ενοικίαση.",
	},
	"property.html": {
		path: "/property",
		title: "Ακίνητο | Four Walls",
		description: "Λεπτομέρειες ακινήτου — Four Walls, Θεσσαλονίκη.",
		workerManaged: true,
		sitemap: false,
	},
	"services.html": {
		path: "/services",
		title: "Υπηρεσίες · Four Walls Real Estate",
		description: "Οι υπηρεσίες της Four Walls στη Θεσσαλονίκη: αγορά, πώληση, ενοικίαση, εκτίμηση, ανακαίνιση και διαχείριση ακινήτων — δίπλα σας σε κάθε βήμα.",
	},
	"services/buying.html": {
		path: "/services/buying",
		title: "Αγορά ακινήτου · Four Walls Real Estate",
		description: "Αγορά ακινήτου στη Θεσσαλονίκη με τη Four Walls — προσωπική αναζήτηση, υποδείξεις, διαπραγμάτευση και υποστήριξη μέχρι το συμβόλαιο.",
	},
	"services/selling.html": {
		path: "/services/selling",
		title: "Πώληση ακινήτου · Four Walls Real Estate",
		description: "Πώληση ακινήτου στη Θεσσαλονίκη με τη Four Walls — σωστή τιμή, προσεγμένη προβολή και διαπραγμάτευση μέχρι το συμβόλαιο.",
	},
	"services/renting.html": {
		path: "/services/renting",
		title: "Ενοικίαση · Four Walls Real Estate",
		description: "Ενοικίαση ακινήτου στη Θεσσαλονίκη με τη Four Walls — το σωστό ενοίκιο για εσάς ή ο αξιόπιστος ενοικιαστής για το ακίνητό σας.",
	},
	"services/valuation.html": {
		path: "/services/valuation",
		title: "Εκτίμηση ακινήτου · Four Walls Real Estate",
		description: "Εκτίμηση αξίας ακινήτου στη Θεσσαλονίκη από τη Four Walls — τεκμηριωμένη πρόταση τιμής με πραγματικά στοιχεία αγοράς.",
	},
	"services/renovation.html": {
		path: "/services/renovation",
		title: "Ανακαινίσεις · Four Walls Real Estate",
		description: "Ανακαινίσεις ακινήτων στη Θεσσαλονίκη από τη Four Walls — μερική ή ολική ανακαίνιση και ενεργειακή αναβάθμιση, με συνεργεία που εμπιστευόμαστε.",
	},
	"services/property-management.html": {
		path: "/services/property-management",
		title: "Διαχείριση ακινήτων · Four Walls Real Estate",
		description: "Διαχείριση ακινήτων στη Θεσσαλονίκη από τη Four Walls — μισθώσεις, συντήρηση και εισπράξεις, χωρίς κανέναν πονοκέφαλο για εσάς.",
	},
	"about.html": {
		path: "/about",
		title: "Σχετικά με εμάς · Four Walls Real Estate",
		description: "Γνωρίστε τη Four Walls — μεσιτικό γραφείο στη Θεσσαλονίκη με προσωπική εξυπηρέτηση και διαφάνεια σε αγορά, πώληση, ενοικίαση και διαχείριση ακινήτων.",
	},
	"contact.html": {
		path: "/contact",
		title: "Επικοινωνία · Four Walls Real Estate",
		description: "Επικοινωνήστε με τη Four Walls: Φραγκίνη 9, 54624 Θεσσαλονίκη · τηλ. +30 6907 483 463 · info@four-walls.gr · Δευτέρα–Παρασκευή 10:00–18:00.",
	},
	"faq.html": {
		path: "/faq",
		title: "Συχνές ερωτήσεις · Four Walls Real Estate",
		description: "Απαντήσεις στις πιο συχνές ερωτήσεις για αγορά, πώληση, ενοικίαση και εκτίμηση ακινήτων στη Θεσσαλονίκη από τη Four Walls.",
	},
	"terms-of-use.html": {
		path: "/terms-of-use",
		title: "Όροι χρήσης · Four Walls Real Estate",
		description: "Οι όροι χρήσης του ιστότοπου της Four Walls — μεσιτικό γραφείο στη Θεσσαλονίκη.",
	},
	"privacy-policy.html": {
		path: "/privacy-policy",
		title: "Πολιτική απορρήτου · Four Walls Real Estate",
		description: "Πώς η Four Walls συλλέγει και προστατεύει τα προσωπικά σας δεδομένα, σύμφωνα με τον ΓΚΠΔ (GDPR).",
	},
	"cookies.html": {
		path: "/cookies",
		title: "Cookies · Four Walls Real Estate",
		description: "Ενημέρωση για τα cookies στον ιστότοπο της Four Walls — ποια χρησιμοποιούνται και πώς να τα διαχειριστείτε.",
	},
	"404.html": {
		path: null,
		title: "Η σελίδα δεν βρέθηκε · Four Walls Real Estate",
		description: "Η σελίδα που ζητήσατε δεν βρέθηκε — Four Walls Real Estate, Θεσσαλονίκη.",
		sitemap: false,
	},
};
