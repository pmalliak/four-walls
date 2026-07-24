// Spitogatos lead intake — verify + log step (node, EstatePrime /api).
//
// Input : results JSON from the browser POST step — array of
//         { leadId, contactId, requestId, commId }.
// Does  : reads each request + communication back from /api, confirms the request has
//         locations + the right contact, and the comm links BOTH contact_id and
//         request_id. Appends only fully-verified leadIds to processed.json.
// Output: prints a per-lead PASS/FAIL report; updates processed.json in place.
//
// Usage: node verify-log.mjs <results.json> <processed.json>
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [, , resultsPath, processedPath] = process.argv;
if (!resultsPath || !processedPath) { console.error("usage: node verify-log.mjs <results.json> <processed.json>"); process.exit(1); }

function loadVars() {
	const v = {};
	for (const p of [".dev.vars", "../../../../.dev.vars"]) {
		if (existsSync(p)) { for (const line of readFileSync(p, "utf8").split(/\r?\n/)) { const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/); if (m) v[m[1]] = m[2]; } break; }
	}
	return v;
}
const vars = loadVars();
const base = `https://${vars.ESTATEPRIME_SUBDOMAIN || "fourwalls"}.estateprime.gr/api`;
const H = { Authorization: "Basic " + Buffer.from(vars.ESTATEPRIME_API_KEY + ":" + vars.ESTATEPRIME_API_SECRET).toString("base64"), "Content-Type": "application/json" };

// GET /requests and /communication single endpoints can 500 — read via the paginated list.
async function listAll(resource) {
	let all = [], page = 1, tp = 1;
	do { const b = await (await fetch(`${base}/${resource}?page=${page}`, { headers: H })).json(); all = all.concat(b.data || []); tp = b.total_pages || 1; page++; } while (page <= tp && page < 30);
	return all;
}

const results = JSON.parse(readFileSync(resultsPath, "utf8"));
const processed = existsSync(processedPath) ? JSON.parse(readFileSync(processedPath, "utf8")) : { done: [] };
const doneSet = new Set(processed.done.map(String));

const reqs = await listAll("requests");
const comms = await listAll("communication");
const reqById = Object.fromEntries(reqs.map((r) => [String(r.id), r]));
const commById = Object.fromEntries(comms.map((c) => [String(c.id), c]));

let pass = 0, fail = 0;
for (const r of results) {
	const req = reqById[String(r.requestId)];
	const comm = commById[String(r.commId)];
	const problems = [];
	if (!req) problems.push(`request ${r.requestId} not found`);
	else {
		if (!(req.locations || []).length) problems.push("request has 0 locations");
		if (!(req.contacts || []).map(String).includes(String(r.contactId))) problems.push("request not linked to contact");
	}
	if (!comm) problems.push(`comm ${r.commId} not found`);
	else {
		if (String(comm.contact_id) !== String(r.contactId)) problems.push("comm contact_id mismatch");
		if (String(comm.request_id) !== String(r.requestId)) problems.push("comm not linked to request");
	}
	if (problems.length === 0) {
		pass++; doneSet.add(String(r.leadId));
		console.log(`PASS lead ${r.leadId}: contact ${r.contactId}, req ${r.requestId} (${req.locations.length} locs), comm ${r.commId}`);
	} else {
		fail++; console.log(`FAIL lead ${r.leadId}: ${problems.join("; ")}`);
	}
}

processed.done = [...doneSet];
writeFileSync(processedPath, JSON.stringify(processed, null, 1));
console.log(`--- ${pass} passed, ${fail} failed; processed.json now has ${processed.done.length} leads ---`);
