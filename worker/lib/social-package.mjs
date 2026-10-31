// Small STORE-only ZIP stream: JPEGs are already compressed. At most one
// photograph is buffered at a time, keeping this within the Worker's memory.
function crc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
function header(size, fields, name = new Uint8Array()) {
	const bytes = new Uint8Array(size + name.length), view = new DataView(bytes.buffer);
	for (const [offset, value, width] of fields) width === 4 ? view.setUint32(offset, value, true) : view.setUint16(offset, value, true);
	bytes.set(name, size);
	return bytes;
}
export function zipStream(entries) {
	async function* generate() {
		let offset = 0;
		const central = [];
		for (const entry of entries) {
			const name = new TextEncoder().encode(entry.name), bytes = await entry.bytes(), crc = crc32(bytes);
			const local = header(30, [[0,0x04034b50,4],[4,20],[6,0x800],[14,crc,4],[18,bytes.length,4],[22,bytes.length,4],[26,name.length]], name);
			central.push(header(46, [[0,0x02014b50,4],[4,20],[6,20],[8,0x800],[16,crc,4],[20,bytes.length,4],[24,bytes.length,4],[28,name.length],[42,offset,4]], name));
			yield local; yield bytes; offset += local.length + bytes.length;
		}
		const start = offset;
		for (const record of central) { yield record; offset += record.length; }
		yield header(22, [[0,0x06054b50,4],[8,central.length],[10,central.length],[12,offset-start,4],[16,start,4]]);
	}
	const iterator = generate();
	return new ReadableStream({ async pull(controller) {
		try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); }
		catch (error) { controller.error(error); }
	}, async cancel() { await iterator.return(); } });
}

export async function marketplacePackage(env, post, property) {
	const text = `${property.title}\n${property.price == null ? 'Τιμή κατόπιν επικοινωνίας' : `EUR ${property.price}`}\n${property.location.area}, ${property.location.city}\n\n${post.caption}\n\nΔημοσιεύστε χειροκίνητα στο Facebook Marketplace. Ελέγξτε διαθεσιμότητα και κατηγορία πριν από την καταχώριση. Δεν έχει γίνει δημοσίευση από την εφαρμογή.\n`;
	const entries = [{ name: 'listing.txt', bytes: async () => new TextEncoder().encode(text) }];
	for (const [i, key] of JSON.parse(post.assets).entries()) {
		if (!await env.PHOTO_BUCKET.head(key)) throw new Error('package_image_missing');
		entries.push({ name: `photo-${String(i + 1).padStart(2, '0')}.jpg`, bytes: async () => {
			const object = await env.PHOTO_BUCKET.get(key);
			if (!object) throw new Error('package_image_missing');
			return new Uint8Array(await object.arrayBuffer());
		} });
	}
	return new Response(zipStream(entries), { headers: {
		'Content-Type': 'application/zip', 'Cache-Control': 'private, no-store',
		'Content-Disposition': `attachment; filename="fourwalls-marketplace-${post.id}.zip"`,
	} });
}
