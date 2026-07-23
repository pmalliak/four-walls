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
     description    meta + og description (aim for 120–160 chars, in the
                    page's language).
     workerManaged  true = the Worker injects canonical/OG/JSON-LD per
                    request (listing detail page) — the static head gets
                    only title + description so the two never duplicate.
     sitemap        false = keep out of sitemap.xml (shells, error pages).

   LANGUAGES — keys under "en/" are the English site (/en/…). A page's
   language and its translation pair derive from the KEY alone (pageLang /
   alternateKey below), so el↔en pairs can never drift: "en/about.html"
   is always the alternate of "about.html" and vice versa.
   ===================================================================== */

export const SITE = {
	origin: "https://four-walls.gr",
	name: "Four Walls Real Estate",
	locales: { el: "el_GR", en: "en_GB" }, // og:locale per language
	/* Shared social-preview image (og:image / twitter:image), root-relative.
	   The ?v=… is a cache-buster: bump it whenever og-home.fw.png is
	   re-rendered so social scrapers (FB/LinkedIn/WhatsApp/Viber) re-fetch
	   instead of showing the cached preview. */
	ogImage: "/images/assets/og-home.fw.png?v=20260723",
};

/* Language of a PAGES_META key ("en/about.html" -> "en", else "el"). */
export const pageLang = (key) => (key.startsWith("en/") ? "en" : "el");

/* The key of the same page in the other language. May not exist in
   PAGES_META — callers must check before emitting hreflang pairs. */
export const alternateKey = (key) => (key.startsWith("en/") ? key.slice(3) : "en/" + key);

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

	/* ------------------------- English site (/en/) ------------------------- */
	"en/index.html": {
		path: "/en/",
		title: "Four Walls Real Estate · Estate Agency in Thessaloniki, Greece",
		description: "Four Walls Real Estate — estate agency in Thessaloniki, Greece. Buying, selling, renting, property valuation and property management.",
	},
	"en/properties.html": {
		path: "/en/properties",
		title: "Properties for Sale & Rent in Thessaloniki | Four Walls",
		description: "Browse all available Four Walls properties in Thessaloniki — apartments, houses, commercial spaces and plots of land, for sale or to rent.",
	},
	"en/property.html": {
		path: "/en/property",
		title: "Property | Four Walls",
		description: "Property details — Four Walls, Thessaloniki, Greece.",
		workerManaged: true,
		sitemap: false,
	},
	"en/services.html": {
		path: "/en/services",
		title: "Services · Four Walls Real Estate",
		description: "Four Walls services in Thessaloniki: buying, selling, renting, valuation, renovation and property management — with you at every step.",
	},
	"en/services/buying.html": {
		path: "/en/services/buying",
		title: "Buying a Property · Four Walls Real Estate",
		description: "Buy property in Thessaloniki with Four Walls — tailored search, accompanied viewings, negotiation and support all the way to contract.",
	},
	"en/services/selling.html": {
		path: "/en/services/selling",
		title: "Selling Your Property · Four Walls Real Estate",
		description: "Sell your property in Thessaloniki with Four Walls — the right asking price, polished marketing and negotiation through to completion.",
	},
	"en/services/renting.html": {
		path: "/en/services/renting",
		title: "Renting · Four Walls Real Estate",
		description: "Rent property in Thessaloniki with Four Walls — the right home at the right rent, or a reliable tenant for your property.",
	},
	"en/services/valuation.html": {
		path: "/en/services/valuation",
		title: "Property Valuation · Four Walls Real Estate",
		description: "Property valuation in Thessaloniki by Four Walls — a documented price recommendation backed by real market data.",
	},
	"en/services/renovation.html": {
		path: "/en/services/renovation",
		title: "Renovation · Four Walls Real Estate",
		description: "Property renovation in Thessaloniki by Four Walls — partial or full renovation and energy upgrades, with contractors we trust.",
	},
	"en/services/property-management.html": {
		path: "/en/services/property-management",
		title: "Property Management · Four Walls Real Estate",
		description: "Property management in Thessaloniki by Four Walls — lettings, maintenance and rent collection, with none of the hassle.",
	},
	"en/about.html": {
		path: "/en/about",
		title: "About Us · Four Walls Real Estate",
		description: "Meet Four Walls — an estate agency in Thessaloniki, Greece, offering personal service and transparency in buying, selling, renting and property management.",
	},
	"en/contact.html": {
		path: "/en/contact",
		title: "Contact · Four Walls Real Estate",
		description: "Contact Four Walls: Fragkini 9, 54624 Thessaloniki, Greece · tel. +30 6907 483 463 · info@four-walls.gr · Monday–Friday 10:00–18:00.",
	},
	"en/faq.html": {
		path: "/en/faq",
		title: "Frequently Asked Questions · Four Walls Real Estate",
		description: "Answers to the most common questions about buying, selling, renting and property valuation in Thessaloniki, from Four Walls.",
	},
	"en/terms-of-use.html": {
		path: "/en/terms-of-use",
		title: "Terms of Use · Four Walls Real Estate",
		description: "The terms of use of the Four Walls website — estate agency in Thessaloniki, Greece.",
	},
	"en/privacy-policy.html": {
		path: "/en/privacy-policy",
		title: "Privacy Policy · Four Walls Real Estate",
		description: "How Four Walls collects and protects your personal data, in line with the GDPR.",
	},
	"en/cookies.html": {
		path: "/en/cookies",
		title: "Cookies · Four Walls Real Estate",
		description: "How the Four Walls website uses cookies — which ones are set and how to manage them.",
	},
	"en/404.html": {
		path: null,
		title: "Page Not Found · Four Walls Real Estate",
		description: "The page you requested could not be found — Four Walls Real Estate, Thessaloniki.",
		sitemap: false,
	},
};
