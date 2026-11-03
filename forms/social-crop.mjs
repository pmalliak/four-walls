// Social-only source cropping. Percentages refer to the displayed (EXIF-oriented)
// original, before the template's cover fit. CRM originals remain unchanged.
export function defaultSocialCrop() {
	return { landscape: 16, portrait: 10, photos: [] };
}
const percent = value => Number.isInteger(value) && value >= 0 && value <= 40;
export function normalizeSocialCrop(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input) ||
		Object.keys(input).some(key => !['landscape', 'portrait', 'photos'].includes(key)) ||
		!percent(input.landscape) || !percent(input.portrait) || !Array.isArray(input.photos) || input.photos.length > 10) return null;
	const seen = new Set(), photos = [];
	for (const item of input.photos) {
		if (!item || typeof item !== 'object' || Array.isArray(item) ||
			Object.keys(item).some(key => !['url', 'bottom'].includes(key)) ||
			typeof item.url !== 'string' || !item.url || item.url.length > 2048 || seen.has(item.url) || !percent(item.bottom)) return null;
		seen.add(item.url); photos.push({ url: item.url, bottom: item.bottom });
	}
	return { landscape: input.landscape, portrait: input.portrait, photos };
}
export function photoCropPercent(crop, url, width, height) {
	if (!crop) return 0;
	const override = crop.photos.find(item => item.url === url);
	return override ? override.bottom : height > width ? crop.portrait : crop.landscape;
}
export function sourceCropBox(crop, url, width, height) {
	if (![width, height].every(value => Number.isFinite(value) && value > 0)) return null;
	const bottom = Math.min(height - 1, Math.round(height * photoCropPercent(crop, url, width, height) / 100));
	return { left: 0, top: 0, width, height: height - bottom, bottom };
}
