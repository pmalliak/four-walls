// Step 5 (headless): POST each worklist entry to /requests/form + /communication/form
// through the logged-in CRM tab (session cookie, no CSRF). Same body encoding as
// SKILL.md — parallel area_level1[]/area_level2[], NO area_level3[].
//
// Every browser call is bounded from node and each step is its own eval: Edge FREEZES a
// background tab (timers stop, fetch never settles), and because Runtime.evaluate awaits
// the promise, a frozen tab hangs the whole run with no timeout to save it — that is
// exactly how the 2026-08-05 run stalled for 40 minutes after one lead. On a timeout we
// reopen a fresh tab and read the CRM back over /api instead of blindly re-POSTing, so a
// call that DID land is adopted rather than duplicated.
//
// No EstatePrime key on this machine (the cloud + PC split, SKILL.md): the posts work the
// same, but a timeout cannot be checked from here, so the run STOPS at the first one with
// exit 2 and marks that lead «unknown». The cloud session then reads /api, adopts or drops
// it, and re-runs the rest. Never re-post an «unknown» lead blind.
//
// Usage: node crm-post.mjs <worklist.json> <out results.json>
import { Tab, sleep } from './cdp.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { estateprime } from '../lib/env.mjs';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) { console.error('usage: node crm-post.mjs <worklist.json> <results.json>'); process.exit(1); }
const jobs = JSON.parse(readFileSync(inPath, 'utf8'));
console.log('posting', jobs.length, 'requests…');

const CRM = 'https://fourwalls.estateprime.gr';
const EVAL_MS = 120000;

// ---- read-back over /api (HTTP Basic, node) — the recovery path after a hung eval ----
const API = estateprime();
if (!API) console.log('no EstatePrime key here: a hung eval stops the run for the cloud to check');
const apiGet = async (p) => (await fetch(API.base + p, { headers: API.headers }).then((r) => r.json()).catch(() => null));
// newest-first page 1 is enough: we only ever look for something created seconds ago.
const newest = async (resource) => (API && (await apiGet('/' + resource + '?page=1'))?.data) || [];
const UNKNOWN = { error: 'eval timeout, unknown: no /api here to check, verify from the cloud before any re-post' };
let stop = false;

// ---- the tab we drive (ours, activated, replaced whenever it stops answering) ----
let tab = await Tab.openActive(CRM + '/requests');
async function reopen(why) {
	console.log('  ! tab unresponsive (' + why + ') — reopening');
	await tab.destroy().catch(() => {});
	tab = await Tab.openActive(CRM + '/requests');
}
async function evalJson(expr, label) {
	await tab.send('Page.bringToFront').catch(() => {});
	const out = await Promise.race([
		tab.eval(expr, { timeoutMs: EVAL_MS }),
		sleep(EVAL_MS).then(() => Promise.reject(new Error('eval timeout: ' + label))),
	]);
	return JSON.parse(out);
}

const H = "{ 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }";
const results = [];
for (const j of jobs) {
	const r = { leadId: j.leadId, name: j.name, contactId: j.contactId, starred: null, requestId: null, requestRaw: null, commId: null, commRaw: null, deactivated: null };

	// New contacts: star the default email/phone first — POST /api/contacts never sets
	// one, and the CRM's send-listing-email action 500s on a contact without it.
	if (j.star && (j.star.email || j.star.phone)) {
		try {
			r.starred = await evalJson(`(async () => {
				const j = ${JSON.stringify(j)}, H = ${H}, out = {};
				for (const [kind, val] of [['email', j.star.email], ['phone', j.star.phone]]) {
					if (!val) continue;
					const sb = new URLSearchParams(); sb.set('star_' + kind, val);
					const sr = await fetch('/contacts/view/' + j.contactId, { method: 'POST', credentials: 'include', headers: H, body: sb })
						.then((x) => x.json()).catch(() => null);
					out[kind] = sr && sr.success ? 'ok' : 'FAIL';
				}
				return JSON.stringify(out);
			})()`, `star ${j.leadId}`);
		} catch (e) { r.starred = { error: 'timeout' }; await reopen(e.message); }
	}

	// --- the ζήτηση ---
	const beforeReq = Math.max(0, ...(await newest('requests')).map((x) => Number(x.id) || 0));
	try {
		const rr = await evalJson(`(async () => {
			const j = ${JSON.stringify(j)}, H = ${H};
			const p = ['save_request=1', 'source_id=' + (j.requestSource ?? '1'),
				'contact_ids[]=' + j.contactId, 'user_ids[]=2', 'request_status=1', 'rating='];
			for (const t of (j.requestTags || [13, 14])) p.push('tags[]=' + t);
			for (const [l1, l2] of j.areas) { p.push('area_level1[]=' + l1); p.push('area_level2[]=' + l2); }
			p.push(j.fields, 'shortterm_unit=per_day', 'polygons=%5B%5D');
			const rr = await (await fetch('/requests/form', { method: 'POST', credentials: 'include', headers: H, body: p.join('&') }))
				.json().catch(() => ({ parse: 'fail' }));
			return JSON.stringify(rr);
		})()`, `request ${j.leadId}`);
		r.requestId = rr && rr.id; r.requestRaw = rr && !rr.id ? rr : null;
	} catch (e) {
		await reopen(e.message);
		// Did it land anyway? Adopt it — a blind retry would create a second ζήτηση.
		const hit = (await newest('requests')).find((x) => Number(x.id) > beforeReq && (x.contacts || []).map(String).includes(String(j.contactId)));
		if (!API) { r.requestRaw = UNKNOWN; stop = true; }
		else if (hit) { r.requestId = hit.id; r.requestRaw = { recovered: 'after eval timeout' }; }
		else r.requestRaw = { error: 'eval timeout, nothing landed' };
	}

	// --- the incoming communication (site-form leads arrive without j.comm: the Make
	//     scenario already logged one when the form was submitted) ---
	if (r.requestId && j.comm) {
		try {
			const cr = await evalJson(`(async () => {
				const j = ${JSON.stringify(j)}, H = ${H};
				const cb = ['create_communication=1', 'type=incoming', 'channel=2', 'contact_id=' + j.contactId,
					'request_id=' + ${JSON.stringify(String(r.requestId))}, 'user_id=2',
					...(j.commTags || [15, 8]).map((t) => 'tags[]=' + t),
					'communication_date=' + encodeURIComponent(j.comm.date),
					'comments=' + encodeURIComponent(j.comm.comments)].join('&');
				const cr = await (await fetch('/communication/form', { method: 'POST', credentials: 'include', headers: H, body: cb }))
					.json().catch(() => ({ parse: 'fail' }));
				return JSON.stringify(cr);
			})()`, `comm ${j.leadId}`);
			r.commId = cr && cr.id; r.commRaw = cr && !cr.id ? cr : null;
		} catch (e) {
			await reopen(e.message);
			const hit = (await newest('communication')).find((x) => String(x.request_id) === String(r.requestId));
			if (!API) { r.commRaw = UNKNOWN; stop = true; }
			else if (hit) { r.commId = hit.id; r.commRaw = { recovered: 'after eval timeout' }; }
			else r.commRaw = { error: 'eval timeout, nothing landed' };
		}
	}

	// --- οι παλιές ζητήσεις που αντικατέστησε η νέα κλείνουν ---
	// Δύο ξεχωριστές ενέργειες του UI, και οι δύο χρειάζονται: η κατάσταση («Ανενεργή»)
	// τη βγάζει από τις ενεργές, το στάδιο («Αποσύρθηκε», λόγος 5 = Διπλή καταχώρηση)
	// εξηγεί ΓΙΑΤΙ — αλλιώς μένει «Ανοιχτό» και μοιάζει με δουλειά που ξεχάστηκε.
	// Μόνο ΜΕΤΑ από επιτυχημένη δημιουργία: αλλιώς μια αποτυχία θα άφηνε τον πελάτη
	// χωρίς καμία ενεργή ζήτηση.
	if (r.requestId && (j.supersedes || []).length) {
		try {
			r.deactivated = await evalJson(`(async () => {
				const H = ${H}, out = {};
				const post = (id, body) => fetch('/requests/view/' + id, { method: 'POST', credentials: 'include', headers: H, body })
					.then((v) => v.json()).catch(() => null);
				for (const id of ${JSON.stringify(j.supersedes)}) {
					const a = await post(id, 'change_status=2');
					const b = await post(id, 'change_deal_status=withdrawn&close_reason=5');
					out[id] = (a && a.success ? 'ανενεργή' : 'FAIL κατάσταση') + '+' + (b && b.success ? 'αποσύρθηκε' : 'FAIL στάδιο');
				}
				return JSON.stringify(out);
			})()`, `close ${j.leadId}`);
		} catch (e) { r.deactivated = { error: 'timeout' }; await reopen(e.message); }
	}

	results.push(r);
	console.log(`  ${r.leadId} ${r.name}: request=${r.requestId ?? JSON.stringify(r.requestRaw)} comm=${r.commId ?? JSON.stringify(r.commRaw)}${r.starred ? ' star=' + JSON.stringify(r.starred) : ''}${r.deactivated ? ' παλιές=' + JSON.stringify(r.deactivated) : ''}`);
	writeFileSync(outPath, JSON.stringify(results, null, 1), 'utf8'); // survive a kill mid-run
	if (stop) { console.log('STOPPED at an unverifiable timeout (' + r.leadId + '): check /api from the cloud, then re-run the rest'); break; }
	await sleep(600); // pace + stay under 429s
}

writeFileSync(outPath, JSON.stringify(results, null, 1), 'utf8');
await tab.destroy().catch(() => {});
process.exit(stop ? 2 : 0);
