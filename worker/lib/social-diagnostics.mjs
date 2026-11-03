// Log only allowlisted diagnostics. Upstream exception text can contain URLs,
// tokens, SQL parameters, captions, or CRM details, so it is never emitted.
const stages = new Set(['authenticate', 'serve_asset', 'database_check', 'load_feed', 'list_posts', 'parse_request', 'create_draft', 'load_post', 'serialize_post', 'load_history', 'load_image', 'validate_property', 'save_post', 'delete_post', 'render_images', 'save_submission', 'verify_crm', 'record_export', 'build_package', 'test_meta', 'manage_platform']);
const errorTypes = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'TimeoutError', 'AbortError', 'ImagesError']);
const serviceCodes = new Set(['social_database_not_configured', 'feed_missing_or_stale', 'photo_sources_pending_sync', 'crm_verification_failed', 'image_storage_not_configured', 'image_text_not_available', 'creative_asset_missing', 'photo_fetch_failed', 'logo_missing', 'render_too_large']);
const d1Codes = ['D1_ERROR', 'D1_EXEC_ERROR', 'D1_TYPE_ERROR', 'D1_COLUMN_NOTFOUND', 'SQLITE_ERROR', 'SQLITE_BUSY', 'SQLITE_CONSTRAINT'];

function operation(pathname) {
	if (pathname === '/api/social/bootstrap') return 'bootstrap';
	if (pathname === '/api/social/posts') return 'posts';
	const match = pathname.match(/^\/api\/social\/posts\/[a-f0-9-]{36}(?:\/(submit|approve|test|platform|schedule|cancel|resolve|history|package|image\/\d))?$/);
	if (match) return match[1]?.startsWith('image/') ? 'posts.image' : `posts.${match[1] || 'detail'}`;
	return /^\/(?:forms\/)?social(?:\.html|\.fw\.(?:js|css))?$/.test(pathname) ? 'asset' : 'unknown';
}

function providerCode(error) {
	for (const candidate of [error, error?.cause]) {
		if (!candidate || typeof candidate !== 'object') continue;
		const message = typeof candidate.message === 'string' ? candidate.message : '';
		for (const code of d1Codes) if (candidate.code === code || message.startsWith(`${code}:`)) return code;
		// Cloudflare Images uses four-digit service codes. Extract the code only,
		// never the error description or any surrounding provider response.
		const code = String(candidate.code ?? message.match(/^(?:Images?Error|ERROR)\s*[: ]\s*(9[45]\d{2})\b/i)?.[1] ?? '');
		if (/^9[45]\d{2}$/.test(code)) return `IMAGES_${code}`;
	}
}

export function logSocialFailure(error, request, url, stage) {
	const errorId = crypto.randomUUID();
	const diagnostic = {
		event: 'social_operation_failed', errorId,
		method: ['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method) ? request.method : 'OTHER',
		operation: operation(url.pathname),
		stage: stages.has(stage) ? stage : 'unknown',
		errorType: errorTypes.has(error?.name) ? error.name : 'Error',
	};
	const code = serviceCodes.has(error?.message) ? error.message : providerCode(error);
	if (code) diagnostic.code = code;
	console.error(diagnostic);
	return errorId;
}
