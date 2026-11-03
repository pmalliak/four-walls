import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSocialCrop, normalizeSocialCrop, photoCropPercent, sourceCropBox } from '../forms/social-crop.mjs';
import { normalizeCreative } from '../worker/lib/social-creative.mjs';
import { renderSocialImages, socialPhotoInput } from '../worker/lib/social-media.mjs';

const url = 'https://files.estateprime.gr/public/photo.jpg';

test('source crop defaults follow source orientation and preserve legacy images', () => {
	const crop = defaultSocialCrop();
	assert.deepEqual(sourceCropBox(crop, url, 1600, 1000), { left: 0, top: 0, width: 1600, height: 840, bottom: 160 });
	assert.deepEqual(sourceCropBox(crop, url, 1000, 1600), { left: 0, top: 0, width: 1000, height: 1440, bottom: 160 });
	assert.equal(photoCropPercent(crop, url, 1000, 1000), 16);
	assert.equal(sourceCropBox(undefined, url, 1600, 1000).bottom, 0);
	assert.equal(sourceCropBox(crop, url, 0, 1000), null);
	assert.equal(sourceCropBox(crop, url, 1600, NaN), null);
	assert.equal(sourceCropBox(crop, url, 1000, 999).bottom, 160);
});

test('overrides stay with photo URLs, including explicit no-crop', () => {
	const crop = { ...defaultSocialCrop(), photos: [{ url, bottom: 0 }, { url: url + '?two', bottom: 25 }] };
	for (const images of [[url, url + '?two'], [url + '?two', url]]) {
		assert.deepEqual(images.map(photo => [photo, photoCropPercent(crop, photo, 1600, 1000)]), images.map(photo => [photo, photo === url ? 0 : 25]));
	}
	assert.equal(sourceCropBox(crop, url + '?two', 1000, 1600).bottom, 400);
	assert.equal(defaultSocialCrop().photos.length, 0);
});

test('creative crop validation rejects malformed, duplicate and unbounded settings', () => {
	const good = defaultSocialCrop();
	const creative = { preset: 'architectural', version: 1, includeFacts: true, includeCta: true };
	assert.deepEqual(normalizeCreative({ ...creative, crop: good }).crop, good);
	for (const invalid of [null, [], {}, { ...good, extra: 1 }, { ...good, photos: {} },
		...[-1, 41, 1.5, NaN, Infinity, '16', true].map(value => ({ ...good, landscape: value })),
		{ ...good, portrait: -1 }, { ...good, photos: [{ url, bottom: 41 }] },
		{ ...good, photos: [{ url, bottom: 5, left: 1 }] },
		{ ...good, photos: [{ url, bottom: 5 }, { url, bottom: 10 }] },
		{ ...good, photos: [{ url: '', bottom: 5 }] },
		{ ...good, photos: Array.from({ length: 11 }, (_, i) => ({ url: url + i, bottom: 5 })) }]) {
		assert.equal(normalizeSocialCrop(invalid), null);
		assert.equal(normalizeCreative({ ...creative, crop: invalid }), null);
	}
});

function imagesRecorder(width = 1600, height = 1000) {
	const outputs = [], infos = [];
	const operations = node => node.transforms.length + node.overlays.reduce((sum, overlay) => sum + 1 + operations(overlay), 0);
	function input() {
		const node = { transforms: [], overlays: [] };
		const handle = { node,
			transform(value) { node.transforms.push(value); return handle; },
			draw(child) { node.overlays.push(child.node); return handle; },
			async output(options) {
				assert.ok(operations(node) <= 10, 'Cloudflare graph limit');
				outputs.push({ node, options });
				return { response: () => new Response(new Uint8Array([1, 2, 3])) };
			},
		};
		return handle;
	}
	return { outputs, infos, binding: { input, text: input, async info(stream) { infos.push(stream); return { width, height, format: 'image/png' }; } } };
}

test('cropping uses upright intermediate dimensions and precedes cover fitting', async t => {
	t.mock.method(globalThis, 'fetch', async (requested, options) => {
		assert.equal(requested, url); assert.equal(options.redirect, 'manual');
		return new Response('original', { headers: { 'Content-Type': 'image/jpeg' } });
	});
	for (const [width, height, bottom] of [[1600, 1000, 160], [1000, 1600, 160], [1000, 1000, 160]]) {
		const recorder = imagesRecorder(width, height);
		const image = await socialPhotoInput({ IMAGES: recorder.binding }, url, defaultSocialCrop());
		image.transform({ width: 1080, height: 1350, fit: 'cover' });
		assert.deepEqual(recorder.outputs[0].node.transforms, [{ width: 4096, height: 4096, fit: 'scale-down' }]);
		assert.equal(recorder.outputs[0].options.format, 'image/png');
		assert.equal(recorder.infos.length, 1);
		assert.deepEqual(image.node.transforms, [{ trim: { bottom } }, { width: 1080, height: 1350, fit: 'cover' }]);
	}
	for (const crop of [undefined, { landscape: 0, portrait: 0, photos: [] }, { ...defaultSocialCrop(), photos: [{ url, bottom: 0 }] }]) {
		const recorder = imagesRecorder();
		await socialPhotoInput({ IMAGES: recorder.binding }, url, crop);
		assert.equal(recorder.outputs.length, 0); assert.equal(recorder.infos.length, 0);
	}
});

test('cropped photos preserve selected sources and fit inside Images graph limits for every preset', async t => {
	t.mock.method(globalThis, 'fetch', async requested => {
		assert.equal(requested, url);
		return new Response('original', { headers: { 'Content-Type': 'image/jpeg' } });
	});
	for (const preset of ['classic', 'editorial', 'architectural', 'neighbourhood']) for (const template of ['portrait', 'square']) {
		const recorder = imagesRecorder(), stored = [];
		const env = { IMAGES: recorder.binding, ASSETS: { fetch: async () => new Response('asset') }, PHOTO_BUCKET: { put: async key => stored.push(key) } };
		const post = { id: crypto.randomUUID(), template, channel: 'instagram', photos: JSON.stringify([url]),
			snapshot: JSON.stringify({ code: 'TEST', typeLabel: 'Διαμέρισμα', images: [url], area: 85, price: 100000 }),
			creative: JSON.stringify({ preset, version: 1, includeFacts: preset !== 'classic', includeCta: preset !== 'classic', crop: defaultSocialCrop() }) };
		const keys = await renderSocialImages(env, post);
		assert.equal(keys.length, preset === 'classic' ? 1 : 3);
		assert.equal(stored.length, keys.length);
		assert.equal(recorder.infos.length, 1);
		assert.equal(recorder.outputs.filter(output => output.options.format === 'image/jpeg').length, keys.length);
	}
});
