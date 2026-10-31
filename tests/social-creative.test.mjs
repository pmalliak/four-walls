import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { normalizeCreative, buildSlidePlan } from '../worker/lib/social-creative.mjs';
import { validateDraft, publicProperty } from '../worker/lib/social-model.mjs';
import { handleSocial, getPost } from '../worker/lib/social.mjs';
import { renderSocialImages } from '../worker/lib/social-media.mjs';
import { environment, property } from './social-fixtures.mjs';

const classic = { preset: 'classic', version: 1, includeFacts: false, includeCta: false };
const creative = (preset = 'architectural', flags = {}) => ({ preset, version: 1, includeFacts: true, includeCta: true, ...flags });
const origin = 'http://localhost:8787';
async function api(env, path, method = 'GET', body) {
	const request = new Request(`${origin}/api/social${path}`, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
	return handleSocial(request, env, new URL(request.url));
}
async function action(env, post, name, fields = {}) {
	return api(env, `/posts/${post.id}/${name}`, 'POST', { revision: post.revision, ...fields });
}

test('creative normalization preserves legacy defaults and rejects unsupported configurations', () => {
	assert.deepEqual(normalizeCreative(), classic);
	assert.deepEqual(normalizeCreative(null), classic);
	assert.deepEqual(normalizeCreative(classic), classic);
	for (const preset of ['architectural', 'editorial', 'neighbourhood']) {
		for (const includeFacts of [false, true]) for (const includeCta of [false, true]) {
			const value = creative(preset, { includeFacts, includeCta });
			assert.deepEqual(normalizeCreative(value), value);
		}
	}
	for (const invalid of [
		{}, [], 'architectural', 1, false,
		creative('unknown'), creative('architectural', { version: 2 }), creative('architectural', { version: '1' }),
		creative('architectural', { version: undefined }), creative('architectural', { includeFacts: 'true' }),
		creative('architectural', { includeCta: 1 }), creative('architectural', { includeCta: undefined }),
		creative('architectural', { customSource: 'https://untrusted.example/asset.png' }),
		creative('classic'), { ...classic, includeFacts: true }, { ...classic, includeCta: true },
	]) assert.equal(normalizeCreative(invalid), null, JSON.stringify(invalid));
});

test('carousel plans keep selected photo order with facts after the opening and CTA last', () => {
	const photos = Array.from({ length: 8 }, (_, i) => `https://photos.example/${i}.jpg`);
	for (const preset of ['architectural', 'editorial', 'neighbourhood']) {
		const one = buildSlidePlan({ photos: [photos[0]], creative: creative(preset) });
		assert.deepEqual(one.map(s => s.kind), ['cover', 'facts', 'cta']);
		assert.equal(one[0].photo, photos[0]);
		const eight = buildSlidePlan({ photos: JSON.stringify(photos), creative: JSON.stringify(creative(preset)) });
		assert.equal(eight.length, 10);
		assert.equal(eight[0].kind, 'cover');
		assert.equal(eight[1].kind, 'photo');
		assert.equal(eight[2].kind, 'facts');
		assert.equal(eight.at(-1).kind, 'cta');
		assert.deepEqual(eight.filter(s => s.photo).map(s => s.photo), photos);
		const plain = buildSlidePlan({ photos, creative: creative(preset, { includeFacts: false, includeCta: false }) });
		assert.equal(plain.length, 8);
		assert.equal(plain.some(s => ['facts', 'cta'].includes(s.kind)), false);
	}
	assert.deepEqual(buildSlidePlan({ photos, creative: classic }), photos.map(photo => ({ kind: 'photo', photo })));
});

test('draft validation applies the ten-slide cap to photos and optional cards together', () => {
	const photos = Array.from({ length: 10 }, (_, i) => `https://photos.example/${i}.jpg`);
	const current = publicProperty({ ...property, originalImages: photos });
	const input = { channel: 'instagram', template: 'portrait', caption: 'Ακίνητο', photos: photos.slice(0, 8), creative: creative() };
	assert.equal(validateDraft(input, current).photos.length, 8);
	assert.throws(() => validateDraft({ ...input, photos: photos.slice(0, 9) }, current), /carousel_max_10_slides/);
	assert.equal(validateDraft({ ...input, photos: photos.slice(0, 9), creative: creative('editorial', { includeFacts: false }) }, current).photos.length, 9);
	assert.equal(validateDraft({ ...input, photos, creative: classic }, current).photos.length, 10);
	assert.throws(() => validateDraft({ ...input, creative: creative('unsupported') }, current), /invalid_creative/);
});

test('new API drafts default to Architectural and preserve explicit preset choices', async () => {
	const env = environment();
	const response = await api(env, '/posts', 'POST', { property_id: property.id, channel: 'instagram', template: 'portrait' });
	assert.equal(response.status, 201);
	const post = await response.json();
	assert.deepEqual(post.creative, creative());
	assert.deepEqual(JSON.parse((await getPost(env, post.id)).creative), creative());
	for (const preset of ['editorial', 'neighbourhood', 'classic']) {
		const choice = preset === 'classic' ? classic : creative(preset, { includeFacts: false });
		const chosen = await api(env, '/posts', 'POST', { property_id: property.id, channel: 'facebook', template: 'square', creative: choice });
		assert.equal(chosen.status, 201);
		assert.deepEqual((await chosen.json()).creative, choice);
	}
	const fetched = await (await api(env, `/posts/${post.id}`)).json();
	assert.deepEqual(fetched.creative, creative());
	const listed = await (await api(env, '/posts')).json();
	assert.deepEqual(listed.posts.find(p => p.id === post.id).creative, creative());
});

test('changing an approved creative clears its approval and rendered images', async t => {
	const env = environment();
	t.mock.method(globalThis, 'fetch', async () => new Response('photo', { headers: { 'Content-Type': 'image/jpeg' } }));
	let post = await (await api(env, '/posts', 'POST', { property_id: property.id, channel: 'instagram', template: 'portrait', creative: classic })).json();
	post = await (await action(env, post, 'submit')).json();
	post = await (await action(env, post, 'approve')).json();
	assert.equal(post.status, 'approved');
	assert.equal(post.assets.length, 1);
	const next = creative('neighbourhood');
	const edited = await api(env, `/posts/${post.id}`, 'PATCH', { revision: post.revision, channel: post.channel, template: post.template, caption: post.caption, photos: post.photos, creative: next });
	assert.equal(edited.status, 200);
	const saved = await edited.json();
	assert.deepEqual(saved.creative, next);
	assert.equal(saved.status, 'draft');
	assert.equal(saved.approved_by, null);
	assert.equal(saved.scheduled_at, null);
	assert.deepEqual(saved.assets, []);
	assert.equal(saved.revision, post.revision + 1);
	assert.equal((await action(env, saved, 'schedule', { at: new Date().toISOString() })).status, 409);
});

test('creative migration leaves existing audit records and designs intact as Classic', () => {
	const db = new DatabaseSync(':memory:');
	try {
		db.exec(readFileSync(new URL('../worker/migrations/0001_social.sql', import.meta.url), 'utf8'));
		const saved = { photos: JSON.stringify(property.images), snapshot: JSON.stringify(publicProperty(property)), assets: '["old-render.jpg"]' };
		db.prepare('INSERT INTO social_posts(id,property_id,channel,template,caption,photos,snapshot,fingerprint,assets,status,revision,created_by,approved_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
			.run('old', property.id, 'instagram', 'square', 'Existing caption', saved.photos, saved.snapshot, 'old-hash', saved.assets, 'approved', 7, 'author', 'approver', '2026-10-01', '2026-10-02');
		const before = db.prepare('SELECT * FROM social_posts WHERE id=?').get('old');
		const history = db.prepare('SELECT * FROM social_events').all();
		db.exec(readFileSync(new URL('../worker/migrations/0002_social_creative.sql', import.meta.url), 'utf8'));
		const after = db.prepare('SELECT * FROM social_posts WHERE id=?').get('old');
		assert.deepEqual(JSON.parse(after.creative), classic);
		delete after.creative;
		assert.deepEqual(after, before);
		assert.deepEqual(db.prepare('SELECT * FROM social_events').all(), history);
	} finally { db.close(); }
});

// Record the Images public API rather than mock the renderer's own helpers.
// This verifies output geometry/format and text provenance without pretending
// that a stub can validate Cloudflare's rasterisation or Greek font support.
function imageRecorder() {
	const texts = [], outputs = [];
	function image(kind, content, options) {
		const record = { kind, content, options, transforms: [], overlays: [] };
		const chain = {
			record,
			transform(value) { record.transforms.push(value); return chain; },
			draw(overlay, position) { record.overlays.push({ record: overlay.record, position }); return chain; },
			async output(options) {
				outputs.push({ record, options });
				return { response: () => new Response(new Uint8Array([255, 216, 255, 217])) };
			},
		};
		return chain;
	}
	return {
		texts, outputs,
		binding: {
			input: stream => image('input', stream),
			text(content, options) { texts.push({ content, options }); return image('text', content, options); },
		},
	};
}
function outputDimensions(record) {
	let width = 0, height = 0;
	for (const transform of record.transforms) {
		if (transform.width) width = transform.width;
		if (transform.height) height = transform.height;
		if (transform.border) {
			width += (transform.border.left || 0) + (transform.border.right || 0);
			height += (transform.border.top || 0) + (transform.border.bottom || 0);
		}
	}
	return { width, height };
}

test('each preset renders ordered JPEGs at both sizes using only selected originals and public text', async t => {
	const requestedPhotos = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		assert.equal(options.redirect, 'manual');
		assert.ok(property.images.includes(String(url)), `unexpected image request: ${url}`);
		requestedPhotos.push(String(url));
		return new Response('original photo', { headers: { 'Content-Type': 'image/jpeg' } });
	});
	for (const preset of ['classic', 'architectural', 'editorial', 'neighbourhood']) {
		for (const template of ['square', 'portrait']) {
			const env = environment(), recorder = imageRecorder(), stored = [], assets = [];
			env.IMAGES = recorder.binding;
			env.ASSETS.fetch = async request => { assets.push(new URL(request.url).pathname); return new Response('brand asset'); };
			env.PHOTO_BUCKET.put = async (key, bytes, options) => stored.push({ key, bytes, options });
			const start = requestedPhotos.length;
			const post = {
				id: crypto.randomUUID(), template, photos: JSON.stringify(property.images),
				creative: JSON.stringify(preset === 'classic' ? classic : creative(preset)),
				snapshot: JSON.stringify(property),
			};
			const keys = await renderSocialImages(env, post);
			const count = preset === 'classic' ? 2 : 4;
			assert.equal(keys.length, count, `${preset} ${template}`);
			assert.equal(recorder.outputs.length, count);
			assert.equal(stored.length, count);
			assert.deepEqual(requestedPhotos.slice(start), property.images);
			for (let i = 0; i < count; i++) {
				assert.match(keys[i], new RegExp(`^social/${post.id}/[a-f0-9-]{36}/${i}\\.jpg$`));
				assert.equal(stored[i].key, keys[i]);
				assert.equal(stored[i].options.httpMetadata.contentType, 'image/jpeg');
				assert.equal(recorder.outputs[i].options.format, 'image/jpeg');
				assert.deepEqual(outputDimensions(recorder.outputs[i].record), { width: 1080, height: template === 'portrait' ? 1350 : 1080 });
			}
			const printed = recorder.texts.map(item => item.content).join('\n');
			assert.equal(printed.includes('PRIVATE'), false);
			if (preset !== 'classic') {
				assert.match(printed, /4W-123/);
				assert.match(printed, /185\.000/);
				assert.match(printed, /Καλαμαριά/);
				assert.ok(recorder.texts.every(item => item.options.font.url.startsWith('https://four-walls.gr/')));
				assert.ok(assets.includes('/images/social/logo-vertical.png'));
			}
			assert.ok(assets.length > 0);
		}
	}
});

test('facts cards omit missing measurements and never invent a price or expose private details', async t => {
	const env = environment(), recorder = imageRecorder();
	env.IMAGES = recorder.binding;
	t.mock.method(globalThis, 'fetch', async () => new Response('photo', { headers: { 'Content-Type': 'image/jpeg' } }));
	const snapshot = { ...property, area: null, price: null, location: { address: 'PRIVATE ADDRESS', lat: 40, lng: 22 } };
	await renderSocialImages(env, {
		id: crypto.randomUUID(), template: 'portrait', photos: JSON.stringify(property.images.slice(0, 1)),
		creative: JSON.stringify(creative()), snapshot: JSON.stringify(snapshot),
	});
	const printed = recorder.texts.map(item => item.content).join('\n');
	assert.match(printed, /Τιμή κατόπιν επικοινωνίας/);
	assert.doesNotMatch(printed, /PRIVATE|ΕΜΒΑΔΟΝ|τ\.μ\.|€0|undefined|NaN/);
});
