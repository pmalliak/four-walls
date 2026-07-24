// Step 5 (headless): POST each worklist entry to /requests/form + /communication/form
// through the logged-in CRM tab (session cookie, no CSRF). Same body encoding as
// SKILL.md — parallel area_level1[]/area_level2[], NO area_level3[].
// Usage: node crm-post.mjs <worklist.json> <out results.json>
import { Tab, sleep } from './cdp.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) { console.error('usage: node crm-post.mjs <worklist.json> <results.json>'); process.exit(1); }
const jobs = JSON.parse(readFileSync(inPath, 'utf8'));
console.log('posting', jobs.length, 'requests…');

const tab = await Tab.find('https://fourwalls.estateprime.gr');
if (!tab) { console.log('no CRM tab — run crm-login.mjs first'); process.exit(1); }
await tab.navigate('https://fourwalls.estateprime.gr/requests', { waitMs: 30000 }).catch((e) => console.log('nav warn:', e.message));
await sleep(1500);

const out = await tab.eval(`(async () => {
	const jobs = ${JSON.stringify(jobs)};
	const H = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' };
	const results = [];
	for (const j of jobs) {
		const p = ['save_request=1', 'source_id=1', 'contact_ids[]=' + j.contactId, 'user_ids[]=2',
			'tags[]=13', 'tags[]=14', 'request_status=1', 'rating='];
		for (const [l1, l2] of j.areas) { p.push('area_level1[]=' + l1); p.push('area_level2[]=' + l2); }
		p.push(j.fields, 'shortterm_unit=per_day', 'polygons=%5B%5D');
		const rr = await (await fetch('/requests/form', { method: 'POST', credentials: 'include', headers: H, body: p.join('&') }))
			.json().catch(() => ({ parse: 'fail' }));
		let commId = null, commRaw = null;
		if (rr && rr.id) {
			const cb = ['create_communication=1', 'type=incoming', 'channel=2', 'contact_id=' + j.contactId,
				'request_id=' + rr.id, 'user_id=2', 'tags[]=15', 'tags[]=8',
				'communication_date=' + encodeURIComponent(j.comm.date),
				'comments=' + encodeURIComponent(j.comm.comments)].join('&');
			const cr = await (await fetch('/communication/form', { method: 'POST', credentials: 'include', headers: H, body: cb }))
				.json().catch(() => ({ parse: 'fail' }));
			commId = cr && cr.id; commRaw = cr && !cr.id ? cr : null;
		}
		results.push({ leadId: j.leadId, name: j.name, contactId: j.contactId, requestId: rr && rr.id,
			requestRaw: rr && !rr.id ? rr : null, commId, commRaw });
		await new Promise((r) => setTimeout(r, 600)); // pace + stay under 429s
	}
	return JSON.stringify(results);
})()`, { timeoutMs: Math.max(180000, jobs.length * 5000) });

const results = JSON.parse(out);
writeFileSync(outPath, JSON.stringify(results, null, 1), 'utf8');
for (const r of results)
	console.log(`  ${r.leadId} ${r.name}: request=${r.requestId ?? JSON.stringify(r.requestRaw)} comm=${r.commId ?? JSON.stringify(r.commRaw)}`);
tab.close();
