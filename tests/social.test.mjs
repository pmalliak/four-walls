import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.mjs';
import { environment, property, rawProperty, publicFixture } from './social-fixtures.mjs';
import { fingerprint, greekCaption, liveReady, validateDraft, publicProperty, socialTitle } from '../worker/lib/social-model.mjs';
import { handleSocial, getPost, reconcileSocial, verifyLiveProperty } from '../worker/lib/social.mjs';
import { runSocialPublisher } from '../worker/lib/social-publisher.mjs';
import { publishMeta } from '../worker/lib/social-meta.mjs';
import { testMeta } from '../worker/lib/social-meta-test.mjs';
import { signedMediaUrl, serveSocialMedia } from '../worker/lib/social-media.mjs';
import { mapListing } from '../worker/lib/estateprime.mjs';

const origin = 'http://localhost:8787';
test('draft connection test does not bypass public clean-photo review or approve the creation', async t => {
	const env = environment(); t.after(() => env.SOCIAL_DB.close());
	const post = await (await call(env, '/posts', 'POST', { property_id: '123', channel: 'facebook', template: 'square', creative: { preset: 'classic', version: 1, includeFacts: false, includeCta: false } })).json();
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		if (String(url).includes('/listings/')) return Response.json({ data: rawProperty });
		if (!String(url).includes('graph.facebook.com')) return new Response('photo', { headers: { 'Content-Type': 'image/jpeg' } });
		return Response.json(options.method === 'GET' ? { is_published: false } : { id: '999' });
	});
	const response = await action(env, post, 'test');
	assert.equal(response.status, 200);
	const current = await response.json();
	assert.equal(current.status, 'draft');
	assert.equal(current.photos_confirmed_clean, false);
	assert.equal(current.approved_by, null);
	assert.equal(current.remote_id, null);
	assert.deepEqual(current.assets, []);
	assert.equal((await action(env, current, 'schedule')).status, 409);
	assert.equal((await action(env, current, 'submit')).status, 409);
	assert.equal((await action(env, current, 'test')).status, 409);
});
test('unpublished tests use real Meta preparation endpoints without publishing, for one image and carousels', async t => {
	const env = environment(); t.after(() => env.SOCIAL_DB.close());
	for (const channel of ['instagram', 'facebook']) for (const count of [1, 3]) {
		const calls = []; let id = 100;
		t.mock.method(globalThis, 'fetch', async (url, options) => {
			const fields = Object.fromEntries(options.body || []);
			calls.push({ url: String(url), method: options.method, fields });
			assert.equal(options.headers.Authorization, 'Bearer SECRET-META-TOKEN');
			assert.ok(!String(url).includes('media_publish'));
			if (channel === 'facebook' && options.method === 'POST') assert.equal(fields.published, 'false');
			assert.equal(fields.scheduled_publish_time, undefined);
			return Response.json(options.method === 'GET' ? { status_code: 'FINISHED', is_published: false } : { id: String(++id) });
		});
		const result = await testMeta(env, { channel, caption: 'Test' }, Array(count).fill('https://four-walls.gr/image.jpg'), async () => {});
		assert.equal(result.result, channel === 'instagram' ? 'instagram_container_ready' : 'facebook_draft_verified');
		if (channel === 'facebook') assert.equal(calls.find(c => c.url.endsWith('/feed')).fields.unpublished_content_type, 'DRAFT');
		assert.equal(liveReady(env), false);
	}
});

test('Meta test endpoint requires reviewer, records IDs, and never retries an approved revision', async t => {
	const env = environment(); t.after(() => env.SOCIAL_DB.close());
	const post = await approved(t, env, 'instagram');
	env.SOCIAL_APPROVERS = 'someone-else';
	assert.equal((await action(env, post, 'test')).status, 403);
	env.SOCIAL_APPROVERS = 'local-developer';
	let mutations = 0;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		if (String(url).includes('/listings/')) return Response.json({ data: rawProperty });
		if (options.method === 'POST') { mutations++; return Response.json({ id: '555' }); }
		return Response.json({ status_code: 'FINISHED' });
	});
	const response = await action(env, post, 'test');
	assert.equal(response.status, 200);
	const updated = await response.json();
	assert.equal(updated.status, 'approved');
	assert.equal(updated.remote_id, null);
	assert.equal(updated.scheduled_at, null);
	assert.equal((await action(env, post, 'test')).status, 409);
	assert.equal((await action(env, updated, 'test')).status, 409);
	assert.equal(mutations, 1);
	const history = await (await call(env, `/posts/${post.id}/history`)).json();
	assert.ok(history.some(e => e.kind === 'instagram_container_ready' && e.detail === '555'));
	assert.ok(!JSON.stringify(history).includes('SECRET-META-TOKEN'));
});

test('ambiguous Meta test failure is recorded and cannot retry; stale CRM fails before Meta', async t => {
	const env = environment(); t.after(() => env.SOCIAL_DB.close());
	const post = await approved(t, env, 'facebook'); let calls = 0;
	t.mock.method(globalThis, 'fetch', async url => {
		if (String(url).includes('/listings/')) return Response.json({ data: { ...rawProperty, status: 'inactive' } });
		calls++; throw new Error('SECRET-META-TOKEN');
	});
	assert.equal((await action(env, post, 'test')).status, 409);
	assert.equal(calls, 0);
	t.mock.method(globalThis, 'fetch', async url => {
		if (String(url).includes('/listings/')) return Response.json({ data: rawProperty });
		calls++; throw new Error('SECRET-META-TOKEN');
	});
	const response = await action(env, post, 'test');
	assert.equal(response.status, 502);
	assert.ok(!(await response.text()).includes('SECRET-META-TOKEN'));
	const current = await getPost(env, post.id);
	assert.equal((await action(env, current, 'test')).status, 409);
	assert.equal(calls, 1);
	const history = await (await call(env, `/posts/${post.id}/history`)).json();
	assert.ok(history.some(e => e.kind === 'meta_test_failed'));
});
async function call(env, path, method = 'GET', body, headers = {}) {
	const request = new Request(`${origin}/api/social${path}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
	return handleSocial(request, env, new URL(request.url));
}
async function confirmPhotos(env, post) {
	return (await call(env, `/posts/${post.id}`, 'PATCH', {
		revision: post.revision, channel: post.channel, template: post.template, caption: post.caption,
		photos: post.photos, creative: post.creative, photos_confirmed_clean: true,
	})).json();
}
async function create(env, channel = 'instagram') {
	const post = await (await call(env, '/posts', 'POST', { property_id: '123', channel, template: 'square', creative: { preset: 'classic', version: 1, includeFacts: false, includeCta: false } })).json();
	return confirmPhotos(env, post);
}
async function action(env, post, name, extra = {}) { return call(env, `/posts/${post.id}/${name}`, 'POST', { revision: post.revision, ...extra }); }
function mockPhotos(t) { t.mock.method(globalThis, 'fetch', async () => new Response('photo', { headers: { 'Content-Type': 'image/jpeg' } })); }
async function approved(t, env, channel) {
	mockPhotos(t);
	let post = await create(env, channel);
	post = await (await action(env, post, 'submit')).json();
	return (await action(env, post, 'approve')).json();
}

const watermark = 'https://photos.example/watermarked.jpg';
// Simulate a revision approved before source provenance was included in the
// snapshot/hash. Do not call the new fingerprint() to construct a legacy hash.
async function legacyPost(env, { watermarked = false, status = 'approved', channel = 'facebook' } = {}) {
	const post = await create(env, channel);
	const snapshot = { ...publicFixture, images: watermarked ? [watermark] : [...publicFixture.images] };
	delete snapshot.photoSource;
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(snapshot)));
	const hash = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
	await env.SOCIAL_DB.prepare('UPDATE social_posts SET snapshot=?,fingerprint=?,photos=?,status=?,approved_by=?,scheduled_at=?,assets=?,photos_confirmed_clean=0 WHERE id=?')
		.bind(JSON.stringify(snapshot), hash, JSON.stringify(snapshot.images.slice(0, 1)), status, 'local-developer',
			status === 'scheduled' ? new Date().toISOString() : null,
			JSON.stringify([`social/${post.id}/${crypto.randomUUID()}/0.jpg`]), post.id).run();
	return getPost(env, post.id);
}

test('CRM mapping preserves website fallback but social uses public originals only', async () => {
	const original = property.images[0];
	const mapped = mapListing({ ...rawProperty, photos: [
		{ original_image: original, watermark_image: watermark, is_public: true },
		{ watermark_image: watermark, is_public: true },
		{ original_image: 'https://photos.example/private.jpg', is_public: false },
		{ original_image: null, watermark_image: 'https://photos.example/second-watermark.jpg' },
	] });
	assert.deepEqual(mapped.images, [original, watermark, 'https://photos.example/second-watermark.jpg']);
	assert.deepEqual(mapped.originalImages, [original]);
	const projected = publicProperty(mapped);
	assert.deepEqual(projected.images, [original]);
	assert.equal(projected.photoSource, 'estateprime_original');
	assert.deepEqual(publicProperty(projected), projected);
	assert.equal(await fingerprint(mapped), await fingerprint(projected));
	assert.equal(JSON.stringify(projected).includes(watermark), false);
	assert.deepEqual(mapListing({ ...rawProperty, photos: [
		{ original_image: '', watermark_image: watermark },
		{ original_image: '   ', watermark_image: watermark },
		{ original_image: 42, watermark_image: watermark },
	] }).originalImages, []);
});

test('legacy image arrays and watermark-only listings cannot supply social photos', async () => {
	const env = environment();
	const { originalImages, ...legacy } = property;
	assert.deepEqual(publicProperty(legacy).images, []);
	assert.deepEqual(publicProperty({ ...legacy, photoSource: 'unknown' }).images, []);
	// Explicit clean metadata is authoritative even if a conflicting marker exists.
	assert.deepEqual(publicProperty({ ...legacy, originalImages: [], photoSource: 'estateprime_original' }).images, []);
	env.feed.listings = [legacy];
	for (const response of [await call(env, '/bootstrap'), await call(env, '/posts', 'POST', { property_id: '123', channel: 'instagram', template: 'square' })]) {
		assert.equal(response.status, 503);
		assert.equal((await response.json()).error, 'photo_sources_pending_sync');
	}
	env.feed.listings = [mapListing({ ...rawProperty, photos: [{ watermark_image: watermark }] })];
	const bootstrap = await (await call(env, '/bootstrap')).json();
	assert.deepEqual(bootstrap.feed.listings, []);
	assert.equal((await call(env, '/posts', 'POST', { property_id: '123', channel: 'instagram', template: 'square' })).status, 409);
});

test('public listing feed retains its website photos without exposing source metadata', async () => {
	const env = environment();
	env.feed.listings = [{ ...property, images: [...property.images, watermark] }];
	assert.deepEqual(env.feed.listings[0].originalImages, property.images);
	env.LISTINGS_KV.get = async () => JSON.stringify(env.feed);
	const response = await worker.fetch(new Request('https://four-walls.gr/data/listings.json'), env, {});
	assert.equal(response.status, 200);
	const feed = await response.json();
	assert.deepEqual(feed.listings[0].images, [...property.images, watermark]);
	assert.equal('originalImages' in feed.listings[0], false);
	assert.equal('listedAt' in feed.listings[0], false);
});

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
	await verifyLiveProperty(env, await getPost(env, post.id));
	raw = { ...raw, subcategory: 'office' };
	await assert.rejects(async () => verifyLiveProperty(env, await getPost(env, post.id)), /property_changed_reapprove/);
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
	assert.deepEqual((await (await call(env, `/posts/${post.id}/history`)).json()).map(e => e.kind), ['edited', 'draft']);
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
	assert.deepEqual((await (await call(env, `/posts/${post.id}/history`)).json()).map(e => e.kind), ['edited', 'draft']);
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
	assert.deepEqual(history.map(e => e.kind), ['edited', 'approved', 'submitted', 'edited', 'draft']);
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

test('new drafts cannot render until the selected photos are explicitly reviewed and saved', async t => {
	const env = environment(); let fetches = 0;
	t.mock.method(globalThis, 'fetch', async () => { fetches++; return new Response('photo', { headers: { 'Content-Type': 'image/jpeg' } }); });
	const response = await call(env, '/posts', 'POST', {
		property_id: property.id, channel: 'instagram', template: 'square',
		creative: { preset: 'classic', version: 1, includeFacts: false, includeCta: false },
		// Creating a draft cannot attest that its newly shown photos were checked.
		photos_confirmed_clean: true,
	});
	assert.equal(response.status, 201);
	let post = await response.json();
	assert.equal(post.photos_confirmed_clean, false);
	assert.equal((await getPost(env, post.id)).photos_confirmed_clean, 0);
	const rejected = await action(env, post, 'submit');
	assert.ok(rejected.status >= 400 && rejected.status < 500);
	assert.equal((await rejected.json()).error, 'clean_photos_confirmation_required');
	assert.equal(fetches, 0);
	for (const invalid of ['true', 1, null]) {
		const invalidSave = await call(env, `/posts/${post.id}`, 'PATCH', {
			revision: post.revision, channel: post.channel, template: post.template, caption: post.caption,
			photos: post.photos, creative: post.creative, photos_confirmed_clean: invalid,
		});
		assert.equal(invalidSave.status, 400);
	}
	post = await confirmPhotos(env, post);
	assert.equal(post.photos_confirmed_clean, true);
	assert.equal((await getPost(env, post.id)).photos_confirmed_clean, 1);
	post = await (await action(env, post, 'submit')).json();
	assert.equal(post.status, 'pending');
	assert.equal(fetches, 1);
});

test('editing selected photos without a new confirmation resets the review', async t => {
	const env = environment(); let fetches = 0;
	t.mock.method(globalThis, 'fetch', async () => { fetches++; return new Response('photo', { headers: { 'Content-Type': 'image/jpeg' } }); });
	const original = await create(env);
	assert.equal(original.photos_confirmed_clean, true);
	const changed = await call(env, `/posts/${original.id}`, 'PATCH', {
		revision: original.revision, channel: original.channel, template: original.template, caption: original.caption,
		photos: [property.images[1]], creative: original.creative,
	});
	assert.equal(changed.status, 200);
	let post = await changed.json();
	assert.equal(post.photos_confirmed_clean, false);
	const rejected = await action(env, post, 'submit');
	assert.equal((await rejected.json()).error, 'clean_photos_confirmation_required');
	assert.equal(fetches, 0);
	post = await confirmPhotos(env, post);
	assert.equal((await action(env, post, 'submit')).status, 200);
	assert.equal(fetches, 1);
});

test('scheduler blocks an unreviewed source before contacting Meta', async t => {
	const env = environment(); let post = await approved(t, env, 'facebook');
	post = await (await action(env, post, 'schedule', { at: new Date().toISOString() })).json();
	// A migrated or otherwise stale approved record has no manual review proof.
	await env.SOCIAL_DB.prepare('UPDATE social_posts SET photos_confirmed_clean=0 WHERE id=?').bind(post.id).run();
	env.SOCIAL_LIVE_PUBLISH = '1';
	let crmCalls = 0;
	t.mock.method(globalThis, 'fetch', async url => {
		assert.match(String(url), /estateprime/);
		crmCalls++;
		return Response.json({ data: rawProperty });
	});
	await runSocialPublisher(env);
	const blocked = await getPost(env, post.id);
	assert.equal(blocked.status, 'blocked');
	assert.equal(blocked.error, 'clean_photos_confirmation_required');
	assert.equal(crmCalls, 1);
	await runSocialPublisher(env);
	assert.equal(crmCalls, 1);
});

test('rendering fetches the chosen original and never retries with a watermark', async t => {
	const env = environment();
	env.feed.listings = [mapListing({ ...rawProperty, photos: [{ original_image: property.images[0], watermark_image: watermark }] })];
	const fetched = []; let status = 404;
	t.mock.method(globalThis, 'fetch', async url => {
		fetched.push(String(url));
		return new Response('photo', { status, headers: { 'Content-Type': 'image/jpeg' } });
	});
	const post = await create(env);
	const failure = await action(env, post, 'submit');
	assert.equal(failure.status, 502);
	assert.equal((await failure.json()).error, 'photo_fetch_failed');
	assert.deepEqual(fetched, [property.images[0]]);
	status = 200;
	const submitted = await (await action(env, post, 'submit')).json();
	assert.equal(submitted.status, 'pending');
	assert.deepEqual(fetched, [property.images[0], property.images[0]]);
});

test('stored non-original selections cannot render or pass direct CRM verification', async t => {
	const env = environment();
	const post = await create(env);
	await env.SOCIAL_DB.prepare('UPDATE social_posts SET photos=? WHERE id=?').bind(JSON.stringify([watermark]), post.id).run();
	const stored = await getPost(env, post.id);
	let fetched = 0;
	t.mock.method(globalThis, 'fetch', async url => {
		fetched++;
		assert.match(String(url), /estateprime/);
		return Response.json({ data: rawProperty });
	});
	const rejected = await action(env, stored, 'submit');
	assert.equal(rejected.status, 400);
	assert.equal((await rejected.json()).error, 'invalid_photo_selection');
	assert.equal(fetched, 0);
	await assert.rejects(() => verifyLiveProperty(env, stored), /invalid_photo_selection/);
	assert.equal(fetched, 1);
});

test('legacy approvals require regeneration even when the old sources were originals', async t => {
	t.mock.method(globalThis, 'fetch', async url => {
		assert.match(String(url), /estateprime/);
		return Response.json({ data: rawProperty });
	});
	for (const watermarked of [false, true]) {
		const env = environment();
		const pending = await legacyPost(env, { watermarked, status: 'pending' });
		const approval = await action(env, pending, 'approve');
		assert.equal(approval.status, 409);
		assert.equal((await approval.json()).error, 'property_changed_reapprove');
		const manual = await legacyPost(env, { watermarked, channel: 'marketplace' });
		const exported = await action(env, manual, 'package');
		assert.equal(exported.status, 409);
		assert.equal((await exported.json()).error, 'property_changed_reapprove');
		const scheduled = await legacyPost(env, { watermarked, status: 'scheduled' });
		env.SOCIAL_LIVE_PUBLISH = '1';
		await runSocialPublisher(env);
		const blocked = await getPost(env, scheduled.id);
		assert.equal(blocked.status, 'blocked');
		assert.equal(blocked.error, 'property_changed_reapprove');
	}
});

test('old watermark approvals become blocked and recover only through save render and approval', async t => {
	const env = environment();
	const old = await legacyPost(env, { watermarked: true });
	await reconcileSocial(env, env.feed);
	let post = await getPost(env, old.id);
	assert.equal(post.status, 'blocked');
	assert.equal(post.approved_by, null);
	assert.equal(post.scheduled_at, null);
	const saved = await call(env, `/posts/${post.id}`, 'PATCH', {
		revision: post.revision, channel: post.channel, template: post.template, caption: post.caption, photos: [property.images[1]], photos_confirmed_clean: true,
	});
	assert.equal(saved.status, 200);
	post = await saved.json();
	assert.equal(post.status, 'draft');
	assert.deepEqual(post.assets, []);
	assert.deepEqual(post.photos, [property.images[1]]);
	assert.equal(post.snapshot.photoSource, 'estateprime_original');
	assert.equal((await action(env, post, 'approve')).status, 409);
	const fetched = [];
	t.mock.method(globalThis, 'fetch', async url => {
		fetched.push(String(url));
		return new Response('photo', { headers: { 'Content-Type': 'image/jpeg' } });
	});
	post = await (await action(env, post, 'submit')).json();
	assert.equal(post.status, 'pending');
	assert.deepEqual(fetched, [property.images[1]]);
	post = await (await action(env, post, 'approve')).json();
	assert.equal(post.status, 'approved');
});

test('losing all originals blocks an approved post while website watermark photos remain', async t => {
	const env = environment(), post = await approved(t, env);
	env.feed.listings = [{ ...property, originalImages: [], images: [watermark] }];
	await reconcileSocial(env, env.feed);
	const blocked = await getPost(env, post.id);
	assert.equal(blocked.status, 'blocked');
	assert.equal(blocked.error, 'property_unavailable');
	assert.equal(blocked.approved_by, null);
	assert.equal(blocked.scheduled_at, null);
	assert.equal((await call(env, '/bootstrap')).status, 200);
	assert.deepEqual((await (await call(env, '/bootstrap')).json()).feed.listings, []);
});
test('two concurrent changes have one winner and one audit event', async () => {
	const env = environment(), post = await create(env);
	const results = await Promise.all([action(env, post, 'cancel'), action(env, post, 'cancel')]);
	assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
	assert.equal((await (await call(env, `/posts/${post.id}/history`)).json()).length, 3);
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
