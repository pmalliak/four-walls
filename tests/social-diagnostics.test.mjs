import test from 'node:test';
import assert from 'node:assert/strict';
import { environment } from './social-fixtures.mjs';
import { handleSocial } from '../worker/lib/social.mjs';
import { logSocialFailure } from '../worker/lib/social-diagnostics.mjs';

const origin = 'http://localhost:8787';
async function call(env, path, method = 'GET', body) {
	const request = new Request(`${origin}/api/social${path}?secret=PRIVATE_QUERY`, { method, headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: 'PRIVATE_TOKEN' }, body: body ? JSON.stringify(body) : undefined });
	return handleSocial(request, env, new URL(request.url));
}

test('unexpected database failures log a safe stage and matching response reference', async t => {
	const logs = [];
	t.mock.method(console, 'error', (...args) => logs.push(args));
	const env = environment();
	env.SOCIAL_DB.prepare = () => { throw new Error('D1_ERROR: PRIVATE_SQL PRIVATE_CAPTION PRIVATE_TOKEN'); };
	const response = await call(env, '/posts', 'POST', { property_id: '123', channel: 'instagram', template: 'square' });
	assert.equal(response.status, 502);
	const data = await response.json();
	assert.equal(data.error, 'social_operation_failed');
	assert.match(data.errorId, /^[a-f0-9-]{36}$/);
	assert.deepEqual(logs, [[{ event: 'social_operation_failed', errorId: data.errorId, method: 'POST', operation: 'posts', stage: 'create_draft', errorType: 'Error', code: 'D1_ERROR' }]]);
	assert.equal(JSON.stringify({ logs, data }).includes('PRIVATE'), false);
});

test('image failures identify the submit stage without exposing provider text or post IDs', async t => {
	const logs = [];
	t.mock.method(console, 'error', (...args) => logs.push(args));
	t.mock.method(globalThis, 'fetch', async () => new Response('photo', { headers: { 'Content-Type': 'image/jpeg' } }));
	const env = environment();
	const post = await (await call(env, '/posts', 'POST', { property_id: '123', channel: 'instagram', template: 'square' })).json();
	env.IMAGES.input = () => { throw Object.assign(new Error('PRIVATE_URL PRIVATE_TOKEN PRIVATE_CRM'), { code: 9524 }); };
	const response = await call(env, `/posts/${post.id}/submit`, 'POST', { revision: post.revision });
	const data = await response.json();
	assert.equal(response.status, 502);
	assert.equal(logs[0][0].stage, 'render_images');
	assert.equal(logs[0][0].operation, 'posts.submit');
	assert.equal(logs[0][0].code, 'IMAGES_9524');
	assert.equal(logs[0][0].errorId, data.errorId);
	assert.equal(JSON.stringify(logs).includes(post.id), false);
	assert.equal(JSON.stringify({ logs, data }).includes('PRIVATE'), false);
});

test('validation failures stay quiet while service failures include a reference and safe code', async t => {
	const logs = [];
	t.mock.method(console, 'error', (...args) => logs.push(args));
	const env = environment();
	const bad = await call(env, '/posts', 'POST', { property_id: 'missing' });
	assert.equal(bad.status, 409);
	assert.deepEqual(await bad.json(), { error: 'property_unavailable' });
	assert.equal(logs.length, 0);
	const failed = await call({}, '/posts');
	assert.equal(failed.status, 503);
	const data = await failed.json();
	assert.equal(data.error, 'social_database_not_configured');
	assert.equal(logs[0][0].code, 'social_database_not_configured');
	assert.equal(logs[0][0].errorId, data.errorId);
});

test('diagnostics discard arbitrary names, stages, methods, paths, codes and nested messages', t => {
	const logs = [];
	t.mock.method(console, 'error', (...args) => logs.push(args));
	logSocialFailure({ name: 'PRIVATE_NAME', code: 'PRIVATE_CODE', message: 'PRIVATE_MESSAGE', cause: { message: 'D1_TYPE_ERROR: PRIVATE_PARAMS' } }, { method: 'PRIVATE_METHOD' }, new URL(`${origin}/PRIVATE_PATH?token=PRIVATE_TOKEN`), 'PRIVATE_STAGE');
	assert.deepEqual({ ...logs[0][0], errorId: undefined }, { event: 'social_operation_failed', errorId: undefined, method: 'OTHER', operation: 'unknown', stage: 'unknown', errorType: 'Error', code: 'D1_TYPE_ERROR' });
	assert.equal(JSON.stringify(logs).includes('PRIVATE'), false);
});
