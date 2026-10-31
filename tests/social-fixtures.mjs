import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { publicProperty } from '../worker/lib/social-model.mjs';

// Execute real migration/SQL/transactions in SQLite, implementing only D1's
// documented prepare/bind/first/all/run/batch surface. No fake SQL parser.
export function database() {
	const db = new DatabaseSync(':memory:');
	db.exec(readFileSync(new URL('../worker/migrations/0001_social.sql', import.meta.url), 'utf8'));
	function prepare(sql, params = []) {
		return {
			bind: (...values) => prepare(sql, values),
			first: async () => db.prepare(sql).get(...params) || null,
			all: async () => ({ results: db.prepare(sql).all(...params) }),
			run: async () => execute(),
			execute,
		};
		function execute() { const result = db.prepare(sql).run(...params); return { meta: { changes: Number(result.changes) } }; }
	}
	return { prepare, async batch(statements) {
		db.exec('BEGIN');
		try { const results = statements.map(s => s.execute()); db.exec('COMMIT'); return results; }
		catch (e) { db.exec('ROLLBACK'); throw e; }
	}, close: () => db.close() };
}
export const property = { id: '123', code: '4W-123', title: 'Διαμέρισμα στην Καλαμαριά', transaction: 'sale', price: 185000, area: 85, location: { area: 'Καλαμαριά', city: 'Θεσσαλονίκη', address: 'PRIVATE ADDRESS', lat: 40 }, images: ['https://photos.example/one.jpg', 'https://photos.example/two.jpg'], listedAt: 'PRIVATE', owner: { phone: 'PRIVATE' } };
export const rawProperty = { id: 123, code: '4W-123', status: 'active', availability: 'sale', price: 185000, size: 85, translations: [{ language_id: 1, title: property.title }], location: { area_level2: { name_el: 'Καλαμαριά' }, area_level1: { name_el: 'Θεσσαλονίκη' } }, photos: property.images.map(original_image => ({ original_image })) };
export function environment() {
	const objects = new Map();
	const env = { SOCIAL_DB: database(), SOCIAL_APPROVERS: 'local-developer', SOCIAL_LIVE_PUBLISH: '0', SAMPLE_DATA: '0',
		feed: { generatedAt: new Date().toISOString(), source: 'estateprime', listings: [property] },
		LISTINGS_KV: { get: async () => env.feed },
		PHOTO_BUCKET: { async put(key, data) { objects.set(key, data); }, async head(key) { return objects.has(key) ? {} : null; }, async get(key) { const bytes = objects.get(key); return bytes ? { body: new Blob([bytes]).stream(), arrayBuffer: async () => bytes } : null; } },
		IMAGES: { input() { const chain = { transform: () => chain, draw: () => chain, output: async () => ({ response: () => new Response(new Uint8Array([255,216,255,217])) }) }; return chain; } },
		ASSETS: { fetch: async () => new Response('asset') },
		ESTATEPRIME_SUBDOMAIN: 'example', ESTATEPRIME_API_KEY: 'private', ESTATEPRIME_API_SECRET: 'private', PHOTO_SIGN_KEY: 'test-signing-key',
		META_PAGE_ACCESS_TOKEN: 'SECRET-META-TOKEN', META_PAGE_ID: '99', META_IG_USER_ID: '88', META_GRAPH_VERSION: 'v25.0', SOCIAL_META_PERMISSIONS_CONFIRMED: '1',
	};
	return env;
}
export const publicFixture = publicProperty(property);
