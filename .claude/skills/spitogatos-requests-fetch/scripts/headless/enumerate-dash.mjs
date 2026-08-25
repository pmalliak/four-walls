// Step 1 FALLBACK: enumerate leads from the spitogatos dashboard instead of the
// Spark mailbox. Use it when Spark Desktop will not start (it has refused shell
// launches on 2026-07-27 and 2026-08-20; ensure-apps.ps1 now retries via
// explorer.exe, which usually cures it, so try that first).
//
// Why a script and not a hand-driven tab: the SPA IGNORES a ?page=N query param on
// the page URL (it always re-requests page=1), so the only way to walk back in time
// is to click the real «next» arrow. Each click is one list XHR the page makes
// itself, so it is human-identical, NOT a bulk sweep of the list endpoint. We stop the
// moment the rows overlap processed.json, so we never walk further back than the
// gap we actually have.
//
// The list rows carry names/phones/prices but NOT rooms/floorNumber/elevator, and
// their `geographies` are display strings rather than the `geographyIds` prep.mjs
// needs, so always follow up with sg-fetch(-nav).mjs per id.
//
// Usage: node enumerate-dash.mjs <out fresh.json> [maxPages=4]
//   fresh.json = the not-yet-processed rows, newest first. Feed the live ones to
//   sg-fetch-nav.mjs as [{showDetailsId}] (rows with status "deleted" come back
//   anonymized, so record those in processed.json → skipped_duplicates instead).
import { Tab, sleep } from './cdp.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROCESSED = resolve(HERE, '../../state/processed.json');
const [outPath, maxPagesArg] = process.argv.slice(2);
if (!outPath) { console.error('usage: node enumerate-dash.mjs <fresh.json> [maxPages]'); process.exit(1); }
const maxPages = Number(maxPagesArg || 4);

const processed = JSON.parse(readFileSync(PROCESSED, 'utf8'));
const seen = new Set([...processed.done, ...Object.keys(processed.skipped_duplicates || {})].map(String));

// A fresh, activated tab: a backgrounded one gets frozen by Edge and every eval
// hangs forever (see the 2026-08-05 gotcha in SKILL.md).
const tab = await Tab.open('about:blank');
await tab.send('Page.enable');
await tab.send('Network.enable');
await tab.send('Page.bringToFront').catch(() => {});
await tab.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});

const hits = [];
tab.ws.addEventListener('message', (ev) => {
	const m = JSON.parse(ev.data);
	if (m.method === 'Network.responseReceived' && /\/api\/search-enquiries\?/.test(m.params.response.url))
		hits.push({ requestId: m.params.requestId, url: m.params.response.url });
});

async function takeBody(before, label) {
	const t0 = Date.now();
	while (hits.length === before && Date.now() - t0 < 40000) await sleep(500);
	if (hits.length === before) { console.log(`${label}: NO list XHR captured`); return null; }
	await sleep(1000); // let the body land before asking for it
	const h = hits[hits.length - 1];
	return { body: JSON.parse((await tab.send('Network.getResponseBody', { requestId: h.requestId })).body), url: h.url };
}

const rows = [];
let hitOverlap = false;
let before = hits.length;
await tab.send('Page.navigate', { url: 'https://live.spitogatos.gr/leads/searchEnquiries' });
let r = await takeBody(before, 'page 1');
if (!r) { console.log('no list XHR at all. Is the session logged in? run sg-login.mjs'); process.exit(1); }

for (let page = 1; page <= maxPages && r; page++) {
	const got = r.body.searches || [];
	console.log(`page ${page}/${r.body.lastPage} [${r.url.match(/page=\d+/)?.[0]}]: ${got.length} rows`);
	rows.push(...got);
	if (got.some((x) => seen.has(String(x.searchEnquiryId)))) { hitOverlap = true; console.log('  -> overlap with processed.json reached'); break; }
	if (page >= r.body.lastPage || page >= maxPages) break;
	await sleep(3000); // pace like a human reading the page before clicking on
	before = hits.length;
	if (!(await tab.clickSel('button.pagination--next:not(.is--disabled)'))) { console.log('  next arrow not clickable, stopping'); break; }
	r = await takeBody(before, `page ${page + 1}`);
}

const uniq = [...new Map(rows.map((x) => [x.searchEnquiryId, x])).values()].sort((a, b) => b.searchEnquiryId - a.searchEnquiryId);
const fresh = uniq.filter((x) => !seen.has(String(x.searchEnquiryId)));
writeFileSync(outPath, JSON.stringify(fresh, null, 1), 'utf8');
console.log(`\n${uniq.length} unique rows, ${fresh.length} fresh -> ${outPath}`);
if (fresh.length) {
	const o = fresh[fresh.length - 1], n = fresh[0];
	console.log(`fresh range: ${o.searchEnquiryId} (${o.dateSubmitted}) .. ${n.searchEnquiryId} (${n.dateSubmitted})`);
	const dead = fresh.filter((x) => x.status === 'deleted').map((x) => x.searchEnquiryId);
	if (dead.length) console.log(`deleted (anonymized, do NOT process): ${dead.join(', ')}`);
}
// No overlap means the window may start mid-gap, so raise maxPages and re-run.
if (!hitOverlap) console.log('WARNING: never overlapped processed.json, window may be incomplete, raise maxPages.');
await tab.destroy();
setTimeout(() => process.exit(0), 200);
