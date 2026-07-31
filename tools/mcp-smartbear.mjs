#!/usr/bin/env node
/* =====================================================================
   SmartBear / Bugsnag MCP server launcher
   ---------------------------------------------------------------------
   Registered in .mcp.json as the command for the `smartbear` MCP server.
   It exists so the Bugsnag auth token never lands in the MCP config file
   or the repo.

   Token lookup, first hit wins:
     1. BUGSNAG_AUTH_TOKEN in .dev.vars (manual override / offline).
     2. Bitwarden Secrets Manager: the secret named «Bugsnag Claude PC
        Token», read with `bws` using the BW_ACCESS_TOKEN from .dev.vars.
        Note the name mismatch: the CLI wants BWS_ACCESS_TOKEN.

   Then hands stdio over to `npx @smartbear/mcp`. Without a token the
   upstream server still starts, only with its Bugsnag tools disabled —
   a missing token degrades, it does not crash.

   Nothing is written to stdout: that channel is the MCP protocol.
   ===================================================================== */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SECRET_NAME = 'Bugsnag Claude PC Token';
const BWS_CANDIDATES = [
	join(process.env.LOCALAPPDATA || '', 'FourWalls', 'bws.exe'),
	'bws',
];

function devVars() {
	try {
		const text = readFileSync(join(REPO, '.dev.vars'), 'utf8');
		const out = {};
		for (const line of text.split(/\r?\n/)) {
			const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
			if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
		}
		return out;
	} catch {
		return {};
	}
}

function fromSecretsManager(accessToken) {
	if (!accessToken) return null;
	const bws = BWS_CANDIDATES.find((p) => p === 'bws' || existsSync(p));
	if (!bws) return null;
	const run = spawnSync(bws, ['secret', 'list', '--output', 'json'], {
		env: { ...process.env, BWS_ACCESS_TOKEN: accessToken },
		encoding: 'utf8',
	});
	if (run.status !== 0) return null;
	try {
		const hit = JSON.parse(run.stdout).find((s) => s.key === SECRET_NAME);
		return hit?.value || null;
	} catch {
		return null;
	}
}

const vars = devVars();
const token = vars.BUGSNAG_AUTH_TOKEN || fromSecretsManager(vars.BW_ACCESS_TOKEN);

const env = { ...process.env };
if (token) env.BUGSNAG_AUTH_TOKEN = token;
else console.error(`[mcp-smartbear] no token found (.dev.vars or «${SECRET_NAME}») — Bugsnag tools disabled`);
if (vars.BUGSNAG_PROJECT_API_KEY) env.BUGSNAG_PROJECT_API_KEY = vars.BUGSNAG_PROJECT_API_KEY;

/* npx sits next to the node binary running this script, so the launcher
   works even when node is missing from a fresh shell's PATH. */
const npx = join(dirname(process.execPath), 'npx.cmd');
const child = spawn(`"${npx}" -y @smartbear/mcp@latest`, { env, stdio: 'inherit', shell: true });

child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
child.on('error', (err) => {
	console.error('[mcp-smartbear] failed to start:', err.message);
	process.exit(1);
});
