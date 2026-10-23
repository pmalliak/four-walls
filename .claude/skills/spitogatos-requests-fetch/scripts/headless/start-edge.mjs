// Start the dedicated Edge on :9222 (own profile, NOT Panos's browser) if it is not up.
// The node twin of the Edge half of ensure-apps.ps1, for a PC session that may run node
// scripts but not PowerShell ones. Same exe, profile and flags, normal window on purpose
// (a minimized Edge throttles timers and hangs the eval steps). No-op when already up.
// Usage: node start-edge.mjs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE = join(process.env.LOCALAPPDATA || '', 'FourWalls', 'edge-claude-profile');
const up = () => fetch('http://127.0.0.1:9222/json/version').then((r) => r.ok).catch(() => false);

if (await up()) { console.log('Edge :9222: already listening (left as-is).'); process.exit(0); }
if (!existsSync(EXE)) { console.log('Edge: not found at ' + EXE); process.exit(1); }

console.log('Edge :9222: starting dedicated CDP profile...');
spawn(EXE, ['--remote-debugging-port=9222', `--user-data-dir=${PROFILE}`, '--no-first-run',
	'--no-default-browser-check', '--window-size=1280,900', 'about:blank'],
{ detached: true, stdio: 'ignore' }).unref();

for (let i = 0; i < 50; i++) {
	await new Promise((r) => setTimeout(r, 600));
	if (await up()) { console.log('  CDP up.'); process.exit(0); }
}
console.log('Edge :9222: did not come up within 30s. A stale msedge holding the profile is the usual cause: close it and re-run.');
process.exit(1);
