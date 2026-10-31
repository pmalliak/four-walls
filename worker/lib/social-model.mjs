import { subcategoryLabel, fmtNumber } from './seo.mjs';
import { normalizeCreative } from './social-creative.mjs';

// CRM titles are optional. Derive a readable fallback using only public
// listing fields, like the marketing site; preserve authored titles exactly.
export function socialTitle(p) {
	const title = typeof p.title === 'string' ? p.title.trim() : '';
	if (title) return p.title;
	const mapped = subcategoryLabel(p);
	const type = mapped && mapped !== p.subcategory ? mapped : 'Ακίνητο';
	const size = typeof p.area === 'number' && Number.isFinite(p.area) && p.area > 0 ? ` ${fmtNumber(p.area)} τ.μ.` : '';
	const area = p.location?.area?.trim() || p.location?.city?.trim();
	return `${type}${size}${area ? `, ${area}` : ''}`;
}

// Only these public facts cross the social module's browser/storage boundary.
export function publicProperty(p) {
	// Only the CRM originals list or an already-projected social snapshot has
	// source provenance. Legacy/general feed images may include watermarks.
	const originals = Array.isArray(p.originalImages) ? p.originalImages :
		p.photoSource === 'estateprime_original' && Array.isArray(p.images) ? p.images : [];
	return {
		id: String(p.id), code: p.code || '', title: socialTitle(p),
		transaction: p.transaction || '', price: p.price ?? null, area: p.area ?? null,
		location: { area: p.location?.area || '', city: p.location?.city || '' },
		images: [...new Set(originals.filter(safePhoto))], photoSource: 'estateprime_original',
	};
}

export function safePhoto(value) {
	try {
		const u = new URL(value);
		return u.protocol === 'https:' && !u.username && !u.password &&
			!/(^localhost$|^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|:)/i.test(u.hostname);
	} catch { return false; }
}

export async function fingerprint(p) {
	const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(publicProperty(p))));
	return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
}

export function greekCaption(p, link = null) {
	const transaction = { sale: 'Πωλείται', rent: 'Ενοικιάζεται', shortterm: 'Βραχυχρόνια μίσθωση', auction: 'Δημοπρασία' }[p.transaction] || 'Ακίνητο';
	const price = p.price == null ? 'Τιμή κατόπιν επικοινωνίας' :
		`€${Number(p.price).toLocaleString('el-GR')}${p.transaction === 'rent' ? '/μήνα' : ''}`;
	return `${transaction} · ${socialTitle(p)}\n${[p.location?.area, p.location?.city].filter(Boolean).join(', ')}\n${p.area ? `${p.area} τ.μ. · ` : ''}${price}\n\nΚωδικός: ${p.code}\n${link?.label || 'Ανακαλύψτε το με τη Four Walls.'}\n${link?.url || `https://four-walls.gr/properties/${encodeURIComponent(p.code || p.id)}`}\n\n#FourWalls #Ακίνητα #Θεσσαλονίκη`;
}

export class SocialError extends Error {
	constructor(code, status = 400) { super(code); this.status = status; }
}
export function check(condition, code, status = 400) {
	if (!condition) throw new SocialError(code, status);
}

export function validateDraft(input, property) {
	const creative = normalizeCreative(input.creative);
	check(creative, 'invalid_creative');
	check(['instagram', 'facebook', 'marketplace'].includes(input.channel), 'invalid_channel');
	check(['square', 'portrait'].includes(input.template), 'invalid_template');
	check(typeof input.caption === 'string' && input.caption.trim().length > 0 && input.caption.length <= 2200, 'caption_1_to_2200');
	check(Array.isArray(input.photos) && input.photos.length >= 1 && input.photos.length <= 10, 'select_1_to_10_photos');
	check(input.photos.length + Number(creative.includeFacts) + Number(creative.includeCta) <= 10, 'carousel_max_10_slides');
	check(new Set(input.photos).size === input.photos.length && input.photos.every(p => property.images.includes(p) && safePhoto(p)), 'invalid_photo_selection');
	return { channel: input.channel, template: input.template, caption: input.caption.trim(), photos: input.photos, creative };
}

export function liveReady(env) {
	return env.SOCIAL_LIVE_PUBLISH === '1' && env.SOCIAL_META_PERMISSIONS_CONFIRMED === '1' &&
		env.SAMPLE_DATA !== '1' && !env.CRM_DEV_BYPASS &&
		/^v\d+\.0$/.test(env.META_GRAPH_VERSION || '') &&
		/^\d+$/.test(env.META_PAGE_ID || '') && /^\d+$/.test(env.META_IG_USER_ID || '') &&
		!!env.META_PAGE_ACCESS_TOKEN && !!env.PHOTO_SIGN_KEY;
}
