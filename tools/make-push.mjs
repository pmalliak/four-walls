#!/usr/bin/env node
// git → Make: ανεβάζει ένα blueprint από το make/scenarios/ πίσω στο Make.
//
//   node tools/make-push.mjs 6604242           # dry run: τι θα άλλαζε
//   node tools/make-push.mjs 6604242 --yes     # το ανεβάζει στ' αλήθεια
//
// ΠΡΟΣΟΧΗ: το PATCH αντικαθιστά ΟΛΟ το blueprint του live σεναρίου. Αν
// κάποιος πείραξε το σενάριο μέσα από το Make UI μετά το τελευταίο
// `make-pull`, το push σβήνει εκείνη την αλλαγή. Γι' αυτό το dry run
// συγκρίνει πάντα πρώτα με το live και τυπώνει τα modules που διαφέρουν.
//
// Ροή δουλειάς: pull → edit JSON → push --yes → pull (για να ξαναγραφτεί
// το INDEX.md με ό,τι δέχτηκε τελικά το Make). Δες docs/make-scenarios.md.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCEN = join(ROOT, 'make', 'scenarios');
const LIVE = join(ROOT, 'make', '.live');

const argv = process.argv.slice(2);
const YES = argv.includes('--yes');
const ID = argv.find((a) => /^\d+$/.test(a));

if (!ID) {
	console.error('Χρήση: node tools/make-push.mjs <scenarioId> [--yes]');
	process.exit(2);
}

function devVars() {
	const out = {};
	const f = resolve(ROOT, '.dev.vars');
	if (!existsSync(f)) return out;
	for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
		const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
		if (m) out[m[1]] = m[2];
	}
	return out;
}
const VARS = { ...devVars(), ...process.env };
const TOKEN = VARS.MAKE_API_TOKEN;
const ZONE = VARS.MAKE_ZONE || 'eu1.make.com';
if (!TOKEN) {
	console.error(`Λείπει το MAKE_API_TOKEN (.dev.vars). Φτιάξ' το: https://${ZONE}/user/api`);
	process.exit(2);
}

async function api(path, init = {}) {
	const r = await fetch(`https://${ZONE}/api/v2${path}`, {
		...init,
		headers: { Authorization: `Token ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
	});
	const body = await r.text();
	if (!r.ok) throw new Error(`${init.method || 'GET'} ${path} → ${r.status}\n${body}`);
	return body ? JSON.parse(body) : {};
}

// ── τοπικό blueprint ────────────────────────────────────────────────────────
const fname = readdirSync(SCEN).find((f) => f.startsWith(`${ID}-`) && f.endsWith('.blueprint.json'));
if (!fname) {
	console.error(`Δεν βρέθηκε make/scenarios/${ID}-*.blueprint.json — τρέξε πρώτα make-pull.mjs.`);
	process.exit(1);
}
const local = JSON.parse(readFileSync(join(SCEN, fname), 'utf8'));

// ── live blueprint ──────────────────────────────────────────────────────────
const live = (await api(`/scenarios/${ID}/blueprint`)).response.blueprint;

// ── diff ανά module ─────────────────────────────────────────────────────────
function flatten(flow, out = new Map()) {
	for (const m of flow || []) {
		out.set(m.id, m);
		(m.routes || []).forEach((r) => flatten(r.flow, out));
		(m.branches || []).forEach((b) => flatten(b.flow, out));
		(m.onerror || []).forEach((e) => out.set(e.id, e));
	}
	return out;
}
const A = flatten(live.flow);
const B = flatten(local.flow);
const name = (m) => `${m.module}${m.metadata?.designer?.name ? ` «${m.metadata.designer.name}»` : ''}`;

const added = [...B.keys()].filter((id) => !A.has(id));
const removed = [...A.keys()].filter((id) => !B.has(id));
const modified = [...B.keys()].filter((id) => A.has(id) && JSON.stringify(A.get(id)) !== JSON.stringify(B.get(id)));

const same = JSON.stringify(live) === JSON.stringify(local);
console.log(`${local.name} (${ID})`);
if (same) {
	console.log('Το live είναι ήδη ίδιο με το repo. Τίποτα να ανέβει.');
	process.exit(0);
}

for (const id of added) console.log(`  + module ${id}  ${name(B.get(id))}`);
for (const id of removed) console.log(`  - module ${id}  ${name(A.get(id))}`);
for (const id of modified) console.log(`  ~ module ${id}  ${name(B.get(id))}`);
if (!added.length && !removed.length && !modified.length) console.log('  ~ αλλαγές εκτός modules (metadata / scheduling / όνομα)');

// Το live σε αρχείο, για πλήρες diff με τα μάτια.
mkdirSync(LIVE, { recursive: true });
const livePath = join(LIVE, fname);
writeFileSync(livePath, JSON.stringify(live, null, '\t') + '\n', 'utf8');
console.log(`\nΠλήρες diff:  git diff --no-index make/.live/${fname} make/scenarios/${fname}`);

if (!YES) {
	console.log('\nDry run. Ξανατρέξε με --yes για να ανέβει.');
	process.exit(0);
}

// ── push ────────────────────────────────────────────────────────────────────
await api(`/scenarios/${ID}?confirmed=true`, {
	method: 'PATCH',
	body: JSON.stringify({ blueprint: JSON.stringify(local) }),
});
console.log('\nΑνέβηκε. Τρέξε `node tools/make-pull.mjs` για να ξαναγραφτεί το snapshot.');
