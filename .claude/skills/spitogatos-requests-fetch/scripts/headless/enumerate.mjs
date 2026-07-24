// Step 1 (headless): enumerate Spitogatos «Αίτηση ζήτησης» emails via Spark CLI
// (Spark Desktop must be running) → fresh showDetailsIds not yet in processed.json.
// Usage: node enumerate.mjs <after yyyy/MM/dd> <processed.json> <out enquiries.json>
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const SPARK = 'C:\\Users\\panos\\AppData\\Local\\Programs\\SparkDesktop\\resources\\app.asar.unpacked\\node_modules\\@readdle\\sparkcore-win\\bin\\Release\\SparkCore.bundle\\spark.exe';
const [after, processedPath, outPath] = process.argv.slice(2);
if (!after || !processedPath || !outPath) {
	console.error('usage: node enumerate.mjs <after yyyy/MM/dd> <processed.json> <out.json>');
	process.exit(1);
}

const processed = JSON.parse(readFileSync(processedPath, 'utf8'));
const done = new Set([...(processed.done || []), ...Object.keys(processed.skipped_duplicates || {})]);

const run = (args) => {
	const r = spawnSync(SPARK, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
	if (r.status !== 0) throw new Error(`spark ${args.join(' ')} failed: ${r.stderr}`);
	return r.stdout;
};

// 1. Collect email ids whose subject is «Αίτηση ζήτησης …» across all result pages
const emails = [];
for (let page = 1; page <= 20; page++) {
	const out = run(['search', '--filter', `from:notifications@spitogatos.gr after:${after}`,
		'--page', String(page), '--page-size', '100', '--order', 'descending']);
	for (const line of out.split('\n')) {
		const m = line.match(/^\s*(\d+)\s+\S+@\S+\s+.*?(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+(.+?)\s*$/);
		if (m && m[3].includes('Αίτηση ζήτησης')) emails.push({ emailId: m[1], date: m[2] });
	}
	const pm = out.match(/Page (\d+) of (\d+)/);
	if (!pm || Number(pm[1]) >= Number(pm[2])) break;
}
console.log(`ζήτηση emails in window: ${emails.length}`);

// 2. Open each thread, extract showDetailsId from the live.spitogatos.gr link
const found = new Map(); // showDetailsId -> {emailId,date}
let noLink = 0;
for (const e of emails) {
	const out = run(['thread', e.emailId]);
	const m = out.match(/showDetailsId=(\d+)/);
	if (!m) { noLink++; console.log(`  ! no showDetailsId in email ${e.emailId} (${e.date})`); continue; }
	if (!found.has(m[1])) found.set(m[1], { emailId: e.emailId, date: e.date });
}

const fresh = [...found.entries()]
	.filter(([id]) => !done.has(id))
	.map(([id, v]) => ({ showDetailsId: id, ...v }))
	.sort((a, b) => Number(a.showDetailsId) - Number(b.showDetailsId));

console.log(`unique showDetailsIds: ${found.size}, already processed: ${found.size - fresh.length}, no-link: ${noLink}`);
console.log(`FRESH: ${fresh.length}`);
for (const f of fresh) console.log(`  ${f.showDetailsId}  ${f.date}  (email ${f.emailId})`);
writeFileSync(outPath, JSON.stringify(fresh, null, 1), 'utf8');
