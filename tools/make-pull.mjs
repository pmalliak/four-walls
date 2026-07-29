#!/usr/bin/env node
// Make → git: κατεβάζει ΟΛΑ τα σενάρια της ομάδας ως blueprints στο make/.
//
//   node tools/make-pull.mjs              # κατεβάζει τα πάντα στο make/
//   node tools/make-pull.mjs 6604242      # μόνο ένα σενάριο
//   node tools/make-pull.mjs --check      # δεν γράφει· βγάζει exit 1 αν το
//                                         # live διαφέρει από το repo (για CI)
//
// Γιατί υπάρχει: το Make UI δεν κρατάει ιστορικό που να διαβάζεται, και
// κάθε αλλαγή μέσω API αντικαθιστά ΟΛΟ το blueprint. Με το blueprint στο
// git, μια αλλαγή γίνεται «pull → edit JSON → push» αντί για «σβήσε τα
// modules και ξαναφτιάξ' τα». Δες docs/make-scenarios.md.
//
// Χρειάζεται MAKE_API_TOKEN στο .dev.vars (Make → Profile → API access →
// Add token, scopes: scenarios:read, scenarios:write, connections:read,
// keys:read, hooks:read, datastores:read, teams:read).

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'make');
const SCEN = join(OUT, 'scenarios');

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const ONLY = argv.find((a) => /^\d+$/.test(a)) || null;

// ── secrets / config ────────────────────────────────────────────────────────
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
const TEAM = VARS.MAKE_TEAM_ID || '2060918';

if (!TOKEN) {
	console.error('Λείπει το MAKE_API_TOKEN (.dev.vars ή env).');
	console.error(`Φτιάξ' το: https://${ZONE}/user/api → Add token`);
	process.exit(2);
}

async function api(path) {
	const r = await fetch(`https://${ZONE}/api/v2${path}`, {
		headers: { Authorization: `Token ${TOKEN}`, 'Content-Type': 'application/json' },
	});
	if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${await r.text()}`);
	return r.json();
}

// ── ονόματα αρχείων ─────────────────────────────────────────────────────────
// Τα σενάρια έχουν ελληνικά ονόματα· τα αρχεία τα θέλουμε ASCII για να μη
// σπάνε σε git/Windows/CI.
const GR = {
	α: 'a', ά: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', έ: 'e', ζ: 'z', η: 'i', ή: 'i',
	θ: 'th', ι: 'i', ί: 'i', ϊ: 'i', ΐ: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x',
	ο: 'o', ό: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', ύ: 'y', ϋ: 'y',
	ΰ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o', ώ: 'o',
};
function slug(name) {
	return [...name.toLowerCase()]
		.map((c) => GR[c] ?? c)
		.join('')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}
const fileFor = (s) => `${s.id}-${slug(s.name)}.blueprint.json`;

// ── outline: το blueprint σε δέντρο που διαβάζεται με το μάτι ───────────────
function outline(flow, depth = 0, lines = []) {
	const pad = '  '.repeat(depth);
	for (const m of flow || []) {
		const name = m.metadata?.designer?.name;
		const bits = [`${pad}${String(m.id).padEnd(3)} ${m.module}`];
		if (name) bits.push(`· ${name}`);
		if (m.filter?.name) bits.push(`· [φίλτρο: ${m.filter.name}]`);
		else if (m.filter) bits.push('· [φίλτρο]');
		if (m.onerror?.length) bits.push(`· [onerror: ${m.onerror.map((e) => e.module).join(', ')}]`);
		lines.push(bits.join(' '));
		(m.routes || []).forEach((r, i) => {
			lines.push(`${pad}  ├─ route ${i + 1}`);
			outline(r.flow, depth + 2, lines);
		});
		(m.branches || []).forEach((b) => {
			lines.push(`${pad}  ├─ ${b.type}${b.label ? ` «${b.label}»` : ''}`);
			outline(b.flow, depth + 2, lines);
		});
	}
	return lines;
}

function scheduleText(sch) {
	if (!sch) return '—';
	const t = sch.type;
	if (t === 'immediately') return 'άμεσα (webhook/mailhook)';
	if (t === 'indefinitely') return `κάθε ${sch.interval}s`;
	if (t === 'on-demand') return 'μόνο χειροκίνητα';
	return [t, sch.time, (sch.days || []).join(',')].filter(Boolean).join(' ');
}

// ── main ────────────────────────────────────────────────────────────────────
const list = (await api(`/scenarios?teamId=${TEAM}&pg[limit]=200`)).scenarios || [];
const wanted = ONLY ? list.filter((s) => String(s.id) === ONLY) : list;
if (!wanted.length) {
	console.error(ONLY ? `Δεν βρέθηκε σενάριο ${ONLY}.` : 'Καμία εγγραφή σεναρίου.');
	process.exit(1);
}

mkdirSync(SCEN, { recursive: true });

const idx = [];
let changed = 0;

for (const s of wanted.sort((a, b) => a.id - b.id)) {
	const bp = (await api(`/scenarios/${s.id}/blueprint`)).response.blueprint;
	const file = join(SCEN, fileFor(s));
	const json = JSON.stringify(bp, null, '\t') + '\n';
	const prev = existsSync(file) ? readFileSync(file, 'utf8') : null;
	if (prev !== json) {
		changed++;
		if (!CHECK) writeFileSync(file, json, 'utf8');
		console.log(`${prev === null ? 'νέο' : 'άλλαξε'}  ${s.id}  ${s.name}`);
	} else {
		console.log(`ίδιο   ${s.id}  ${s.name}`);
	}

	idx.push({ s, bp, file: fileFor(s) });
}

if (CHECK) {
	console.log(changed ? `\n${changed} σενάρια διαφέρουν από το repo.` : '\nΌλα συγχρονισμένα.');
	process.exit(changed ? 1 : 0);
}

// Καθάρισε blueprints σεναρίων που δεν υπάρχουν πια (μόνο σε πλήρες pull).
if (!ONLY) {
	const keep = new Set(idx.map((e) => e.file));
	for (const f of readdirSync(SCEN)) {
		if (f.endsWith('.blueprint.json') && !keep.has(f)) {
			rmSync(join(SCEN, f));
			console.log(`σβήστηκε  ${f} (δεν υπάρχει πια στο Make)`);
		}
	}
}

// Το INDEX.md και το registry.json περιγράφουν ΟΛΗ την ομάδα, οπότε γράφονται
// μόνο σε πλήρες pull — αλλιώς ένα `make-pull 6604242` θα τα άφηνε με ένα
// σενάριο μέσα.
if (ONLY) {
	console.log('\nΈνα σενάριο. Για να ενημερωθούν INDEX.md / registry.json τρέξε το pull χωρίς id.');
	process.exit(0);
}

// ── registry: τι σημαίνουν τα αδιαφανή IDs μέσα στα blueprints ──────────────
const safe = async (p, k) => {
	try { return (await api(p))[k] || []; } catch { return []; }
};
const registry = {
	team: Number(TEAM),
	zone: ZONE,
	connections: (await safe(`/connections?teamId=${TEAM}`, 'connections')).map((c) => ({
		id: c.id, name: c.name, accountName: c.accountName, accountLabel: c.accountLabel,
	})),
	keys: (await safe(`/keys?teamId=${TEAM}`, 'keys')).map((k) => ({ id: k.id, name: k.name, typeName: k.typeName })),
	hooks: (await safe(`/hooks?teamId=${TEAM}`, 'hooks')).map((h) => ({
		id: h.id, name: h.name, type: h.type, scenarioId: h.scenarioId, udid: h.udid ? '(κρυφό)' : undefined,
	})),
	dataStores: (await safe(`/data-stores?teamId=${TEAM}`, 'dataStores')).map((d) => ({ id: d.id, name: d.name })),
};
writeFileSync(join(OUT, 'registry.json'), JSON.stringify(registry, null, '\t') + '\n', 'utf8');

// ── INDEX.md: όλα τα σενάρια σε ένα αρχείο, για γρήγορο διάβασμα ────────────
const label = (arr, id) => arr.find((x) => x.id === id)?.name || `#${id}`;
const md = [];
md.push('# Τα σενάρια του Make (snapshot)');
md.push('');
md.push('Παράγεται από `node tools/make-pull.mjs` — **μην το γράφεις στο χέρι**.');
md.push('Τα blueprints είναι στο [scenarios/](scenarios/). Οδηγίες: [../docs/make-scenarios.md](../docs/make-scenarios.md).');
md.push('');
md.push('| ID | Σενάριο | Ενεργό | Χρονισμός | Modules | Αρχείο |');
md.push('|---|---|---|---|---|---|');
for (const { s, file } of idx) {
	md.push(`| \`${s.id}\` | ${s.name} | ${s.isActive ? 'ναι' : '**όχι**'} | ${scheduleText(s.scheduling)} | ${(s.usedModules || []).length} | [${file}](scenarios/${file}) |`);
}
md.push('');
for (const { s, bp } of idx) {
	md.push(`## ${s.name} \`${s.id}\``);
	md.push('');
	const meta = [];
	meta.push(`- Ενεργό: ${s.isActive ? 'ναι' : 'όχι'} · χρονισμός: ${scheduleText(s.scheduling)}`);
	if (s.hookId) meta.push(`- Hook: \`${s.hookId}\` (${label(registry.hooks, s.hookId)})`);
	const sc = bp.metadata?.scenario || {};
	meta.push(`- DLQ: ${sc.dlq ? 'ναι' : 'όχι'} · maxErrors: ${sc.maxErrors ?? '—'} · sequential: ${sc.sequential ? 'ναι' : 'όχι'}`);
	if (s.description) meta.push(`- ${s.description}`);
	md.push(...meta, '');
	md.push('```');
	md.push(...outline(bp.flow));
	md.push('```');
	md.push('');
}
writeFileSync(join(OUT, 'INDEX.md'), md.join('\n'), 'utf8');

console.log(`\n${idx.length} σενάρια → make/scenarios/ · make/INDEX.md · make/registry.json`);
