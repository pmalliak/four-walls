/* =====================================================================
   Four Walls Έντυπα — FWExif: διαβάζει GPS/ημερομηνία από τη φωτογραφία
   ---------------------------------------------------------------------
   Το χρειάζεται το lead.html: όταν ο σύμβουλος ανεβάζει φωτογραφίες που
   τράβηξε ΝΩΡΙΤΕΡΑ, η μόνη αυτόματη πηγή τοποθεσίας είναι τα metadata
   του αρχείου.

   ΓΙΑΤΙ ΔΙΚΟΣ ΜΑΣ PARSER και όχι έτοιμη βιβλιοθήκη: θέλουμε τρία tags
   (GPS, ημερομηνία λήψης, μοντέλο συσκευής), όχι πλήρη μεταδεδομένα, και
   η εφαρμογή δουλεύει offline — ο service worker κατεβάζει ό,τι μπει εδώ
   μέσα σε κάθε συσκευή. 5 KB αντί για 70.

   ΚΡΙΣΙΜΟ: κάλεσέ το ΠΑΝΤΑ πάνω στο πρωτότυπο αρχείο, ΠΡΙΝ από
   οποιοδήποτε resize. Το `canvas.toBlob()` (όπως στο enhance.html) πετάει
   ΟΛΟ το EXIF — αν πρώτα σμικρύνεις και μετά διαβάσεις, το GPS έχει ήδη
   χαθεί.

   ΤΟ EXIF ΛΕΙΠΕΙ ΠΟΛΥ ΣΥΧΝΑ — δεν είναι σφάλμα, είναι ο κανόνας:
   - φωτογραφία τραβηγμένη μέσα από browser/canvas: δεν έχει καθόλου EXIF
   - Android photo picker: κόβει την τοποθεσία πριν δώσει το αρχείο
   - WhatsApp/Viber/Messenger: τα σβήνουν κατά την αποστολή
   - κλειστό location στην κάμερα, ή χωρίς GPS fix τη στιγμή της λήψης
   - screenshot αγγελίας: μηδέν metadata
   Γι' αυτό το lead.html ΔΕΝ στηρίζεται σε αυτό — είναι το bonus, με το
   στίγμα της συσκευής και τη χειρόγραφη διεύθυνση από κάτω.

   Χειρίζεται JPEG (APP1), HEIC/HEIF (ISO-BMFF), PNG (eXIf) και WebP
   (EXIF chunk) με τον ίδιο τρόπο: εντοπίζει το TIFF header μέσα στα bytes
   και διαβάζει από εκεί. Επιστρέφει null όταν δεν βρει τίποτα.
   ===================================================================== */
'use strict';
(function (global) {

	/* --------------------------------------------------------- TIFF/EXIF */

	/* Τα IFD entries είναι 12 bytes: tag(2) type(2) count(4) value|offset(4).
	   Ό,τι δεν χωράει στα 4 bytes αποθηκεύεται αλλού, με offset από την αρχή
	   του TIFF header — γι' αυτό όλα τα offsets εδώ είναι σχετικά με `base`. */
	var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

	function readValues(dv, base, entry, little) {
		var type = entry.type, count = entry.count, size = TYPE_SIZE[type];
		if (!size) return null;
		var bytes = size * count;
		var at = bytes <= 4 ? entry.valueAt : base + dv.getUint32(entry.valueAt, little);
		if (at < 0 || at + bytes > dv.byteLength) return null;
		var out = [];
		for (var i = 0; i < count; i++) {
			var p = at + i * size;
			switch (type) {
				case 1: case 7: out.push(dv.getUint8(p)); break;
				case 2: out.push(String.fromCharCode(dv.getUint8(p))); break;
				case 3: out.push(dv.getUint16(p, little)); break;
				case 4: out.push(dv.getUint32(p, little)); break;
				case 9: out.push(dv.getInt32(p, little)); break;
				case 5: case 10: {
					var num = type === 5 ? dv.getUint32(p, little) : dv.getInt32(p, little);
					var den = type === 5 ? dv.getUint32(p + 4, little) : dv.getInt32(p + 4, little);
					out.push(den ? num / den : 0);
					break;
				}
			}
		}
		/* Τα ASCII πεδία τελειώνουν σε NUL — κόψ' το, αλλιώς κολλάει στο
		   τέλος κάθε ονόματος συσκευής. */
		if (type === 2) return out.join('').replace(/\0+$/, '');
		return out;
	}

	function readIfd(dv, base, offset, little) {
		var at = base + offset;
		if (at + 2 > dv.byteLength) return null;
		var count = dv.getUint16(at, little);
		/* Λογικό ταβάνι: ένα IFD με 900 entries σημαίνει ότι διαβάζουμε
		   σκουπίδια (false positive στην αναζήτηση του TIFF header). */
		if (count > 512) return null;
		var entries = {};
		for (var i = 0; i < count; i++) {
			var p = at + 2 + i * 12;
			if (p + 12 > dv.byteLength) break;
			entries[dv.getUint16(p, little)] = {
				type: dv.getUint16(p + 2, little),
				count: dv.getUint32(p + 4, little),
				valueAt: p + 8,
			};
		}
		return entries;
	}

	function num(v) { return Array.isArray(v) ? v[0] : v; }

	/* Μοίρες/λεπτά/δευτερόλεπτα -> δεκαδικές μοίρες. Νότος και Δύση αρνητικά. */
	function dms(parts, ref) {
		if (!Array.isArray(parts) || parts.length < 3) return null;
		var d = (parts[0] || 0) + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600;
		if (!isFinite(d)) return null;
		var r = String(ref || '').toUpperCase();
		return (r === 'S' || r === 'W') ? -d : d;
	}

	/* «2026:07:31 18:04:12» (το EXIF format) -> ISO. Η ώρα είναι τοπική
	   χωρίς ζώνη, οπότε κρατιέται ως έχει — δεν επινοούμε UTC offset. */
	function exifDate(s) {
		var m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''));
		return m ? m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] : null;
	}

	function parseTiff(dv, base) {
		if (base + 8 > dv.byteLength) return null;
		var order = dv.getUint16(base, false);
		var little = order === 0x4949;                       // "II"
		if (!little && order !== 0x4d4d) return null;         // ούτε "MM"
		if (dv.getUint16(base + 2, little) !== 42) return null;

		var ifd0 = readIfd(dv, base, dv.getUint32(base + 4, little), little);
		if (!ifd0) return null;

		var out = { lat: null, lng: null, taken_at: null, device: null };

		if (ifd0[0x010f] || ifd0[0x0110]) {
			var mk = ifd0[0x010f] ? readValues(dv, base, ifd0[0x010f], little) : '';
			var md = ifd0[0x0110] ? readValues(dv, base, ifd0[0x0110], little) : '';
			out.device = [mk, md].filter(Boolean).join(' ').trim() || null;
		}

		if (ifd0[0x8769]) {                                   // Exif sub-IFD
			var exif = readIfd(dv, base, num(readValues(dv, base, ifd0[0x8769], little)), little);
			/* DateTimeOriginal, αλλιώς DateTimeDigitized. */
			if (exif && (exif[0x9003] || exif[0x9004])) {
				out.taken_at = exifDate(readValues(dv, base, exif[0x9003] || exif[0x9004], little));
			}
		}
		if (!out.taken_at && ifd0[0x0132]) {                  // DateTime (τροποποίησης)
			out.taken_at = exifDate(readValues(dv, base, ifd0[0x0132], little));
		}

		if (ifd0[0x8825]) {                                   // GPS IFD
			var gps = readIfd(dv, base, num(readValues(dv, base, ifd0[0x8825], little)), little);
			if (gps && gps[0x0002] && gps[0x0004]) {
				var lat = dms(readValues(dv, base, gps[0x0002], little), gps[0x0001] ? readValues(dv, base, gps[0x0001], little) : 'N');
				var lng = dms(readValues(dv, base, gps[0x0004], little), gps[0x0003] ? readValues(dv, base, gps[0x0003], little) : 'E');
				/* 0,0 είναι το «Null Island»: το γράφουν κάμερες που έχουν το
				   GPS field αλλά όχι fix. Δεν είναι τοποθεσία. */
				if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
					&& !(Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001)) {
					out.lat = lat;
					out.lng = lng;
				}
			}
		}
		return out;
	}

	/* ------------------------------------------------- εύρεση του TIFF

	   Αντί για τρεις container parsers (JPEG markers, ISO-BMFF boxes, PNG
	   chunks) ψάχνουμε τη σφραγίδα «Exif\0\0» μέσα στα bytes και δοκιμάζουμε
	   TIFF από κει και μετά. Το validation του TIFF header (byte order +
	   magic 42 + λογικό IFD) είναι αρκετά αυστηρό ώστε τυχαία σύμπτωση να
	   μην περνάει, και ένα αρχείο έχει το πολύ 2-3 υποψήφια σημεία. */
	function findExif(buf) {
		var b = new Uint8Array(buf), dv = new DataView(buf), i, res;

		/* 1. «Exif\0\0» — JPEG APP1, HEIC Exif item, WebP EXIF chunk. */
		for (i = 0; i + 14 < b.length; i++) {
			if (b[i] === 0x45 && b[i + 1] === 0x78 && b[i + 2] === 0x69 && b[i + 3] === 0x66
				&& b[i + 4] === 0x00 && b[i + 5] === 0x00) {
				res = parseTiff(dv, i + 6);
				if (res) return res;
			}
		}
		/* 2. PNG «eXIf» chunk και WebP «EXIF» chunk χωρίς τη σφραγίδα:
		      το TIFF ξεκινά αμέσως μετά το όνομα (PNG) ή μετά το μέγεθος
		      (WebP RIFF). Δοκίμασε και τα δύο. */
		for (i = 0; i + 20 < b.length; i++) {
			var isPng = b[i] === 0x65 && b[i + 1] === 0x58 && b[i + 2] === 0x49 && b[i + 3] === 0x66; // eXIf
			var isRiff = b[i] === 0x45 && b[i + 1] === 0x58 && b[i + 2] === 0x49 && b[i + 3] === 0x46; // EXIF
			if (!isPng && !isRiff) continue;
			res = parseTiff(dv, i + 4) || parseTiff(dv, i + 8);
			if (res) return res;
		}
		/* 3. Σκέτο TIFF/DNG: το header είναι στο byte 0. */
		return parseTiff(dv, 0);
	}

	/* ------------------------------------------------------------- API */

	/* read(file) -> Promise<{lat,lng,taken_at,device}|null>
	   Ποτέ δεν κάνει throw: μια χαλασμένη φωτογραφία δεν πρέπει να ρίξει
	   τη φόρμα, απλώς δεν έχει τοποθεσία. */
	function read(file) {
		return new Promise(function (resolve) {
			if (!file || !file.size) return resolve(null);
			var fr = new FileReader();
			fr.onerror = function () { resolve(null); };
			fr.onload = function () {
				try {
					var r = findExif(fr.result);
					resolve(r && (r.lat != null || r.taken_at || r.device) ? r : null);
				} catch (e) { resolve(null); }
			};
			/* Σε HEIC το Exif item μπορεί να κάθεται βαθιά μέσα στο mdat, οπότε
			   διαβάζουμε όλο το αρχείο. Μία φωτογραφία τη φορά — το lead.html
			   τις επεξεργάζεται σειριακά. */
			fr.readAsArrayBuffer(file);
		});
	}

	global.FWExif = { read: read };

})(window);
