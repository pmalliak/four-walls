// Step 1 (cloud): enumerate Spitogatos «Αίτηση ζήτησης» emails in info@ via the Zoho API
// → fresh showDetailsIds not yet in processed.json. Same output as headless/enumerate.mjs
// (the Spark version), so the rest of the pipeline does not care which one ran.
// Usage: node enumerate-zoho.mjs <after yyyy/MM/dd> <processed.json> <out enquiries.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { zohoSession, zohoSearch, zohoHtml, athens, sinceArg } from './lib/zoho.mjs';

const [after, processedPath, outPath] = process.argv.slice(2);
if (!after || !processedPath || !outPath) {
	console.error('usage: node enumerate-zoho.mjs <after yyyy/MM/dd> <processed.json> <out.json>');
	process.exit(1);
}

const processed = JSON.parse(readFileSync(processedPath, 'utf8'));
const done = new Set([...(processed.done || []), ...Object.keys(processed.skipped_duplicates || {})].map(String));

const z = await zohoSession();
const mails = (await zohoSearch(z, 'sender:notifications@spitogatos.gr', sinceArg(after)))
	.filter((m) => String(m.subject || '').includes('Αίτηση ζήτησης'));
console.log(`ζήτηση emails in window (${z.address}): ${mails.length}`);

const found = new Map(); // showDetailsId -> {emailId,date}
let noLink = 0;
for (const m of mails) {
	const id = (await zohoHtml(z, m)).match(/showDetailsId(?:=|%3D)(\d+)/)?.[1];
	const date = athens(m.receivedTime);
	if (!id) { noLink++; console.log(`  ! no showDetailsId in email ${m.messageId} (${date})`); continue; }
	if (!found.has(id)) found.set(id, { emailId: m.messageId, date });
}

const fresh = [...found.entries()]
	.filter(([id]) => !done.has(id))
	.map(([id, v]) => ({ showDetailsId: id, ...v }))
	.sort((a, b) => Number(a.showDetailsId) - Number(b.showDetailsId));

console.log(`unique showDetailsIds: ${found.size}, already processed: ${found.size - fresh.length}, no-link: ${noLink}`);
console.log(`FRESH: ${fresh.length}`);
for (const f of fresh) console.log(`  ${f.showDetailsId}  ${f.date}  (email ${f.emailId})`);
writeFileSync(outPath, JSON.stringify(fresh, null, 1), 'utf8');
