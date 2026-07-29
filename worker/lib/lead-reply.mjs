/* =====================================================================
   Four Walls — «λάβαμε το αίτημά σας» reply to a Spitogatos lead
   ---------------------------------------------------------------------
   The Spitogatos «Πελάτης για ακίνητό σου» email says a visitor asked
   about one of our ads. Spitogatos offers a copy-paste reply template
   for this; we build the same thing here, but automatically and with
   the one advantage they cannot give us: **we know whether the property
   is still available**, because the ad code in their email is the same
   `code` as in EstatePrime (verified live 2026-07-29, ad #2400001 =
   listing 117). Everything else in the mail (photo, price, similar
   properties) also comes from the live feed, so nobody maintains a
   second copy of the listing data.

   GET /api/lead-reply?code=2400001&lang=el&name=Ιωάννα
     -> { found, available, subject, html, text, listing, similar }
   Add &format=html to eyeball the mail in a browser.

   WHY A WORKER ENDPOINT AND NOT A MAKE TEMPLATE: the mail needs the
   feed (availability + similar listings), which Make cannot filter
   without a pile of unreadable IML. Here it is ordinary code, in git,
   diffable, and the same similarity rule as the website's «Παρόμοια
   ακίνητα» row.

   PUBLIC BUT INERT: it only echoes data that is already public on the
   site, sends nothing itself, and refuses to carry attacker text —
   `name` is filtered down to letters/spaces (see safeName) so the URL
   cannot be turned into a four-walls.gr-hosted message. Make calls it
   server-side and does the actual sending.
   ===================================================================== */

import { SITE } from "./pages-meta.mjs";
import { fmtNumber, subcategoryLabel, locField, canonicalUrl, listingTitle } from "./seo.mjs";

/* KV key of the feed — keep in sync with FEED_KEY in worker/index.mjs. */
const FEED_KEY = "listings.json";

const STR = {
	el: {
		subjectAvail: (c) => `Το αίτημά σας για το ακίνητο #${c}`,
		subjectGone: (c) => `Το αίτημά σας για το ακίνητο #${c}`,
		subjectNoCode: "Το αίτημά σας για ακίνητο",
		preheaderAvail: "Λάβαμε το αίτημά σας. Το ακίνητο είναι διαθέσιμο.",
		preheaderGone: "Λάβαμε το αίτημά σας. Το ακίνητο δεν είναι πλέον διαθέσιμο.",
		hi: (n) => (n ? `Καλησπέρα ${n},` : "Καλησπέρα σας,"),
		thanks: "σας ευχαριστούμε για το ενδιαφέρον σας. Λάβαμε το αίτημά σας για το παρακάτω ακίνητο.",
		/* No card follows when the listing is gone, so «παρακάτω» would
		   point at nothing. */
		thanksNoCard: (c) => (c
			? `σας ευχαριστούμε για το ενδιαφέρον σας. Λάβαμε το αίτημά σας για το ακίνητο με κωδικό #${c}.`
			: "σας ευχαριστούμε για το ενδιαφέρον σας. Λάβαμε το αίτημά σας."),
		available: "Το ακίνητο είναι διαθέσιμο. Θα επικοινωνήσει μαζί σας ο συνεργάτης μας για να κανονίσουμε επίσκεψη ή για ό,τι άλλο χρειάζεστε.",
		gone: "Το συγκεκριμένο ακίνητο δεν είναι πλέον διαθέσιμο. Θα επικοινωνήσει μαζί σας ο συνεργάτης μας, και παρακάτω θα βρείτε μερικά ακίνητα που ίσως σας ταιριάζουν.",
		/* Same news, but nothing to show — do not promise suggestions that
		   are not in the mail. */
		goneEmpty: "Το συγκεκριμένο ακίνητο δεν είναι πλέον διαθέσιμο. Θα επικοινωνήσει μαζί σας ο συνεργάτης μας για να δούμε τι άλλο μπορούμε να βρούμε για εσάς.",
		/* No ad code in the notification: we do not know WHICH property was
		   asked about, so any claim about availability would be invented. */
		unknown: "Θα επικοινωνήσει μαζί σας ο συνεργάτης μας το συντομότερο, για να δούμε τι ακριβώς ψάχνετε.",
		preheaderUnknown: "Λάβαμε το αίτημά σας.",
		code: "Κωδικός ακινήτου",
		cta: "ΔΕΙΤΕ ΤΟ ΑΚΙΝΗΤΟ",
		similarTitle: "Παρόμοια ακίνητα",
		nearbyTitle: "Άλλα ακίνητα που ίσως σας ενδιαφέρουν",
		ctaAll: "ΔΕΙΤΕ ΟΛΑ ΤΑ ΑΚΙΝΗΤΑ ΜΑΣ",
		askTitle: "Δεν είναι αυτό που ψάχνετε;",
		askBody: "Πείτε μας τι ακίνητο θέλετε, περιοχή, τιμή και χαρακτηριστικά, και ψάχνουμε εμείς για εσάς. Μόλις βρούμε κάτι που ταιριάζει, θα το μάθετε πρώτοι.",
		askCta: "ΠΕΙΤΕ ΜΑΣ ΤΙ ΨΑΧΝΕΤΕ",
		call: (t) => `Αν βιάζεστε, καλέστε μας στο <strong style="color:#FF1462;">${t}</strong> ή απαντήστε σε αυτό το email.`,
		regards: "Με εκτίμηση,",
		team: "Η ομάδα της Four Walls Real Estate",
		month: "/μήνα",
		sqm: " τ.μ.",
		ask: "ρωτήσατε για",
	},
	en: {
		subjectAvail: (c) => `Your enquiry about property #${c}`,
		subjectGone: (c) => `Your enquiry about property #${c}`,
		subjectNoCode: "Your property enquiry",
		preheaderAvail: "We received your enquiry. The property is available.",
		preheaderGone: "We received your enquiry. That property is no longer available.",
		hi: (n) => (n ? `Hello ${n},` : "Hello,"),
		thanks: "thank you for your interest. We have received your enquiry about the property below.",
		thanksNoCard: (c) => (c
			? `thank you for your interest. We have received your enquiry about property #${c}.`
			: "thank you for your interest. We have received your enquiry."),
		available: "The property is available. One of our agents will contact you to arrange a viewing or answer any question.",
		gone: "This property is no longer available. One of our agents will contact you, and below are a few properties that may suit you.",
		goneEmpty: "This property is no longer available. One of our agents will contact you so we can find something else for you.",
		unknown: "One of our agents will contact you shortly to go through exactly what you are looking for.",
		preheaderUnknown: "We received your enquiry.",
		code: "Property code",
		cta: "VIEW THE PROPERTY",
		similarTitle: "Similar properties",
		nearbyTitle: "Other properties you may like",
		ctaAll: "SEE ALL OUR PROPERTIES",
		askTitle: "Not quite what you are after?",
		askBody: "Tell us what you are looking for, area, price and features, and we will do the searching. The moment something matches, you hear it from us first.",
		askCta: "TELL US WHAT YOU WANT",
		call: (t) => `If you are in a hurry, call us on <strong style="color:#FF1462;">${t}</strong> or just reply to this email.`,
		regards: "Kind regards,",
		team: "The Four Walls Real Estate team",
		month: "/month",
		sqm: " m²",
		ask: "asked about",
	},
};

const PHONE_DISPLAY = "+30 6907 483 463";
const PHONE_HREF = "+306907483463";

const esc = (s) => String(s ?? "")
	.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* The visitor's first name is the only free text in the mail, and the
   URL that carries it is public. Letters, spaces, apostrophes and
   hyphens only (Greek + Latin, accents included), and only the FIRST
   word is used — enough for «Καλησπέρα Ιωάννα», useless as a vehicle
   for a link or a sentence. */
function safeName(raw) {
	const n = String(raw ?? "").trim().slice(0, 60);
	if (!/^[\p{L}][\p{L} '’.\-]*$/u.test(n)) return "";
	const first = n.split(/\s+/)[0];
	return first.length > 24 ? "" : first;
}

/* Tracked link, so the office can see in Observability which of these
   mails actually pulled someone back to the site (same /go route the
   CRM emails use). */
function track(path, campaign) {
	return `${SITE.origin}/go?to=${encodeURIComponent(path)}&amp;c=${encodeURIComponent(campaign)}`;
}

function priceLabel(l, lang) {
	if (l.price == null) return "";
	const s = "€" + fmtNumber(l.price, lang);
	return l.transaction === "rent" || l.transaction === "shortterm" ? s + STR[lang].month : s;
}

/* Mirror of similarityScore() in js/listings.fw.js — same weights, so
   the mail proposes what the website would. Keep the two in step. */
export function similarityScore(base, x) {
	let score = 0;
	const bArea = base.location?.area, xArea = x.location?.area;
	if (bArea && xArea && bArea === xArea) score += 100;
	const bHood = base.location?.neighbourhood, xHood = x.location?.neighbourhood;
	if (bHood && xHood && bHood === xHood) score += 40;
	if (base.subcategory && base.subcategory === x.subcategory) score += 30;
	if (base.price > 0 && x.price > 0) {
		score += 40 * Math.max(0, 1 - Math.abs(x.price - base.price) / base.price);
	}
	if (base.area > 0 && x.area > 0) {
		score += 30 * Math.max(0, 1 - Math.abs(x.area - base.area) / base.area);
	}
	return score;
}

/* The website can afford to fill the «Παρόμοια» row with whatever is
   closest — the visitor sees the price and moves on. An email cannot:
   proposing a €650 flat to someone who asked about a €350 one under the
   heading «Παρόμοια» reads as «they did not read my message».

   So the mail asks twice. First strictly (price band + score floor): a
   real match, and it is called one. If nothing qualifies — which is the
   normal case with a few dozen listings in stock — it falls back to the
   widest band and relabels the block «Άλλα ακίνητα που ίσως σας
   ενδιαφέρουν». Honest either way, and never an empty mail.
   MIN_SCORE 60 = roughly «same area» or «same subcategory + close on
   price and size». */
const PRICE_BAND = 0.4;
const LOOSE_BAND = 1.5;
const MIN_SCORE = 60;

export function pickSimilar(listings, base, limit = 3, strict = false) {
	const band = strict ? PRICE_BAND : LOOSE_BAND;
	return listings
		.filter((x) => x.id !== base.id && x.transaction === base.transaction && x.category === base.category)
		.filter((x) => !(base.price > 0 && x.price > 0)
			|| Math.abs(x.price - base.price) / base.price <= band)
		.map((x) => ({ l: x, s: similarityScore(base, x) }))
		.filter((x) => !strict || x.s >= MIN_SCORE)
		.sort((a, b) => b.s - a.s)
		.slice(0, limit)
		.map((x) => x.l);
}

function listingCard(l, lang, campaign) {
	const S = STR[lang];
	const url = track(new URL(canonicalUrl(l, lang)).pathname, campaign);
	const photo = l.images?.[0];
	const price = priceLabel(l, lang);
	/* Heading without the area, because the address line right below
	   carries it — listingTitle() glues them together for <title>. */
	const heading = subcategoryLabel(l, lang) + (l.area != null ? " " + fmtNumber(l.area, lang) + S.sqm : "");
	/* «Τριανδρία, Τριανδρία - Δόξα» reads like a bug: the CRM's district
	   name often contains the neighbourhood, so drop the narrower one
	   whenever it is already spelled out in the wider. */
	const hood = locField(l, "neighbourhood", lang), district = locField(l, "area", lang);
	const addr = [hood && (!district || !district.includes(hood)) ? hood : null, district]
		.filter(Boolean).join(", ");
	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceef2; border-radius:6px; overflow:hidden;">
	${photo ? `<tr><td style="padding:0;"><a href="${url}" style="display:block;"><img src="${esc(photo)}" alt="" width="480" style="width:100%; max-width:480px; height:260px; object-fit:cover; display:block; border:0;"></a></td></tr>` : ""}
	<tr><td style="padding:12px 14px 14px 14px; font-size:14px; line-height:1.6; color:#16233A;">
		<div style="font-size:15px; font-weight:bold; color:#16233A; margin:0 0 4px 0;">${esc(heading)}</div>
		${addr ? `<div style="font-size:13px; color:#777777; margin:0 0 4px 0;">${esc(addr)}</div>` : ""}
		${price ? `<div style="font-size:17px; font-weight:bold; color:#FF1462; margin:0 0 4px 0;">${esc(price)}</div>` : ""}
		${l.code ? `<div style="font-size:12px; color:#777777; margin:0 0 10px 0;">${S.code}: ${esc(l.code)}</div>` : ""}
		<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 0 0;">
			<tr><td style="background:#FF1462; border-radius:4px;">
				<a href="${url}" style="display:block; padding:9px 18px; font-size:13px; font-weight:bold; color:#ffffff; text-decoration:none; letter-spacing:0.4px;">${S.cta}</a>
			</td></tr>
		</table>
	</td></tr>
</table>`;
}

/* One place decides what we may honestly claim: with no code we know
   nothing, with a code we know exactly, and «gone» only promises
   suggestions when the mail actually carries some. */
function statusLine({ S, code, available, similar }) {
	if (!code) return S.unknown;
	if (available) return S.available;
	return similar.length ? S.gone : S.goneEmpty;
}

function buildHtml({ lang, name, listing, similar, available, strictMatch, code }) {
	const S = STR[lang];
	const preheader = !code ? S.preheaderUnknown : (available ? S.preheaderAvail : S.preheaderGone);
	const allUrl = track(lang === "en" ? "/en/properties" : "/properties", "lead_reply_all");
	const requestUrl = track(lang === "en" ? "/en/request" : "/request", "lead_reply_request");
	return `<!DOCTYPE html>
<html lang="${lang}" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(preheader)}</title>
</head>
<body style="margin:0; padding:0; background:#f4f5f7; font-family:Arial,sans-serif;">
	<div style="display:none; max-height:0; overflow:hidden; opacity:0;">${esc(preheader)}</div>
	<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7; padding:16px 0;">
		<tr><td align="center">
			<table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px; width:100%; background:#ffffff; border-radius:8px; overflow:hidden;">

				<tr><td style="background:#16233A; padding:15px 20px;"><span style="color:#ffffff; font-size:18px; font-weight:bold; letter-spacing:1.5px;">FOUR WALLS</span><span style="color:#FF1462; font-size:10px; font-weight:bold; letter-spacing:2px;">&nbsp;&nbsp;REAL ESTATE</span></td></tr>
				<tr><td style="height:3px; background:#FF1462;"></td></tr>

				<tr><td style="padding:18px 20px 4px 20px; font-size:14px; line-height:1.7; color:#16233A;">
					<p style="margin:0 0 10px 0;">${esc(S.hi(name))}</p>
					<p style="margin:0 0 12px 0;">${esc(listing ? S.thanks : S.thanksNoCard(code))}</p>
				</td></tr>

				${listing ? `<tr><td style="padding:4px 20px 0 20px;">${listingCard(listing, lang, "lead_reply")}</td></tr>` : ""}

				<tr><td style="padding:16px 20px 4px 20px;">
					<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
						<tr><td style="background:${available ? "#f2f9f4" : "#f7f8fa"}; border-left:3px solid ${available ? "#2e9e5b" : "#FF1462"}; border-radius:6px; padding:12px 14px; font-size:14px; line-height:1.6; color:#16233A;">
							${esc(statusLine({ S, code, available, similar }))}
						</td></tr>
					</table>
				</td></tr>

				${similar.length ? `<tr><td style="padding:18px 20px 0 20px; font-size:15px; font-weight:bold; color:#16233A;">${strictMatch ? S.similarTitle : S.nearbyTitle}</td></tr>
				${similar.map((s) => `<tr><td style="padding:12px 20px 0 20px;">${listingCard(s, lang, "lead_reply_similar")}</td></tr>`).join("\n\t\t\t\t")}` : ""}

				<tr><td style="padding:18px 20px 2px 20px;" align="center">
					<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
						<tr><td style="border:1px solid #FF1462; border-radius:4px;">
							<a href="${allUrl}" style="display:block; padding:10px 22px; font-size:13px; font-weight:bold; color:#FF1462; text-decoration:none; letter-spacing:0.4px;">${S.ctaAll}</a>
						</td></tr>
					</table>
				</td></tr>

				<!-- The point of the whole mail: turn a portal lead into a
				     ζήτηση on our own site, which keeps working for months
				     without paying for the lead again. -->
				<tr><td style="padding:20px 20px 0 20px;">
					<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
						<tr><td style="background:#f7f8fa; border-radius:8px; padding:16px 18px; font-size:14px; line-height:1.6; color:#16233A;">
							<div style="font-size:15px; font-weight:bold; margin:0 0 6px 0;">${esc(S.askTitle)}</div>
							<div style="margin:0 0 12px 0;">${esc(S.askBody)}</div>
							<table role="presentation" cellpadding="0" cellspacing="0">
								<tr><td style="background:#FF1462; border-radius:4px;">
									<a href="${requestUrl}" style="display:block; padding:10px 20px; font-size:13px; font-weight:bold; color:#ffffff; text-decoration:none; letter-spacing:0.4px;">${S.askCta}</a>
								</td></tr>
							</table>
						</td></tr>
					</table>
				</td></tr>

				<tr><td style="padding:16px 20px 6px 20px; font-size:14px; line-height:1.7; color:#16233A;">
					<p style="font-size:12px; color:#777777; margin:0 0 12px 0; line-height:1.5;">${S.call(PHONE_DISPLAY)}</p>
					<p style="margin:14px 0 4px 0;">${esc(S.regards)}</p>
					<div style="font-size:14px; font-weight:bold; color:#16233A;">${esc(S.team)}</div>
				</td></tr>

				<tr><td style="border-top:1px solid #eceef2; padding:14px 20px; font-size:11px; color:#999999; line-height:1.6;">
					<strong style="color:#16233A;">Four Walls Real Estate</strong> · Φραγκίνη 9, 54624 Θεσσαλονίκη · <a href="tel:${PHONE_HREF}" style="color:#999999; text-decoration:none;">${PHONE_DISPLAY}</a><br>
					<a href="mailto:info@four-walls.gr" style="color:#FF1462; text-decoration:none;">info@four-walls.gr</a> · <a href="${track("/", "lead_reply_footer")}" style="color:#FF1462; text-decoration:none;">four-walls.gr</a>
				</td></tr>

			</table>
		</td></tr>
	</table>
</body>
</html>`;
}

/* Plain-text alternative — some clients show it, and it is what lands in
   the CRM communication comment when the office wants to see what the
   client was told. */
function buildText({ lang, name, listing, similar, available, strictMatch, code }) {
	const S = STR[lang];
	const lines = [S.hi(name), "", listing ? S.thanks : S.thanksNoCard(code), ""];
	if (listing) {
		lines.push(`${listingTitle(listing, lang)} — ${priceLabel(listing, lang)}`.trim());
		if (listing.code) lines.push(`${S.code}: ${listing.code}`);
		lines.push(canonicalUrl(listing, lang), "");
	}
	lines.push(statusLine({ S, code, available, similar }), "");
	if (similar.length) {
		lines.push((strictMatch ? S.similarTitle : S.nearbyTitle) + ":");
		for (const s of similar) {
			lines.push(`- ${listingTitle(s, lang)} — ${priceLabel(s, lang)} — ${canonicalUrl(s, lang)}`);
		}
		lines.push("");
	}
	lines.push(`${PHONE_DISPLAY} · info@four-walls.gr`, "", S.regards, S.team);
	return lines.join("\n");
}

export async function handleLeadReply(request, env, url) {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response(JSON.stringify({ error: "method_not_allowed" }), {
			status: 405,
			headers: { "Content-Type": "application/json; charset=utf-8", "Allow": "GET" },
		});
	}
	const lang = url.searchParams.get("lang") === "en" ? "en" : "el";
	const code = String(url.searchParams.get("code") || "").trim().slice(0, 24);
	const name = safeName(url.searchParams.get("name"));
	const wantsHtml = url.searchParams.get("format") === "html";

	let feed = null;
	try {
		const raw = await env.LISTINGS_KV.get(FEED_KEY);
		if (raw) feed = JSON.parse(raw);
	} catch (err) {
		console.error(`lead-reply: feed read failed: ${err.message}`);
	}
	const listings = Array.isArray(feed?.listings) ? feed.listings : [];

	/* The feed carries active stock only, so «found in the feed» IS
	   «still available» — no extra CRM call, no second source of truth. */
	const listing = code ? listings.find((l) => l.code === code || l.id === code) || null : null;
	const available = Boolean(listing);

	/* Not found means sold/rented/withdrawn. We no longer know what the
	   client wanted, so fall back to the newest stock of the transaction
	   type Make passes along (from the email's «προς ενοικίαση/πώληση»). */
	let similar = [];
	let strictMatch = false;
	if (listing) {
		similar = pickSimilar(listings, listing, 3, true);
		strictMatch = similar.length > 0;
		if (!similar.length) similar = pickSimilar(listings, listing, 3, false);
	} else {
		const t = url.searchParams.get("transaction");
		const c = url.searchParams.get("category");
		const pool = listings.filter((l) => (!t || l.transaction === t) && (!c || l.category === c));
		similar = pool.slice().sort((a, b) =>
			String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))).slice(0, 3);
	}

	const S = STR[lang];
	const subject = code
		? (available ? S.subjectAvail(code) : S.subjectGone(code))
		: S.subjectNoCode;
	const ctx = { lang, name, listing, similar, available, strictMatch, code };
	const html = buildHtml(ctx);

	if (wantsHtml) {
		return new Response(html, {
			headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
		});
	}
	return new Response(JSON.stringify({
		found: available,
		available,
		subject,
		html,
		text: buildText(ctx),
		listing: listing && {
			code: listing.code,
			title: listingTitle(listing, lang),
			price: priceLabel(listing, lang),
			url: canonicalUrl(listing, lang),
		},
		similar: similar.map((s) => ({
			code: s.code,
			title: listingTitle(s, lang),
			price: priceLabel(s, lang),
			url: canonicalUrl(s, lang),
		})),
	}), {
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
	});
}
