// Headless EstatePrime CRM login in the dedicated CDP Edge. Cloudflare's interstitial
// clears itself in a real browser; the form accepts synthetic fills. No-op if the
// session is still alive (remember_me is ticked on login).
// Usage: node crm-login.mjs
import { Tab, waitFor, sleep } from './cdp.mjs';
import { bwGet, ITEM_ESTATEPRIME } from './bw.mjs';

const ORIGIN = 'https://fourwalls.estateprime.gr';

let tab = await Tab.find(ORIGIN);
if (!tab) tab = await Tab.open(ORIGIN + '/login');
else await tab.navigate(ORIGIN + '/login').catch(() => {});

// /login redirects home when a session exists; otherwise wait out Cloudflare → form.
const state = await waitFor(tab, `(()=>{
	if (document.title.includes('Just a moment')) return '';
	if (!location.pathname.startsWith('/login')) return 'in';
	if (document.querySelector('input[type=password]')) return 'form';
	return '';
})()`, { timeoutMs: 90000, everyMs: 1500, label: 'login form or session' });

if (state === 'form') {
	const fill = `(()=>{
		const pw = document.querySelector('input[type=password]');
		const form = pw.closest('form');
		const set = (el, v) => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
			el.dispatchEvent(new Event('input', {bubbles:true}));
			el.dispatchEvent(new Event('change', {bubbles:true}));
		};
		set(form.querySelector('input[name=email]'), ${JSON.stringify(bwGet('username', ITEM_ESTATEPRIME))});
		set(pw, ${JSON.stringify(bwGet('password', ITEM_ESTATEPRIME))});
		const remember = form.querySelector('input[name=remember_me]');
		if (remember && !remember.checked) remember.click();
		form.querySelector('button[type=submit],button').click();
		return 'submitted';
	})()`;
	console.log('fill:', await tab.eval(fill));
	await sleep(4000);
	const after = await waitFor(tab, `(()=>{
		if (document.title.includes('Just a moment')) return '';
		return location.pathname.startsWith('/login') ? '' : 'in';
	})()`, { timeoutMs: 30000, label: 'post-login' }).catch(() => 'STUCK ON /login (wrong creds?)');
	console.log('after login:', after);
}

const probe = await tab.eval(
	`fetch('/dashboard',{credentials:'include',redirect:'manual'}).then(r=>r.status).catch(()=>'ERR')`);
console.log('dashboard probe status:', probe); // 200 = logged in
tab.close();
process.exit(probe === 200 ? 0 : 1);
