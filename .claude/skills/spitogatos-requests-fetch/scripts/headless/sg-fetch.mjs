// Step 2 (headless): fetch enquiry details via the logged-in live.spitogatos.gr tab,
// one paced GET per id (~0.7s apart — NEVER bulk-sweep the list endpoint).
// Leads with status "deleted" come back anonymized (asterisks) — record them as
// skipped in processed.json instead of processing.
// Usage: node sg-fetch.mjs <enquiries.json> <out details.json>
import { Tab, sleep } from './cdp.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) { console.error('usage: node sg-fetch.mjs <enquiries.json> <details.json>'); process.exit(1); }
const ids = JSON.parse(readFileSync(inPath, 'utf8')).map((e) => e.showDetailsId);
console.log('fetching', ids.length, 'details…');

const tab = await Tab.find('https://live.spitogatos.gr');
if (!tab) { console.log('no live.spitogatos.gr tab — run sg-login.mjs first'); process.exit(1); }

// Pace from node, one eval per id: in-page setTimeout chains hang forever in a
// long-hidden background tab (intensive timer throttling fires them 1/min).
await tab.send('Page.bringToFront').catch(() => {});
const details = [];
for (const id of ids) {
	const out = await tab.eval(`fetch('/api/search-enquiries/' + ${JSON.stringify(id)}, { headers: { accept: 'application/json' }, credentials: 'include' })
		.then((r) => r.ok ? r.json() : { searchEnquiryId: ${JSON.stringify(id)}, httpError: r.status })
		.then((j) => JSON.stringify(j))`, { timeoutMs: 30000 });
	details.push(JSON.parse(out));
	await sleep(700);
}
writeFileSync(outPath, JSON.stringify(details, null, 1), 'utf8');
for (const d of details) {
	if (d.httpError) { console.log(`  ${d.searchEnquiryId}: HTTP ${d.httpError}`); continue; }
	console.log(`  ${d.searchEnquiryId} [${d.status}]: ${d.firstName} ${d.lastName} | ${d.listingType}/${d.propertyType} | €${d.price ?? '-'} | ${d.livingArea ?? '-'}τμ | ${d.telephone}`);
}
tab.close();
