import { getPost, statement, mutate, verifyLiveProperty } from './social.mjs';
import { liveReady, SocialError } from './social-model.mjs';
import { signedMediaUrl } from './social-media.mjs';
import { publishMeta } from './social-meta.mjs';

export async function runSocialPublisher(env) {
	if (!env.SOCIAL_DB) return;
	// A crashed invocation may have published externally. Never reclaim it.
	const stuck = await statement(env, "SELECT * FROM social_posts WHERE status='publishing' AND updated_at < ?", new Date(Date.now() - 20 * 60000).toISOString()).all();
	for (const post of stuck.results) {
		try { await mutate(env, post, { status: 'needs_review', error: 'interrupted_check_meta_before_retry' }, 'scheduler', 'needs_review'); }
		catch (e) { if (e.message !== 'revision_conflict_reload') throw e; }
	}
	if (!liveReady(env)) return;
	const due = await statement(env, "SELECT * FROM social_posts WHERE status='scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 3", new Date().toISOString()).all();
	for (const candidate of due.results) {
		let post;
		try {
			post = await mutate(env, candidate, { status: 'publishing' }, 'scheduler', 'claimed');
		} catch (e) { if (e.message === 'revision_conflict_reload') continue; throw e; }
		let contactedMeta = false;
		try {
			await verifyLiveProperty(env, post);
			const urls = await Promise.all(JSON.parse(post.assets).map(key => signedMediaUrl(env, key)));
			const checkpoint = async (kind, detail) => {
				await statement(env, 'INSERT INTO social_events(post_id,revision,kind,actor,detail,created_at) VALUES(?,?,?,?,?,?)', post.id, post.revision, kind, 'meta', detail, new Date().toISOString()).run();
			};
			contactedMeta = true;
			const id = await publishMeta(env, post, urls, () => verifyLiveProperty(env, post), checkpoint);
			await mutate(env, post, { status: 'published', remote_id: id, error: null }, 'scheduler', 'published', id);
		} catch (error) {
			// All failures after contacting Meta are held, including timeouts and
			// D1 failures after successful publication. No automatic duplicate risk.
			const latest = await getPost(env, post.id);
			if (latest.status !== 'publishing') continue;
			await mutate(env, latest, { status: contactedMeta ? 'needs_review' : 'blocked', error: error instanceof SocialError ? error.message : 'publication_failed_check_meta' }, 'scheduler', contactedMeta ? 'needs_review' : 'blocked');
		}
	}
}
