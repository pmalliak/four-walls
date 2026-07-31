#!/usr/bin/env node
/* =====================================================================
   SmartBear / Bugsnag MCP server launcher
   ---------------------------------------------------------------------
   Registered in Claude Code as the command for the `smartbear` MCP
   server. It exists so the Bugsnag auth token stays in `.dev.vars`
   (gitignored, next to BW_SESSION and MAKE_API_TOKEN) instead of being
   pasted into the MCP config file.

   Reads BUGSNAG_AUTH_TOKEN (and optional BUGSNAG_PROJECT_API_KEY) from
   .dev.vars, then hands stdio over to `npx @smartbear/mcp`. Without the
   token the upstream server still starts, only with its Bugsnag tools
   disabled — so a missing token degrades, it does not crash.

   Nothing is printed to stdout: that channel is the MCP protocol.
   ===================================================================== */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const PASS = ['BUGSNAG_AUTH_TOKEN', 'BUGSNAG_PROJECT_API_KEY'];

function fromDevVars() {
	let text;
	try {
		text = readFileSync(join(REPO, '.dev.vars'), 'utf8');
	} catch {
		return {};
	}
	const out = {};
	for (const line of text.split(/\r?\n/)) {
		const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!m) continue;
		const [, key, rawValue] = m;
		if (!PASS.includes(key)) continue;
		out[key] = rawValue.trim().replace(/^["']|["']$/g, '');
	}
	return out;
}

const env = { ...process.env, ...fromDevVars() };
if (!env.BUGSNAG_AUTH_TOKEN) {
	console.error('[mcp-smartbear] no BUGSNAG_AUTH_TOKEN in .dev.vars — Bugsnag tools will be disabled');
}

/* npx lives next to the node binary running this script, so the launcher
   works even when node is missing from a fresh shell's PATH. */
const npx = join(dirname(process.execPath), 'npx.cmd');
const child = spawn(`"${npx}" -y @smartbear/mcp@latest`, {
	env,
	stdio: 'inherit',
	shell: true,
});

child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
child.on('error', (err) => {
	console.error('[mcp-smartbear] failed to start:', err.message);
	process.exit(1);
});
