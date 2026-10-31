// One composition for browser previews and Cloudflare output. Coordinates are
// output pixels; each text item is already wrapped and bounded to its box.
import { measureSocialText } from './social-font-metrics.mjs';
const NAVY = '#1C3457', PINK = '#FF0062', WHITE = '#FFFFFF';
const ASSET = '/images/social/';
const clean = value => String(value ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const amount = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value.toLocaleString('el-GR') : '';

// Leave room for rasterizer/kerning differences between SVG and Images text.
const units = (value, font) => measureSocialText(value, font) * 1.04;
function linesFor(value, width, size, maxLines, font) {
	const words = clean(value).split(' ').filter(Boolean), lines = [];
	let line = '';
	for (let word of words) {
		while (units(word, font) * size > width && word.length > 1) {
			if (line) { lines.push(line); line = ''; }
			let end = 1;
			while (end < word.length && units(word.slice(0, end + 1), font) * size <= width) end++;
			lines.push(word.slice(0, end)); word = word.slice(end);
		}
		if (!word) continue;
		const next = line ? `${line} ${word}` : word;
		if (units(next, font) * size > width && line) { lines.push(line); line = word; }
		else line = next;
	}
	if (line) lines.push(line);
	if (lines.length > maxLines) {
		lines.length = maxLines;
		let last = lines[maxLines - 1];
		while (last && units(`${last}…`, font) * size > width) last = last.slice(0, -1);
		lines[maxLines - 1] = `${last.trimEnd()}…`;
	}
	return lines;
}
function logo(portrait, left, top, width, light = false) {
	return { left, top, width, height: width * (portrait ? 100 / 175.7 : 189 / 1048.06), file: `${ASSET}${portrait ? 'logo-social' : light ? 'logo-horizontal-white' : 'logo-horizontal'}.png` };
}

export function buildSocialDesign({ preset = 'architectural', kind = 'cover', height = 1350, property = {}, destination = 'property', channel = 'instagram', link = null } = {}) {
	const square = height === 1080, arch = preset === 'architectural', neighbour = preset === 'neighbourhood';
	const result = { frame: `${ASSET}${preset}-${kind}${square ? '-square' : ''}.png`, photo: null, logo: null, texts: [] };
	const type = clean(property.typeLabel) || 'Ακίνητο';
	const size = amount(property.area), area = size ? `${size} τ.μ.` : '';
	// Drop only the CRM's administrative suffix in artwork. Saved facts and
	// editable captions retain the original EstatePrime location.
	const city = clean(property.location?.city).replace(/\s+-\s+(?:Δήμος|Περιφ\/κοί δήμοι)$/u, '');
	const region = clean(property.location?.area) || city;
	const code = clean(property.code || property.id);
	const price = typeof property.price === 'number' && Number.isFinite(property.price) && property.price > 0 ? `€${property.price.toLocaleString('el-GR')}${property.transaction === 'rent' ? '/μήνα' : ''}` : 'Κατόπιν επικοινωνίας';
	const sale = { sale: 'ΠΡΟΣ ΠΩΛΗΣΗ', rent: 'ΠΡΟΣ ΕΝΟΙΚΙΑΣΗ', shortterm: 'ΒΡΑΧΥΧΡΟΝΙΑ ΜΙΣΘΩΣΗ', auction: 'ΔΗΜΟΠΡΑΣΙΑ' }[property.transaction] || 'ΑΚΙΝΗΤΟ';
	const add = (text, left, top, width, size, font = 'sans', color = NAVY, options = {}) => {
		const value = clean(text); if (!value) return;
		const maxLines = options.lines || 1;
		const fitted = maxLines === 1 ? Math.min(size, Math.max(1, Math.floor(width / Math.max(1, units(value, font))))) : size;
		const lines = maxLines === 1 ? [value] : linesFor(value, width, size, maxLines, font);
		for (const [i, line] of lines.entries()) result.texts.push({ text: line, left, top: top + i * Math.ceil(size * 1.22), width, size: fitted, font, color, ...(options.align ? { align: options.align } : {}) });
	};
	if (kind === 'cover') {
		if (preset === 'editorial') {
			result.photo = { left: 0, top: 0, width: 1080, height: height - 420 };
			result.logo = logo(false, 64, height - 120, 360);
			add(sale, 82, height - 507, 292, 23, 'sansBold', WHITE);
			add(type, 64, height - 440, 570, 82, 'heading');
			add(area, 64, height - 340, 570, 82, 'heading');
			add(city, 64, height - 210, 570, 29, 'sans', NAVY, { lines: 2 });
			add(price, 654, height - 250, 362, 64, 'heading', NAVY, { align: 'right' });
			add(`Κωδικός ${code}`, 654, height - 150, 362, 23, 'sans', NAVY, { align: 'right' });
		} else if (arch) {
			result.photo = { left: 54, top: 64, width: 972, height: height - 150 };
			result.logo = logo(true, 65, 87, 250);
			add(type, 76, height - 392, 770, 78, 'heading');
			add(area, 76, height - 300, 770, 78, 'heading');
			add(city, 76, height - 192, 770, 27, 'sans', NAVY, { lines: 2 });
			add(price, 76, height - 110, 420, 58, 'heading', PINK);
			add(`Κωδικός ${code}`, 526, height - 91, 330, 22, 'sans', NAVY, { align: 'right' });
		} else {
			result.photo = { left: 54, top: 320, width: 740, height: height - 500 };
			result.logo = logo(false, 54, height - 110, 360);
			add(type, 64, 66, 545, 76, 'heading');
			add(area, 64, 154, 545, 76, 'heading');
			add(price, 652, 82, 364, 56, 'heading', NAVY, { align: 'right' });
			add(`Κωδικός ${code}`, 652, 168, 364, 22, 'sans', NAVY, { align: 'right' });
			add(city, 64, 268, 730, 33);
		}
	} else if (kind === 'photo') {
		result.photo = { left: 40, top: 40, width: 1000, height: height - 240 };
		result.logo = arch ? logo(true, 766, height - 171, 250) : logo(false, 64, height - 133, 360);
		const left = arch ? 64 : 530, width = arch ? 670 : 486, align = arch ? {} : { align: 'right' };
		add([type, area].filter(Boolean).join(' · '), left, height - 157, width, 34, 'heading', NAVY, align);
		add(city, left, height - 102, width, 25, 'sans', NAVY, align);
		add(`Κωδικός ${code}`, left, height - 58, width, 23, 'sans', NAVY, align);
	} else if (kind === 'facts') {
		result.logo = arch ? logo(true, 64, height - 170, 250) : logo(false, 64, height - 114, 360);
		add(type, 570, square ? 100 : 170, 446, 65, 'heading');
		add(area, 570, square ? 185 : 262, 446, 65, 'heading');
		add(city, 570, square ? 284 : 370, 446, 29, 'sans', NAVY, { lines: 2 });
		const cells = [['ΕΜΒΑΔΟΝ', area], ['ΠΕΡΙΟΧΗ', region], ['ΤΙΜΗ', price], ['ΚΩΔΙΚΟΣ', code]];
		for (const [index, [label, value]] of cells.entries()) {
			if (!value) continue;
			const left = index % 2 ? 638 : 136, top = height - 568 + Math.floor(index / 2) * 192;
			add(label, left, top, 365, 27, 'sansBold', PINK);
			add(value, left, top + 44, 365, label === 'ΠΕΡΙΟΧΗ' ? 38 : 46, 'sans', NAVY, { lines: 2 });
		}
	} else if (kind === 'cta') {
		const dark = preset === 'editorial', color = dark ? WHITE : NAVY;
		result.logo = arch ? logo(true, 64, 64, 250) : logo(false, 64, 86, 390, dark);
		const top = square ? 275 : 355;
		const targets = {
			property: ['Δείτε το', 'ακίνητο', 'Φωτογραφίες και πληροφορίες'],
			request: ['Ψάχνετε', 'ακίνητο;', 'Πείτε μας τι αναζητάτε'],
			sell: ['Θέλετε να', 'πουλήσετε;', 'Στείλτε τα στοιχεία του ακινήτου'],
			message: ['Θέλετε να', 'το δείτε;', 'Στείλτε μας μήνυμα'],
		};
		const target = link ? destination : 'message', copy = targets[target] || targets.message;
		const width = neighbour ? 610 : 780;
		add(copy[0], 64, top, width, 96, 'heading', color);
		add(copy[1], 64, top + 118, width, 96, 'heading', color);
		add(copy[2], 64, top + 298, width, 38, 'sans', color, { lines: 2 });
		if (link) {
			const url = clean(link.shortUrl), slash = url.indexOf('/');
			if (slash > 0 && units(url, 'sansBold') * 38 > width) {
				add(url.slice(0, slash), 64, top + 410, width, 38, 'sansBold', color);
				add(url.slice(slash), 64, top + 457, width, 38, 'sansBold', color, { lines: 2 });
			} else add(url, 64, top + 410, width, 38, 'sansBold', color);
			if (channel === 'instagram' && target === 'property') {
				add('Ή ζητήστε μας τον σύνδεσμο', 64, top + 580, width, 30, 'sans', color);
				add(`με κωδικό ${code}`, 64, top + 619, width, 30, 'sans', color);
			}
		} else {
			add(`«${code}»`, 64, top + 388, width, 56, 'sansBold', color);
			add('four-walls.gr', 64, height - 100, width, 26, 'sans', color);
		}
	}
	return result;
}
