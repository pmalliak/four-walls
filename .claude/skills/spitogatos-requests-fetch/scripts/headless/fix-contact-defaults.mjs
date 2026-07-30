// Backfill: set the default (star) email/phone on every CRM contact that lacks one.
//
// Why: POST /api/contacts (Make scenarios, prep.mjs, site-requests.mjs — ANY API client)
// creates phone/email rows WITHOUT the is_default flag; only UI-created contacts get it.
// The send-listing-email mass action then 500s on such contacts and the modal's
// «Αποστολή» button never enables. First noticed + fully backfilled 2026-07-30
// (134 of 211 contacts were affected). New skill contacts are starred by crm-post.mjs;
// Make-created ones keep arriving default-less until EstatePrime fixes the API, so
// re-run this after busy lead periods (or when the send button plays dead again).
//
// Detector: the contact page renders `.star-email/.star-phone` per row — `fa-star`
// (filled) = default, only `fa-star-o` (outline) = none. Fix: the UI star-click POST,
// `star_email=<address>` / `star_phone=<number>` to /contacts/view/{id}, on the first row.
// Idempotent: contacts with a filled star are never touched.
//
// Needs: logged-in CRM session in the CDP browser (crm-login.mjs or manual login),
// and ESTATEPRIME_API_* in .dev.vars (for enumeration only).
// Usage: node fix-contact-defaults.mjs [--dry]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Tab, sleep } from './cdp.mjs';

const DRY = process.argv.includes('--dry');

const vars = {};
for (const p of ['.dev.vars', '../../../../.dev.vars', '../../../../../.dev.vars']) {
	if (!existsSync(p)) continue;
	for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/);
		if (m) vars[m[1]] = m[2];
	}
	break;
}
if (!vars.ESTATEPRIME_API_KEY) { console.error('MISSING ESTATEPRIME_API_KEY/SECRET in .dev.vars'); process.exit(1); }
const API = `https://${vars.ESTATEPRIME_SUBDOMAIN || 'fourwalls'}.estateprime.gr/api`;
const AH = {
	Authorization: 'Basic ' + Buffer.from(vars.ESTATEPRIME_API_KEY + ':' + vars.ESTATEPRIME_API_SECRET).toString('base64'),
	'Content-Type': 'application/json',
};

// 1. Enumerate all contacts (the API pages 50 rows regardless of per_page).
const contacts = [];
for (let page = 1; page < 100; page++) {
	const r = await fetch(`${API}/contacts?page=${page}`, { headers: AH });
	const b = await r.json().catch(() => null);
	const rows = b?.data || [];
	if (!rows.length) break;
	for (const c of rows) contacts.push({ id: c.id, name: `${c.first_name || ''} ${c.last_name || ''}`.trim(), nEmails: (c.emails || []).length, nPhones: (c.phones || []).length });
}
console.log(`contacts: ${contacts.length}${DRY ? ' (DRY RUN)' : ''}`);

const tab = await Tab.find('https://fourwalls.estateprime.gr');
if (!tab) { console.log('no CRM tab — run crm-login.mjs first'); process.exit(1); }
await tab.send('Page.bringToFront').catch(() => {});

const results = { fixed: [], ok: [], skippedEmpty: [], errors: [] };

// One eval per contact, paced from node (in-page loops hang in throttled tabs).
for (const c of contacts) {
	if (!c.nEmails && !c.nPhones) { results.skippedEmpty.push(c.id); continue; }
	const out = await tab.eval(`(async () => {
		const H = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' };
		const res = { id: ${c.id}, did: {} };
		const page = await fetch('/contacts/view/${c.id}', { credentials: 'include' });
		if (!page.ok) { res.error = 'page ' + page.status; return JSON.stringify(res); }
		const doc = new DOMParser().parseFromString(await page.text(), 'text/html');
		for (const kind of ['email', 'phone']) {
			const filled = doc.querySelector('.star-' + kind + '.fa-star');
			const rows = [...doc.querySelectorAll('.star-' + kind)];
			if (filled || !rows.length) continue;
			const value = rows[0].getAttribute('data-value');
			if (!value) continue;
			if (${DRY}) { res.did[kind] = 'DRY:' + value; continue; }
			const body = new URLSearchParams(); body.set('star_' + kind, value);
			const r2 = await fetch('/contacts/view/${c.id}', { method: 'POST', credentials: 'include', headers: H, body });
			const d2 = await r2.json().catch(() => null);
			res.did[kind] = d2 && d2.success ? 'ok:' + value : 'FAIL ' + r2.status;
		}
		return JSON.stringify(res);
	})()`, { timeoutMs: 45000 }).catch((e) => JSON.stringify({ id: c.id, error: e.message.slice(0, 80) }));

	const r = JSON.parse(out);
	if (r.error) results.errors.push({ id: c.id, name: c.name, error: r.error });
	else if (r.did && Object.keys(r.did).length) {
		results.fixed.push({ id: c.id, name: c.name, ...r.did });
		console.log(`  #${c.id} ${c.name}: ${JSON.stringify(r.did)}`);
	} else results.ok.push(c.id);
	await sleep(300);
}

console.log(`\n${DRY ? 'DRY RUN — would fix' : 'fixed'}: ${results.fixed.length} contacts`);
console.log(`already ok: ${results.ok.length} · no email+phone at all: ${results.skippedEmpty.length} · errors: ${results.errors.length}`);
if (results.errors.length) console.log('errors:', JSON.stringify(results.errors));
writeFileSync(DRY ? 'fix-defaults-dry.json' : 'fix-defaults-results.json', JSON.stringify(results, null, 1));
tab.close();
process.exit(0);
