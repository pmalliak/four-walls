import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.mjs';
import { environment, property, rawProperty, publicFixture } from './social-fixtures.mjs';
import { fingerprint, greekCaption, liveReady, validateDraft, publicProperty, socialTitle } from '../worker/lib/social-model.mjs';
import { handleSocial, getPost, reconcileSocial, verifyLiveProperty } from '../worker/lib/social.mjs';
import { runSocialPublisher } from '../worker/lib/social-publisher.mjs';
import { publishMeta } from '../worker/lib/social-meta.mjs';
import { signedMediaUrl, serveSocialMedia } from '../worker/lib/social-media.mjs';

const origin = 'http://localhost:8787';
async function call(env, path, method = 'GET', body, headers = {}) {
	const request = new Request(`${origin}/api/social${path}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
	return handleSocial(request, env, new URL(request.url));
}
async function create(env, channel = 'instagram') { return (await call(env, '/posts', 'POST', { property_id: '123', channel, template: 'square' })).json(); }
async function action(env, post, name, extra = {}) { return call(env, `/posts/${post.id}/${name}`, 'POST', { revision: post.revision, ...extra }); }
function mockPhotos(t) { t.mock.method(globalThis, 'fetch', async () => new Response('photo', { headers: { 'Content-Type': 'image/jpeg' } })); }
async function approved(t, env, channel) {
	mockPhotos(t);
	let post = await create(env, channel);
	post = await (await action(env, post, 'submit')).json();
	return (await action(env, post, 'approve')).json();
}

test('public projection excludes private fields, captions use Greek and EUR, invalid photos rejected', async () => {
	assert.equal(JSON.stringify(publicFixture).includes('PRIVATE'), false);
	assert.match(greekCaption(publicFixture), /€185\.000/);
	assert.match(greekCaption({ ...publicFixture, price: null }), /κατόπιν επικοινωνίας/);
	assert.equal(await fingerprint(property), await fingerprint(publicFixture));
	for (const photos of [[], ['https://evil.example/x'], [property.images[0], property.images[0]], ['http://127.0.0.1/photo']]) {
		assert.throws(() => validateDraft({ channel: 'instagram', template: 'square', caption: 'hello', photos }, publicFixture));
	}
});

test('missing CRM titles use public Greek labels and stable feed/direct CRM fingerprints', async t => {
	const env = environment();
	const untitled = { ...property, title: null, category: 'residential', subcategory: 'apartment' };
	const expected = 'Διαμέρισμα 85 τ.μ., Καλαμαριά';
	for (const title of [null, undefined, '', '  \n ']) {
		const raw = { ...untitled, title }, projected = publicProperty(raw);
		assert.equal(projected.title, expected);
		assert.deepEqual(publicProperty(projected), projected);
		assert.equal(await fingerprint(raw), await fingerprint(projected));
		assert.match(greekCaption(projected), /^Πωλείται · Διαμέρισμα 85 τ\.μ\., Καλαμαριά/);
		assert.equal(JSON.stringify(projected).includes('PRIVATE'), false);
	}
	assert.equal(socialTitle({ ...untitled, title: '  Τίτλος CRM  ' }), '  Τίτλος CRM  ');
	assert.equal(socialTitle({ subcategory: 'unknown', area: -1, location: {} }), 'Ακίνητο');
	assert.equal(socialTitle({ subcategory: 'office', area: 0, location: { city: 'Θεσσαλονίκη' } }), 'Γραφείο, Θεσσαλονίκη');
	assert.equal(socialTitle({ subcategory: 'store', area: 1200.5 }), 'Κατάστημα 1.200,5 τ.μ.');
	env.feed.listings = [untitled];
	const post = await create(env);
	assert.equal(post.snapshot.title, expected);
	assert.match(post.caption, /Διαμέρισμα 85/);
	let raw = { ...rawProperty, translations: [], category: 'residential', subcategory: 'apartment' };
	t.mock.method(globalThis, 'fetch', async () => Response.json({ data: raw }));
	await verifyLiveProperty(env, post);
	raw = { ...raw, subcategory: 'office' };
	await assert.rejects(() => verifyLiveProperty(env, post), /property_changed_reapprove/);
});
test('Worker guards HTML, script and API aliases on public hosts including encoded names', async () => {
	for (const host of ['four-walls.gr', 'dev.four-walls.gr', 'test.workers.dev', 'forms.evil.test']) {
		for (const path of ['/social', '/forms/social.html', '/forms/%73ocial.html', '/social.fw.js', '/api/social/posts']) {
			const res = await worker.fetch(new Request(`https://${host}${path}`), { CRM_DEV_BYPASS: '1' }, {});
			assert.equal(res.status, 404, `${host}${path}`);
		}
	}
	for (const path of ['/social', '/social.fw.css', '/api/social/posts']) {
		const res = await worker.fetch(new Request(`https://forms.four-walls.gr${path}`), { ACCESS_TEAM_DOMAIN: 'team', ACCESS_AUD: 'aud', CRM_DEV_BYPASS: '1' }, {});
		assert.equal(res.status, 401);
	}
});
test('mutations require same origin and JSON; no DB fails closed', async () => {
	const env = environment();
	assert.equal((await call(env, '/posts', 'POST', {}, { Origin: 'https://evil.test' })).status, 403);
	assert.equal((await call(env, '/posts', 'POST', {}, { 'Content-Type': 'text/plain' })).status, 415);
	assert.equal((await call({}, '/posts')).status, 503);
	assert.equal((await call(env, '/bootstrap')).headers.get('Cache-Control'), 'no-store');
	env.feed.generatedAt = '2020-01-01';
	assert.equal((await call(env, '/bootstrap')).status, 503);
});
test('social clean URL serves HTML without a canonical redirect loop', async () => {
	const env = environment();
	env.ASSETS.fetch = async request => {
		const path = new URL(request.url).pathname;
		if (path === '/forms/social.html') return new Response(null, { status: 307, headers: { Location: '/forms/social' } });
		if (path === '/forms/social') return new Response('<h1>Social</h1>', { headers: { 'Content-Type': 'text/html' } });
		return new Response('Not Found', { status: 404 });
	};
	for (const path of ['/social', '/forms/social']) {
		const response = await worker.fetch(new Request(`${origin}${path}`), env, {});
		assert.equal(response.status, 200);
		assert.equal(response.headers.get('Location'), null);
		assert.equal(await response.text(), '<h1>Social</h1>');
	}
	const redirect = await worker.fetch(new Request(`${origin}/social.html`), env, {});
	assert.equal(redirect.status, 307);
	assert.equal(redirect.headers.get('Location'), '/social');
	const response = await worker.fetch(new Request(new URL(redirect.headers.get('Location'), origin)), env, {});
	assert.equal(response.status, 200);
});
test('unpublished creations can be deleted with their history, including without a fresh feed', async () => {
	const env = environment();
	for (const status of ['draft', 'pending', 'approved', 'scheduled', 'blocked', 'cancelled']) {
		const post = await create(env);
		await env.SOCIAL_DB.prepare('UPDATE social_posts SET status=? WHERE id=?').bind(status, post.id).run();
		const feedTime = env.feed.generatedAt;
		env.feed.generatedAt = '2020-01-01';
		const response = await worker.fetch(new Request(`${origin}/api/social/posts/${post.id}`, { method: 'DELETE', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: post.revision }) }), env, {});
		assert.equal(response.status, 200, status);
		assert.deepEqual(await response.json(), { deleted: true });
		assert.equal(await getPost(env, post.id), null);
		assert.deepEqual((await env.SOCIAL_DB.prepare('SELECT * FROM social_events WHERE post_id=?').bind(post.id).all()).results, []);
		assert.equal((await call(env, `/posts/${post.id}`)).status, 404);
		env.feed.generatedAt = feedTime;
	}
	assert.deepEqual((await (await call(env, '/posts')).json()).posts, []);
});

test('deletion rejects published, publishing, uncertain, stale and cross-origin requests', async () => {
	const env = environment();
	const post = await create(env);
	for (const status of ['published', 'publishing', 'needs_review']) {
		await env.SOCIAL_DB.prepare('UPDATE social_posts SET status=? WHERE id=?').bind(status, post.id).run();
		assert.equal((await call(env, `/posts/${post.id}`, 'DELETE', { revision: post.revision })).status, 409);
	}
	await env.SOCIAL_DB.prepare("UPDATE social_posts SET status='draft', remote_id='123' WHERE id=?").bind(post.id).run();
	assert.equal((await call(env, `/posts/${post.id}`, 'DELETE', { revision: post.revision })).status, 409);
	await env.SOCIAL_DB.prepare('UPDATE social_posts SET remote_id=NULL WHERE id=?').bind(post.id).run();
	assert.equal((await call(env, `/posts/${post.id}`, 'DELETE', { revision: 0 })).status, 409);
	assert.equal((await call(env, `/posts/${post.id}`, 'DELETE', { revision: post.revision }, { Origin: 'https://evil.test' })).status, 403);
	assert.equal((await call(env, `/posts/${post.id}`, 'DELETE', { revision: post.revision }, { 'Content-Type': 'text/plain' })).status, 415);
	assert.ok(await getPost(env, post.id));
	assert.equal((await (await call(env, `/posts/${post.id}/history`)).json()).length, 1);
});

test('a scheduler claim racing deletion preserves the creation and history', async () => {
	const env = environment();
	const post = await create(env);
	await env.SOCIAL_DB.prepare("UPDATE social_posts SET status='scheduled' WHERE id=?").bind(post.id).run();
	const batch = env.SOCIAL_DB.batch.bind(env.SOCIAL_DB);
	env.SOCIAL_DB.batch = async statements => {
		await env.SOCIAL_DB.prepare("UPDATE social_posts SET status='publishing', revision=revision+1 WHERE id=?").bind(post.id).run();
		return batch(statements);
	};
	assert.equal((await call(env, `/posts/${post.id}`, 'DELETE', { revision: post.revision })).status, 409);
	assert.equal((await getPost(env, post.id)).status, 'publishing');
	assert.equal((await (await call(env, `/posts/${post.id}/history`)).json()).length, 1);
});

test('draft editing, rendering, role approval, stale revision, and approval invalidation', async t => {
	const env = environment(); mockPhotos(t);
	let post = await create(env);
	assert.equal(post.status, 'draft'); assert.equal(JSON.stringify(post).includes('PRIVATE'), false);
	assert.equal((await action(env, post, 'approve')).status, 409);
	post = await (await action(env, post, 'submit')).json(); assert.equal(post.assets.length, 1);
	env.SOCIAL_APPROVERS = '';
	assert.equal((await action(env, post, 'approve')).status, 403);
	env.SOCIAL_APPROVERS = 'local-developer';
	const stale = post;
	post = await (await action(env, post, 'approve')).json(); assert.equal(post.status, 'approved');
	assert.equal((await action(env, stale, 'cancel')).status, 409);
	const edited = await call(env, `/posts/${post.id}`, 'PATCH', { revision: post.revision, channel: post.channel, template: 'portrait', caption: 'Νέα λεζάντα', photos: [property.images[1]] });
	post = await edited.json(); assert.equal(post.status, 'draft'); assert.equal(post.approved_by, null); assert.deepEqual(post.assets, []);
	const history = await (await call(env, `/posts/${post.id}/history`)).json();
	assert.deepEqual(history.map(e => e.kind), ['edited', 'approved', 'submitted', 'draft']);
});

test('image submission uses Workers-supported fetch options and rejects redirects', async t => {
	const env = environment();
	let status = 302, fetches = 0;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		fetches++;
		// Unlike Node's fetch, Workers rejects this mode before sending a request.
		if (options.redirect === 'error') throw new TypeError('Invalid redirect value');
		assert.equal(options.redirect, 'manual');
		return new Response('photo', { status, headers: { 'Content-Type': 'image/jpeg', Location: 'https://elsewhere.example/photo' } });
	});
	let post = await create(env);
	const rejected = await action(env, post, 'submit');
	assert.equal(rejected.status, 502);
	assert.equal((await rejected.json()).error, 'photo_fetch_failed');
	assert.equal(fetches, 1);
	assert.equal((await getPost(env, post.id)).status, 'draft');
	status = 200;
	post = await (await action(env, post, 'submit')).json();
	assert.equal(post.status, 'pending');
	assert.equal(post.assets.length, 1);
});
test('two concurrent changes have one winner and one audit event', async () => {
	const env = environment(), post = await create(env);
	const results = await Promise.all([action(env, post, 'cancel'), action(env, post, 'cancel')]);
	assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
	assert.equal((await (await call(env, `/posts/${post.id}/history`)).json()).length, 2);
});
test('feed removals invalidate approvals and never auto-reactivate them', async t => {
	const env = environment(), post = await approved(t, env);
	await reconcileSocial(env, { ...env.feed, listings: [] });
	assert.equal((await getPost(env, post.id)).status, 'blocked');
	await reconcileSocial(env, env.feed);
	assert.equal((await getPost(env, post.id)).status, 'blocked');
});
test('direct CRM verification rejects inactive, unknown, mismatched and changed properties', async t => {
	const env = environment(), post = await getPost(env, (await create(env)).id);
	let raw = rawProperty;
	t.mock.method(globalThis, 'fetch', async () => Response.json({ data: raw }));
	await verifyLiveProperty(env, post);
	for (const changed of [{ ...rawProperty, status: 'inactive' }, { ...rawProperty, status: undefined }, { ...rawProperty, id: 999 }, { ...rawProperty, price: 1 }, []]) {
		raw = changed; await assert.rejects(() => verifyLiveProperty(env, post));
	}
});
test('live gate is off by default and cannot publish in sample/dev mode', () => {
	const env = environment(); assert.equal(liveReady(env), false);
	env.SOCIAL_LIVE_PUBLISH = '1'; assert.equal(liveReady(env), true);
	for (const change of [{ SAMPLE_DATA: '1' }, { CRM_DEV_BYPASS: '1' }, { META_PAGE_ACCESS_TOKEN: '' }, { SOCIAL_META_PERMISSIONS_CONFIRMED: '0' }]) assert.equal(liveReady({ ...env, ...change }), false);
});
test('scheduler disabled makes zero Meta calls; concurrent ticks publish once', async t => {
	const env = environment(); let post = await approved(t, env, 'facebook');
	post = await (await action(env, post, 'schedule', { at: new Date().toISOString() })).json();
	let publications = 0;
	t.mock.method(globalThis, 'fetch', async (url) => {
		if (String(url).includes('estateprime')) return Response.json({ data: rawProperty });
		if (String(url).endsWith('/feed')) publications++;
		return Response.json({ id: '12345' });
	});
	await runSocialPublisher(env); assert.equal(publications, 0);
	env.SOCIAL_LIVE_PUBLISH = '1';
	await Promise.all([runSocialPublisher(env), runSocialPublisher(env)]);
	assert.equal(publications, 1); assert.equal((await getPost(env, post.id)).status, 'published');
	await runSocialPublisher(env); assert.equal(publications, 1);
});
test('ambiguous Meta failure is held and never retried', async t => {
	const env = environment(); let post = await approved(t, env, 'facebook');
	post = await (await action(env, post, 'schedule', { at: new Date().toISOString() })).json();
	env.SOCIAL_LIVE_PUBLISH = '1'; let calls = 0;
	t.mock.method(globalThis, 'fetch', async url => {
		if (String(url).includes('estateprime')) return Response.json({ data: rawProperty });
		calls++; throw new Error('SECRET-META-TOKEN timeout');
	});
	await runSocialPublisher(env); await runSocialPublisher(env);
	assert.equal(calls, 1); const held = await getPost(env, post.id);
	assert.equal(held.status, 'needs_review'); assert.equal(JSON.stringify(held).includes('SECRET'), false);
	assert.equal((await action(env, held, 'cancel')).status, 409);
});
test('Instagram carousel uses child containers, readiness and final availability check', async t => {
	const env = environment(); env.SOCIAL_LIVE_PUBLISH = '1'; const calls = []; let sequence = 100, verified = false;
	t.mock.method(globalThis, 'fetch', async (url, opts) => {
		assert.equal(String(url).includes(env.META_PAGE_ACCESS_TOKEN), false);
		calls.push({ path: new URL(url).pathname, body: opts.body?.toString() });
		if (opts.method === 'GET') return Response.json({ status_code: 'FINISHED' });
		if (String(url).endsWith('/media_publish')) assert.equal(verified, true);
		return Response.json({ id: String(++sequence) });
	});
	await publishMeta(env, { channel: 'instagram', caption: 'Καλημέρα' }, property.images, async () => { verified = true; }, async () => {});
	assert.equal(calls.filter(c => c.body?.includes('is_carousel_item=true')).length, 2);
	assert.equal(calls.filter(c => c.body?.includes('media_type=CAROUSEL')).length, 1);
	assert.equal(calls.at(-1).path, '/v25.0/88/media_publish');
});
test('signed media rejects tampering and serves only a scoped JPEG', async () => {
	const env = environment(), key = `social/${crypto.randomUUID()}/${crypto.randomUUID()}/0.jpg`;
	await env.PHOTO_BUCKET.put(key, new Uint8Array([1,2,3]).buffer);
	const url = new URL(await signedMediaUrl(env, key));
	assert.equal((await serveSocialMedia(new Request(url), env, url)).status, 200);
	url.pathname = url.pathname.replace('0.jpg', '1.jpg');
	assert.equal((await serveSocialMedia(new Request(url), env, url)).status, 403);
});
test('Marketplace package contains text and selected images and never contacts Meta', async t => {
	const env = environment(), post = await approved(t, env, 'marketplace');
	t.mock.method(globalThis, 'fetch', async url => { assert.match(String(url), /estateprime/); return Response.json({ data: rawProperty }); });
	const response = await action(env, post, 'package');
	assert.equal(response.headers.get('Content-Type'), 'application/zip');
	const bytes = new Uint8Array(await response.arrayBuffer()), text = new TextDecoder().decode(bytes);
	assert.equal(new DataView(bytes.buffer).getUint32(0, true), 0x04034b50);
	assert.match(text, /listing.txt/); assert.match(text, /photo-01.jpg/); assert.match(text, /χειροκίνητα/);
	assert.equal((await getPost(env, post.id)).status, 'approved');
});

test('unavailable scheduled property is blocked before any Meta request', async t => {
	const env = environment(); let post = await approved(t, env, 'facebook');
	post = await (await action(env, post, 'schedule', { at: new Date().toISOString() })).json();
	env.SOCIAL_LIVE_PUBLISH = '1';
	t.mock.method(globalThis, 'fetch', async url => { assert.match(String(url), /estateprime/); return Response.json({ data: { ...rawProperty, status: 'inactive' } }); });
	await runSocialPublisher(env);
	assert.equal((await getPost(env, post.id)).status, 'blocked');
});
test('availability is checked again after Facebook uploads and before feed publication', async t => {
	const env = environment(); env.SOCIAL_LIVE_PUBLISH = '1'; let posted = false;
	t.mock.method(globalThis, 'fetch', async (url, opts) => {
		if (String(url).endsWith('/feed')) posted = true;
		assert.equal(opts.body.get('published'), 'false');
		return Response.json({ id: '123' });
	});
	await assert.rejects(() => publishMeta(env, { channel: 'facebook', caption: 'Hello' }, property.images, async () => { throw new Error('inactive'); }, async () => {}));
	assert.equal(posted, false);
});
test('stuck publication is held, reviewers resolve it without automatic retry', async t => {
	const env = environment(), post = await approved(t, env);
	await env.SOCIAL_DB.prepare("UPDATE social_posts SET status='publishing', updated_at='2020-01-01' WHERE id=?").bind(post.id).run();
	await runSocialPublisher(env);
	const held = await getPost(env, post.id); assert.equal(held.status, 'needs_review');
	assert.equal((await action(env, held, 'resolve', { outcome: 'published' })).status, 400);
	const resolved = await (await action(env, held, 'resolve', { outcome: 'published', remote_id: '123_456' })).json();
	assert.equal(resolved.status, 'published'); assert.equal(resolved.remote_id, '123_456');
});
test('invalid schedule is rejected and Marketplace cannot enter automated queue', async t => {
	const env = environment(); const post = await approved(t, env);
	assert.equal((await action(env, post, 'schedule', { at: '2020-01-01T00:00:00Z' })).status, 400);
	assert.equal((await action(env, post, 'schedule', { at: '2026-11-01T12:00' })).status, 400);
	const manual = await approved(t, env, 'marketplace');
	assert.equal((await action(env, manual, 'schedule', { at: new Date().toISOString() })).status, 409);
});
