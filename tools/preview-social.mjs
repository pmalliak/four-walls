// Isolated UI preview: in-memory SQLite, synthetic feed, no secrets or Meta.
// Node 24+; never reads .dev.vars or calls the CRM. Rendering needs Cloudflare.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { environment, property } from '../tests/social-fixtures.mjs';
import { handleSocial } from '../worker/lib/social.mjs';
const env = environment();
env.SAMPLE_DATA = '1';
env.feed.source = 'sample';
const previewPhotos = ['img_42.jpg', 'img_41.jpg', 'img_40.jpg'].map(name => `https://four-walls.gr/images/listing/${name}`);
const previewProperty = process.argv[3] ? JSON.parse(await readFile(process.argv[3], 'utf8')) : { ...property, images: previewPhotos };
env.feed.listings = [{ ...previewProperty, originalImages: previewProperty.images }];
delete env.IMAGES;
delete env.META_PAGE_ACCESS_TOKEN;
const files = new Map([
	['/forms/fourwalls-symbol.svg', ['../forms/fourwalls-symbol.svg', 'image/svg+xml']],
	['/forms/gordita-bold.woff2', ['../forms/gordita-bold.woff2', 'font/woff2']],
	['/forms/fourwalls-logo.svg', ['../forms/fourwalls-logo.svg', 'image/svg+xml']],
	['/forms/fourwalls-logo-light.svg', ['../forms/fourwalls-logo-light.svg', 'image/svg+xml']],
	['/forms/social', ['../forms/social.html', 'text/html; charset=utf-8']],
	['/forms/social.fw.js', ['../forms/social.fw.js', 'text/javascript; charset=utf-8']],
	['/forms/social.fw.css', ['../forms/social.fw.css', 'text/css; charset=utf-8']],
	['/forms/social-design.mjs', ['../forms/social-design.mjs', 'text/javascript; charset=utf-8']],
	['/forms/social-crop.mjs', ['../forms/social-crop.mjs', 'text/javascript; charset=utf-8']],
	['/forms/social-font-metrics.mjs', ['../forms/social-font-metrics.mjs', 'text/javascript; charset=utf-8']],
]);
env.ASSETS.fetch = async request => {
	const rawPath = new URL(request.url).pathname;
	const vendor = rawPath.match(/^\/(?:forms\/)?vendor\/bootstrap\/((?:bootstrap(?:\.bundle)?\.min\.(?:css|js))|(?:select-chevron|check)\.svg)$/);
	if (vendor) return new Response(await readFile(new URL('../forms/vendor/bootstrap/' + vendor[1], import.meta.url)), { headers: { 'Content-Type': vendor[1].endsWith('.css') ? 'text/css' : vendor[1].endsWith('.svg') ? 'image/svg+xml' : 'text/javascript' } });
	const pathname = /^\/(fourwalls-(?:symbol|logo(?:-light)?)\.svg|gordita-bold\.woff2)$/.test(rawPath) ? `/forms${rawPath}` : rawPath;
	const art = pathname.match(/^\/images\/social\/([A-Za-z0-9-]+\.(png|svg|ttf))$/);
	if (art) return new Response(await readFile(new URL(`../images/social/${art[1]}`, import.meta.url)), { headers: { 'Content-Type': { png: 'image/png', svg: 'image/svg+xml', ttf: 'font/ttf' }[art[2]] } });
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
		const response = /^\/(fourwalls-(?:symbol|logo(?:-light)?)\.svg|gordita-bold\.woff2)$/.test(url.pathname) || url.pathname.startsWith('/images/social/') || url.pathname.startsWith('/vendor/bootstrap/') ? await env.ASSETS.fetch(request) : await handleSocial(request, env, url);
		res.writeHead(response.status, Object.fromEntries(response.headers));
		res.end(Buffer.from(await response.arrayBuffer()));
	} catch { res.writeHead(500); res.end('Preview error'); }
}).listen(port, '127.0.0.1', () => console.log(`Social UI preview (simulated CRM, publication disabled): http://localhost:${port}/social`));
