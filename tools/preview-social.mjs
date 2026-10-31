// Isolated UI preview: in-memory SQLite, synthetic feed, no secrets or Meta.
// Node 24+; never reads .dev.vars or calls the CRM. Rendering needs Cloudflare.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { environment, property } from '../tests/social-fixtures.mjs';
import { handleSocial } from '../worker/lib/social.mjs';
const env = environment();
env.SAMPLE_DATA = '1';
env.feed.source = 'sample';
env.feed.listings = [{ ...property, images: ['https://four-walls.gr/images/listing/img_42.jpg'] }];
delete env.IMAGES;
delete env.META_PAGE_ACCESS_TOKEN;
const files = new Map([
	['/forms/social', ['../forms/social.html', 'text/html; charset=utf-8']],
	['/forms/social.fw.js', ['../forms/social.fw.js', 'text/javascript; charset=utf-8']],
	['/forms/social.fw.css', ['../forms/social.fw.css', 'text/css; charset=utf-8']],
]);
env.ASSETS.fetch = async request => {
	const pathname = new URL(request.url).pathname;
	if (pathname === '/forms/social.html') return new Response(null, { status: 307, headers: { Location: '/forms/social' } });
	const file = files.get(pathname);
	return file ? new Response(await readFile(new URL(file[0], import.meta.url)), { headers: { 'Content-Type': file[1] } }) : new Response('Not Found', { status: 404 });
};
const port = Number(process.argv[2] || 5174);
createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://${req.headers.host}`);
		if (!['localhost', '127.0.0.1'].includes(url.hostname)) { res.writeHead(403); res.end(); return; }
		if (url.pathname === '/') { res.writeHead(302, { Location: '/social' }); res.end(); return; }
		const chunks = []; for await (const chunk of req) chunks.push(chunk);
		const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
		env.feed.generatedAt = new Date().toISOString();
		const response = await handleSocial(request, env, url);
		res.writeHead(response.status, Object.fromEntries(response.headers));
		res.end(Buffer.from(await response.arrayBuffer()));
	} catch { res.writeHead(500); res.end('Preview error'); }
}).listen(port, '127.0.0.1', () => console.log(`Social UI preview (simulated CRM, publication disabled): http://localhost:${port}/social`));
