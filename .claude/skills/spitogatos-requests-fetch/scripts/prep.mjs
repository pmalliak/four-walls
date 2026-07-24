// Spitogatos lead intake — deterministic prep step (node, EstatePrime /api Basic auth).
//
// Input : a leads JSON file (array of spitogatos search-enquiry details, each augmented
//         with greek_first / greek_last set by the operator — see SKILL.md).
// Does  : for each NOT-yet-processed lead -> dedupe by phone, create the CRM contact
//         (or reuse an existing one), resolve spitogatos geographyIds to EstatePrime
//         {area_level1,area_level2}, parse the free-text description (accent-safe) into
//         heating / furnished / feature flags, and emit a COMPACT worklist the browser
//         step turns into /requests/form + /communication/form POSTs.
// Output: worklist.json  (compact per-lead: contactId, area pairs, request fields, comm).
//
// Tags are ALWAYS by id (Panos may rename tag names): contact [12,9,10], request [13,14],
// comm [15,8]. Area encoding OMITS area_level3[] for level-2 areas (empty breaks pairing).
//
// Usage: node prep.mjs <leads.json> <worklist.json> <processed.json>
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [, , leadsPath, worklistPath, processedPath] = process.argv;
if (!leadsPath || !worklistPath || !processedPath) {
	console.error("usage: node prep.mjs <leads.json> <worklist.json> <processed.json>");
	process.exit(1);
}

// ---- credentials (.dev.vars at repo root, gitignored) ----
function loadVars() {
	const v = {};
	for (const p of [".dev.vars", "../../../../.dev.vars"]) {
		if (existsSync(p)) {
			for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
				const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/);
				if (m) v[m[1]] = m[2];
			}
			break;
		}
	}
	return v;
}
const vars = loadVars();
const SUB = vars.ESTATEPRIME_SUBDOMAIN || "fourwalls";
const base = `https://${SUB}.estateprime.gr/api`;
const H = {
	Authorization: "Basic " + Buffer.from(vars.ESTATEPRIME_API_KEY + ":" + vars.ESTATEPRIME_API_SECRET).toString("base64"),
	"Content-Type": "application/json",
};
if (!vars.ESTATEPRIME_API_KEY) { console.error("MISSING ESTATEPRIME_API_KEY/SECRET in .dev.vars"); process.exit(1); }

async function apiGet(path) { const r = await fetch(base + path, { headers: H }); return { http: r.status, body: await r.json().catch(() => null) }; }
async function apiPost(path, obj) { const r = await fetch(base + path, { method: "POST", headers: H, body: JSON.stringify(obj) }); return { http: r.status, body: await r.json().catch(() => null) }; }

// ---- Greek accent-safe text matching ----
const strip = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// ---- name Title-Case (spitogatos sends ALLCAPS or lowercase; keep it readable) ----
const titleCase = (s) => (s || "").trim().toLowerCase().replace(/(^|[\s\-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
const gfirst = (l) => l.greek_first || titleCase(l.firstName);
const glast = (l) => l.greek_last || titleCase(l.lastName);

// ---- description parser -> CRM flags (accent-insensitive) ----
function parseDesc(desc) {
	const t = strip(desc);
	const f = {};
	if (/(μη|οχι|χωρις)\s*επιπλωμ/.test(t)) f.is_furnished = "no";
	else if (/επιπλωμ/.test(t)) f.is_furnished = "yes";
	if (/ηλεκτρικ/.test(t)) f.has_electrical_appliances = 1;
	if (/ανακαιν/.test(t)) f.property_condition = "renovated";
	if (/νεοδμητ|καινουρ/.test(t)) f.property_condition = "new";
	if (/βεραντα|μπαλκον/.test(t)) f.has_balcony = 1;
	if (/πορτα ασφαλ|θωρακισμ/.test(t)) f.has_security_door = 1;
	if (/φυσικ.? αερ/.test(t)) f.heating_source = "natural_gas";
	if (/πετρελαι/.test(t)) f.heating_source = "oil";
	if (/ατομικ/.test(t)) f.heating_type = "individual";
	if (/αυτονομ/.test(t)) f.heating_type = "autonomous";
	if (/φοιτητ|σπουδ/.test(t)) f.suitable_for_students = 1;
	if (/αποθηκ/.test(t)) f.has_storage_room = 1;
	if (/κατοικιδ/.test(t)) f.pets_allowed = 1;
	return f;
}

// ---- area resolver: geographyId -> {area_level1, area_level2} (level-2 only for now) ----
const locCache = {};
async function loc(id) { if (locCache[id]) return locCache[id]; const { body } = await apiGet("/locations/" + id); const d = body && (Array.isArray(body.data) ? body.data[0] : body.data); return (locCache[id] = d); }
async function resolvePair(geoId, warnings) {
	const d = await loc(geoId);
	if (!d) { warnings.push(`geoId ${geoId}: not found in /locations`); return null; }
	if (d.level === 1) return [d.id, null];            // whole region
	if (d.level === 2) return [d.parent_id, d.id];     // the common case
	// level 3 encoding is UNVERIFIED (no level-3 leads seen yet) — flag and use level-2 parent.
	warnings.push(`geoId ${geoId} is level 3 ("${d.name_el}") — encoding unverified; using level-2 parent ${d.parent_id}`);
	const p = await loc(d.parent_id);
	return p ? [p.parent_id, d.parent_id] : null;
}

// ---- agency filter: ΜΗΝ δημιουργείς leads από μεσιτικά γραφεία (Panos, 2026-07-24) ----
// Τα επαγγελματικά ακίνητα & η γη ΜΑΣ ΕΝΔΙΑΦΕΡΟΥΝ — φιλτράρουμε μόνο τα μεσιτικά.
const AGENCY_RE = /real\s*estate|realestate|realty|broker|estate\s*agency|μεσιτ/i;
function looksLikeAgency(l) {
	const hay = `${l.firstName || ""} ${l.lastName || ""} ${l.email || ""}`;
	return AGENCY_RE.test(hay) || AGENCY_RE.test(strip(hay));
}

// ---- phone normalization (spaces, missing +30 on Greek mobiles) ----
function normPhone(p) {
	let s = (p || "").replace(/[\s.\-()]/g, "");
	if (/^\+/.test(s)) return s;
	if (/^0030/.test(s)) return "+" + s.slice(2);
	if (/^30\d{10}$/.test(s)) return "+" + s;
	if (/^69\d{8}$/.test(s)) return "+30" + s;      // Greek mobile without prefix
	return s;                                        // foreign / unknown -> leave as-is
}

// ---- contact ----
async function dedupePhone(phone) {
	const digits = phone.replace(/\D/g, "").replace(/^30/, ""); // search on national digits
	const { body } = await apiGet("/contacts?search=" + encodeURIComponent(digits));
	const arr = body && body.data;
	return Array.isArray(arr) && arr.length ? arr[0].id : null;
}
async function createContact(l) {
	const notes = [
		`Spitogatos αίτηση ζήτησης #${l.searchEnquiryId}, ${l.dateSubmitted.slice(0, 10)}.`,
		`Ζητά: Κατοικία προς ${l.listingType === "rent" ? "Ενοικίαση" : "Πώληση"} — ${l.propertyType}. €${l.price}${l.listingType === "rent" ? "/μήνα" : ""} · ~${l.livingArea} τ.μ.`,
		`Μήνυμα: «${(l.description || "").trim()}»`,
		`Ώρες επικοινωνίας: ${l.contactHours}. (όνομα από Spitogatos: ${l.latin_name || l.firstName + " " + l.lastName})`,
		`https://live.spitogatos.gr/leads/searchEnquiries?showDetailsId=${l.searchEnquiryId}`,
	].join("\n");
	const payload = {
		first_name: gfirst(l), last_name: glast(l),
		source_id: 3, is_lead: true, is_company: false, is_active: true,
		country: "GR", language_id: 1, office_id: 1, created_by: 2, users: [2], tags: [12, 9, 10],
		phones: [{ type: "mobile-personal", number: normPhone(l.telephone) }],
		emails: [{ type: "personal", email: l.email, email_address: l.email }], notes,
	};
	const { http, body } = await apiPost("/contacts", payload);
	return { http, id: body?.data?.id, err: body?.error_message };
}

// spitogatos propertyType -> [CRM subcategory slug, subtype ids[] | null].
// "studio" is the "Studio / Γκαρσονιέρα" category -> apartment + both subtypes (studio=1, γκαρσονιέρα=2).
// "unspecified" / unknown -> no subcategory (the /requests/form endpoint accepts that).
const PROP_TYPE = {
	studio: ["apartment", ["1", "2"]], apartment: ["apartment", null], maisonette: ["maisonette", null],
	loft: ["loft", null], detached: ["detached", null], villa: ["villa", null],
	residential_building: ["residential_building", null], apartment_complex: ["apartment_complex", null],
};

// ---- request fields (everything except contact/tags/areas, which the browser adds) ----
function requestFields(l) {
	const p = [];
	const add = (k, v) => p.push(k + "=" + encodeURIComponent(v));
	add("availability", l.listingType); add("category", l.category || "residential");
	const pt = PROP_TYPE[l.propertyType];
	if (pt) { add("subcategory[]", pt[0]); if (pt[1]) for (const s of pt[1]) add("subtype[]", s); }
	add("price_max", l.price);
	if (l.livingArea) add("size_min", Math.max(0, Number(l.livingArea) - 5));
	const f = parseDesc(l.description);
	if (f.is_furnished) add("is_furnished", f.is_furnished);
	if (f.heating_type) add("heating_type[]", f.heating_type);
	if (f.heating_source) add("heating_source[]", f.heating_source);
	if (f.property_condition) add("property_condition[]", f.property_condition);
	const fm = /^(\d+)_plus$/.exec(l.floorNumber || ""); // "1_plus","2_plus",… -> floor_min
	if (fm) add("floor_min", fm[1]);
	if (l.rooms === "1_plus") add("rooms_min", "1");
	if (l.elevator === "yes" || f.has_elevator) add("has_elevator", "1");
	for (const k of ["has_electrical_appliances", "has_balcony", "suitable_for_students", "has_storage_room", "pets_allowed", "has_security_door"]) if (f[k]) add(k, "1");
	return p.join("&");
}

// ---- main ----
const leads = JSON.parse(readFileSync(leadsPath, "utf8"));
const processed = existsSync(processedPath) ? JSON.parse(readFileSync(processedPath, "utf8")) : { done: [] };
const doneSet = new Set(processed.done.map(String));

const worklist = [];
const skipped = [];
for (const l of leads) {
	const id = String(l.searchEnquiryId);
	if (doneSet.has(id)) { skipped.push({ id, why: "already in processed.json" }); continue; }
	if (looksLikeAgency(l)) { skipped.push({ id, why: `μεσιτικό γραφείο (${l.firstName} ${l.lastName} / ${l.email}) — δεν δημιουργείται` }); continue; }

	const warnings = [];
	// dedupe by phone (existing contact -> reuse; a new ζήτηση/comm are still added)
	let contactId = await dedupePhone(l.telephone);
	let contactStatus = contactId ? "reused" : "created";
	if (!contactId) {
		const c = await createContact(l);
		if (c.http !== 200 || !c.id) { skipped.push({ id, why: `contact create failed: ${c.http} ${c.err || ""}` }); continue; }
		contactId = c.id;
	}

	const areas = [];
	for (const g of (l.geographyIds || [])) { const pair = await resolvePair(g, warnings); if (pair && pair[1]) areas.push(pair); }
	if (!areas.length) { skipped.push({ id, why: "no resolvable areas (location is required)" }); continue; }

	const d = l.dateSubmitted; // "YYYY-MM-DD HH:MM:SS" -> "DD/MM/YYYY HH:MM"
	const commDate = `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)} ${d.slice(11, 16)}`;
	const comments = `Spitogatos αίτηση ζήτησης #${l.searchEnquiryId}: ${l.listingType === "rent" ? "Ενοικίαση" : "Πώληση"} — ${l.propertyType}, ~${l.livingArea} τ.μ., €${l.price}. Μήνυμα: «${(l.description || "").trim()}» ${(l.geographyIds || []).length} περιοχές. https://live.spitogatos.gr/leads/searchEnquiries?showDetailsId=${l.searchEnquiryId}`;

	worklist.push({
		leadId: l.searchEnquiryId, name: `${glast(l)} ${gfirst(l)}`,
		contactId, contactStatus, areas, fields: requestFields(l),
		comm: { contact_id: contactId, date: commDate, comments }, warnings,
	});
	console.log(`lead ${id} (${glast(l)} ${gfirst(l)}): contact ${contactStatus} ${contactId}, ${areas.length} areas${warnings.length ? " [" + warnings.length + " warn]" : ""}`);
}

writeFileSync(worklistPath, JSON.stringify(worklist, null, 1));
console.log(`--- worklist: ${worklist.length} leads ready, ${skipped.length} skipped ---`);
if (skipped.length) console.log("skipped:", JSON.stringify(skipped));
