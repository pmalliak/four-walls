import { check, SocialError, metaReady } from './social-model.mjs';

const stmt = (env, sql, ...args) => env.SOCIAL_DB.prepare(sql).bind(...args);
const parse = value => { try { return JSON.parse(value); } catch { return {}; } };
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function safePlatformLink(value, channel) {
	try {
		const u = new URL(value);
		const domains = channel === 'facebook' ? ['facebook.com', 'www.facebook.com'] : ['instagram.com', 'www.instagram.com'];
		if (u.protocol !== 'https:' || u.username || u.password || u.port || !domains.includes(u.hostname)) return null;
		for (const key of [...u.searchParams.keys()]) if (!['id', 'story_fbid'].includes(key)) u.searchParams.delete(key);
		u.hash = '';
		return u.href;
	} catch { return null; }
}

export async function platformTargets(env, post) {
	const events = (await stmt(env, 'SELECT * FROM social_events WHERE post_id=? ORDER BY id', post.id).all()).results;
	const targets = new Map();
	if (post.remote_id && ['published', 'cancelled', 'needs_review'].includes(post.status)) targets.set(post.remote_id, { id: post.remote_id, kind: 'post' });
	for (const event of events) {
		if (post.channel === 'facebook' && event.kind === 'facebook_draft_verified') targets.set(event.detail, { id: event.detail, kind: 'draft' });
		if (post.channel === 'instagram' && event.kind === 'instagram_container_ready') targets.set(event.detail, { id: event.detail, kind: 'container' });
	}
	for (const event of events) {
		if (!event.kind.startsWith('platform_')) continue;
		const data = parse(event.detail), target = targets.get(data.id);
		if (!target) continue;
		if (event.kind === 'platform_snapshot') target.snapshot = data;
		if (event.kind === 'platform_edited') target.snapshot = null;
		if (event.kind === 'platform_started') target.pending = data;
		if (['platform_edited', 'platform_deleted', 'platform_rejected'].includes(event.kind) && target.pending?.requestId === data.requestId) target.pending = null;
		if (event.kind === 'platform_deleted') target.deleted = true;
	}
	return [...targets.values()].filter(t => post.channel === 'facebook' ? new RegExp(`^${env.META_PAGE_ID}_\\d+$`).test(t.id) : /^\d+$/.test(t.id)).map(t => ({ ...t,
		url: t.kind === 'container' || t.deleted ? null : t.kind === 'draft' ? null : t.snapshot?.url || (post.channel === 'facebook' ? `https://www.facebook.com/${t.id}` : null),
		manageUrl: post.channel === 'facebook' ? `https://business.facebook.com/latest/posts/${t.kind === 'draft' ? 'draft_posts' : 'published_posts'}?asset_id=${env.META_PAGE_ID}` : t.snapshot?.url || null,
	}));
}

async function graph(env, id, fields = {}, method = 'GET', insights = false) {
	check(metaReady(env), 'meta_not_configured', 503);
	check(/^[\d_]+$/.test(id), 'invalid_meta_id');
	const url = new URL(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${id}${insights ? '/insights' : ''}`);
	if (method === 'GET') url.search = new URLSearchParams(fields).toString();
	const response = await fetch(url, { method, headers: { Authorization: `Bearer ${env.META_PAGE_ACCESS_TOKEN}` },
		body: method === 'GET' ? undefined : new URLSearchParams(fields), redirect: 'manual', signal: AbortSignal.timeout(20000) });
	const data = await response.json();
	if (!response.ok || data.error) {
		const code = Number(data.error?.code);
		const error = new SocialError([10, 200, 190].includes(code) ? 'meta_permission_or_token_required' : 'meta_request_rejected', 502);
		// Only a concrete Graph error confirms rejection. Network failures and
		// malformed responses remain ambiguous after a write.
		error.definite = !!data.error && response.status >= 400 && response.status < 500;
		throw error;
	}
	return data;
}

async function owned(env, post, target) {
	const data = await graph(env, target.id, { fields: post.channel === 'facebook' ? 'id,from,is_published,permalink_url,message' : 'id,owner,permalink,caption,media_type,like_count,comments_count' });
	check(String(post.channel === 'facebook' ? data.from?.id : data.owner?.id) === String(post.channel === 'facebook' ? env.META_PAGE_ID : env.META_IG_USER_ID), 'meta_owner_mismatch', 403);
	return data;
}

export async function recordPlatform(env, post, actor, kind, detail) {
	await stmt(env, 'INSERT INTO social_events(post_id,revision,kind,actor,detail,created_at) VALUES(?,?,?,?,?,?)', post.id, post.revision, kind, actor, JSON.stringify(detail), new Date().toISOString()).run();
}

export async function refreshPlatform(env, post, target, actor) {
	check(target.kind !== 'container' && !target.deleted, 'platform_statistics_unavailable', 409);
	if (target.snapshot && Date.now() - Date.parse(target.snapshot.fetchedAt) < 60000 && !target.pending) return target.snapshot;
	const data = await owned(env, post, target);
	const published = post.channel === 'instagram' || data.is_published === true;
	const snapshot = { id: target.id, fetchedAt: new Date().toISOString(), published,
		url: safePlatformLink(data.permalink_url || data.permalink, post.channel), caption: String(data.message ?? data.caption ?? '').slice(0, 2200), metrics: {}, issues: {} };
	if (published) {
		if (post.channel === 'instagram') {
			snapshot.metrics.likes = number(data.like_count); snapshot.metrics.comments = number(data.comments_count);
		} else {
			try {
				const counts = await graph(env, target.id, { fields: 'reactions.limit(0).summary(true),comments.limit(0).summary(true),shares' });
				snapshot.metrics.reactions = number(counts.reactions?.summary?.total_count);
				snapshot.metrics.comments = number(counts.comments?.summary?.total_count);
				snapshot.metrics.shares = number(counts.shares?.count);
			} catch { snapshot.issues.engagement = 'unavailable'; }
		}
		const metrics = post.channel === 'instagram' ? { views: 'views', reach: 'reach', saves: 'saved', shares: 'shares' } : { views: 'post_media_view', viewers: 'post_total_media_view_unique', clicks: 'post_clicks', linkClicks: 'post_clicks_by_type' };
		await Promise.all(Object.entries(metrics).map(async ([name, metric]) => {
			try {
				const response = await graph(env, target.id, { metric }, 'GET', true);
				const item = response.data?.find(item => item.name === metric);
				const value = item?.values?.[0]?.value ?? item?.total_value?.value;
				snapshot.metrics[name] = number(name === 'linkClicks' ? value?.['link clicks'] : value);
				if (snapshot.metrics[name] === null) snapshot.issues[name] = 'unavailable';
			} catch (error) { snapshot.metrics[name] = null; snapshot.issues[name] = error.message === 'meta_permission_or_token_required' ? 'permission_required' : 'unavailable'; }
		}));
	}
	await recordPlatform(env, post, actor, 'platform_snapshot', snapshot);
	// A read-back can resolve an ambiguous text edit without resending it.
	if (target.pending?.operation === 'edit' && snapshot.caption === target.pending.caption) await recordPlatform(env, post, actor, 'platform_edited', target.pending);
	return snapshot;
}

export async function changeFacebook(env, post, target, input, actor, claim) {
	check(post.channel === 'facebook' && target.kind !== 'container', 'platform_action_not_supported', 409);
	check(!target.deleted && !target.pending, 'platform_action_needs_review', 409);
	check(['edit', 'delete'].includes(input.operation), 'invalid_platform_operation');
	check(input.confirm_id === target.id, 'platform_confirmation_required');
	if (input.operation === 'edit') check(typeof input.caption === 'string' && input.caption.trim().length > 0 && input.caption.length <= 2200, 'caption_1_to_2200');
	const existing = await owned(env, post, target);
	// Do not unexpectedly edit a test draft that someone published in Meta.
	check(target.kind !== 'draft' || existing.is_published === false, 'meta_draft_was_published', 409);
	const detail = { id: target.id, requestId: crypto.randomUUID(), operation: input.operation, ...(input.operation === 'edit' ? { caption: input.caption.trim() } : {}) };
	post = await claim(detail);
	try {
		const result = await graph(env, target.id, input.operation === 'edit' ? { message: detail.caption } : {}, input.operation === 'edit' ? 'POST' : 'DELETE');
		check(result.success === true, 'meta_result_unconfirmed', 502);
		await recordPlatform(env, post, actor, input.operation === 'edit' ? 'platform_edited' : 'platform_deleted', detail);
		return { success: true };
	} catch (error) {
		await recordPlatform(env, post, actor, error.definite ? 'platform_rejected' : 'platform_uncertain', detail);
		throw new SocialError(error.definite ? error.message : 'platform_action_needs_review', 502);
	}
}
