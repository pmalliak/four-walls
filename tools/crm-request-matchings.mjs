#!/usr/bin/env node
// Νέα ακίνητα ανά ζήτηση → digest email στη γραμματεία.
//
// Σαρώνει κάθε ΕΝΕΡΓΗ ζήτηση του EstatePrime και μαζεύει τα ακίνητα που
// κάθονται ακόμη σε κατάσταση «Νέο» στο tab «Ακίνητα» (/requests/listings/{id}).
// Αυτά είναι οι εκκρεμότητες: η γραμματεία τα κάνει «Προτεινόμενα» ή
// «Απορριφθέντα» μέσα στο CRM και φεύγουν μόνα τους από το επόμενο digest.
//
//   node tools/crm-request-matchings.mjs            # dry run — τυπώνει, δεν στέλνει
//   node tools/crm-request-matchings.mjs --send     # στέλνει το email μέσω Make
//   node tools/crm-request-matchings.mjs --request 135 --send   # μόνο μία ζήτηση
//
// Δύο πηγές, δύο τρόποι αυθεντικοποίησης (δες docs/request-matchings.md):
//   • λίστα ζητήσεων + επαφές → public API, Basic auth (.dev.vars)
//   • τα ματσαρίσματα         → POST /listings, session cookie, μέσω του
//     αφιερωμένου Edge στο :9222 (δεν υπάρχουν στο public API)

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Tab, sleep } from '../.claude/skills/spitogatos-requests-fetch/scripts/headless/cdp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CRM = 'https://fourwalls.estateprime.gr';
const CHUNK = 20; // ζητήσεις ανά in-page eval
const IN_PAGE_CONCURRENCY = 4;

const argv = process.argv.slice(2);
const SEND = argv.includes('--send');
const ONLY = (() => {
	const i = argv.indexOf('--request');
	return i >= 0 ? argv[i + 1] : null;
})();

// ── secrets ─────────────────────────────────────────────────────────────────
function devVars() {
	const out = {};
	for (const line of readFileSync(resolve(ROOT, '.dev.vars'), 'utf8').split(/\r?\n/)) {
		const m = line.match(/^([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/);
		if (m) out[m[1]] = m[2];
	}
	return out;
}
const VARS = devVars();
const BASIC = 'Basic ' + Buffer.from(`${VARS.ESTATEPRIME_API_KEY}:${VARS.ESTATEPRIME_API_SECRET}`).toString('base64');

// Το tab.close() του cdp.mjs κλείνει μόνο το WebSocket — το tab μένει ανοιχτό.
// Σε καθημερινό run αυτό συσσωρεύει tabs στον Edge, που τελικά μπλοκάρει το
// connection pool του renderer ([[edge-cdp-automation]]). Κλείσε το target.
async function closeTab(tab) {
	try { tab.close(); } catch {}
	try { await fetch(`http://127.0.0.1:9222/json/close/${tab.info.id}`); } catch {}
}

async function api(path) {
	const r = await fetch(CRM + '/api' + path, {
		headers: { Authorization: BASIC, 'Content-Type': 'application/json' },
	});
	if (!r.ok) throw new Error(`API ${path} → ${r.status}`);
	return r.json();
}

// ── 1. ενεργές ζητήσεις (public API) ────────────────────────────────────────
async function activeRequests() {
	const all = [];
	let page = 1, pages = 1;
	do {
		const j = await api(`/requests?page=${page}`);
		pages = j.total_pages || 1;
		all.push(...(j.data || []));
		page++;
	} while (page <= pages);
	// status 1 = Ενεργή
	return all.filter((r) => r.status === 1 && (!ONLY || String(r.id) === String(ONLY)));
}

// ── 2. «Νέα» ακίνητα ανά ζήτηση (session cookie, μέσω Edge) ─────────────────
// Το /listings είναι datatable endpoint: γυρίζει HTML κελιά, όχι καθαρά πεδία.
const SWEEP = (ids, conc) => `(async()=>{
	const ids = ${JSON.stringify(ids)};
	const strip = (h) => String(h ?? '').replace(/<br\\s*\\/?>/gi, ' · ')
		.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
		.replace(/\\s+/g, ' ').trim();
	const out = {};
	let i = 0;
	async function worker() {
		while (i < ids.length) {
			const id = ids[i++];
			try {
				const body = new URLSearchParams({
					draw: '1', start: '0', length: '200',
					'tableData[show-table]': '1',
					'tableData[listing_status]': 'active',
					'tableData[request_id]': String(id),
					'tableData[request_listing_filter]': 'new',
				});
				const res = await fetch('/listings', { method: 'POST', headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'X-Requested-With': 'XMLHttpRequest' }, body });
				const j = await res.json();
				out[id] = (j.data || []).map((row) => ({
					listing_id: (String(row.code || '').match(/\\/listings\\/view\\/(\\d+)/) || [])[1] || null,
					code: strip(row.code).split(' ')[0],
					price: strip(row.price),
					size: strip(row.size),
					subcategory: strip(row.subcategory),
					floor: strip(row.floor),
					location: strip(row.location),
					added: strip(row.date_created),
					status: strip(row.request_status),
				}));
			} catch (e) { out[id] = { error: String(e && e.message || e) }; }
		}
	}
	await Promise.all(Array.from({ length: ${conc} }, worker));
	return out;
})()`;

// ── 3. digest ───────────────────────────────────────────────────────────────
const AVAIL = { sale: 'Πώληση', rent: 'Ενοικίαση', auction: 'Πλειστηριασμός', shortterm: 'Βραχυχρόνια' };
const CATEG = { residential: 'Κατοικία', commercial: 'Επαγγελματικό', land: 'Γη', other: 'Άλλο' };
const euro = (n) => '€' + Number(n).toLocaleString('el-GR');

function criteriaLine(r) {
	const bits = [CATEG[r.category] || r.category, AVAIL[r.availability] || r.availability];
	if (r.price_max) bits.push('έως ' + euro(r.price_max));
	else if (r.price_min) bits.push('από ' + euro(r.price_min));
	if (r.size_min || r.size_max) bits.push(`${r.size_min || ''}${r.size_min && r.size_max ? '–' : ''}${r.size_max || '+'} τ.μ.`);
	return bits.filter(Boolean).join(' · ');
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* Το ίδιο περιεχόμενο, λιτό, για το description της ημερήσιας υποχρέωσης
   στο CRM. Ένα task τη μέρα, όχι ένα ανά ματσάρισμα: η κατάσταση «Νέο»
   στο tab «Ακίνητα» ΕΙΝΑΙ ήδη η λίστα εκκρεμοτήτων και αδειάζει μόνη της
   όταν δουλέψει ο άνθρωπος — δεύτερο task ανά γραμμή θα ζητούσε την ίδια
   δουλειά δύο φορές. Το task λέει μόνο «η σημερινή παρτίδα δουλεύτηκε».
   Χωρίς εισαγωγικά: το κείμενο μπαίνει σε JSON string μέσα στο Make. */
function buildTaskBody(items, totalNew) {
	const rows = items.map((it) => `<li><a href='${CRM}/requests/listings/${it.request.id}'>Ζήτηση ${it.request.id} · ${esc(it.contact)}</a>`
		+ ` (${it.listings.length}): ${esc(it.listings.map((l) => l.code).join(', '))}</li>`).join('');
	return (`<p><b>${totalNew} νέα ακίνητα</b> περιμένουν χαρακτηρισμό σε ${items.length} `
		+ `${items.length === 1 ? 'ζήτηση' : 'ζητήσεις'}.</p><ul>${rows}</ul>`
		+ '<p>Κάθε ματσάρισμα γίνεται «Προτεινόμενο» ή «Απορριφθέν» μέσα στο CRM. '
		+ 'Κλείσε την υποχρέωση όταν αδειάσει η λίστα.</p>').replace(/"/g, "'");
}

function buildEmail(items, totalNew, failedCount = 0) {
	const blocks = items.map((it) => `
<tr><td style="padding:0 20px 18px 20px;">
	<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6e8ec; border-radius:6px;">
		<tr><td style="padding:12px 14px 8px 14px; border-bottom:1px solid #eef0f3;">
			<div style="font-size:15px; font-weight:bold; color:#16233A;">
				<a href="${CRM}/requests/listings/${it.request.id}" style="color:#16233A; text-decoration:none;">Ζήτηση ${it.request.id} · ${esc(it.contact)}</a>
			</div>
			<div style="font-size:13px; color:#777777; padding-top:3px;">${esc(criteriaLine(it.request))}</div>
			${it.phone ? `<div style="font-size:13px; color:#777777;">${esc(it.phone)}</div>` : ''}
		</td></tr>
		${it.listings.map((l) => `<tr><td style="padding:8px 14px; border-bottom:1px solid #f4f5f7; font-size:13px; line-height:1.55; color:#16233A;">
			<a href="${CRM}/listings/view/${l.listing_id}" style="color:#FF1462; font-weight:bold; text-decoration:none;">${esc(l.code)}</a>
			<span style="color:#16233A;"> — ${esc([l.subcategory, l.price, l.size && l.size + ' τ.μ.', l.floor].filter(Boolean).join(' · '))}</span>
			${l.location ? `<div style="color:#777777;">${esc(l.location)}</div>` : ''}
		</td></tr>`).join('')}
		<tr><td style="padding:10px 14px;">
			<a href="${CRM}/requests/listings/${it.request.id}" style="color:#FF1462; font-size:13px; font-weight:bold; text-decoration:none;">Άνοιγμα στο CRM →</a>
		</td></tr>
	</table>
</td></tr>`).join('');

	return `<!DOCTYPE html>
<html lang="el"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0; padding:0; background:#f4f5f7; font-family:Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7; padding:16px 0;">
<tr><td align="center">
<table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px; width:100%; background:#ffffff; border-radius:8px; overflow:hidden;">

<tr><td style="background:#16233A; padding:12px 20px; color:#ffffff; font-size:15px; font-weight:bold; letter-spacing:1px;">ΝΕΑ ΑΚΙΝΗΤΑ ΣΕ ΖΗΤΗΣΕΙΣ</td></tr>
<tr><td style="height:3px; background:#FF1462;"></td></tr>

<tr><td style="padding:16px 20px 14px 20px; font-size:14px; line-height:1.7; color:#16233A;">
<p style="margin:0;"><strong>${totalNew}</strong> ${totalNew === 1 ? 'ακίνητο περιμένει' : 'ακίνητα περιμένουν'} σε ${items.length} ${items.length === 1 ? 'ζήτηση' : 'ζητήσεις'}. Ανοίξτε κάθε ζήτηση και σημάνετε τα ως <strong>Προτεινόμενα</strong> ή <strong>Απορριφθέντα</strong> — όσα μείνουν «Νέα» θα ξαναεμφανιστούν στο επόμενο email.</p>
${failedCount ? `<p style="margin:12px 0 0 0; padding:10px 12px; background:#fff4f7; border-left:3px solid #FF1462; font-size:13px;">Προσοχή: ${failedCount} ${failedCount === 1 ? 'ζήτηση δεν ελέγχθηκε' : 'ζητήσεις δεν ελέγχθηκαν'} λόγω σφάλματος — η λίστα μπορεί να είναι ελλιπής.</p>` : ''}
</td></tr>

${blocks}

<tr><td style="padding:4px 20px 18px 20px; font-size:12px; color:#999999; line-height:1.6;">Αυτόματος έλεγχος από το EstatePrime · ${new Date().toLocaleString('el-GR', { timeZone: 'Europe/Athens' })}</td></tr>

</table></td></tr></table></body></html>`;
}

// ── main ────────────────────────────────────────────────────────────────────
// Καμία `process.exit()` όσο το tab είναι ανοιχτό: το exit παρακάμπτει το
// `finally` και αφήνει το tab πίσω. Επέστρεψε exit code, καθάρισε, μετά βγες.
async function main() {
	const requests = await activeRequests();
	console.log(`Ενεργές ζητήσεις: ${requests.length}`);
	if (!requests.length) return 0;

	// openActive, όχι open: ένα tab που περνάει στο παρασκήνιο το παγώνει ο Edge
	// (σταματούν timers και fetch), και η σάρωση κρεμάει για πάντα — το evaluate
	// περιμένει promise που δεν λύνεται ποτέ.
	const tab = await Tab.openActive(CRM + '/requests');
	try {
		await sleep(4000);
		const path = await tab.eval('location.pathname');
		if (!path.startsWith('/requests')) throw new Error(`Ο Edge δεν είναι συνδεδεμένος στο CRM (κατέληξε στο ${path}) — άνοιξε το ${CRM} και κάνε login.`);

		const matches = {};
		const ids = requests.map((r) => r.id);
		for (let i = 0; i < ids.length; i += CHUNK) {
			const chunk = ids.slice(i, i + CHUNK);
			Object.assign(matches, await tab.eval(SWEEP(chunk, IN_PAGE_CONCURRENCY), { timeoutMs: 180000 }));
			console.log(`  σαρώθηκαν ${Math.min(i + CHUNK, ids.length)}/${ids.length}`);
		}

		// Χωρίς αυτό, ένα ληγμένο session κάνει κάθε σάρωση να σκάει, το digest
		// βγάζει «καμία εκκρεμότητα» και η μέρα μοιάζει ήσυχη ενώ δεν κοίταξε κανείς.
		const failed = Object.entries(matches).filter(([, v]) => v && v.error);
		if (failed.length) console.warn(`⚠ απέτυχαν ${failed.length}/${ids.length} ζητήσεις:`, failed.slice(0, 3));
		if (failed.length > ids.length / 4)
			throw new Error(`Απέτυχε το ${Math.round((100 * failed.length) / ids.length)}% των σαρώσεων — πιθανότατα έληξε το session του CRM στον Edge. Δεν στέλνεται digest (θα ήταν ψευδώς άδειο).`);

		const hits = requests
			.filter((r) => Array.isArray(matches[r.id]) && matches[r.id].length)
			.sort((a, b) => String(b.date_created).localeCompare(String(a.date_created)));

		const items = [];
		for (const r of hits) {
			let contact = '—', phone = '';
			const cid = (r.contacts || [])[0];
			if (cid) {
				try {
					const c = (await api(`/contacts/${cid}`)).data;
					contact = c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || `Επαφή ${cid}`;
					phone = (c.phones || []).map((p) => p.number).filter(Boolean)[0] || '';
				} catch { contact = `Επαφή ${cid}`; }
			}
			items.push({ request: r, contact, phone, listings: matches[r.id] });
		}

		const totalNew = items.reduce((n, it) => n + it.listings.length, 0);
		console.log(`\nΖητήσεις με «Νέα» ακίνητα: ${items.length} · σύνολο ακινήτων: ${totalNew}`);
		for (const it of items)
			console.log(`  #${it.request.id} ${it.contact} → ${it.listings.map((l) => l.code).join(', ')}`);

		if (!totalNew) { console.log('\nΚαμία εκκρεμότητα — δεν στέλνεται email.'); return 0; }

		const html = buildEmail(items, totalNew, failed.length);
		const subject = `ΝΕΑ ΑΚΙΝΗΤΑ ΣΕ ΖΗΤΗΣΕΙΣ · ${totalNew} σε ${items.length} ${items.length === 1 ? 'ζήτηση' : 'ζητήσεις'}`;

		if (!SEND) {
			console.log('\n(dry run — πρόσθεσε --send για αποστολή)');
			console.log('subject:', subject);
			return 0;
		}
		const hook = VARS.MAKE_MATCHINGS_WEBHOOK;
		if (!hook) throw new Error('Λείπει το MAKE_MATCHINGS_WEBHOOK από το .dev.vars');
		const res = await fetch(hook, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				subject, html, total_new: totalNew, requests: items.length,
				task_body: buildTaskBody(items, totalNew),
				sent_at: new Date().toISOString(),
			}),
		});
		console.log(`\nMake webhook → ${res.status} ${(await res.text()).slice(0, 80)}`);
		return res.ok ? 0 : 1;
	} finally {
		await closeTab(tab);
	}
}

try {
	process.exitCode = await main();
} catch (e) {
	console.error('✗ ' + (e && e.message || e));
	process.exitCode = 1;
}
