import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../forms/sw.js', import.meta.url), 'utf8');
function serviceWorker() {
	const events = {}, calls = { cache: 0, fetch: 0 };
	vm.runInNewContext(source, {
		URL, Request, Response, Headers,
		self: { registration: { scope: 'https://forms.four-walls.gr/' }, location: { origin: 'https://forms.four-walls.gr' }, addEventListener: (name, callback) => { events[name] = callback; } },
		caches: { async open() { calls.cache++; return { match: async () => new Response('old cached asset'), put: async () => {} }; } },
		fetch: async () => { calls.fetch++; return new Response('current asset'); },
	});
	return { events, calls };
}

test('social templates and private assets always bypass the offline forms cache on both mounts', () => {
	const { events, calls } = serviceWorker();
	for (const mount of ['', '/forms']) for (const asset of ['social', 'social.html', 'social.fw.js', 'social.fw.css', 'social-design.mjs', 'social-font-metrics.mjs', 'social-crop.mjs', 'social-assets/architectural-cover.png', 'social-assets/FourWallsWebsite-SemiBold.ttf', '%73ocial-crop.mjs', '%73ocial-assets/logo-social.png']) {
		let intercepted = false;
		events.fetch({ request: new Request(`https://forms.four-walls.gr${mount}/${asset}?revision=new`), respondWith() { intercepted = true; }, waitUntil() {} });
		assert.equal(intercepted, false, `${mount}/${asset}`);
	}
	assert.deepEqual(calls, { cache: 0, fetch: 0 });
});

test('ordinary forms assets retain their existing offline cache behavior', async () => {
	const { events, calls } = serviceWorker();
	let response;
	events.fetch({ request: new Request('https://forms.four-walls.gr/_crm.fw.js'), respondWith(value) { response = value; }, waitUntil() {} });
	assert.equal(await (await response).text(), 'old cached asset');
	assert.equal(calls.cache, 1);
	assert.equal(calls.fetch, 1);
});
