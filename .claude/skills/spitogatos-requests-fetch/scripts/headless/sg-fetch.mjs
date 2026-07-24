// Step 2 (headless): fetch enquiry details via the logged-in live.spitogatos.gr tab,
// one paced GET per id (~0.7s apart — NEVER bulk-sweep the list endpoint).
// Leads with status "deleted" come back anonymized (asterisks) — record them as
// skipped in processed.json instead of processing.
// Usage: node sg-fetch.mjs <enquiries.json> <out details.json>
import { Tab } from './cdp.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) { console.error('usage: node sg-fetch.mjs <enquiries.json> <details.json>'); process.exit(1); }
const ids = JSON.parse(readFileSync(inPath, 'utf8')).map((e) => e.showDetailsId);
console.log('fetching', ids.length, 'details…');

const tab = await Tab.find('https://live.spitogatos.gr');
if (!tab) { console.log('no live.spitogatos.gr tab — run sg-login.mjs first'); process.exit(1); }

const out = await tab.eval(`(async () => {
	const ids = ${JSON.stringify(ids)};
	const out = [];
	for (const id of ids) {
		const r = await fetch('/api/search-enquiries/' + id, { headers: { accept: 'application/json' }, credentials: 'include' });
		out.push(r.ok ? await r.json() : { searchEnquiryId: id, httpError: r.status });
		await new Promise((res) => setTimeout(res, 700));
	}
	return JSON.stringify(out);
})()`, { timeoutMs: Math.max(120000, ids.length * 3000) });

const details = JSON.parse(out);
writeFileSync(outPath, JSON.stringify(details, null, 1), 'utf8');
for (const d of details) {
	if (d.httpError) { console.log(`  ${d.searchEnquiryId}: HTTP ${d.httpError}`); continue; }
	console.log(`  ${d.searchEnquiryId} [${d.status}]: ${d.firstName} ${d.lastName} | ${d.listingType}/${d.propertyType} | €${d.price ?? '-'} | ${d.livingArea ?? '-'}τμ | ${d.telephone}`);
}
tab.close();
