// Headless spitogatos login (guru → live) in the dedicated CDP Edge.
// - Uses REAL input (CDP mouse/keyboard): the guru form silently ignores synthetic fills.
// - Handles the email-2FA step by reading «Κωδικός επαλήθευσης» from Spark CLI.
// - No-op if the live session is still alive (remember-me was ticked).
// Usage: node sg-login.mjs
import { Tab, waitFor, sleep } from './cdp.mjs';
import { bwGet, ITEM_SPITOGATOS } from './bw.mjs';
import { spawnSync } from 'node:child_process';

const SPARK = 'C:\\Users\\panos\\AppData\\Local\\Programs\\SparkDesktop\\resources\\app.asar.unpacked\\node_modules\\@readdle\\sparkcore-win\\bin\\Release\\SparkCore.bundle\\spark.exe';
const sparkOut = (args) => {
	const r = spawnSync(SPARK, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
	return r.status === 0 ? r.stdout : '';
};

let tab = await Tab.find('https://live.spitogatos.gr') || await Tab.find('https://www.spitogatos.gr');
if (!tab) tab = await Tab.open('https://live.spitogatos.gr/');
else await tab.navigate('https://live.spitogatos.gr/').catch(() => {});
await sleep(4000); // redirects + Imperva token

// Session still alive? live host without a login form = done.
const first = await waitFor(tab, `(()=>{
	if (document.readyState !== 'complete') return '';
	if (location.host === 'live.spitogatos.gr') return 'live';
	if (document.querySelector('input[name=fieldEmail]')) return 'login';
	return '';
})()`, { timeoutMs: 60000, everyMs: 1500, label: 'landing' });
if (first === 'live') { console.log('session already alive'); tab.close(); process.exit(0); }

const loginStarted = Date.now();
await tab.typeSel('input[name=fieldEmail]', bwGet('username', ITEM_SPITOGATOS));
await tab.typeSel('input[name=fieldPassword]', bwGet('password', ITEM_SPITOGATOS));
const rm = await tab.eval(`(()=>{ const el=document.querySelector('input[name=fieldRememberMe]'); return el ? el.checked : null; })()`);
if (rm === false) await tab.clickSel('input[name=fieldRememberMe]');
await tab.eval(`(()=>{ const f=document.querySelector('input[name=fieldPassword]').closest('form');
	const b=[...f.querySelectorAll('button, input[type=submit]')].find(x=>/login|σύνδεση/i.test(x.innerText||x.value||''))
		|| f.querySelector('button[type=submit],input[type=submit],button');
	b.setAttribute('data-fw-login','1'); return true; })()`);
await tab.clickSel('[data-fw-login="1"]');
console.log('credentials submitted');
await sleep(6000);

const stateExpr = `(()=>{
	if (document.readyState !== 'complete') return '';
	if (location.host === 'live.spitogatos.gr') return 'live';
	if (document.querySelector('input[name=fv_mfaCodeReq]')) return 'mfa';
	const t = (document.body.innerText||'').slice(0,600);
	if (/λάθος|invalid|incorrect/i.test(t)) return 'error:' + t.match(/[^\\n]*(?:λάθος|invalid|incorrect)[^\\n]*/i)[0];
	return '';
})()`;
let st = await waitFor(tab, stateExpr, { timeoutMs: 45000, everyMs: 1500, label: 'post-submit' });
console.log('state:', st);

if (st === 'mfa') {
	// Poll Spark for the verification code (email lands at info@four-walls.gr within ~1min)
	let code = null, src = null;
	for (let i = 0; i < 30 && !code; i++) {
		const list = sparkOut(['emails', '--filter', 'from:notifications@spitogatos.gr newer_than:1d',
			'--page-size', '10', 'info@four-walls.gr']);
		for (const l of list.split('\n')) {
			if (!l.includes('Κωδικός επαλήθευσης')) continue;
			const id = l.match(/^\s*(\d+)/)?.[1];
			const dateStr = l.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/)?.[1];
			if (!id || !dateStr) continue;
			if (new Date(dateStr.replace(' ', 'T') + ':00').getTime() < loginStarted - 90e3) continue; // stale
			const body = sparkOut(['thread', id]);
			code = body.match(/^\s*\**\s*(\d{4,8})\s*\**\s*$/m)?.[1]
				|| body.match(/(?:κωδικ|code)[^\d]{0,80}(\d{4,8})/i)?.[1];
			if (code) { src = `${id} (${dateStr})`; break; }
		}
		if (!code) await sleep(5000);
	}
	if (!code) { console.log('NO 2FA CODE ARRIVED within ~2.5min'); process.exit(1); }
	console.log('2FA code from email', src);
	await tab.typeSel('input[name=fv_mfaCodeReq]', code);
	// tick any trust-device checkbox, then submit
	const boxes = await tab.eval(`(()=>{ const f=document.querySelector('input[name=fv_mfaCodeReq]').closest('form')||document;
		return [...f.querySelectorAll('input[type=checkbox]')].map((c,i)=>{ c.setAttribute('data-fw-cb', i); return {i, checked:c.checked}; }); })()`);
	for (const b of boxes) if (!b.checked) await tab.clickSel(`[data-fw-cb="${b.i}"]`);
	await tab.eval(`(()=>{ const f=document.querySelector('input[name=fv_mfaCodeReq]').closest('form')||document;
		const b=[...f.querySelectorAll('button, input[type=submit]')].find(x=>/submit|continue|συνέχεια|επιβεβαίωση|verify|login/i.test(x.innerText||x.value||''))
			|| f.querySelector('button[type=submit],input[type=submit],button');
		b.setAttribute('data-fw-go','1'); return true; })()`);
	await tab.clickSel('[data-fw-go="1"]');
	await sleep(6000);
	st = await waitFor(tab, stateExpr, { timeoutMs: 45000, everyMs: 1500, label: 'post-mfa' });
	console.log('state:', st);
}

if (st !== 'live') { console.log('NOT LOGGED IN'); process.exit(1); }
console.log('logged in:', await tab.eval('location.href'));
tab.close();
