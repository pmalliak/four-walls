import { hmac, safeEqual } from './signing.mjs';
import { check } from './social-model.mjs';
import { normalizeCreative, buildSlidePlan, slideLayout, wrapSocialText, websiteDestination } from './social-creative.mjs';

const NAVY = '#1C3457', PINK = '#FF0062';
const stream = bytes => new Blob([bytes]).stream();

async function sourcePhoto(photo) {
	// Workers supports only manual/follow. Never follow a redirect, switch to a
	// watermark URL, or replace a failed original with another photograph.
	const response = await fetch(photo, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
	check(response.ok && /^image\//.test(response.headers.get('Content-Type') || ''), 'photo_fetch_failed', 502);
	return response.body;
}

// The font assets are public, license-cleared typefaces supporting Greek.
// The optional origin is for an isolated preview Worker, never a browser input.
function textLines(env, queue, value, { left = 64, top, width = 950, size = 42, color = NAVY, serif = false, columns = 36, lines = 1 }) {
	const font = new URL(`/images/social/${serif ? 'GFSDidot-Regular.ttf' : 'NotoSans.ttf'}`, env.SOCIAL_ASSET_ORIGIN || 'https://four-walls.gr').href;
	for (const [i, line] of wrapSocialText(value, columns, lines).entries()) {
		queue.push({ line, font, size, color, width, left, top: top + i * Math.ceil(size * 1.25) });
	}
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
		const { line, font, size, color, width, left, top } = item;
		const text = env.IMAGES.text(line, { font: { url: font }, size, color })
			.transform({ width, height: Math.ceil(size * 1.35), fit: 'scale-down' });
		canvas = canvas.draw(text, { left, top });
		if ((i + 1) % 3 === 0 && i + 1 < queue.length) canvas = await flatten(env, canvas);
	}
	return canvas.output({ format: 'image/jpeg', quality: 90 });
}

function propertyPrice(property) {
	if (typeof property.price !== 'number' || !Number.isFinite(property.price)) return 'Τιμή κατόπιν επικοινωνίας';
	return `€${property.price.toLocaleString('el-GR')}${property.transaction === 'rent' ? '/μήνα' : ''}`;
}

async function renderPreset(env, post, slide, creative, height, asset) {
	check(typeof env.IMAGES.text === 'function', 'image_text_not_available', 503);
	const p = typeof post.snapshot === 'string' ? JSON.parse(post.snapshot) : post.snapshot;
	const layout = slideLayout(creative.preset, slide.kind, height);
	const frame = await asset(`${creative.preset}-${slide.kind}${height === 1080 ? '-square' : ''}.png`);
	let canvas = env.IMAGES.input(stream(frame)).transform({ width: 1080, height, fit: 'cover' });
	if (slide.photo) {
		const box = layout.photo;
		canvas = canvas.draw(env.IMAGES.input(await sourcePhoto(slide.photo)).transform({ width: box.width, height: box.height, fit: 'cover' }), { left: box.left, top: box.top })
			.draw(env.IMAGES.input(stream(frame)), { left: 0, top: 0 });
	}
	const logo = await asset('logo-vertical.png');
	const logoBox = slide.kind === 'cover' ? layout.logo : slide.kind === 'photo' ? { left: 848, top: height - 168, width: 150 } : { left: 64, top: 64, width: 190 };
	canvas = canvas.draw(env.IMAGES.input(stream(logo)).transform({ width: logoBox.width }), { left: logoBox.left, top: logoBox.top });
	const location = [p.location?.area, p.location?.city].filter(Boolean).join(', ');
	const text = [];
	if (slide.kind === 'cover') {
		textLines(env, text, p.title, { top: layout.titleTop, width: layout.titleWidth, size: layout.titleSize, serif: true, columns: layout.titleChars, lines: 2 });
		textLines(env, text, location, { top: layout.locationTop, width: 940, size: 30, columns: 58 });
		textLines(env, text, propertyPrice(p), { top: layout.priceTop, width: creative.preset === 'neighbourhood' ? 720 : 940, size: 50, color: PINK, serif: true, columns: 32 });
		textLines(env, text, `Κωδικός ${p.code || p.id}`, { top: layout.codeTop, width: 720, size: 24, columns: 50 });
	} else if (slide.kind === 'photo') {
		textLines(env, text, p.title, { top: height - 155, width: 730, size: 32, columns: 42, lines: 2 });
		textLines(env, text, `Κωδικός ${p.code || p.id}`, { top: height - 58, width: 730, size: 23, columns: 48 });
	} else if (slide.kind === 'facts') {
		textLines(env, text, 'Στοιχεία ακινήτου', { top: 270, size: 58, serif: true, columns: 30 });
		const facts = [
			...(typeof p.area === 'number' && Number.isFinite(p.area) && p.area > 0 ? [['ΕΜΒΑΔΟΝ', `${p.area.toLocaleString('el-GR')} τ.μ.`]] : []),
			...(location ? [['ΠΕΡΙΟΧΗ', location]] : []),
			['ΤΙΜΗ', propertyPrice(p)], ['ΚΩΔΙΚΟΣ ΑΚΙΝΗΤΟΥ', p.code || p.id],
		];
		for (const [i, [label, value]] of facts.entries()) {
			const top = (height === 1350 ? 458 : 365) + i * (height === 1350 ? 160 : 150);
			textLines(env, text, label, { top, size: 22, color: PINK, columns: 40 });
			textLines(env, text, value, { top: top + 36, size: 38, columns: 48, lines: 2 });
		}
	} else {
		const color = creative.preset === 'editorial' ? '#FFFFFF' : NAVY;
		const top = height === 1350 ? 400 : 265;
		const destination = websiteDestination(post);
		if (destination) {
			const copy = {
				property: ['Δείτε το', 'ακίνητο', 'Φωτογραφίες και πληροφορίες'],
				request: ['Ψάχνετε', 'ακίνητο;', 'Συμπληρώστε το αίτημά σας'],
				sell: ['Θέλετε να', 'πουλήσετε;', 'Στείλτε τα στοιχεία του ακινήτου'],
			}[creative.destination];
			textLines(env, text, copy[0], { top, size: 88, width: 620, serif: true, color, columns: 20 });
			textLines(env, text, copy[1], { top: top + 105, size: 88, width: 620, serif: true, color, columns: 20 });
			textLines(env, text, copy[2], { top: top + 295, size: 33, width: 630, color, columns: 32, lines: 2 });
			textLines(env, text, destination.shortUrl, { top: top + 415, size: 30, width: 630, color, columns: 32, lines: 3 });
			if (post.channel === 'instagram' && creative.destination === 'property') {
				// A carousel image has no clickable link and we do not assume that
				// staff have already updated the account's bio or posted a Story.
				textLines(env, text, 'Ή ζητήστε τον σύνδεσμο', { top: top + 555, size: 26, width: 630, color, columns: 34 });
				textLines(env, text, `με κωδικό ${p.code || p.id}`, { top: top + 610, size: 26, width: 630, color, columns: 40, lines: 2 });
			}
		} else {
			textLines(env, text, 'Θέλετε να', { top, size: 88, width: 620, serif: true, color, columns: 20 });
			textLines(env, text, 'το δείτε;', { top: top + 105, size: 88, width: 620, serif: true, color, columns: 20 });
			textLines(env, text, 'Στείλτε μας μήνυμα', { top: top + 295, size: 35, width: 630, color, columns: 25 });
			textLines(env, text, 'με τον κωδικό', { top: top + 352, size: 35, width: 630, color, columns: 25 });
			textLines(env, text, p.code || p.id, { top: top + 415, size: 44, width: 630, color, columns: 40, lines: 2 });
		}
		textLines(env, text, 'four-walls.gr', { top: height - 105, size: 28, width: 600, color, columns: 30 });
	}
	return finishText(env, canvas, text);
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
			const response = await env.ASSETS.fetch(new Request(`https://four-walls.gr/images/social/${name}`));
			check(response.ok, 'creative_asset_missing', 503);
			cache.set(name, await response.arrayBuffer());
		}
		return cache.get(name);
	};
	for (const [i, slide] of slides.entries()) {
		const height = post.template === 'portrait' ? 1350 : 1080;
		let rendered;
		if (creative.preset === 'classic') {
			const source = await sourcePhoto(slide.photo);
			const logo = await env.ASSETS.fetch(new Request('https://four-walls.gr/images/logo/fourwalls_watermark.png'));
			check(logo.ok, 'logo_missing', 503);
			rendered = await env.IMAGES.input(source)
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
