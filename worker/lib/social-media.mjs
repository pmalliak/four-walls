import { hmac, safeEqual } from './signing.mjs';
import { check } from './social-model.mjs';

// Reuse the existing Images binding and brand watermark; R2 keeps the exact
// reviewed JPEGs. Rendering is server-side: browsers never upload replacements.
export async function renderSocialImages(env, post) {
	check(env.IMAGES && env.PHOTO_BUCKET, 'image_storage_not_configured', 503);
	const batch = crypto.randomUUID();
	const keys = [];
	for (const [i, photo] of JSON.parse(post.photos).entries()) {
		const source = await fetch(photo, { redirect: 'error', signal: AbortSignal.timeout(15000) });
		check(source.ok && /^image\//.test(source.headers.get('Content-Type') || ''), 'photo_fetch_failed', 502);
		const logo = await env.ASSETS.fetch(new Request('https://four-walls.gr/images/logo/fourwalls_watermark.png'));
		check(logo.ok, 'logo_missing', 503);
		const height = post.template === 'portrait' ? 1350 : 1080;
		// A transparent border adds a navy footer without distorting the photo.
		const rendered = await env.IMAGES.input(source.body)
			.transform({ width: 1080, height: height - 180, fit: 'cover' })
			.transform({ border: { bottom: 168, top: 0, left: 0, right: 0, color: '#1C3457' } })
			.transform({ border: { bottom: 12, top: 0, left: 0, right: 0, color: '#FF0062' } })
			.draw(env.IMAGES.input(logo.body).transform({ width: 350 }), { bottom: 40, right: 40 })
			.output({ format: 'image/jpeg', quality: 90 });
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
