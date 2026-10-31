// Build frames and exact brand variants. Sharp is an authoring-only dependency:
// node tools/generate-social-assets.mjs <sharp-module-path>.
// Runtime photos/text and browser previews share forms/social-design.mjs.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildSocialDesign } from '../forms/social-design.mjs';
const require = createRequire(import.meta.url), sharp = require(process.argv[2] || 'sharp');
const directory = new URL('../images/social/', import.meta.url);
await mkdir(directory, { recursive: true });
const navy = '#1C3457', pink = '#FF0062';
const street = `data:image/png;base64,${(await readFile(new URL('illustration-street.png', directory))).toString('base64')}`;
const door = `data:image/png;base64,${(await readFile(new URL('illustration-door.png', directory))).toString('base64')}`;
const websiteSvg = (await readFile(new URL('../images/assets/ils_01.fw.svg', import.meta.url), 'utf8'))
	.replace('width="1800" height="778" viewBox="0 0 1800 778"', 'width="700" height="448" viewBox="0 330 700 448"');
const websitePng = await sharp(Buffer.from(websiteSvg)).resize({ width: 1000 }).png().toBuffer();
await writeFile(new URL('illustration-website.png', directory), websitePng);
const website = `data:image/png;base64,${websitePng.toString('base64')}`;
const image = (src, x, y, width, height) => `<image href="${src}" x="${x}" y="${y}" width="${width}" height="${height}"/>`;
function room(x, y, scale) {
	return `<g transform="translate(${x} ${y}) scale(${scale})" fill="none" stroke="${navy}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M0 8 178 75 335 20V330L180 272 0 329Z M179 75 180 272 M19 19 20 318 M40 27 40 311 M60 34 61 304 M81 41 80 297 M100 48 101 289 M121 56 122 282 M142 63 143 277"/><path d="M5 12 177 80 330 25 M5 334 178 278 331 334" opacity=".25" stroke-width="1"/><path fill="#F3F1EC" stroke="none" opacity=".7" d="M192 271V208Q192 138 245 138T296 207V312Z"/><path d="M245 64V115"/><g stroke="${pink}" stroke-width="4.4"><circle cx="245" cy="153" r="33"/><path d="M245 186V286L233 280V265L245 270V251L235 246"/><circle cx="245" cy="137" r="4"/></g></g>`;
}
function grid(height) {
	const y = height - 590;
	return `<g fill="none" stroke="${navy}" stroke-width="1.5"><path opacity=".3" d="M64 ${y}H1016M64 ${y+192}H1016M64 ${y+384}H1016M540 ${y}V${y+384}"/><g stroke-width="2.5"><path d="M78 ${y+47}H114V${y+83}H78Z M81 ${y+79} 110 ${y+51}M81 ${y+57}V${y+51}H87M104 ${y+79}H110V${y+73}"/><path d="M596 ${y+84}Q571 ${y+58} 580 ${y+44}Q596 ${y+25} 612 ${y+44}Q621 ${y+58} 596 ${y+84}Z"/><circle cx="596" cy="${y+51}" r="7"/><g transform="translate(0 24)"><ellipse cx="96" cy="${y+217}" rx="19" ry="7"/><path d="M77 ${y+217}V${y+242}Q96 ${y+256} 115 ${y+242}V${y+217}M77 ${y+226}Q96 ${y+241} 115 ${y+226}M77 ${y+234}Q96 ${y+249} 115 ${y+234}"/><path d="M581 ${y+206}H610V${y+249}H581Z M588 ${y+217}H604M588 ${y+227}H604M588 ${y+237}H598"/></g></g></g>`;
}
function frame(preset, kind, height) {
	const square = height === 1080, neighbour = preset === 'neighbourhood', arch = preset === 'architectural';
	const paper = neighbour ? '#FFFCF7' : '#FFFFFF';
	const { photo: p } = buildSocialDesign({ preset, kind, height });
	let body = `<defs><linearGradient id="paper" x2=".8" y2="1"><stop stop-color="${paper}"/><stop offset="1" stop-color="${neighbour ? '#FCF9F2' : '#FEFDFB'}"/></linearGradient></defs>`;
	if (p) {
		if (kind === 'cover' && preset === 'editorial') {
			const end = height - 438;
			body += `<defs><linearGradient id="fade" x1="0" x2="0" y1="${end-142}" y2="${end}" gradientUnits="userSpaceOnUse"><stop stop-color="${paper}" stop-opacity="0"/><stop offset="1" stop-color="${paper}"/></linearGradient></defs><rect y="${end-142}" width="1080" height="142" fill="url(#fade)"/><rect y="${end}" width="1080" height="${height-end}" fill="url(#paper)"/><rect x="64" y="${height-518}" width="330" height="54" fill="${pink}"/><path d="M64 ${height-160}H254" stroke="${pink}" stroke-width="4"/>`;
		} else {
			let hole;
			if (kind === 'cover' && neighbour) hole = `M${p.left} ${p.top+185}Q${p.left} ${p.top+105} ${p.left+185} ${p.top+63}L${p.left+p.width-215} ${p.top+4}Q${p.left+p.width} ${p.top-36} ${p.left+p.width} ${p.top+175}V${p.top+p.height}H${p.left}Z`;
			else {
				const r = kind === 'cover' && arch ? 248 : 0;
				hole = `M${p.left} ${p.top}H${p.left+p.width-r}Q${p.left+p.width} ${p.top} ${p.left+p.width} ${p.top+r}V${p.top+p.height}H${p.left}Z`;
			}
			body += `<path fill="url(#paper)" fill-rule="evenodd" d="M0 0H1080V${height}H0Z ${hole}"/>`;
			if (kind === 'cover' && arch) body += `<path d="M34 57V31H778Q1048 31 1048 301V${height-25}" stroke="${navy}" stroke-width="3" fill="none"/><path d="M54 ${height-422}H758Q924 ${height-422} 924 ${height-263}V${height}H0V${height-422}Z" fill="url(#paper)"/><path d="M925 ${height-260}V${height}" stroke="${navy}" stroke-width="2.5"/><path d="M508 ${height-117}V${height-45}" stroke="${navy}" stroke-width="1.5"/><rect x="45" y="65" width="289" height="186" fill="#fff"/><path d="M45 65V251" stroke="${pink}" stroke-width="8"/>`;
			if (kind === 'cover' && neighbour) body += image(street, square ? 580 : 560, square ? 280 : 365, square ? 500 : 520, square ? 750 : 780) + `<path d="M64 240H177" stroke="${pink}" stroke-width="5"/>`;
		}
	} else if (kind === 'facts') {
		body += `<rect width="1080" height="${height}" fill="url(#paper)"/>`;
		if (neighbour) body += image(street, 40, 30, square ? 325 : 470, square ? 488 : 705);
		else if (arch) body += room(64, square ? 66 : 114, square ? 1.1 : 1.45);
		else body += image(website, 44, square ? 78 : 170, 490, 314);
		body += `<path d="M570 ${square ? 265 : 347}H680" stroke="${pink}" stroke-width="4"/>` + grid(height);
	} else {
		const dark = preset === 'editorial', top = square ? 275 : 355;
		body += `<rect width="1080" height="${height}" fill="${dark ? navy : 'url(#paper)'}"/>`;
		if (neighbour) body += image(door, square ? 645 : 590, square ? 130 : 270, square ? 540 : 655, square ? 810 : 983);
		else body += `<g fill="none" stroke="${dark ? '#6F829B' : navy}" stroke-width="3" opacity=".55"><path d="M798 -10V180Q798 330 948 330H1100M918 -10V${height-210}Q918 ${height-105} 1023 ${height-105}H1100M760 ${height}V${height-262}Q760 ${height-380} 878 ${height-380}H1100"/><path d="M928 -10V153Q928 225 1000 225H1100M850 ${height}V${height-290}Q850 ${height-450} 1010 ${height-450}H1100" stroke="${pink}" stroke-width="5" opacity="1"/></g>`;
		body += `<path d="M64 ${top+257}H208" stroke="${pink}" stroke-width="5"/>`;
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${height}" viewBox="0 0 1080 ${height}">${body}</svg>`;
}
for (const preset of ['editorial', 'architectural', 'neighbourhood']) for (const height of [1350, 1080]) for (const kind of ['cover', 'photo', 'facts', 'cta']) {
	await sharp(Buffer.from(frame(preset, kind, height))).png().toFile(fileURLToPath(new URL(`${preset}-${kind}${height === 1080 ? '-square' : ''}.png`, directory)));
}
const socialLogo = await readFile(new URL('../brand/fourwalls_logo_social.svg', import.meta.url));
await writeFile(new URL('logo-social.svg', directory), socialLogo);
await sharp(socialLogo).resize({ width: 750 }).png().toFile(fileURLToPath(new URL('logo-social.png', directory)));
const horizontal = await readFile(new URL('../images/logo/fourwalls_logo.svg', import.meta.url), 'utf8');
for (const [name, color] of [['logo-horizontal', navy], ['logo-horizontal-white', '#FFFFFF']]) {
	const svg = horizontal.replaceAll('#000000', color);
	await writeFile(new URL(`${name}.svg`, directory), svg);
	await sharp(Buffer.from(svg)).resize({ width: 1080 }).png().toFile(fileURLToPath(new URL(`${name}.png`, directory)));
}
await writeFile(new URL('README.txt', directory), 'Four Walls social template assets\nFrames generated by tools/generate-social-assets.mjs from the same geometry used by forms/social-design.mjs.\nCompact portrait mark: brand/fourwalls_logo_social.svg, retaining original outlined paths. Horizontal marks: images/logo/fourwalls_logo.svg with navy/white wordmarks. Canonical masters unchanged.\nIllustrations are decorative, not representations of a listed property or geographic map.\nFonts are provided under their included SIL Open Font Licenses; generator preserves font files.\n');
console.log('Generated shared-design frames and social logo variants.');
