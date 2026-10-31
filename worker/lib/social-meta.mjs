import { check, liveReady } from './social-model.mjs';

// Meta Facebook Login: Page access token also grants the linked Instagram
// professional account. There are no Marketplace endpoints in this adapter.
export async function graph(env, path, fields, method = 'POST') {
	check(liveReady(env), 'live_publishing_disabled', 503);
	check(/^[\d_]+(?:\/(media|media_publish|photos|feed))?$/.test(path), 'invalid_meta_path');
	const url = new URL(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${path}`);
	if (method === 'GET') url.search = new URLSearchParams(fields).toString();
	const res = await fetch(url, {
		method, headers: { Authorization: `Bearer ${env.META_PAGE_ACCESS_TOKEN}` },
		body: method === 'GET' ? undefined : new URLSearchParams(fields),
		signal: AbortSignal.timeout(20000), redirect: 'error',
	});
	let body;
	try { body = await res.json(); } catch { throw new Error('meta_invalid_response'); }
	// Error text, request URLs and response bodies are deliberately not stored.
	check(res.ok && !body.error, `meta_http_${res.status}`, 502);
	return body;
}

async function created(env, path, fields, checkpoint) {
	const body = await graph(env, path, fields);
	check(/^[\d_]+$/.test(body.id || ''), 'meta_missing_id', 502);
	await checkpoint('meta_created', body.id);
	return body.id;
}

async function ready(env, id) {
	for (let i = 0; i < 5; i++) {
		const body = await graph(env, id, { fields: 'status_code' }, 'GET');
		if (body.status_code === 'FINISHED') return;
		check(body.status_code === 'IN_PROGRESS', 'meta_container_failed', 502);
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
	// Safe, conservative MVP: operator reviews instead of blindly retrying.
	throw new Error('meta_container_not_ready');
}

export async function publishMeta(env, post, urls, verify, checkpoint) {
	check(liveReady(env), 'live_publishing_disabled', 503);
	check(urls.length >= 1 && urls.length <= 10, 'invalid_media_count');
	if (post.channel === 'instagram') {
		const children = [];
		for (const url of urls) {
			const id = await created(env, `${env.META_IG_USER_ID}/media`, {
				image_url: url, ...(urls.length > 1 ? { is_carousel_item: 'true' } : { caption: post.caption }),
			}, checkpoint);
			await ready(env, id);
			children.push(id);
		}
		const container = children.length === 1 ? children[0] : await created(env, `${env.META_IG_USER_ID}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: post.caption }, checkpoint);
		if (children.length > 1) await ready(env, container);
		await verify();
		await checkpoint('publication_requested', container);
		return created(env, `${env.META_IG_USER_ID}/media_publish`, { creation_id: container }, checkpoint);
	}
	check(post.channel === 'facebook', 'unsupported_channel');
	const photos = [];
	for (const url of urls) photos.push(await created(env, `${env.META_PAGE_ID}/photos`, { url, published: 'false' }, checkpoint));
	await verify();
	await checkpoint('publication_requested', photos.join(','));
	return created(env, `${env.META_PAGE_ID}/feed`, { message: post.caption, attached_media: JSON.stringify(photos.map(media_fbid => ({ media_fbid }))) }, checkpoint);
}
