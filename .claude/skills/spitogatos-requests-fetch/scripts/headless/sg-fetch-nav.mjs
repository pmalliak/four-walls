// Step 2 fallback (first needed 2026-07-27): Imperva now stalls fetch() calls made
// from Runtime.evaluate on live.spitogatos.gr — they hang forever even with the tab
// focused — while XHRs initiated by the page itself still work. So mimic clicking
// the email notification for real: navigate to /leads/searchEnquiries?showDetailsId=<id>
// and capture the page's OWN detail XHR via CDP Network events. Paced from node.
// Try sg-fetch.mjs first; if it hangs on the first id, kill it and use this.
// Usage: node sg-fetch-nav.mjs <enquiries.json> <out details.json>
import { Tab, sleep } from './cdp.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) { console.error('usage: node sg-fetch-nav.mjs <enquiries.json> <details.json>'); process.exit(1); }
const ids = JSON.parse(readFileSync(inPath, 'utf8')).map((e) => e.showDetailsId);
console.log('fetching', ids.length, 'details via navigation…');

const tab = await Tab.find('https://live.spitogatos.gr');
if (!tab) { console.log('no live.spitogatos.gr tab — run sg-login.mjs first'); process.exit(1); }

// Collect detail XHRs: /api/search-enquiries/<digits>
const hits = [];
tab.ws.addEventListener('message', (ev) => {
	const m = JSON.parse(ev.data);
	if (m.method === 'Network.responseReceived' && /\/api\/search-enquiries\/\d+/.test(m.params.response.url)) {
		hits.push({ requestId: m.params.requestId, url: m.params.response.url, status: m.params.response.status });
	}
});
await tab.send('Network.enable');
await tab.send('Page.bringToFront').catch(() => {});

const details = [];
for (const id of ids) {
	const seen = hits.length;
	await tab.navigate(`https://live.spitogatos.gr/leads/searchEnquiries?showDetailsId=${id}`);
	const t0 = Date.now();
	while (hits.length === seen && Date.now() - t0 < 30000) await sleep(400);
	if (hits.length === seen) { console.log(`  ${id}: NO detail XHR captured`); details.push({ searchEnquiryId: id, captureError: 'no XHR' }); continue; }
	const h = hits[hits.length - 1];
	await sleep(600); // let the body land
	try {
		const b = await tab.send('Network.getResponseBody', { requestId: h.requestId });
		details.push(JSON.parse(b.body));
	} catch (e) {
		details.push({ searchEnquiryId: id, captureError: String(e), httpStatus: h.status });
	}
	await sleep(2500); // pace navigations like a human clicking through notifications
}
writeFileSync(outPath, JSON.stringify(details, null, 1), 'utf8');
for (const d of details) {
	if (d.captureError) { console.log(`  ${d.searchEnquiryId}: CAPTURE FAIL ${d.captureError}`); continue; }
	console.log(`  ${d.searchEnquiryId} [${d.status}]: ${d.firstName} ${d.lastName} | ${d.listingType}/${d.propertyType} | €${d.price ?? '-'} | ${d.livingArea ?? '-'}τμ | ${d.telephone}`);
}
tab.close();
