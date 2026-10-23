// Cloud helper for a manual Spitogatos login on the PC: prints the newest «Κωδικός
// επαλήθευσης» from info@ via Zoho. Polls for up to ~2.5 min when the newest code is older
// than --since-min minutes (default 3), so it can be started right after «Σύνδεση».
// Usage: node zoho-2fa.mjs [--since-min 3]
import { zohoSession, zohoSearch, zohoHtml, htmlToText, athens } from './lib/zoho.mjs';

const i = process.argv.indexOf('--since-min');
const sinceMs = Date.now() - 60e3 * Number(i > 0 ? process.argv[i + 1] : 3);
const z = await zohoSession();

for (let tries = 0; tries < 30; tries++) {
	const hits = (await zohoSearch(z, 'sender:notifications@spitogatos.gr', sinceMs))
		.filter((m) => String(m.subject || '').includes('Κωδικός επαλήθευσης'));
	if (hits.length) {
		const text = htmlToText(await zohoHtml(z, hits[0]));
		const code = text.match(/^\s*\**\s*(\d{4,8})\s*\**\s*$/m)?.[1] || text.match(/(?:κωδικ|code)[^\d]{0,80}(\d{4,8})/i)?.[1];
		if (code) { console.log(`${code}  (${athens(hits[0].receivedTime)})`); process.exit(0); }
	}
	await new Promise((r) => setTimeout(r, 5000));
}
console.log('NO 2FA CODE ARRIVED');
process.exit(1);
