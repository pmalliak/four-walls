import { check, metaReady } from './social-model.mjs';

// Separate transport: no caller-controlled paths or publishing parameters.
// Never calls media_publish, schedules content, or updates an existing object.
export async function testMeta(env, post, urls, checkpoint) {
	check(metaReady(env), 'meta_not_configured', 503);
	check(['instagram', 'facebook'].includes(post.channel), 'unsupported_channel');
	check(urls.length >= 1 && urls.length <= 10, 'invalid_media_count');
	const ids = new Set();
	async function request(path, fields, method = 'POST') {
		const allowed = method === 'GET' ? ids.has(path) :
			post.channel === 'instagram' ? path === `${env.META_IG_USER_ID}/media` :
			[path === `${env.META_PAGE_ID}/photos`, path === `${env.META_PAGE_ID}/feed`].some(Boolean) && fields.published === 'false' &&
			(path !== `${env.META_PAGE_ID}/feed` || fields.unpublished_content_type === 'DRAFT') && !fields.scheduled_publish_time;
		check(allowed, 'unsafe_meta_test_request');
		const url = new URL(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${path}`);
		if (method === 'GET') url.search = new URLSearchParams(fields).toString();
		const res = await fetch(url, { method, headers: { Authorization: `Bearer ${env.META_PAGE_ACCESS_TOKEN}` },
			body: method === 'GET' ? undefined : new URLSearchParams(fields), signal: AbortSignal.timeout(20000), redirect: 'manual' });
		const body = await res.json();
		check(res.ok && !body.error, `meta_http_${res.status}`, 502);
		return body;
	}
	async function create(path, fields) {
		const body = await request(path, fields);
		check(/^[\d_]+$/.test(body.id || ''), 'meta_missing_id', 502);
		ids.add(body.id);
		await checkpoint('meta_test_object', body.id);
		return body.id;
	}
	async function ready(id) {
		for (let i = 0; i < 5; i++) {
			const body = await request(id, { fields: 'status_code' }, 'GET');
			if (body.status_code === 'FINISHED') return;
			check(body.status_code === 'IN_PROGRESS', 'meta_container_failed', 502);
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
		check(false, 'meta_container_not_ready', 502);
	}
	const children = [];
	if (post.channel === 'instagram') {
		for (const url of urls) {
			const id = await create(`${env.META_IG_USER_ID}/media`, { image_url: url,
				...(urls.length > 1 ? { is_carousel_item: 'true' } : { caption: post.caption }) });
			await ready(id);
			children.push(id);
		}
		const id = children.length === 1 ? children[0] : await create(`${env.META_IG_USER_ID}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: post.caption });
		if (children.length > 1) await ready(id);
		return { id, result: 'instagram_container_ready' };
	}
	for (const url of urls) children.push(await create(`${env.META_PAGE_ID}/photos`, { url, published: 'false' }));
	const id = await create(`${env.META_PAGE_ID}/feed`, { message: post.caption, published: 'false', unpublished_content_type: 'DRAFT',
		attached_media: JSON.stringify(children.map(media_fbid => ({ media_fbid }))) });
	const result = await request(id, { fields: 'is_published' }, 'GET');
	check(result.is_published === false, 'meta_unpublished_not_confirmed', 502);
	return { id, result: 'facebook_draft_verified' };
}
