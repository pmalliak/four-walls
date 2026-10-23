// Read-only: is the dedicated Edge (:9222) still logged in at Spitogatos and the CRM?
// Opens each site in a fresh tab, waits out the redirects / bot checks, reports where it
// landed and whether a login form shows, then closes the tabs. Never fills a form, so it is
// safe to run before every intake (step 2 of the cloud + PC split in SKILL.md).
// Exit 0 = both logged in, 1 = at least one needs a login.
// Usage: node login-status.mjs
import { Tab, waitFor, sleep } from './cdp.mjs';

const SITES = [
	{ name: 'spitogatos', url: 'https://live.spitogatos.gr/', expr: `(()=>{
		if (document.readyState !== 'complete') return '';
		if (location.host === 'live.spitogatos.gr' && !document.querySelector('input[name=fieldEmail]')) return 'in';
		if (document.querySelector('input[name=fieldEmail]')) return 'login';
		return '';
	})()` },
	{ name: 'crm', url: 'https://fourwalls.estateprime.gr/login', expr: `(()=>{
		if (document.readyState !== 'complete' || document.title.includes('Just a moment')) return '';
		if (!location.pathname.startsWith('/login')) return 'in';
		if (document.querySelector('input[type=password]')) return 'login';
		return '';
	})()` },
];

let ok = true;
for (const s of SITES) {
	const tab = await Tab.open(s.url);
	try {
		await sleep(3000);
		const state = await waitFor(tab, s.expr, { timeoutMs: 90000, everyMs: 1500, label: s.name }).catch(() => 'stuck');
		const href = await tab.eval('location.href').catch(() => '?');
		console.log(`${s.name}: ${state === 'in' ? 'LOGGED IN' : state === 'login' ? 'NEEDS LOGIN' : 'UNKNOWN (stuck on a check)'}  ${href}`);
		if (state !== 'in') ok = false;
	} finally {
		try { tab.close(); } catch {}
		try { await fetch(`http://127.0.0.1:9222/json/close/${tab.info.id}`); } catch {}
	}
}
process.exit(ok ? 0 : 1);
