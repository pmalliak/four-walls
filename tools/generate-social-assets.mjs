// Rebuild the code-authored illustrations and exact brand lockup. Requires
// sharp only at authoring time: node tools/generate-social-assets.mjs <sharp-path>
// No image synthesis or property alteration is involved. Font files are from
// google/fonts (GFS Didot + Noto Sans); their OFL licenses travel with the assets.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { slideLayout } from '../worker/lib/social-creative.mjs';
const require = createRequire(import.meta.url);
const sharp = require(process.argv[2] || 'sharp');
const directory = new URL('../images/social/', import.meta.url);
await mkdir(directory, { recursive: true });
const navy = '#1C3457', pink = '#FF0062';

function keyArt(x = 700, y = 100, scale = 1) {
	return `<g transform="translate(${x} ${y}) scale(${scale})" fill="none" stroke="${navy}" stroke-width="3"><path d="M0 10 185 72 335 20V330L185 270 0 330Z M185 72V270 M20 22V317 M40 29V310 M60 35V303 M80 42V296 M100 49V290 M120 56V283"/><path d="M245 70V120"/><g stroke="${pink}" stroke-width="5"><circle cx="245" cy="160" r="33"/><path d="M245 193V286H230V268H245V251H233"/></g></g>`;
}
function streetArt(height) {
	return `<g fill="none" stroke="${navy}" stroke-width="3" stroke-linecap="round"><path d="M870 330 1080 220M870 350 1080 240M910 330V${height-290}M1044 250V${height-330}M950 340V440H1028V302M950 475V575H1028V438M950 610V710H1028V573"/><path d="M932 443H1044M932 456H1044M932 578H1044M932 591H1044M932 713H1044M932 726H1044"/><path d="M941 443V468M957 443V468M973 443V468M989 443V468M1005 443V468M1021 443V468M1037 443V468M941 578V603M957 578V603M973 578V603M989 578V603M1005 578V603M1021 578V603M1037 578V603"/><path d="M860 ${height-285}Q830 ${height-410}840 ${height-540}M840 ${height-440} 800 ${height-480}M840 ${height-470} 881 ${height-520}M840 ${height-500} 817 ${height-545}"/><path stroke="${pink}" stroke-width="18" opacity=".22" d="M802 ${height-535}Q825 ${height-600}870 ${height-550}M794 ${height-480}Q835 ${height-580}886 ${height-495}"/><path d="M834 ${height-290}H886L877 ${height-250}H844Z M916 ${height-250} 1080 ${height-330}"/></g>`;
}
function doorArt(height) {
	const y = height - 760;
	return `<g transform="translate(735 ${y})" fill="none" stroke="${navy}" stroke-width="4"><path fill="${navy}" d="M20 80 240 0V600L20 660Z"/><path stroke="${pink}" stroke-width="12" d="M14 665V70L250 -10"/><path stroke="#fff" opacity=".55" d="M50 104 208 50V570L50 616Z M128 80V596M51 335 209 289"/><path stroke="#fff" d="M186 332V361"/><path d="M-25 682 278 610M-45 704 300 629"/><path d="M279 573Q249 494 278 398M278 487Q239 476 230 447Q264 450 278 487M278 458Q309 442 308 411Q282 430 278 458M273 527Q237 522 231 491Q260 496 273 527M279 511Q309 496 317 468Q285 475 279 511"/><path fill="#fffaf0" d="M250 573H310L299 634H262Z"/></g>`;
}
function frame(preset, kind, height) {
	const bg = preset === 'neighbourhood' ? '#FBF5EA' : '#FCFBF8';
	const dark = preset === 'editorial' && kind === 'cta';
	const layout = slideLayout(preset, kind, height), p = layout.photo;
	let body = '';
	if (p) {
		if (preset === 'editorial' && kind === 'cover') {
			body += `<defs><linearGradient id="fade" x1="0" x2="0" y1="0" y2="1"><stop stop-color="${bg}" stop-opacity="0"/><stop offset="1" stop-color="${bg}"/></linearGradient></defs><path fill="${bg}" d="M0 ${p.height}H1080V${height}H0Z"/><rect y="${p.height-90}" width="1080" height="90" fill="url(#fade)"/>`;
		} else {
			const radius = kind === 'cover' ? (preset === 'architectural' ? 230 : 240) : 0;
			const hole = `M${p.left} ${p.top}H${p.left+p.width-radius}Q${p.left+p.width} ${p.top} ${p.left+p.width} ${p.top+radius}V${p.top+p.height}H${p.left}Z`;
			body += `<path fill="${bg}" fill-rule="evenodd" d="M0 0H1080V${height}H0Z ${hole}"/>`;
			if (preset === 'architectural') body += `<path d="${hole}" fill="none" stroke="${navy}" stroke-width="3"/><path d="M${p.left-12} ${p.top+90}V${p.top+280}" stroke="${pink}" stroke-width="9"/>`;
			if (preset === 'neighbourhood' && kind === 'cover') body += streetArt(height);
		}
		if (kind === 'cover' && preset !== 'neighbourhood') body += '<rect x="46" y="63" width="189" height="151" fill="#ffffff"/>';
		if (kind === 'cover') body += `<path d="M64 ${height-(preset === 'neighbourhood' ? 235 : 208)}H174" stroke="${pink}" stroke-width="5"/>`;
	} else {
		body += `<rect width="1080" height="${height}" fill="${dark ? navy : bg}"/>`;
		if (kind === 'facts') {
			body += keyArt(670, 58, .9);
			for (let i=0;i<4;i++) body += `<path d="M64 ${(height === 1350 ? 435 : 350)+i*(height === 1350 ? 160 : 150)}H1016" stroke="${navy}" opacity=".2"/>`;
		} else if (preset === 'neighbourhood') body += doorArt(height);
		else body += `<g fill="none" stroke="${dark ? '#6A809E' : navy}" stroke-width="3" opacity=".65"><path d="M780 -20V290Q780 380 870 380H1120M890 0V${height-220}Q890 ${height-120}990 ${height-120}H1100M720 ${height}V${height-260}Q720 ${height-350}810 ${height-350}H1080"/><path d="M920 -20V180Q920 250 990 250H1100M820 ${height}V${height-340}Q820 ${height-440}920 ${height-440}H1100" stroke="${pink}" stroke-width="5"/></g>`;
		if (dark) body += '<rect x="50" y="48" width="218" height="176" fill="#fff"/>';
		body += `<path d="M64 ${kind === 'facts' ? 350 : (height === 1350 ? 650 : 515)}H182" stroke="${pink}" stroke-width="6"/>`;
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${height}" viewBox="0 0 1080 ${height}">${body}</svg>`;
}

for (const preset of ['editorial', 'architectural', 'neighbourhood']) {
	for (const height of [1350, 1080]) {
		for (const kind of ['cover', 'photo', 'facts', 'cta']) {
			const name = `${preset}-${kind}${height === 1080 ? '-square' : ''}.png`;
			await sharp(Buffer.from(frame(preset, kind, height))).png().toFile(new URL(name, directory).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
		}
	}
}
await sharp(await readFile(new URL('../brand/fourwalls_logo_vertical.svg', import.meta.url))).resize({ width: 500 }).png().toFile(new URL('logo-vertical.png', directory).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
await writeFile(new URL('README.txt', directory), 'Four Walls social template assets\nGenerated from tools/generate-social-assets.mjs and the canonical brand/fourwalls_logo_vertical.svg.\nIllustrations are decorative, not drawings of a listed property or a geographic map.\nGFS Didot and Noto Sans are distributed under the included SIL Open Font Licenses.\nSources: https://github.com/google/fonts/tree/main/ofl/gfsdidot and https://github.com/google/fonts/tree/main/ofl/notosans\n');
console.log('Generated 24 template frames and the canonical portrait logo.');
