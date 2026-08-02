#!/usr/bin/env node
/* =====================================================================
   Four Walls: street index builder (OpenStreetMap)
   ---------------------------------------------------------------------
   Χτίζει το `forms/_streets.fw.js`, τον τοπικό κατάλογο δρόμων που δίνει
   autocomplete διεύθυνσης στην «Εκτίμηση Ακινήτου».

   ΓΙΑΤΙ ΤΟΠΙΚΟΣ ΚΑΤΑΛΟΓΟΣ ΚΑΙ ΟΧΙ GEOCODING API
   Δοκιμάστηκαν και τα δύο δωρεάν (2026-08-02) και **αποτυγχάνουν στα
   ελληνικά**: το Photon γυρίζει δρόμους της Πορτογαλίας για
   «Μεταμορφώσεως» και δεν βρίσκει καθόλου την Τσιμισκή· το Nominatim
   γυρίζει κενό ακόμη και για «Τσιμισκή, Θεσσαλονίκη». Τα ΔΕΔΟΜΕΝΑ όμως
   υπάρχουν: το ίδιο Overpass query τους βρίσκει και τους τρεις. Το
   πρόβλημα είναι το text search των geocoders, όχι το OSM. Οπότε τα
   κατεβάζουμε μία φορά εδώ και ψάχνουμε εμείς, στη συσκευή.

   Και βγαίνει καλύτερο απ' ό,τι θα έδινε το API:
     • δουλεύει OFFLINE, όπως όλο το PWA
     • ταιριάζει ΧΩΡΙΣ ΤΟΝΟΥΣ («τσιμισκη» βρίσκει «Τσιμισκή»)
     • ακαριαίο, χωρίς rate limit, χωρίς κλειδί, χωρίς κόστος
     • κάθε δρόμος έρχεται με την ΠΕΡΙΟΧΗ ΤΟΥ ΠΙΝΑΚΑ ΤΙΜΩΝ κολλημένη,
       επειδή τον κατεβάζουμε ανά περιοχή, άρα η επιλογή διεύθυνσης
       γεμίζει περιοχή που ο `findAreaPrices` σίγουρα αναγνωρίζει
     • και με απόσταση από στάση μετρό, το μόνο γεωγραφικό δεδομένο που
       αλλάζει το νούμερο της εκτίμησης (κανόνας Cerved, docs/valuation.md)

   Ίδιο σκεπτικό με το build-accessibility.mjs: το Overpass ΔΕΝ είναι
   προσβάσιμο από τον Cloudflare Worker (οι κλήσεις προς τα public mirrors
   κολλάνε), οπότε ό,τι θέλει OSM προϋπολογίζεται εδώ, σε πραγματικό
   μηχάνημα, και μπαίνει στο git.

   ΤΡΕΞ' ΤΟ όταν αλλάξει ο πίνακας περιοχών (νέα γραμμή στο
   area-prices.mjs) ή για φρέσκα δεδομένα OSM, μετά commit + push:
     node tools/build-streets.mjs                      # συμπληρώνει ό,τι λείπει
     node tools/build-streets.mjs --all                # ξανακατεβάζει τα πάντα
     node tools/build-streets.mjs --area "Καλαμαριά"   # ξαναχτίζει ΜΟΝΟ αυτήν

   INCREMENTAL: ο δημόσιος Overpass κόβει αυθαίρετα κλήσεις και το αρχείο
   γράφεται μετά από κάθε περιοχή, οπότε ένα διακομμένο τρέξιμο δεν χάνει
   τίποτα: ξανατρέχεις και συνεχίζει από εκεί που έμεινε.

   Πηγή: © OpenStreetMap contributors (ODbL).
   ===================================================================== */

import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { AREA_PRICES, zoneOf } from "../worker/lib/area-prices.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "forms", "_streets.fw.js");
const UA = "four-walls-streets/1.0 (+https://four-walls.gr)";
const args = process.argv.slice(2);
const ONLY = args.includes("--area") ? args[args.indexOf("--area") + 1] : null;
const REBUILD_ALL = args.includes("--all");

const MIRRORS = [
	"https://overpass-api.de/api/interpreter",
	"https://overpass.kumi.systems/api/interpreter",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ΠΑΝΤΑ bbox, ΠΟΤΕ `around:`. Το ίδιο ερώτημα με `around:2100,…` γύριζε
   504 μετά από 84 δευτερόλεπτα· ως bbox απαντά σε 2,7. Το τετράγωνο
   πιάνει λίγο παραπάνω από τον κύκλο, που εδώ είναι ακίνδυνο: οι ακτίνες
   είναι ούτως ή άλλως χονδρικές και οι επικαλύψεις επιθυμητές. */
function bboxOf(lat, lon, metres) {
	const dLat = metres / 111320;
	const dLon = metres / (111320 * Math.cos((lat * Math.PI) / 180));
	return [lat - dLat, lon - dLon, lat + dLat, lon + dLon]
		.map((n) => n.toFixed(4)).join(",");
}

/* ΤΑ ΣΗΜΕΙΑ ΚΑΘΕ ΠΕΡΙΟΧΗΣ ΤΟΥ ΠΙΝΑΚΑ, [lat, lon, ακτίνα σε μέτρα].
   Περισσότερα του ενός όπου η γραμμή του πίνακα καλύπτει χωριστούς
   οικισμούς («Θερμαϊκός (Περαία, Ν. Επιβάτες, Αγ. Τριάδα)»): ένας κύκλος
   που θα τους χωρούσε όλους θα έπιανε και τη μισή Θεσσαλονίκη. Οι ακτίνες
   είναι γενναιόδωρες επίτηδες: ο ίδιος δρόμος σε δύο περιοχές είναι πολύ
   μικρότερο κακό από έναν δρόμο που λείπει. */
const AREA_SPOTS = {
	"Κέντρο Θεσσαλονίκης": [[40.6350, 22.9400, 1600]],
	"Ανάληψη / Ντεπώ / Φάληρο": [[40.6185, 22.9555, 1100]],
	"Τριανδρία": [[40.6285, 22.9695, 900]],
	"Τούμπα": [[40.6175, 22.9720, 1300]],
	"Χαριλάου": [[40.6075, 22.9640, 1000]],
	"Καλαμαριά": [[40.5790, 22.9500, 2100]],
	"Πυλαία": [[40.6010, 22.9860, 1800]],
	"Πανόραμα": [[40.5860, 23.0330, 1700]],
	"Θέρμη": [[40.5480, 23.0180, 2400]],
	"Θερμαϊκός (Περαία, Ν. Επιβάτες, Αγ. Τριάδα)": [
		[40.5027, 22.9262, 2200],   // Περαία
		[40.5011, 22.9103, 1800],   // Νέοι Επιβάτες
		[40.4953, 22.8706, 1800],   // Αγία Τριάδα
	],
	"Εύοσμος": [[40.6650, 22.9020, 2000]],
	"Κορδελιό": [[40.6700, 22.8850, 1400]],
	"Αμπελόκηποι": [[40.6580, 22.9150, 1600]],
	"Μενεμένη": [[40.6600, 22.8950, 1600]],
	"Σταυρούπολη": [[40.6720, 22.9250, 1500]],
	"Πολίχνη": [[40.6700, 22.9400, 1800]],
	"Νεάπολη": [[40.6546, 22.9420, 1400]],
	"Συκιές": [[40.6520, 22.9450, 1600]],
	"Ωραιόκαστρο": [[40.7250, 22.9000, 2600]],
	"Καλλιθέα (Παύλου Μελά)": [[40.6650, 22.9330, 1400]],
	"Λαγκαδάς": [[40.7500, 23.0700, 2000]],
	"Ασπροβάλτα / Σταυρός": [
		[40.7280, 23.7100, 2200],   // Ασπροβάλτα
		[40.6600, 23.7050, 2000],   // Σταυρός Θεσσαλονίκης
	],
	"Νέα Μουδανιά / Ν. Καλλικράτεια": [
		[40.2440, 23.2800, 2400],   // Νέα Μουδανιά
		[40.3150, 23.0650, 2200],   // Νέα Καλλικράτεια
	],
	"Κασσάνδρα Χαλκιδικής": [
		[40.0700, 23.4400, 6000],   // Κασσάνδρεια / Καλλιθέα
		[39.9600, 23.6000, 6000],   // Παλιούρι / Χανιώτη / Πευκοχώρι
	],
	"Σιθωνία Χαλκιδικής": [
		[40.2232, 23.6688, 6000],   // Νικήτη / Άγιος Νικόλαος
		[40.0951, 23.9784, 6000],   // Σάρτη / Βουρβουρού
		[40.0956, 23.7812, 5000],   // Νέος Μαρμαράς / Τορώνη
	],
	"Πολύγυρος": [[40.3780, 23.4430, 2000]],
	"Κατερίνη": [[40.2700, 22.5030, 2800]],
	"Παραλία Κατερίνης / Ολυμπιακή Ακτή": [
		[40.2660, 22.5950, 2000],   // Παραλία
		[40.2402, 22.5849, 2000],   // Ολυμπιακή Ακτή
	],
	"Λιτόχωρο / Λεπτοκαρυά / Πλαταμώνας": [
		[40.1010, 22.5030, 2200],   // Λιτόχωρο
		[40.0592, 22.5639, 2000],   // Λεπτοκαρυά
		[39.9840, 22.5940, 2000],   // Πλαταμώνας
	],
	"Σέρρες": [[41.0850, 23.5470, 2800]],
	"Βέροια": [[40.5230, 22.2030, 2600]],
	"Νάουσα": [[40.6300, 22.0700, 2200]],
	"Αλεξάνδρεια Ημαθίας": [[40.6270, 22.4500, 2000]],
	"Έδεσσα": [[40.8020, 22.0470, 2200]],
	"Γιαννιτσά": [[40.7900, 22.4070, 2200]],
	"Κιλκίς": [[40.9930, 22.8730, 2200]],
};

/* Οι τύποι δρόμου που έχουν διεύθυνση ακινήτου. Έξω τα service/track/
   footway: γεμίζουν τον κατάλογο με «Παράδρομος» και μονοπάτια. */
const HIGHWAYS = "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian)$";

async function overpass(query, label) {
	let last = "";
	for (const url of MIRRORS) {
		for (let attempt = 1; attempt <= 3; attempt++) {
			try {
				const res = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
					body: "data=" + encodeURIComponent(query),
					/* Ένα υγιές ερώτημα απαντά σε 3-10 δευτερόλεπτα· πάνω από
					   ένα λεπτό σημαίνει ότι το mirror μας κρατάει στην ουρά,
					   και μας συμφέρει να δοκιμάσουμε το επόμενο αντί να
					   κρεμάμε το build. Χωρίς signal, το fetch περιμένει για
					   πάντα. */
					signal: AbortSignal.timeout(60000),
				});
				const txt = await res.text();
				if (txt.startsWith("{")) return JSON.parse(txt);
				last = txt.replace(/\s+/g, " ").slice(0, 160);
			} catch (err) {
				last = String(err).slice(0, 160);
			}
			await sleep(3000 * attempt);
		}
	}
	throw new Error(`${label}: ${last}`);
}

/* --------------------------------------------------------- οι δρόμοι */

/* Ένας δρόμος είναι δεκάδες ways στο OSM. Τα ενώνουμε ανά όνομα μέσα στην
   ΙΔΙΑ περιοχή και κρατάμε το κεντροειδές: για autocomplete και για την
   απόσταση από το μετρό, το μέσο σημείο ενός δρόμου είναι αρκετό. Ο ίδιος
   δρόμος σε άλλη περιοχή μένει χωριστή εγγραφή, με τη δική του περιοχή:
   γι' αυτό ακριβώς κατεβαίνει ανά περιοχή. */
async function streetsOf(area, spots) {
	const byName = new Map();
	for (const [lat, lon, radius] of spots) {
		/* Το `timeout:` του query πρέπει να είναι ΜΙΚΡΟΤΕΡΟ από το δικό μας
		   AbortSignal, αλλιώς ο server συνεχίζει να δουλεύει 180 δευτερόλεπτα
		   για ένα ερώτημα που εμείς παρατήσαμε στα 60, και μας κρατάει το
		   slot κατειλημμένο στην επόμενη προσπάθεια. */
		const q = `[out:json][timeout:50];`
			+ `way["highway"~"${HIGHWAYS}"]["name"](${bboxOf(lat, lon, radius)});`
			+ `out tags center;`;
		const j = await overpass(q, area);
		for (const w of j.elements || []) {
			const name = w.tags && w.tags.name;
			if (!name || !w.center) continue;
			const cur = byName.get(name) || { lat: 0, lon: 0, n: 0 };
			cur.lat += w.center.lat;
			cur.lon += w.center.lon;
			cur.n++;
			byName.set(name, cur);
		}
		// Ο δημόσιος Overpass δίνει 2 slots ανά IP· η παύση κρατά το build
		// μέσα στο όριο αντί να μαζεύει 429.
		await sleep(2500);
	}
	return [...byName.entries()].map(([name, v]) => ({
		name,
		lat: +(v.lat / v.n).toFixed(4),
		lon: +(v.lon / v.n).toFixed(4),
	}));
}

/* ------------------------------------------------------ οι στάσεις μετρό

   Το μετρό Θεσσαλονίκης είναι το μόνο σημείο όπου η γεωγραφία μπαίνει
   ΑΡΙΘΜΗΤΙΚΑ στην εκτίμηση (premium έως ~150 μ., σβήνει στα ~350· δες
   docs/valuation.md). Σήμερα το πεδίο το συμπληρώνει ο σύμβουλος με το
   μάτι· με τις στάσεις εδώ, το γεμίζει η επιλογή διεύθυνσης.

   Το OSM ξεχωρίζει καθαρά τι λειτουργεί και τι όχι, και η διάκριση
   μετράει: η αγορά πληρώνει premium για στάση που ΔΟΥΛΕΥΕΙ. Κρατάμε
   `railway=station` (λειτουργεί) και `railway=construction` (σε έργο,
   ορατό στον δρόμο, ήδη τιμολογείται εν μέρει) και πετάμε τα
   `railway=proposed`: μια στάση στα σχέδια δεν αλλάζει τιμή σήμερα. */
async function metroStations() {
	const bb = "40.50,22.85,40.70,23.05";
	const q = `[out:json][timeout:90];`
		+ `node["station"="subway"](${bb});`
		+ `out tags center;`;
	const j = await overpass(q, "μετρό");
	const seen = new Set();
	const out = [];
	for (const n of j.elements || []) {
		const t = n.tags || {};
		const name = t["name:el"] || t.name || "";
		const live = t.railway === "station";
		const building = t.railway === "construction";
		if (!name || seen.has(name) || !(live || building)) continue;
		seen.add(name);
		out.push({ name, lat: +n.lat.toFixed(5), lon: +n.lon.toFixed(5), live });
	}
	return out.sort((a, b) => Number(b.live) - Number(a.live) || a.name.localeCompare(b.name, "el"));
}

/* ------------------------------------------------------------- τρέξιμο */

const rows = AREA_PRICES.filter((r) => !ONLY || r.area === ONLY);
if (!rows.length) {
	console.error(`Καμία περιοχή «${ONLY}» στον πίνακα.`);
	process.exit(1);
}

const missing = AREA_PRICES.filter((r) => !AREA_SPOTS[r.area]).map((r) => r.area);
if (missing.length) {
	console.error(`ΛΕΙΠΟΥΝ σημεία από το AREA_SPOTS: ${missing.join(", ")}`);
	process.exit(1);
}

/* INCREMENTAL, όπως το build-accessibility.mjs. Ο δημόσιος Overpass κόβει
   αυθαίρετα κλήσεις και ένα τρέξιμο 36 περιοχών ΘΑ σκοντάψει κάπου· χωρίς
   αυτό κάθε σκόνταμμα πετούσε στα σκουπίδια δέκα λεπτά δουλειάς. Ό,τι έχει
   ήδη κατέβει μένει, ξανατρέχεις και συμπληρώνει μόνο ό,τι λείπει. Με
   `--all` ξανακατεβαίνουν όλα. */
const prev = { areas: [], metro: [] };
try {
	const old = readFileSync(OUT, "utf8").replace(/^[\s\S]*?window\.FW_STREETS\s*=\s*/, "").replace(/;\s*$/, "");
	Object.assign(prev, JSON.parse(old));
} catch { /* πρώτο τρέξιμο, ή χαλασμένο αρχείο: ξεκινάμε από το μηδέν */ }
const have = new Map(prev.areas.map((a) => [a[0], a[1]]));

console.log(`Overpass: ${rows.length} περιοχές${!REBUILD_ALL && have.size ? ` (${have.size} ήδη στο αρχείο)` : ""}\n`);

/* Γράφεται μετά από ΚΑΘΕ περιοχή: ένα Ctrl-C ή ένα κολλημένο mirror δεν
   χάνει ό,τι έχει ήδη κατέβει. */
let metro = prev.metro || [];
function flush() {
	const payload = {
		asOf: new Date().toISOString().slice(0, 10),
		/* ΟΛΕΣ οι γραμμές του πίνακα, χωριστά από τους δρόμους. Η λίστα
		   περιοχών είναι η κρίσιμη λειτουργία (η περιοχή οδηγεί τον
		   υπολογισμό)· οι δρόμοι είναι το βοηθητικό. Αν έβγαινε από το
		   `areas`, μια περιοχή που σκόνταψε στο Overpass θα εξαφανιζόταν
		   και από το dropdown, δηλαδή μια αποτυχία κατεβάσματος θα
		   χάλαγε ΤΟ ΣΩΣΤΟ ΠΕΔΙΟ, όχι απλώς το προαιρετικό. */
		areaNames: AREA_PRICES.map((r) => r.area),
		/* Η ζώνη κάθε περιοχής (`prime`/`urban`/`regional`), όπως την ορίζει
		   ήδη ο πίνακας τιμών. Το autocomplete τη χρειάζεται για κατάταξη:
		   ο κεντρικός δρόμος της Θεσσαλονίκης λέγεται «Ιωάννη Τσιμισκή», και
		   έχανε από τις σκέτες «Τσιμισκή» της Κατερίνης και των Σερρών, που
		   ταίριαζαν από τον πρώτο χαρακτήρα. Το γραφείο είναι στη Θεσσαλονίκη. */
		zones: AREA_PRICES.map((r) => zoneOf(r.area)),
		// σειρά του πίνακα, όχι σειρά κατεβάσματος: το diff του git μένει
		// διαβάσιμο ανάμεσα σε δύο builds
		areas: AREA_PRICES.map((r) => [r.area, have.get(r.area) || []]).filter((a) => a[1].length),
		// 1 = λειτουργεί, 0 = υπό κατασκευή (η φόρμα μετράει απόσταση μόνο από
		// τις πρώτες και αναφέρει τις δεύτερες χωριστά)
		metro,
	};
	const body = `/* Κατάλογος δρόμων ανά περιοχή του πίνακα τιμών, για το autocomplete
   διεύθυνσης της «Εκτίμησης». ΠΑΡΑΓΟΜΕΝΟ ΑΡΧΕΙΟ: μην το πειράξεις με το
   χέρι, τρέξε \`node tools/build-streets.mjs\`.
   Πηγή: © OpenStreetMap contributors (ODbL). */
window.FW_STREETS = ${JSON.stringify(payload)};
`;
	writeFileSync(OUT, body, "utf8");
	return { body, payload };
}

for (const row of rows) {
	/* Το `--area` ξαναχτίζει ΠΑΝΤΑ: το τρέχεις ακριβώς όταν διόρθωσες το
	   σημείο μιας περιοχής και θέλεις τη διόρθωση, όχι ό,τι είχε κατέβει
	   με το λάθος σημείο. */
	if (!REBUILD_ALL && !ONLY && have.has(row.area) && have.get(row.area).length) {
		console.log(`  · ${row.area.padEnd(44)} ${String(have.get(row.area).length).padStart(5)} (στο αρχείο)`);
		continue;
	}
	try {
		const before = (have.get(row.area) || []).length;
		const streets = await streetsOf(row.area, AREA_SPOTS[row.area]);
		have.set(row.area, streets.map((s) => [s.name, s.lat, s.lon]));
		flush();
		const delta = before ? ` (ήταν ${before})` : "";
		console.log(`  ✓ ${row.area.padEnd(44)} ${String(streets.length).padStart(5)} δρόμοι${delta}`);
	} catch (err) {
		console.error(`  ✗ ${row.area}: ${err.message}`);
		process.exitCode = 1;
	}
}

if (REBUILD_ALL || (!ONLY && !metro.length)) {
	console.log("\nΣτάσεις μετρό…");
	try {
		const m = await metroStations();
		metro = m.map((s) => [s.name, s.lat, s.lon, s.live ? 1 : 0]);
		flush();
		console.log(`  ✓ ${m.filter((s) => s.live).length} λειτουργούν, ${m.filter((s) => !s.live).length} υπό κατασκευή`);
	} catch (err) {
		console.error(`  ✗ ${err.message}`);
		process.exitCode = 1;
	}
}

const { body, payload } = flush();
const total = payload.areas.reduce((n, a) => n + a[1].length, 0);
const kb = (n) => `${Math.round(n / 1024)} KB`;
const gap = AREA_PRICES.length - payload.areas.length;

/* Μια περιοχή με ελάχιστους δρόμους σημαίνει σχεδόν πάντα λάθος σημείο
   στο AREA_SPOTS (ή πολύ μικρή ακτίνα), όχι οικισμό χωρίς δρόμους. Χωρίς
   αυτή τη γραμμή το λάθος μένει αόρατο: ο κατάλογος «χτίστηκε κανονικά»
   και απλώς δεν βρίσκει ποτέ τη σωστή διεύθυνση. */
const THIN = 40;
const thin = payload.areas.filter((a) => a[1].length < THIN);
if (thin.length) {
	console.log(`\n⚠ Λίγοι δρόμοι (κάτω από ${THIN}), τσέκαρε τα σημεία στο AREA_SPOTS:`);
	thin.forEach((a) => console.log(`    ${a[0].padEnd(44)} ${String(a[1].length).padStart(5)}`));
}
console.log(`\n✓ forms/_streets.fw.js: ${total} δρόμοι σε ${payload.areas.length}/${AREA_PRICES.length} περιοχές`);
console.log(`  ${kb(Buffer.byteLength(body))} (gzip ${kb(gzipSync(Buffer.from(body)).length)})`);
if (gap) console.log(`  ⚠ ${gap} περιοχές ακόμη χωρίς δρόμους. Ξανατρέξ' το, συμπληρώνει μόνο αυτές.`);
