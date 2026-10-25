// Read-only Zoho Mail access to info@four-walls.gr (ZOHO_* in the environment).
//
// Replaces the Spark CLI as the mail source: it works from the cloud session, where Spark
// does not exist, and needs no desktop app on the PC. The token is read-only
// (accounts/folders/messages READ). Every refresh makes Zoho send a «New login activity»
// mail, so refresh once per run and pass the token around.
//
// Spitogatos mail moves between folders without warning (Inbox → Inbox/Spitogatos in
// July, → Archive by October), so always SEARCH the whole account, never list a folder.
import { env } from './env.mjs';

const API = 'https://mail.zoho.com/api';

export async function zohoSession() {
	const host = env('ZOHO_ACCOUNTS_HOST') || 'accounts.zoho.com';
	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		client_id: env('ZOHO_CLIENT_ID'),
		client_secret: env('ZOHO_CLIENT_SECRET'),
		refresh_token: env('ZOHO_REFRESH_TOKEN'),
	});
	if (!body.get('refresh_token')) throw new Error('MISSING ZOHO_* in the environment');
	const tok = await (await fetch(`https://${host.replace(/^https?:\/\//, '')}/oauth/v2/token`, { method: 'POST', body })).json();
	if (!tok.access_token) throw new Error('Zoho token refresh failed: ' + JSON.stringify(tok));
	const headers = { Authorization: 'Zoho-oauthtoken ' + tok.access_token };
	const get = async (p) => {
		const r = await fetch(API + p, { headers });
		if (!r.ok) throw new Error(`Zoho ${p} → ${r.status}`);
		return r.json();
	};
	const accounts = (await get('/accounts')).data || [];
	const acct = accounts.find((a) => /^info@/i.test(a.primaryEmailAddress)) || accounts[0];
	if (!acct) throw new Error('Zoho: no mail account on this token');
	return { get, accountId: acct.accountId, address: acct.primaryEmailAddress };
}

/** Every message matching `searchKey` received at or after `sinceMs`, newest first. */
export async function zohoSearch(z, searchKey, sinceMs = 0) {
	const out = [];
	for (let start = 1; start < 5000; start += 100) {
		const q = new URLSearchParams({ searchKey, limit: '100', start: String(start) });
		const page = (await z.get(`/accounts/${z.accountId}/messages/search?${q}`)).data || [];
		for (const m of page) if (Number(m.receivedTime) >= sinceMs) out.push(m);
		if (page.length < 100 || Number(page.at(-1).receivedTime) < sinceMs) break;
	}
	return out;
}

export async function zohoHtml(z, m) {
	return (await z.get(`/accounts/${z.accountId}/folders/${m.folderId}/messages/${m.messageId}/content`)).data?.content || '';
}

/** HTML mail → plain text with one block/cell per line, close to what `spark thread` printed. */
export function htmlToText(html) {
	return String(html)
		.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|tr|li|h[1-6]|table)>/gi, '\n')
		.replace(/<\/t[dh]>/gi, ' ')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
		.replace(/[ \t]+/g, ' ')
		.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
}

/** Athens wall-clock «YYYY-MM-DD HH:MM», the format Spark printed (leadIds depend on it). */
export function athens(ms) {
	const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Europe/Athens', year: 'numeric', month: '2-digit', day: '2-digit',
		hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
	}).formatToParts(new Date(Number(ms))).map((x) => [x.type, x.value]));
	return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** «yyyy/MM/dd» (the skill's window argument) → epoch ms at Athens midnight. */
export function sinceArg(s) {
	const [y, mo, d] = String(s).split(/[/-]/).map(Number);
	const utc = Date.UTC(y, mo - 1, d);
	const offset = Date.parse(athens(utc).replace(' ', 'T') + 'Z') - utc; // +2h or +3h
	return utc - offset;
}
