// Versioned design choices are saved with the draft and therefore covered by
// its revision/approval. Keep this module independent of request/storage code.
export const SOCIAL_PRESETS = ['classic', 'editorial', 'architectural', 'neighbourhood'];
export const SOCIAL_DESTINATIONS = ['property', 'request', 'sell', 'message'];

export function normalizeCreative(input) {
	if (input == null) return { preset: 'classic', version: 1, includeFacts: false, includeCta: false };
	if (typeof input !== 'object' || Array.isArray(input) ||
		!SOCIAL_PRESETS.includes(input.preset) || input.version !== 1 ||
		typeof input.includeFacts !== 'boolean' || typeof input.includeCta !== 'boolean' ||
		Object.keys(input).some(key => !['preset', 'version', 'includeFacts', 'includeCta', 'destination'].includes(key)) ||
		('destination' in input && !SOCIAL_DESTINATIONS.includes(input.destination)) ||
		(input.preset === 'classic' && (input.includeFacts || input.includeCta))) return null;
	return { preset: input.preset, version: 1, includeFacts: input.includeFacts, includeCta: input.includeCta,
		...('destination' in input ? { destination: input.destination } : {}) };
}

// All destinations belong to the public marketing site. No editable URL,
// private CRM record, contact field or authentication material enters a link.
// Keep the original descriptor unchanged when destination was not saved yet.
export function websiteDestination(post) {
	const creative = normalizeCreative(typeof post.creative === 'string' ? JSON.parse(post.creative) : post.creative);
	if (!creative || !creative.destination || creative.destination === 'message') return null;
	const property = typeof post.snapshot === 'string' ? JSON.parse(post.snapshot) : post.snapshot;
	const code = String(property?.code || property?.id || '');
	if (!code || code === '.' || code === '..') return null;
	const paths = {
		property: { label: 'Σελίδα ακινήτου', path: `/properties/${encodeURIComponent(code)}` },
		request: { label: 'Αίτημα αναζήτησης ακινήτου', path: '/request' },
		sell: { label: 'Αίτημα πώλησης ακινήτου', path: '/list-property' },
	};
	const { label, path } = paths[creative.destination];
	const url = new URL(path, 'https://four-walls.gr');
	url.searchParams.set('utm_source', ['instagram', 'facebook', 'marketplace'].includes(post.channel) ? post.channel : 'social');
	url.searchParams.set('utm_medium', 'social');
	url.searchParams.set('utm_campaign', `property_${code}`);
	url.searchParams.set('utm_content', String(post.id || ''));
	return { label, url: url.href, shortUrl: `four-walls.gr${path}` };
}

export function buildSlidePlan(post) {
	const photos = typeof post.photos === 'string' ? JSON.parse(post.photos) : post.photos;
	const creative = normalizeCreative(typeof post.creative === 'string' ? JSON.parse(post.creative) : post.creative);
	if (!creative || !Array.isArray(photos) || !photos.length) return [];
	if (creative.preset === 'classic') return photos.map(photo => ({ kind: 'photo', photo }));
	const slides = [{ kind: 'cover', photo: photos[0] }];
	if (photos[1]) slides.push({ kind: 'photo', photo: photos[1] });
	if (creative.includeFacts) slides.push({ kind: 'facts' });
	for (const photo of photos.slice(2)) slides.push({ kind: 'photo', photo });
	if (creative.includeCta) slides.push({ kind: 'cta' });
	return slides;
}

// A shared geometry contract keeps the authored PNG frame and the renderer in
// agreement. All positions are real output pixels, never browser dimensions.
export function slideLayout(preset, kind, height) {
	const portrait = height === 1350;
	if (kind === 'photo') return { photo: { left: 48, top: 48, width: 984, height: height - 240 } };
	if (kind !== 'cover') return {};
	if (preset === 'neighbourhood') return { photo: { left: 64, top: 350, width: 740, height: portrait ? 730 : 460 }, titleTop: 72, titleWidth: 910, titleSize: 58, titleChars: 31, locationTop: 240, priceTop: height - 205, codeTop: height - 115, logo: { left: 860, top: height - 180, width: 152 } };
	return { photo: { left: preset === 'editorial' ? 0 : 54, top: preset === 'editorial' ? 0 : 64, width: preset === 'editorial' ? 1080 : 972, height: height - (preset === 'editorial' ? 390 : 445) }, titleTop: height - 354, titleWidth: 920, titleSize: 58, titleChars: 31, locationTop: height - 186, priceTop: height - 126, codeTop: height - 48, logo: { left: 65, top: 84, width: 150 } };
}

// The text binding does not wrap. Draw bounded lines separately; the renderer
// additionally scale-down fits each line to its box, including wide glyphs.
export function wrapSocialText(value, columns = 32, limit = 2) {
	const words = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
	const lines = [];
	let line = '';
	for (let word of words) {
		while (Array.from(word).length > columns) {
			if (line) { lines.push(line); line = ''; }
			const chars = Array.from(word); lines.push(chars.slice(0, columns).join('')); word = chars.slice(columns).join('');
		}
		if (!word) continue;
		if (Array.from(line ? `${line} ${word}` : word).length > columns) { lines.push(line); line = word; }
		else line = line ? `${line} ${word}` : word;
	}
	if (line) lines.push(line);
	if (lines.length > limit) return [...lines.slice(0, limit - 1), Array.from(lines[limit - 1]).slice(0, columns - 1).join('') + '…'];
	return lines;
}
