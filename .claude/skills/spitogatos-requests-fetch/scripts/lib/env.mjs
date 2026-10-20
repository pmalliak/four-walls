// Secrets for the intake scripts: the process environment first, `.dev.vars` second.
//
// The cloud session has ESTATEPRIME_* / ZOHO_* in its environment, so the /api half of the
// pipeline runs there with no file at all. `.dev.vars` (repo root, gitignored) is only the
// fallback for running everything on the PC by hand. The browser-only steps on the PC
// (sg-fetch-nav, crm-post, crm-request-matchings --sweep-only) need neither.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

function devVars() {
	const v = {};
	for (const p of ['.dev.vars', resolve(ROOT, '.dev.vars')]) {
		if (!existsSync(p)) continue;
		for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
			const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*?)"?\s*$/);
			if (m) v[m[1]] = m[2];
		}
		break;
	}
	return v;
}

const FILE = devVars();
export const env = (k) => process.env[k] || FILE[k] || '';

/** EstatePrime /api config, or null when no key is available on this machine. */
export function estateprime() {
	const key = env('ESTATEPRIME_API_KEY'), secret = env('ESTATEPRIME_API_SECRET');
	if (!key || !secret) return null;
	return {
		base: `https://${env('ESTATEPRIME_SUBDOMAIN') || 'fourwalls'}.estateprime.gr/api`,
		headers: {
			Authorization: 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64'),
			'Content-Type': 'application/json',
		},
	};
}

/** Same, but exit with a clear message when the key is missing. */
export function requireEstateprime() {
	const c = estateprime();
	if (!c) {
		console.error('MISSING ESTATEPRIME_API_KEY/SECRET (environment or .dev.vars). This step runs in the cloud session.');
		process.exit(1);
	}
	return c;
}
