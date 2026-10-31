import { hmac, safeEqual } from './signing.mjs';
import { check } from './social-model.mjs';
import { normalizeCreative, buildSlidePlan, websiteDestination } from './social-creative.mjs';
import { buildSocialDesign } from '../../forms/social-design.mjs';
import { sourceCropBox } from '../../forms/social-crop.mjs';

const NAVY = '#1C3457', PINK = '#FF0062';
const stream = bytes => new Blob([bytes]).stream();

async function sourcePhoto(photo) {
	// Workers supports only manual/follow. Never follow a redirect, switch to a
	// watermark URL, or replace a failed original with another photograph.
	const response = await fetch(photo, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
	check(response.ok && /^image\//.test(response.headers.get('Content-Type') || ''), 'photo_fetch_failed', 502);
	return response.body;
}

export async function socialPhotoInput(env, photo, crop) {
	const source = await sourcePhoto(photo);
	const override = crop?.photos.find(item => item.url === photo);
	if (!crop || override?.bottom === 0 || (!override && !crop.landscape && !crop.portrait)) return env.IMAGES.input(source);
	// Materialize orientation before trimming: Images applies trim before EXIF
	// rotation within a graph. A bounded lossless intermediate gives the same
	// upright bottom edge and orientation as browser naturalWidth/naturalHeight.
	const oriented = await env.IMAGES.input(source)
		.transform({ width: 4096, height: 4096, fit: 'scale-down' })
		.output({ format: 'image/png' });
	const [metadata, pixels] = oriented.response().body.tee();
	const info = await env.IMAGES.info(metadata);
	const box = sourceCropBox(crop, photo, info.width, info.height);
	check(box, 'photo_dimensions_unavailable', 502);
	const image = env.IMAGES.input(pixels);
	return box.bottom ? image.transform({ trim: { bottom: box.bottom } }) : image;
}

async function flatten(env, canvas) {
	const image = await canvas.output({ format: 'image/png' });
	return env.IMAGES.input(image.response().body);
}

async function finishText(env, canvas, queue) {
	// Images limits a single graph to ten transformations, including child
	// overlays. Flatten the art once, then compose at most three text overlays
	// per graph. Intermediate PNGs stay inside the Worker; only the final JPEG
	// is stored/reviewed/published. No lossy re-encoding between these batches.
	if (queue.length) canvas = await flatten(env, canvas);
	for (const [i, item] of queue.entries()) {
		const { text: line, font: face, size, color, width, left, top, align } = item;
		const fontFile = { heading: 'FourWallsWebsite-SemiBold.ttf', serif: 'NotoSerifDisplay-SemiBold.ttf', sans: 'Manrope-Regular.ttf', sansBold: 'Manrope-SemiBold.ttf' }[face];
		const font = new URL(`/images/social/${fontFile}`, env.SOCIAL_ASSET_ORIGIN || 'https://four-walls.gr').href;
		const text = env.IMAGES.text(line, { font: { url: font }, size, color })
			.transform({ width, height: Math.ceil(size * 1.35), fit: 'scale-down' });
		canvas = canvas.draw(text, align === 'right' ? { right: 1080 - left - width, top } : { left, top });
		if ((i + 1) % 3 === 0 && i + 1 < queue.length) canvas = await flatten(env, canvas);
	}
	return canvas.output({ format: 'image/jpeg', quality: 90 });
}

async function renderPreset(env, post, slide, creative, height, asset) {
	check(typeof env.IMAGES.text === 'function', 'image_text_not_available', 503);
	const property = typeof post.snapshot === 'string' ? JSON.parse(post.snapshot) : post.snapshot;
	const design = buildSocialDesign({ preset: creative.preset, kind: slide.kind, height, property,
		destination: creative.destination || 'message', channel: post.channel, link: websiteDestination(post) });
	const frame = await asset(design.frame);
	let canvas = env.IMAGES.input(stream(frame)).transform({ width: 1080, height, fit: 'cover' });
	if (slide.photo) {
		const box = design.photo;
		canvas = canvas.draw((await socialPhotoInput(env, slide.photo, creative.crop)).transform({ width: box.width, height: box.height, fit: 'cover' }), { left: box.left, top: box.top })
			.draw(env.IMAGES.input(stream(frame)), { left: 0, top: 0 });
	}
	const logo = await asset(design.logo.file);
	canvas = canvas.draw(env.IMAGES.input(stream(logo)).transform({ width: design.logo.width }), { left: design.logo.left, top: design.logo.top });
	return finishText(env, canvas, design.texts);
}
// R2 keeps the exact reviewed JPEGs. Rendering is server-side; browsers choose
// known presets and CRM photos, never upload replacement property visuals.
export async function renderSocialImages(env, post) {
	check(env.IMAGES && env.PHOTO_BUCKET, 'image_storage_not_configured', 503);
	const creative = normalizeCreative(typeof post.creative === 'string' ? JSON.parse(post.creative) : post.creative);
	check(creative, 'invalid_creative');
	const slides = buildSlidePlan(post);
	check(slides.length >= 1 && slides.length <= 10, 'carousel_1_to_10_slides');
	const batch = crypto.randomUUID();
	const keys = [];
	const cache = new Map();
	const asset = async name => {
		if (!cache.has(name)) {
			const response = await env.ASSETS.fetch(new Request(new URL(name, 'https://four-walls.gr')));
			check(response.ok, 'creative_asset_missing', 503);
			cache.set(name, await response.arrayBuffer());
		}
		return cache.get(name);
	};
	for (const [i, slide] of slides.entries()) {
		const height = post.template === 'portrait' ? 1350 : 1080;
		let rendered;
		if (creative.preset === 'classic') {
			const source = await socialPhotoInput(env, slide.photo, creative.crop);
			const logo = await env.ASSETS.fetch(new Request('https://four-walls.gr/images/logo/fourwalls_watermark.png'));
			check(logo.ok, 'logo_missing', 503);
			rendered = await source
				.transform({ width: 1080, height: height - 180, fit: 'cover' })
				.transform({ border: { bottom: 168, top: 0, left: 0, right: 0, color: NAVY } })
				.transform({ border: { bottom: 12, top: 0, left: 0, right: 0, color: PINK } })
				.draw(env.IMAGES.input(logo.body).transform({ width: 350 }), { bottom: 40, right: 40 })
				.output({ format: 'image/jpeg', quality: 90 });
		} else rendered = await renderPreset(env, post, slide, creative, height, asset);
		const bytes = await rendered.response().arrayBuffer();
		check(bytes.byteLength <= 8 * 1024 * 1024, 'render_too_large', 502);
		const key = `social/${post.id}/${batch}/${i}.jpg`;
		await env.PHOTO_BUCKET.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
		keys.push(key);
	}
	return keys;
}

export async function signedMediaUrl(env, key) {
	check(env.PHOTO_SIGN_KEY, 'signing_not_configured', 503);
	const path = `/api/social-media/${key}`;
	const exp = String(Math.floor(Date.now() / 1000) + 86400);
	return `https://four-walls.gr${path}?exp=${exp}&sig=${await hmac(env, `${path}:${exp}`)}`;
}

export async function serveSocialMedia(request, env, url) {
	if (url.hostname !== 'four-walls.gr' || request.method !== 'GET' || !env.PHOTO_SIGN_KEY || !env.PHOTO_BUCKET) return new Response('Not Found', { status: 404 });
	const exp = url.searchParams.get('exp') || '';
	const sig = url.searchParams.get('sig') || '';
	const now = Math.floor(Date.now() / 1000);
	if (!/^\d+$/.test(exp) || +exp < now || +exp > now + 86400 || !safeEqual(sig, await hmac(env, `${url.pathname}:${exp}`))) return new Response('Forbidden', { status: 403 });
	const key = url.pathname.slice('/api/social-media/'.length);
	if (!/^social\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/\d\.jpg$/.test(key)) return new Response('Not Found', { status: 404 });
	const object = await env.PHOTO_BUCKET.get(key);
	return object ? new Response(object.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } }) : new Response('Not Found', { status: 404 });
}
