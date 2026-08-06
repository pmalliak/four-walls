// Επαφές με ΞΕΝΟ τηλέφωνο: όνομα λατινικά + γλώσσα Αγγλικά (Πάνος, 2026-08-06).
// Ένας ενοικιαστής με γερμανικό ή ολλανδικό κινητό δεν διαβάζει ελληνικά, και το
// «Ελένη Μπαλτατζίδου» που έγραψε ο μεταγραφέας δεν είναι το όνομα που ξέρει.
//
// Το public API ΔΕΝ ενημερώνει επαφή (PUT 403, PATCH ψεύτικο 200), οπότε γράφουμε
// μέσω `POST /contacts/view/{id}` με `edit_contact=basics` από το session του Edge.
// Το section στέλνεται ΟΛΟΚΛΗΡΟ: ό,τι λείπει καθαρίζεται, δεν διατηρείται. Γι' αυτό
// διαβάζουμε πρώτα το modal (`show_edit=basics`) και σειριοποιούμε το δικό του HTML.
//
// Χρήση:
//   node fix-contact-locale.mjs --ids 276,255            # γλώσσα Αγγλικά
//   node fix-contact-locale.mjs --ids 276 --name "Eleni Mpaltatzides"
//   node fix-contact-locale.mjs --ids 276 --lang 1 --dry # δες τι θα σταλεί
import { Tab } from './cdp.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DRY = argv.includes('--dry');
const ids = (arg('--ids', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const lang = arg('--lang', '2');           // 1=Ελληνικά, 2=Αγγλικά
const name = arg('--name', null);          // "First Last" — μόνο για ΕΝΑ id
if (!ids.length) { console.error('usage: node fix-contact-locale.mjs --ids 276[,255] [--lang 2] [--name "First Last"] [--dry]'); process.exit(1); }
if (name && ids.length > 1) { console.error('--name ισχύει για ένα id τη φορά'); process.exit(1); }

const CRM = 'https://fourwalls.estateprime.gr';
const tab = await Tab.openActive(CRM + '/contacts');

for (const id of ids) {
	const out = await tab.eval(`(async () => {
		const H = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' };
		const shown = await (await fetch('/contacts/view/${id}', { method: 'POST', credentials: 'include', headers: H, body: 'show_edit=basics' })).json();
		if (!shown || !shown.success) return JSON.stringify({ id: ${id}, error: 'show_edit απέτυχε' });
		const doc = new DOMParser().parseFromString(shown.html || '', 'text/html');

		// Σειριοποίηση όπως θα έστελνε ο browser το ίδιο το modal.
		const body = new URLSearchParams();
		for (const el of doc.querySelectorAll('input,select,textarea')) {
			if (!el.name) continue;
			if (el.tagName === 'SELECT') {
				for (const o of el.options) if (o.selected) body.append(el.name, o.value);
			} else if (el.type === 'checkbox' || el.type === 'radio') {
				if (el.checked) body.append(el.name, el.value);
			} else body.append(el.name, el.value);
		}
		const before = { first: body.get('first_name'), last: body.get('last_name'), lang: body.get('language_id') };
		body.set('language_id', ${JSON.stringify(String(lang))});
		${name ? `body.set('first_name', ${JSON.stringify(name.split(' ')[0])}); body.set('last_name', ${JSON.stringify(name.split(' ').slice(1).join(' '))});` : ''}
		if (${DRY}) return JSON.stringify({ id: ${id}, before, willSend: body.toString() });

		const saved = await (await fetch('/contacts/view/${id}', { method: 'POST', credentials: 'include', headers: H, body })).json().catch(() => null);
		return JSON.stringify({ id: ${id}, before, after: { first: body.get('first_name'), last: body.get('last_name'), lang: body.get('language_id') }, saved });
	})()`, { timeoutMs: 60000 });
	console.log(out);
}

await tab.destroy();
process.exit(0);
