import test from 'node:test';
import assert from 'node:assert/strict';
import { environment } from './social-fixtures.mjs';
import { handleSocial, getPost } from '../worker/lib/social.mjs';
import { safePlatformLink } from '../worker/lib/social-platform.mjs';
const origin = 'http://localhost:8787';
async function call(env, path, method = 'GET', body) {
	const request = new Request(origin + '/api/social' + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
	return handleSocial(request, env, new URL(request.url));
}
async function fixture(t, channel = 'facebook', draft = false) {
	const env = environment(); t.after(() => env.SOCIAL_DB.close());
	const post = await (await call(env, '/posts', 'POST', { property_id: '123', channel, template: 'square' })).json();
	const id = channel === 'facebook' ? '99_1234' : '1234';
	if (draft) await env.SOCIAL_DB.prepare('INSERT INTO social_events(post_id,revision,kind,actor,detail,created_at) VALUES(?,?,?,?,?,?)').bind(post.id, post.revision, channel === 'facebook' ? 'facebook_draft_verified' : 'instagram_container_ready', 'tester', id, new Date().toISOString()).run();
	else await env.SOCIAL_DB.prepare("UPDATE social_posts SET status='published',remote_id=? WHERE id=?").bind(id, post.id).run();
	return { env, post: await getPost(env, post.id), id };
}
const operation = (f, kind, extra = {}) => call(f.env, `/posts/${f.post.id}/platform`, 'POST', { revision: f.post.revision, target_id: f.id, operation: kind, ...extra });

test('targets include verified drafts, exclude upload IDs, and preserve linked history', async t => {
	const f = await fixture(t, 'facebook', true);
	const targets = await (await call(f.env, `/posts/${f.post.id}/platform`)).json();
	assert.equal(targets.targets.length, 1); assert.equal(targets.targets[0].kind, 'draft');
	assert.equal(targets.targets[0].url, null);
	assert.ok(targets.targets[0].manageUrl.includes('draft_posts?asset_id=99'));
	assert.equal((await call(f.env, `/posts/${f.post.id}`, 'DELETE', { revision: f.post.revision })).status, 409);
	assert.equal((await operation(f, 'delete', { target_id: 'other' })).status, 404);
});
test('Facebook edits require confirmation, reviewer and ownership; send message only with live publishing off', async t => {
	const f = await fixture(t); let writes = 0;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		assert.equal(options.redirect, 'manual'); assert.ok(!String(url).includes('SECRET'));
		if (options.method === 'GET') return Response.json({ id: f.id, from: { id: '99' }, is_published: true });
		writes++; assert.equal(options.method, 'POST'); assert.deepEqual(Object.fromEntries(options.body), { message: 'Updated caption' });
		return Response.json({ success: true });
	});
	assert.equal((await operation(f, 'edit', { caption: 'Updated caption' })).status, 400);
	f.env.SOCIAL_APPROVERS = 'someone';
	assert.equal((await operation(f, 'edit', { caption: 'Updated caption', confirm_id: f.id })).status, 403);
	f.env.SOCIAL_APPROVERS = 'local-developer';
	assert.equal((await operation(f, 'edit', { caption: 'Updated caption', confirm_id: f.id })).status, 200);
	assert.equal(writes, 1);
	assert.equal((await operation(f, 'edit', { caption: 'Again', confirm_id: f.id })).status, 409);
	assert.equal((await getPost(f.env, f.post.id)).caption, f.post.caption);
});
test('ownership mismatch prevents writes and a published test draft is not changed unexpectedly', async t => {
	const f = await fixture(t, 'facebook', true); let writes = 0;
	t.mock.method(globalThis, 'fetch', async (url, opts) => { if (opts.method !== 'GET') writes++; return Response.json({ from: { id: '88' }, is_published: false }); });
	assert.equal((await operation(f, 'delete', { confirm_id: f.id })).status, 403);
	t.mock.method(globalThis, 'fetch', async () => Response.json({ from: { id: '99' }, is_published: true }));
	assert.equal((await operation(f, 'delete', { confirm_id: f.id })).status, 409);
	assert.equal(writes, 0);
});
test('deletion keeps an audit tombstone and prevents a second delete', async t => {
	const f = await fixture(t); let deletes = 0;
	t.mock.method(globalThis, 'fetch', async (url, opts) => {
		if (opts.method === 'GET') return Response.json({ from: { id: '99' }, is_published: true });
		assert.equal(opts.method, 'DELETE'); deletes++; return Response.json({ success: true });
	});
	const response = await operation(f, 'delete', { confirm_id: f.id }); assert.equal(response.status, 200);
	assert.equal((await response.json()).targets[0].deleted, true);
	f.post = await getPost(f.env, f.post.id); assert.equal(f.post.status, 'cancelled'); assert.equal(f.post.remote_id, f.id);
	assert.equal((await operation(f, 'delete', { confirm_id: f.id })).status, 409); assert.equal(deletes, 1);
});
test('ambiguous write remains locked across revisions and does not leak upstream errors', async t => {
	const f = await fixture(t); let writes = 0;
	t.mock.method(globalThis, 'fetch', async (url, opts) => {
		if (opts.method === 'GET') return Response.json({ from: { id: '99' }, is_published: true });
		writes++; throw new Error('SECRET-META-TOKEN');
	});
	const response = await operation(f, 'delete', { confirm_id: f.id }); assert.equal(response.status, 502);
	assert.ok(!(await response.text()).includes('SECRET'));
	f.post = await getPost(f.env, f.post.id);
	assert.equal((await operation(f, 'delete', { confirm_id: f.id })).status, 409); assert.equal(writes, 1);
});
test('statistics keep zeros, unavailable values, and permission failures distinct; cache avoids repeat calls', async t => {
	const f = await fixture(t, 'instagram'); let requests = 0;
	t.mock.method(globalThis, 'fetch', async url => {
		requests++; const u = new URL(url);
		if (!u.pathname.endsWith('/insights')) return Response.json({ owner: { id: '88' }, permalink: 'https://www.instagram.com/p/TEST/', like_count: 0, comments_count: 4 });
		const metric = u.searchParams.get('metric');
		if (metric === 'views') return Response.json({ error: { code: 10, message: 'SECRET' } }, { status: 403 });
		if (metric === 'saved') return Response.json({ data: [] });
		return Response.json({ data: [{ name: metric, values: [{ value: 12 }] }] });
	});
	let response = await operation(f, 'refresh'); assert.equal(response.status, 200);
	const snapshot = (await response.json()).targets[0].snapshot;
	assert.equal(snapshot.metrics.likes, 0); assert.equal(snapshot.metrics.saves, null); assert.equal(snapshot.metrics.reach, 12);
	assert.equal(snapshot.issues.views, 'permission_required'); assert.equal(snapshot.url, 'https://www.instagram.com/p/TEST/');
	await operation(f, 'refresh'); assert.equal(requests, 5);
	assert.equal((await operation(f, 'delete', { confirm_id: f.id })).status, 409);
});
test('unpublished drafts never request audience insights, and Instagram containers never call Meta', async t => {
	const f = await fixture(t, 'facebook', true); let requests = 0;
	t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ from: { id: '99' }, is_published: false }); });
	const response = await operation(f, 'refresh'); assert.equal(response.status, 200);
	assert.deepEqual((await response.json()).targets[0].snapshot.metrics, {}); assert.equal(requests, 1);
	const ig = await fixture(t, 'instagram', true); assert.equal((await operation(ig, 'refresh')).status, 409); assert.equal(requests, 1);
});
test('platform URLs reject hostile and token-bearing non-platform destinations', () => {
	for (const url of ['javascript:alert(1)', 'https://instagram.com.evil.test/p/x', 'https://evil.test/', 'https://x@instagram.com/p/x']) assert.equal(safePlatformLink(url, 'instagram'), null);
});
