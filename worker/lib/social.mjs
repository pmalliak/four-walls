import { json, requireAccess } from './access.mjs';
import { apiConfig, mapListing } from './estateprime.mjs';
import { publicProperty, fingerprint, greekCaption, validateDraft, check, SocialError, liveReady, metaReady } from './social-model.mjs';
import { renderSocialImages, signedMediaUrl } from './social-media.mjs';
import { testMeta } from './social-meta-test.mjs';
import { websiteDestination } from './social-creative.mjs';
import { marketplacePackage } from './social-package.mjs';
import { logSocialFailure } from './social-diagnostics.mjs';

const now = () => new Date().toISOString();
const editable = ['draft', 'pending', 'approved', 'scheduled', 'blocked'];
export const statement = (env, sql, ...args) => env.SOCIAL_DB.prepare(sql).bind(...args);
export const getPost = (env, id) => statement(env, 'SELECT * FROM social_posts WHERE id = ?', id).first();

// Optimistic revision check and audit insertion form one D1 transaction.
export async function mutate(env, post, changes, actor, kind, detail = '') {
	const entries = Object.entries({ ...changes, updated_at: now() });
	const result = await env.SOCIAL_DB.batch([
		statement(env, `UPDATE social_posts SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, revision = revision + 1 WHERE id = ? AND revision = ?`, ...entries.map(([, v]) => v), post.id, post.revision),
		statement(env, `INSERT INTO social_events(post_id,revision,kind,actor,detail,created_at)
		 SELECT id,revision,?,?,?,? FROM social_posts WHERE id = ? AND changes() = 1`, kind, actor, detail, now(), post.id),
	]);
	check(result[0].meta.changes === 1, 'revision_conflict_reload', 409);
	return getPost(env, post.id);
}

export async function readFeed(env) {
	const feed = await env.LISTINGS_KV.get('listings.json', 'json');
	const age = Date.now() - Date.parse(feed?.generatedAt);
	check(feed && Array.isArray(feed.listings) && Number.isFinite(age) && age >= -60000 && age <= 30 * 60000, 'feed_missing_or_stale', 503);
	check(feed.listings.every(p => Array.isArray(p.originalImages)), 'photo_sources_pending_sync', 503);
	return { generatedAt: feed.generatedAt, source: feed.source, listings: feed.listings.map(publicProperty).filter(p => p.images.length) };
}

export async function currentProperty(env, id) {
	const p = (await readFeed(env)).listings.find(p => p.id === id);
	check(p, 'property_unavailable', 409);
	return p;
}

// Fail closed on missing/unknown status, unexpected envelope, or stale content.
export async function verifyLiveProperty(env, post) {
	check(env.SAMPLE_DATA !== '1', 'sample_data_cannot_publish', 409);
	const { base, headers } = apiConfig(env);
	const res = await fetch(`${base}/listings/${encodeURIComponent(post.property_id)}`, { headers, signal: AbortSignal.timeout(15000) });
	check(res.ok, 'crm_verification_failed', 503);
	const raw = (await res.json()).data;
	check(raw && !Array.isArray(raw) && String(raw.id) === post.property_id && raw.status === 'active', 'property_unavailable', 409);
	const p = publicProperty(mapListing(raw));
	check(await fingerprint(p) === post.fingerprint, 'property_changed_reapprove', 409);
	check(post.photos_confirmed_clean === 1, 'clean_photos_confirmation_required', 409);
	validateDraft({ ...post, photos: JSON.parse(post.photos), creative: JSON.parse(post.creative) }, p);
	return p;
}

function serialize(post) {
	return { ...post, websiteLink: websiteDestination(post), photos_confirmed_clean: post.photos_confirmed_clean === 1, creative: JSON.parse(post.creative), photos: JSON.parse(post.photos), snapshot: JSON.parse(post.snapshot), assets: JSON.parse(post.assets).map((_, i) => `/api/social/posts/${post.id}/image/${i}`) };
}
function reviewers(env) { return (env.SOCIAL_APPROVERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean); }

async function bodyJSON(request) {
	check(request.headers.get('Content-Type')?.split(';')[0] === 'application/json', 'json_required', 415);
	check(Number(request.headers.get('Content-Length') || 0) <= 32768, 'body_too_large', 413);
	const text = await request.text();
	check(text.length <= 32768, 'body_too_large', 413);
	try { return JSON.parse(text); } catch { throw new SocialError('invalid_json'); }
}

export async function handleSocial(request, env, url) {
	let stage = 'authenticate';
	try {
		// Deliberately stricter than the legacy dev bypass: never unlock another host.
		const local = ['localhost', '127.0.0.1'].includes(url.hostname);
		if (url.hostname !== 'forms.four-walls.gr' && !local) return new Response('Not Found', { status: 404 });
		const auth = await requireAccess(request, local ? env : { ...env, CRM_DEV_BYPASS: undefined }, url);
		if (auth.denied) return auth.denied;
		const actor = auth.email || (local ? 'local-developer' : null);
		check(actor, 'human_session_required', 403);
		if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) return json({ error: 'method_not_allowed' }, 405);
		if (request.method !== 'GET') check(request.headers.get('Origin') === url.origin, 'same_origin_required', 403);
		if (!url.pathname.startsWith('/api/social/')) {
			stage = 'serve_asset';
			const name = url.pathname.replace(/^\/forms/, '');
			const allowed = ['/social', '/social.html', '/social.fw.js', '/social.fw.css'];
			check(allowed.includes(name), 'not_found', 404);
			check(request.method === 'GET', 'method_not_allowed', 405);
			// Keep clean paths clean: Assets redirects .html to the extensionless
			// URL, so rewriting /social to .html would redirect back to itself.
			const response = await env.ASSETS.fetch(new Request(new URL(`/forms${name}`, url), request));
			const headers = new Headers(response.headers);
			const location = headers.get('Location');
			if (location?.startsWith('/forms/')) headers.set('Location', location.slice(6));
			headers.set('Cache-Control', 'private, no-store');
			headers.set('X-Robots-Tag', 'noindex, nofollow');
			headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
			return new Response(response.body, { status: response.status, headers });
		}
		stage = 'database_check';
		check(env.SOCIAL_DB, 'social_database_not_configured', 503);
		const path = url.pathname.slice('/api/social'.length);
		if (path === '/bootstrap' && request.method === 'GET') {
			stage = 'load_feed';
			return json({ feed: await readFeed(env), canApprove: reviewers(env).includes(actor.toLowerCase()), live: liveReady(env), canTest: metaReady(env), actor });
		}
		if (path === '/posts' && request.method === 'GET') {
			stage = 'list_posts';
			const rows = await statement(env, 'SELECT * FROM social_posts ORDER BY updated_at DESC LIMIT 100').all();
			stage = 'serialize_post';
			return json({ posts: rows.results.map(serialize) });
		}
		if (path === '/posts' && request.method === 'POST') {
			stage = 'parse_request';
			const input = await bodyJSON(request);
			stage = 'load_feed';
			const p = await currentProperty(env, String(input.property_id));
			const id = crypto.randomUUID(), stamp = now();
			const creative = input.creative ?? { preset: 'architectural', version: 1, includeFacts: true, includeCta: true, destination: 'property' };
			const link = websiteDestination({ id, channel: input.channel, snapshot: p, creative });
			const draft = validateDraft({ ...input, creative, caption: input.caption ?? greekCaption(p, link), photos: input.photos ?? p.images.slice(0, 1) }, p);
			stage = 'create_draft';
			await statement(env, `INSERT INTO social_posts(id,property_id,channel,template,caption,photos,creative,snapshot,fingerprint,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
				id, p.id, draft.channel, draft.template, draft.caption, JSON.stringify(draft.photos), JSON.stringify(draft.creative), JSON.stringify(p), await fingerprint(p), actor, stamp, stamp).run();
			stage = 'load_post';
			const post = await getPost(env, id);
			stage = 'serialize_post';
			return json(serialize(post), 201);
		}
		const match = path.match(/^\/posts\/([a-f0-9-]{36})(?:\/(submit|approve|test|schedule|cancel|resolve|history|package|image\/\d))?$/);
		check(match, 'not_found', 404);
		stage = 'load_post';
		let post = await getPost(env, match[1]);
		check(post, 'not_found', 404);
		const action = match[2];
		if (request.method === 'GET') {
			stage = 'serialize_post';
			if (!action) return json(serialize(post));
			if (action === 'history') {
				stage = 'load_history';
				return json((await statement(env, 'SELECT * FROM social_events WHERE post_id = ? ORDER BY id DESC', post.id).all()).results);
			}
			if (action?.startsWith('image/')) {
				stage = 'load_image';
				const key = JSON.parse(post.assets)[Number(action.split('/')[1])];
				check(key && env.PHOTO_BUCKET, 'image_not_found', 404);
				const object = await env.PHOTO_BUCKET.get(key);
				check(object, 'image_not_found', 404);
				return new Response(object.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'Content-Disposition': `attachment; filename="fourwalls-${post.id}-${action.split('/')[1]}.jpg"` } });
			}
			throw new SocialError('method_not_allowed', 405);
		}
		stage = 'parse_request';
		const input = await bodyJSON(request);
		check(input.revision === post.revision, 'revision_conflict_reload', 409);
		if (request.method === 'DELETE' && !action) {
			check([...editable, 'cancelled'].includes(post.status) && !post.remote_id, 'post_not_deletable', 409);
			stage = 'delete_post';
			// Both deletes share a transaction and the same guard, so a scheduler
			// claim or concurrent edit preserves the post and its history.
			const guard = "id = ? AND revision = ? AND status IN ('draft','pending','approved','scheduled','blocked','cancelled') AND remote_id IS NULL";
			const results = await env.SOCIAL_DB.batch([
				statement(env, `DELETE FROM social_events WHERE post_id IN (SELECT id FROM social_posts WHERE ${guard})`, post.id, post.revision),
				statement(env, `DELETE FROM social_posts WHERE ${guard}`, post.id, post.revision),
			]);
			check(results[1].meta.changes === 1, 'revision_conflict_reload', 409);
			return json({ deleted: true });
		}
		stage = 'validate_property';
		if (request.method === 'PATCH' && !action) {
			check(editable.includes(post.status), 'post_not_editable', 409);
			const p = await currentProperty(env, post.property_id);
			const draft = validateDraft(input, p);
			stage = 'save_post';
			check(input.photos_confirmed_clean === undefined || typeof input.photos_confirmed_clean === 'boolean', 'invalid_photo_confirmation');
			post = await mutate(env, post, { ...draft, photos_confirmed_clean: input.photos_confirmed_clean === true ? 1 : 0, creative: JSON.stringify(draft.creative), photos: JSON.stringify(draft.photos), snapshot: JSON.stringify(p), fingerprint: await fingerprint(p), assets: '[]', status: 'draft', approved_by: null, scheduled_at: null, error: null }, actor, 'edited');
		} else if (request.method === 'POST' && action === 'submit') {
			check(post.status === 'draft', 'draft_required', 409);
			const p = await currentProperty(env, post.property_id);
			check(await fingerprint(p) === post.fingerprint, 'property_changed_save_again', 409);
			check(post.photos_confirmed_clean === 1, 'clean_photos_confirmation_required', 409);
			validateDraft({ ...post, photos: JSON.parse(post.photos), creative: JSON.parse(post.creative) }, p);
			stage = 'render_images';
			const assets = await renderSocialImages(env, post);
			stage = 'save_submission';
			post = await mutate(env, post, { assets: JSON.stringify(assets), status: 'pending' }, actor, 'submitted');
		} else if (request.method === 'POST' && action === 'approve') {
			check(reviewers(env).includes(actor.toLowerCase()), 'approver_required', 403);
			check(post.status === 'pending', 'pending_required', 409);
			check(await fingerprint(await currentProperty(env, post.property_id)) === post.fingerprint, 'property_changed_reapprove', 409);
			check(post.photos_confirmed_clean === 1, 'clean_photos_confirmation_required', 409);
			stage = 'save_post';
			post = await mutate(env, post, { status: 'approved', approved_by: actor }, actor, 'approved');
		} else if (request.method === 'POST' && action === 'test') {
			check(reviewers(env).includes(actor.toLowerCase()), 'approver_required', 403);
			check(metaReady(env), 'meta_not_configured', 503);
			check(post.status === 'approved' && post.channel !== 'marketplace', 'approved_social_post_required', 409);
			check(!await statement(env, "SELECT id FROM social_events WHERE post_id = ? AND revision = ? AND kind = 'meta_test_started'", post.id, post.revision).first(), 'meta_test_already_attempted', 409);
			stage = 'verify_crm';
			await verifyLiveProperty(env, post);
			const assets = JSON.parse(post.assets);
			check(assets.length >= 1 && assets.length <= 10, 'invalid_media_count');
			const urls = await Promise.all(assets.map(key => signedMediaUrl(env, key)));
			// Claim with optimistic revision before contacting Meta. An ambiguous
			// failure stays recorded and is never automatically retried.
			post = await mutate(env, post, {}, actor, 'meta_test_started');
			const checkpoint = (kind, detail) => statement(env,
				'INSERT INTO social_events(post_id,revision,kind,actor,detail,created_at) VALUES(?,?,?,?,?,?)',
				post.id, post.revision, kind, actor, detail, now()).run();
			stage = 'test_meta';
			try {
				const result = await testMeta(env, post, urls, checkpoint);
				await checkpoint(result.result, result.id);
			} catch (error) {
				await checkpoint('meta_test_failed', 'Check recorded Meta IDs before preparing a new version.');
				throw error;
			}
		} else if (request.method === 'POST' && action === 'schedule') {
			check(post.status === 'approved' && post.channel !== 'marketplace', 'approved_social_post_required', 409);
			check(await fingerprint(await currentProperty(env, post.property_id)) === post.fingerprint, 'property_changed_reapprove', 409);
			check(post.photos_confirmed_clean === 1, 'clean_photos_confirmation_required', 409);
			check(typeof input.at === 'string' && /Z$/.test(input.at) && Number.isFinite(Date.parse(input.at)) && Date.parse(input.at) >= Date.now() - 60000, 'future_utc_time_required');
			stage = 'save_post';
			post = await mutate(env, post, { status: 'scheduled', scheduled_at: new Date(input.at).toISOString() }, actor, 'scheduled');
		} else if (request.method === 'POST' && action === 'cancel') {
			check(editable.includes(post.status), 'cannot_cancel', 409);
			stage = 'save_post';
			post = await mutate(env, post, { status: 'cancelled', scheduled_at: null }, actor, 'cancelled');
		} else if (request.method === 'POST' && action === 'resolve') {
			check(reviewers(env).includes(actor.toLowerCase()), 'approver_required', 403);
			check(post.status === 'needs_review', 'review_required', 409);
			check(['published', 'cancelled'].includes(input.outcome), 'invalid_outcome');
			check(input.outcome !== 'published' || /^[\d_]+$/.test(input.remote_id || ''), 'remote_id_required');
			stage = 'save_post';
			post = await mutate(env, post, { status: input.outcome, remote_id: input.outcome === 'published' ? input.remote_id : null, error: null }, actor, 'manually_resolved', input.outcome);
		} else if (request.method === 'POST' && action === 'package') {
			check(post.channel === 'marketplace' && post.status === 'approved', 'approved_marketplace_required', 409);
			stage = 'verify_crm';
			const p = await verifyLiveProperty(env, post);
			stage = 'record_export';
			await statement(env, 'INSERT INTO social_events(post_id,revision,kind,actor,created_at) VALUES(?,?,?,?,?)', post.id, post.revision, 'marketplace_exported', actor, now()).run();
			stage = 'build_package';
			return await marketplacePackage(env, post, p);
		} else throw new SocialError('method_not_allowed', 405);
		stage = 'serialize_post';
		return json(serialize(post));
	} catch (error) {
		// Upstream responses may contain secrets; never relay them or log tokens.
		const expected = error instanceof SocialError;
		const status = expected ? error.status : 502;
		const errorId = status >= 500 ? logSocialFailure(error, request, url, stage) : undefined;
		return json({ error: expected ? error.message : 'social_operation_failed', ...(errorId ? { errorId } : {}) }, status);
	}
}

export async function reconcileSocial(env, feed) {
	if (!env.SOCIAL_DB || feed.source !== 'estateprime') return;
	const present = new Map(feed.listings.map(publicProperty).filter(p => p.images.length).map(p => [p.id, p]));
	const rows = (await statement(env, 'SELECT * FROM social_posts').all()).results;
	for (const post of rows) {
		const p = present.get(post.property_id);
		const hash = p ? await fingerprint(p) : '';
		const previous = await statement(env, 'SELECT * FROM social_property_state WHERE property_id = ?', post.property_id).first();
		if (!previous || previous.fingerprint !== hash || previous.available !== Number(!!p)) {
			await env.SOCIAL_DB.batch([
				statement(env, `INSERT INTO social_property_state VALUES(?,?,?,?) ON CONFLICT(property_id) DO UPDATE SET fingerprint=excluded.fingerprint,available=excluded.available,observed_at=excluded.observed_at`, post.property_id, hash, Number(!!p), feed.generatedAt),
				statement(env, `INSERT INTO social_events(post_id,revision,kind,actor,detail,created_at) SELECT id,revision,'property_observed','estateprime',?,? FROM social_posts WHERE property_id=?`, p ? 'available' : 'unavailable', now(), post.property_id),
			]);
		}
		if (editable.includes(post.status) && post.status !== 'blocked' && hash !== post.fingerprint) {
			try { await mutate(env, post, { status: 'blocked', approved_by: null, scheduled_at: null, error: p ? 'property_changed_reapprove' : 'property_unavailable' }, 'estateprime', 'blocked'); }
			catch (e) { if (e.message !== 'revision_conflict_reload') throw e; }
		}
	}
}
