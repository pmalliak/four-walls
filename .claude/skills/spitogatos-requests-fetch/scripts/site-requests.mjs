// Site ζήτηση intake — the same pipeline as the Spitogatos one, for the leads
// that arrive through OUR OWN form at four-walls.gr/request.
//
// Why it exists: the secretary is supposed to file these by hand (the email says
// so), but a lead that lands on a Saturday should not wait until Monday. This
// script does exactly what she would: read the «ΝΕΑ ΖΗΤΗΣΗ» email, create the
// contact, and emit a worklist entry that crm-post.mjs turns into a ζήτηση + a
// linked communication. Idempotent through processed.json, so running it after
// she has already filed one is safe — see «already processed» in the output.
//
// Input : the office mailbox (Spark CLI) + processed.json
// Output: worklist.json in the SAME shape prep.mjs emits, so steps 5-6 of
//         SKILL.md (crm-post.mjs, verify-log.mjs) work unchanged.
//
// Usage: node site-requests.mjs <after yyyy/MM/dd> <processed.json> <worklist.json> [--dry]
//        --dry reads and parses the emails but creates NO contact, so you can
//        see what a batch would do before it touches the CRM.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const SPARK = "C:\\Users\\panos\\AppData\\Local\\Programs\\SparkDesktop\\resources\\app.asar.unpacked\\node_modules\\@readdle\\sparkcore-win\\bin\\Release\\SparkCore.bundle\\spark.exe";
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const [after, processedPath, worklistPath] = args.filter((a) => !a.startsWith("--"));
if (!after || !processedPath || !worklistPath) {
	console.error("usage: node site-requests.mjs <after yyyy/MM/dd> <processed.json> <worklist.json> [--dry]");
	process.exit(1);
}

/* ---- credentials (.dev.vars at repo root, gitignored) ---- */
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
if (!vars.ESTATEPRIME_API_KEY) { console.error("MISSING ESTATEPRIME_API_KEY/SECRET in .dev.vars"); process.exit(1); }
const base = `https://${vars.ESTATEPRIME_SUBDOMAIN || "fourwalls"}.estateprime.gr/api`;
const H = {
	Authorization: "Basic " + Buffer.from(`${vars.ESTATEPRIME_API_KEY}:${vars.ESTATEPRIME_API_SECRET}`).toString("base64"),
	"Content-Type": "application/json",
};
const apiGet = async (p) => (await fetch(base + p, { headers: H })).json().catch(() => null);
const apiPost = async (p, o) => {
	const r = await fetch(base + p, { method: "POST", headers: H, body: JSON.stringify(o) });
	return { http: r.status, body: await r.json().catch(() => null) };
};

const spark = (args) => {
	const r = spawnSync(SPARK, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	if (r.status !== 0) throw new Error(`spark ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout;
};

/* ---- 1. find the «ΝΕΑ ΖΗΤΗΣΗ» emails -------------------------------------
   Spark's subject: filter matches Latin only (SKILL.md, 2026-07-29), so we
   scope by sender and grep the listing ourselves. The mail is sent by the
   office to itself, so from == to == info@four-walls.gr.

   `--in <account>` covers EVERY folder of that account, Sent included, which
   is why the same ζήτηση can come back twice (see the leadId comment below).
   Narrowing to `:Inbox` would kill the duplicates but is the fragile choice:
   the Zoho filter that files Spitogatos mail into `Inbox/Spitogatos` already
   proved that mail moves out of the Inbox without anyone telling us, and a
   skill that then silently sees nothing is worse than one that sees a lead
   twice and keeps it once. Note the copies are not even consistent — of the
   two test ζητήσεις on 2026-07-29, one had an Inbox+Sent pair and the other
   only an Inbox copy.                                                       */
const emails = [];
for (let page = 1; page <= 20; page++) {
	const out = spark(["search", "--filter", `from:info@four-walls.gr after:${after}`,
		"--in", "info@four-walls.gr", "--page", String(page), "--page-size", "100", "--order", "descending"]);
	for (const line of out.split("\n")) {
		const m = line.match(/^\s*(\d+)\s+\S+@\S+\s+.*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+(.+?)\s*$/);
		if (m && m[3].includes("ΝΕΑ ΖΗΤΗΣΗ")) emails.push({ emailId: m[1], date: m[2] });
	}
	const pm = out.match(/Page (\d+) of (\d+)/);
	if (!pm || Number(pm[1]) >= Number(pm[2])) break;
}
console.log(`«ΝΕΑ ΖΗΤΗΣΗ» emails in window: ${emails.length}`);

/* ---- 2. parse one email --------------------------------------------------
   The template is ours (Make scenario «Site - Φόρμα επικοινωνίας», ζήτηση
   branch), so the labels are a contract we control, not someone else's HTML.
   Anything the visitor left blank arrives as «—» and is dropped here.       */
const FIELD = (text, label) => {
	const re = new RegExp("^\\s*" + label + "\\s+(.+?)\\s*$", "m");
	const m = text.match(re);
	const v = m ? m[1].trim() : "";
	return v === "—" ? "" : v;
};
const digits = (s) => (String(s || "").match(/\d+/) || [""])[0];

function parseEmail(emailId, date) {
	const text = spark(["thread", emailId]);
	const wants = FIELD(text, "Ζητάει");                       // «Ενοικίαση · Κατοικία · Διαμέρισμα»
	const parts = wants.split("·").map((s) => s.trim()).filter(Boolean);
	const priceLine = FIELD(text, "Τιμή");                     // «έως 600 €» | «300 – 600 €»
	const sizeLine = FIELD(text, "Εμβαδόν");                   // «από 45 έως 80 τ.μ.»
	const priceNums = (priceLine.match(/\d+/g) || []);
	const sizeNums = (sizeLine.match(/\d+/g) || []);
	return {
		emailId, date,
		name: FIELD(text, "Όνομα"),
		phone: FIELD(text, "Τηλέφωνο"),
		email: FIELD(text, "Email").replace(/^\[|\]\(mailto:.*$/g, "").trim(),
		transaction: /Αγορά/.test(parts[0] || "") ? "sale" : "rent",
		categoryLabel: parts[1] || "",
		subcategoryLabel: parts[2] || "",
		areas: FIELD(text, "Περιοχές"),
		priceMin: /–|-/.test(priceLine) ? priceNums[0] || "" : "",
		priceMax: /–|-/.test(priceLine) ? priceNums[1] || "" : priceNums[0] || "",
		sizeMin: /από/.test(sizeLine) ? sizeNums[0] || "" : "",
		sizeMax: /έως/.test(sizeLine) ? (/από/.test(sizeLine) ? sizeNums[1] || "" : sizeNums[0] || "") : "",
		bedroomsMin: digits(FIELD(text, "Υπνοδωμάτια")),
		floorMin: digits(FIELD(text, "Όροφος")),
		features: FIELD(text, "Χαρακτηριστικά").split(",").map((s) => s.trim()).filter(Boolean),
		message: FIELD(text, "Σχόλια"),
	};
}

/* ---- 3. areas: free text -> EstatePrime location ids ----------------------
   The visitor types «Τριανδρία, Χαριλάου», not ids. /locations ignores
   ?search= (verified — it returns the whole tree regardless), so the tree is
   pulled once and cached next to processed.json. Thessaloniki wins ties: a
   Θεσσαλονίκη office asked about «Κέντρο» means Θεσσαλονίκη's.              */
/* `.local` suffix so the repo's existing `*.local` ignore rule keeps this
   1.8 MB dump out of git — it is a cache, not state. */
const CACHE = path.join(path.dirname(processedPath), "locations.cache.local");
const strip = (s) => (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

async function loadLocations() {
	if (existsSync(CACHE)) {
		const c = JSON.parse(readFileSync(CACHE, "utf8"));
		if (Array.isArray(c.rows) && c.rows.length) return c.rows;
	}
	const rows = [];
	let page = 1, pages = 1;
	do {
		const j = await apiGet(`/locations?page=${page}`);
		for (const r of j?.data || []) rows.push({ id: r.id, n: r.name_el, lvl: r.level, p: r.parent_id, tree: r.full_tree_name_el });
		pages = j?.total_pages || 1;
		page++;
	} while (page <= pages);
	mkdirSync(path.dirname(CACHE), { recursive: true });
	writeFileSync(CACHE, JSON.stringify({ fetched: new Date().toISOString(), rows }), "utf8");
	console.log(`locations cached: ${rows.length} rows -> ${CACHE}`);
	return rows;
}

function resolveAreas(rows, text, warnings) {
	const out = [];
	const byId = new Map(rows.map((r) => [r.id, r]));
	for (const raw of String(text || "").split(/[,·/]| και /).map((s) => s.trim()).filter(Boolean)) {
		const q = strip(raw);
		if (q.length < 3) continue;
		const cands = rows.filter((r) => r.lvl >= 2 && strip(r.n).includes(q));
		if (!cands.length) { warnings.push(`περιοχή «${raw}»: δεν βρέθηκε στο /locations`); continue; }
		/* exact name first, then Thessaloniki, then the shallowest level. */
		cands.sort((a, b) =>
			(strip(b.n) === q) - (strip(a.n) === q)
			|| (/Θεσσαλον/.test(b.tree || "")) - (/Θεσσαλον/.test(a.tree || ""))
			|| a.lvl - b.lvl);
		const hit = cands[0];
		const l2 = hit.lvl === 2 ? hit : byId.get(hit.p);
		if (!l2) { warnings.push(`περιοχή «${raw}»: level-3 χωρίς γονέα`); continue; }
		const l1 = byId.get(l2.p);
		if (!l1) { warnings.push(`περιοχή «${raw}»: χωρίς level-1`); continue; }
		if (!out.some(([, b]) => b === l2.id)) out.push([l1.id, l2.id]);
		if (cands.length > 3) warnings.push(`περιοχή «${raw}»: ${cands.length} υποψήφιες, πήρα «${hit.tree}»`);
	}
	return out;
}

/* ---- 4. CRM contact ------------------------------------------------------ */
const normPhone = (p) => {
	const s = String(p || "").replace(/[\s.\-()]/g, "");
	if (/^\+/.test(s)) return s;
	if (/^0030/.test(s)) return "+" + s.slice(2);
	if (/^30\d{10}$/.test(s)) return "+" + s;
	if (/^(69|2)\d{8,9}$/.test(s)) return "+30" + s;
	return s;
};
async function dedupe(phone, email) {
	for (const key of [String(phone || "").replace(/\D/g, "").replace(/^30/, ""), email]) {
		if (!key) continue;
		const j = await apiGet("/contacts?search=" + encodeURIComponent(key));
		if (Array.isArray(j?.data) && j.data.length) return j.data[0].id;
	}
	return null;
}

/* The site form asks for a single «Ονοματεπώνυμο», so the split is a guess:
   everything after the first word is the surname. Greek order varies; the
   office fixes it in the CRM if it lands wrong. */
function splitName(full) {
	const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
	return { first: parts[0] || "Πελάτης", last: parts.slice(1).join(" ") || "(από το site)" };
}

const CATEGORY = { "Κατοικία": "residential", "Επαγγελματικός χώρος": "commercial", "Γη / Οικόπεδο": "land" };
const SUBCATEGORY = {
	"Διαμέρισμα": ["apartment", null], "Στούντιο / Γκαρσονιέρα": ["apartment", ["1", "2"]],
	"Μεζονέτα": ["maisonette", null], "Μονοκατοικία": ["detached", null],
	"Βίλα": ["villa", null], "Loft": ["loft", null], "Γραφείο": ["office", null],
	"Κατάστημα": ["store", null], "Αποθήκη": ["warehouse", null], "Οικόπεδο": ["plot", null],
};
const FEATURE = {
	"Βεράντα": "has_balcony", "Πάρκινγκ": "has_parking", "Ασανσέρ": "has_elevator",
	"Αποθήκη": "has_storage_room", "Επιπλωμένο": "is_furnished", "Κλιματισμός": "has_air_condition",
	"Δέχεται κατοικίδια": "pets_allowed", "Φοιτητικό": "suitable_for_students",
};

function requestFields(l) {
	const p = [];
	const add = (k, v) => p.push(`${k}=${encodeURIComponent(v)}`);
	add("availability", l.transaction);
	add("category", CATEGORY[l.categoryLabel] || "residential");
	const sub = SUBCATEGORY[l.subcategoryLabel];
	if (sub) { add("subcategory[]", sub[0]); if (sub[1]) for (const s of sub[1]) add("subtype[]", s); }
	if (l.priceMin) add("price_min", l.priceMin);
	if (l.priceMax) add("price_max", l.priceMax);
	if (l.sizeMin) add("size_min", l.sizeMin);
	if (l.sizeMax) add("size_max", l.sizeMax);
	if (l.bedroomsMin) add("rooms_min", l.bedroomsMin);
	if (l.floorMin) add("floor_min", l.floorMin);
	for (const f of l.features) {
		const slug = FEATURE[f];
		if (!slug) continue;
		if (slug === "is_furnished") add("is_furnished", "yes");
		else if (slug === "has_elevator") add("has_elevator", "1");
		else add(slug, "1");
	}
	return p.join("&");
}

/* ---- main ---------------------------------------------------------------- */
const processed = existsSync(processedPath) ? JSON.parse(readFileSync(processedPath, "utf8")) : { done: [] };
const doneSet = new Set((processed.done || []).map(String));
const rows = await loadLocations();

const worklist = [];
const skipped = [];
const seen = new Set();
for (const e of emails) {
	const l = parseEmail(e.emailId, e.date);
	if (!l.name || (!l.phone && !l.email)) {
		skipped.push({ id: `site-${e.emailId}`, why: "email δεν διαβάστηκε (όνομα/επικοινωνία λείπουν)" });
		continue;
	}

	/* The office mails itself, so Spark lists every ζήτηση twice (Sent and
	   Inbox copies, different ids). Keying on the email id would file the
	   same ζήτηση twice — key on what the lead actually is instead, which
	   also keeps leadIds stable if the mailbox is ever re-indexed. */
	const leadId = `site-${e.date.replace(/[^\d]/g, "")}-${String(l.phone || l.email).replace(/[^0-9a-zA-Z]/g, "").slice(-10)}`;
	if (seen.has(leadId)) continue;
	seen.add(leadId);
	if (doneSet.has(leadId)) { skipped.push({ id: leadId, why: "already processed" }); continue; }

	const warnings = [];
	const areas = resolveAreas(rows, l.areas, warnings);
	if (!areas.length) {
		/* /requests/form refuses a ζήτηση with no location, and guessing one
		   would be worse than leaving it for a human. */
		skipped.push({ id: leadId, why: `καμία περιοχή δεν αναγνωρίστηκε («${l.areas}») — καταχώρισέ τη με το χέρι`, name: l.name });
		continue;
	}

	let contactId = await dedupe(l.phone, l.email);
	let contactStatus = contactId ? "reused" : "created";
	if (!contactId && DRY) {
		contactId = 0;
		contactStatus = "would create";
	} else if (!contactId) {
		const { first, last } = splitName(l.name);
		const notes = [
			`Ζήτηση από τη φόρμα του site, ${l.date}.`,
			`Ζητά: ${l.transaction === "rent" ? "Ενοικίαση" : "Αγορά"} · ${l.categoryLabel}${l.subcategoryLabel ? " · " + l.subcategoryLabel : ""}.`,
			`Περιοχές: ${l.areas}`,
			l.message ? `Σχόλια: «${l.message}»` : "",
		].filter(Boolean).join("\n");
		const { http, body } = await apiPost("/contacts", {
			first_name: first, last_name: last,
			source_id: 3, is_lead: true, is_company: false, is_active: true,
			country: "GR", language_id: 1, office_id: 1, created_by: 2, users: [2],
			tags: [12, 10], // claude, ΖΗΤΗΣΗ — δικό μας site, όχι spitogatos
			phones: l.phone ? [{ type: "mobile-personal", number: normPhone(l.phone), notes: "Από τη φόρμα του site" }] : [],
			emails: l.email ? [{ type: "personal", email: l.email, email_address: l.email, notes: "Από τη φόρμα του site" }] : [],
			notes,
		});
		if (http !== 200 || !body?.data?.id) {
			skipped.push({ id: leadId, why: `contact create failed: ${http} ${body?.error_message || ""}` });
			continue;
		}
		contactId = body.data.id;
	}

	worklist.push({
		leadId, name: l.name, contactId, contactStatus, areas,
		fields: requestFields(l),
		/* Same as prep.mjs: API-created contacts get no default email/phone —
		   crm-post.mjs stars these via the session. */
		star: contactStatus === "created" ? { email: l.email || null, phone: l.phone ? normPhone(l.phone) : null } : null,
		/* NO comm here (since 2026-07-30): the Worker logs the incoming
		   communication the moment the form is submitted (crm-lead.mjs), so
		   the skill's job for a site lead is ONLY the ζήτηση. crm-post.mjs
		   skips the comm POST when the entry carries none. */
		/* No «four-walls.gr» entry exists in the CRM's request sources (only
		   Spitogatos.gr and xe.gr), and labelling our own lead as Spitogatos
		   would corrupt the one number Panos uses to judge the portal. Send
		   none until someone adds the source in the CRM UI. */
		requestSource: "", requestTags: [13],
		warnings, source: "site",
	});
	console.log(`${leadId} (${l.name}): contact ${contactStatus} ${contactId}, ${areas.length} περιοχές${warnings.length ? ` [${warnings.length} warn]` : ""}`);
	for (const w of warnings) console.log(`    ! ${w}`);
}

writeFileSync(worklistPath, JSON.stringify(worklist, null, 1));
console.log(`--- worklist: ${worklist.length} ζητήσεις έτοιμες, ${skipped.length} skipped ---`);
if (skipped.length) console.log("skipped:", JSON.stringify(skipped, null, 1));
