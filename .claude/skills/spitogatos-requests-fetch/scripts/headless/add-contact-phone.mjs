// Προσθήκη τηλεφώνου σε υπάρχουσα επαφή (και προαιρετικά όρισέ το ως κύριο).
//
// Γιατί υπάρχει: όταν ένας πελάτης ξαναγράφει από ΝΕΟ κινητό, το prep τον βρίσκει
// πλέον από το email και ξαναχρησιμοποιεί την επαφή, αλλά η επαφή κρατά ακόμη τον
// παλιό αριθμό. Το prep βγάζει warning γι' αυτό· αυτό το script είναι η διόρθωση.
//
// Το public API ΔΕΝ ενημερώνει επαφή (PUT 403, PATCH ψεύτικο 200), οπότε γράφουμε
// μέσω `POST /contacts/view/{id}` με `edit_contact=phones` από το session του Edge.
// Το section στέλνεται ΟΛΟΚΛΗΡΟ: ό,τι λείπει διαγράφεται. Γι' αυτό διαβάζουμε πρώτα
// το modal (`show_edit=phones`) και σειριοποιούμε το δικό του HTML, προσθέτοντας τη
// νέα γραμμή με τα ονόματα που δίνει το template του UI (`new_phone[]` κ.λπ.).
//
// Σημείωση για όποιον το πειράξει: ο κώδικας που τρέχει ΜΕΣΑ στη σελίδα ζει σε ένα
// template literal, οπότε το node τρώει τα backslashes πριν φτάσουν στον browser.
// Γι' αυτό εδώ δεν υπάρχει ούτε ένα regex μέσα στο eval, μόνο string methods.
//
// Χρήση:
//   node add-contact-phone.mjs --id 148 --phone +306988030485 --star
//   node add-contact-phone.mjs --id 148 --phone +30... --type 2 --notes "από lead 511239" --dry
//     --type  1 Κινητό-Εργασία, 2 Κινητό-Προσωπικό (default), 3 Κινητό-Άλλο,
//             4 Σταθερό-Εργασία, 5 Σταθερό-Οικία, 6 Σταθερό-Άλλο
//     --star  κάνει το νέο τηλέφωνο το κύριο (αυτό που καλεί το CRM)
//     --dry   δείχνει τι θα σταλεί, χωρίς να γράψει
import { Tab } from './cdp.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DRY = argv.includes('--dry');
const STAR = argv.includes('--star');
const id = arg('--id', null);
const phone = arg('--phone', null);
const type = arg('--type', '2');
const notes = arg('--notes', '');
if (!id || !phone) {
	console.error('usage: node add-contact-phone.mjs --id 148 --phone +30... [--type 2] [--notes "..."] [--star] [--dry]');
	process.exit(1);
}
const digitsOf = (s) => [...String(s)].filter((c) => c >= '0' && c <= '9').join('');

const CRM = 'https://fourwalls.estateprime.gr';
const tab = await Tab.openActive(CRM + '/contacts/view/' + id);

const out = await tab.eval(`(async () => {
	const H = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' };
	const digits = (s) => [...String(s)].filter((c) => c >= '0' && c <= '9').join('');
	const shown = await (await fetch('/contacts/view/${id}', { method: 'POST', credentials: 'include', headers: H, body: 'show_edit=phones' })).json();
	if (!shown || !shown.success) return JSON.stringify({ error: 'show_edit=phones απέτυχε' });
	const doc = new DOMParser().parseFromString(shown.html || '', 'text/html');

	// Σειριοποίηση του modal ακριβώς όπως θα το έστελνε ο browser.
	const body = new URLSearchParams();
	const existing = [];
	for (const el of doc.querySelectorAll('input,select,textarea')) {
		if (!el.name) continue;
		if (el.tagName === 'SELECT') { for (const o of el.options) if (o.selected) body.append(el.name, o.value); }
		else if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) body.append(el.name, el.value); }
		else { body.append(el.name, el.value); if (el.name.startsWith('phone[')) existing.push(el.value); }
	}
	const want = digits(${JSON.stringify(phone)});
	if (existing.some((p) => digits(p) === want)) return JSON.stringify({ skipped: 'το τηλέφωνο υπάρχει ήδη', existing });

	// Νέα γραμμή, με τα ονόματα του #new-phone-row template.
	body.append('new_phone_type[]', ${JSON.stringify(String(type))});
	body.append('new_phone[]', ${JSON.stringify(phone)});
	body.append('new_phone_notes[]', ${JSON.stringify(notes)});
	if (${DRY}) return JSON.stringify({ existing, willSend: body.toString() });

	const saved = await (await fetch('/contacts/view/${id}', { method: 'POST', credentials: 'include', headers: H, body })).json().catch(() => null);
	let starred = null;
	if (${STAR} && saved && saved.success) {
		const sb = new URLSearchParams(); sb.set('star_phone', ${JSON.stringify(phone)});
		const sr = await (await fetch('/contacts/view/${id}', { method: 'POST', credentials: 'include', headers: H, body: sb })).json().catch(() => null);
		starred = sr && sr.success ? 'ok' : 'FAIL';
	}
	return JSON.stringify({ existing, added: ${JSON.stringify(phone)}, saved: saved && saved.success, starred });
})()`, { timeoutMs: 60000 });

console.log(out);

// Διάβασε πίσω: ένα ψεύτικο success δεν πρέπει να περάσει απαρατήρητο.
if (!DRY) {
	const check = await tab.eval(`(async () => {
		const page = await fetch('/contacts/view/${id}', { credentials: 'include' });
		const doc = new DOMParser().parseFromString(await page.text(), 'text/html');
		return JSON.stringify([...doc.querySelectorAll('.star-phone')].map((e) => ({
			value: e.getAttribute('data-value'),
			isDefault: e.className.split(' ').includes('fa-star'),
		})));
	})()`, { timeoutMs: 45000 });
	console.log('phones now:', check);
}

await tab.destroy();
process.exit(0);
