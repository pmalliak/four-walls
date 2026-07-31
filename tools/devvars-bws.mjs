#!/usr/bin/env node
/* =====================================================================
   .dev.vars  ⇄  Bitwarden Secrets Manager
   ---------------------------------------------------------------------
   Αντίγραφο των τοπικών μυστικών στο Secrets Manager, ώστε ένα καινούργιο
   PC να τα ξαναφέρει χωρίς κυνήγι στα dashboards. Το `.dev.vars` παραμένει
   η πηγή που διαβάζουν τα εργαλεία· εδώ κρατάμε απλώς εφεδρεία.

     node tools/devvars-bws.mjs push    # .dev.vars  ->  Secrets Manager
     node tools/devvars-bws.mjs pull    # Secrets Manager -> .dev.vars
     node tools/devvars-bws.mjs status  # σύγκριση, χωρίς αλλαγές

   Το `pull` ΜΟΝΟ προσθέτει ό,τι λείπει τοπικά· δεν πατάει ποτέ υπάρχουσα
   τιμή (αν διαφέρει, το λέει και αποφασίζεις εσύ). Καμία τιμή δεν
   τυπώνεται ποτέ, ούτε στα μηνύματα ούτε σε σφάλματα.

   Bootstrap σε νέο PC: χρειάζεσαι μόνο `BW_ACCESS_TOKEN=…` στο `.dev.vars`
   (από το web vault: Secrets Manager → Machine accounts → Access tokens)
   και το bws.exe. Μετά: `node tools/devvars-bws.mjs pull`.
   ===================================================================== */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const DEV_VARS = join(REPO, '.dev.vars');
const PROJECT_NAME = 'Four Walls';

/* Δεν ταξιδεύουν:
   BW_ACCESS_TOKEN — ξεκλειδώνει το ίδιο το Secrets Manager (κότα κι αυγό).
   BW_SESSION      — προσωρινό unlock του `bw`, λήγει, άχρηστο ως εφεδρεία. */
const SKIP = new Set(['BW_ACCESS_TOKEN', 'BW_SESSION']);
const VAR_RE = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/;

const BWS = [join(process.env.LOCALAPPDATA || '', 'FourWalls', 'bws.exe'), 'bws']
	.find((p) => p === 'bws' || existsSync(p));

function readDevVars() {
	if (!existsSync(DEV_VARS)) return { text: '', vars: new Map() };
	const text = readFileSync(DEV_VARS, 'utf8');
	const vars = new Map();
	for (const line of text.split(/\r?\n/)) {
		const m = VAR_RE.exec(line);
		if (m) vars.set(m[1], m[2].trim().replace(/^["']|["']$/g, ''));
	}
	return { text, vars };
}

function bws(args, accessToken) {
	const run = spawnSync(BWS, args, {
		env: { ...process.env, BWS_ACCESS_TOKEN: accessToken },
		encoding: 'utf8',
	});
	if (run.status !== 0) {
		/* Το stderr του bws δεν περιέχει τιμές, μόνο διαγνωστικά. */
		throw new Error(`bws ${args[0]} ${args[1]}: ${(run.stderr || '').trim() || 'exit ' + run.status}`);
	}
	return run.stdout ? JSON.parse(run.stdout) : null;
}

const { text, vars: local } = readDevVars();
const accessToken = local.get('BW_ACCESS_TOKEN');
if (!BWS) throw new Error('Δεν βρέθηκε το bws.exe (%LOCALAPPDATA%\\FourWalls\\bws.exe ή στο PATH).');
if (!accessToken) throw new Error('Λείπει το BW_ACCESS_TOKEN από το .dev.vars.');

const projects = bws(['project', 'list', '--output', 'json'], accessToken) || [];
const project = projects.find((p) => p.name === PROJECT_NAME);
if (!project) {
	throw new Error(`Το machine account δεν βλέπει project «${PROJECT_NAME}». `
		+ 'Δώσ’ του πρόσβαση: web vault → Secrets Manager → Machine accounts → Projects.');
}

const remote = new Map();
for (const s of bws(['secret', 'list', '--output', 'json'], accessToken) || []) {
	if (s.projectId === project.id) remote.set(s.key, s);
}

const cmd = process.argv[2] || 'status';
const candidates = [...local.keys()].filter((k) => !SKIP.has(k));

if (cmd === 'status') {
	console.log(`project «${project.name}» · ${remote.size} secrets · .dev.vars: ${local.size} μεταβλητές\n`);
	for (const key of candidates) {
		const hit = remote.get(key);
		console.log(`  ${key.padEnd(28)} ${!hit ? 'λείπει από το bws' : hit.value === local.get(key) ? 'ίδιο' : 'ΔΙΑΦΕΡΕΙ'}`);
	}
	const extra = [...remote.keys()].filter((k) => VAR_RE.test(`${k}=`) && !local.has(k));
	for (const key of extra) console.log(`  ${key.padEnd(28)} λείπει από το .dev.vars`);
	for (const key of SKIP) if (local.has(key)) console.log(`  ${key.padEnd(28)} (εξαιρείται σκόπιμα)`);
}

if (cmd === 'push') {
	let created = 0, updated = 0, same = 0;
	for (const key of candidates) {
		const value = local.get(key);
		const hit = remote.get(key);
		if (!hit) {
			bws(['secret', 'create', key, value, project.id, '--output', 'json'], accessToken);
			console.log(`  + ${key}`); created++;
		} else if (hit.value !== value) {
			bws(['secret', 'edit', hit.id, '--value', value, '--output', 'json'], accessToken);
			console.log(`  ~ ${key}`); updated++;
		} else same++;
	}
	console.log(`\nνέα: ${created} · ενημερωμένα: ${updated} · αμετάβλητα: ${same}`);
}

if (cmd === 'pull') {
	const missing = [...remote.values()]
		.filter((s) => VAR_RE.test(`${s.key}=`) && !local.has(s.key) && !SKIP.has(s.key));
	const differ = [...remote.values()].filter((s) => local.has(s.key) && local.get(s.key) !== s.value);

	if (missing.length) {
		const block = missing.map((s) => `${s.key}=${s.value}`).join('\n');
		writeFileSync(DEV_VARS, (text.replace(/\s*$/, '') + '\n' + block + '\n').replace(/\r\n/g, '\n'), 'utf8');
		for (const s of missing) console.log(`  + ${s.key}`);
	}
	console.log(`\nπροστέθηκαν: ${missing.length}`);
	if (differ.length) {
		console.log('διαφέρουν (ΔΕΝ πειράχτηκαν, δες τα μόνος σου): ' + differ.map((s) => s.key).join(', '));
	}
}
