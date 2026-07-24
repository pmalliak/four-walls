// Fetch a single credential field from Bitwarden CLI. The session token comes from
// BW_SESSION in .dev.vars (repo root = cwd); Panos refreshes it with `bw unlock --raw`.
// Values are returned to the caller only — never log them.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BW = 'C:\\Users\\panos\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Bitwarden.CLI_Microsoft.Winget.Source_8wekyb3d8bbwe\\bw.exe';

// Vault items (ids are stable across renames):
export const ITEM_SPITOGATOS = '70daa139-bd63-47b9-b300-b49100853cfd'; // www.spitogatos.gr / info@four-walls.gr
export const ITEM_ESTATEPRIME = '439a6c0c-4f73-4994-a972-b49100853cfd'; // fourwalls.estateprime.gr / panos@four-walls.gr

function session() {
	const m = readFileSync('.dev.vars', 'utf8').match(/^BW_SESSION="?([^"\r\n]+)"?/m);
	if (!m) throw new Error('BW_SESSION missing from .dev.vars — run `bw unlock --raw` and add it');
	return m[1].trim();
}

export function bwGet(field, itemId) {
	const r = spawnSync(BW, ['get', field, itemId, '--session', session()], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`bw get ${field} failed (locked vault? stale BW_SESSION?): ${r.stderr}`);
	return r.stdout.trim();
}
