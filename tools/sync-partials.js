#!/usr/bin/env node
/* =====================================================================
   Four Walls — shared partials sync
   =====================================================================
   The marketing site is a no-build static template, so there is no
   server-side include. To keep ONE source of truth for the site header
   (menu) and footer, we keep the canonical markup in:

       partials/header.html   — the main menu  (source: index.html)
       partials/footer.html   — the footer     (source: services.html)

   Pages under en/ get the hand-authored English variants instead
   (partials/header.en.html, partials/footer.en.html — never
   bootstrapped, only read).

   ...and stamp it into each page between HTML-comment markers:

       <!-- FW:INCLUDE header ... -->  ...canonical header...  <!-- /FW:INCLUDE header -->
       <!-- FW:INCLUDE footer ... -->  ...canonical footer...  <!-- /FW:INCLUDE footer -->

   The tool also stamps each page's SEO head block (title, description,
   canonical, Open Graph / Twitter tags) between:

       <!-- FW:HEAD ... -->  ...generated head block...  <!-- /FW:HEAD -->

   from the per-page registry in worker/lib/pages-meta.mjs (shared with
   the Worker, which builds sitemap.xml from the same list). On first
   run the markers are installed automatically: the old hand-written
   title/description/keywords/og lines are removed and the block is
   inserted after <meta charset> (or <base>, when present).

   WORKFLOW
     1. Edit partials/header.html, partials/footer.html, or
        worker/lib/pages-meta.mjs (for titles/descriptions).
     2. Run:  node tools/sync-partials.js
     3. Hard-refresh the preview (Ctrl+F5).

   The markup stays physically in every page (not injected at runtime),
   so the theme JS — sticky menu, Bootstrap dropdowns, lazy-img shapes —
   keeps working exactly as before, with no flash on load. Per-page
   "current page" highlighting is handled at runtime by js/fourwalls.js.

   First run bootstraps the two partials from their source pages (it
   never overwrites an existing partial), then installs the markers.
   ===================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const ROOT = path.resolve(__dirname, "..");

/* Pages that share the header + footer. Add a page here (and re-run) to
   opt it into the shared menu/footer. */
const PAGES = [
	"index.html",
	"services.html",
	"service_details.html",
	"services/buying.html",
	"services/renting.html",
	"services/selling.html",
	"services/valuation.html",
	"services/renovation.html",
	"services/property-management.html",
	"about.html",
	"contact.html",
	"listing_01.html",
	"listing_03.html",
	"listing_details_01.html",
	"properties.html",
	"property.html",
	"faq.html",
	"terms-of-use.html",
	"privacy-policy.html",
	"cookies.html",
	"404.html",
	/* English site (/en/…) — stamped with the .en partial variants. */
	"en/index.html",
	"en/services.html",
	"en/services/buying.html",
	"en/services/renting.html",
	"en/services/selling.html",
	"en/services/valuation.html",
	"en/services/renovation.html",
	"en/services/property-management.html",
	"en/about.html",
	"en/contact.html",
	"en/properties.html",
	"en/property.html",
	"en/faq.html",
	"en/terms-of-use.html",
	"en/privacy-policy.html",
	"en/cookies.html",
	"en/404.html",
];

/* One entry per reusable region. `source` is where the canonical markup
   is lifted from on first run. Anchors delimit the raw region in a page
   that has not been wrapped in markers yet. */
const REGIONS = [
	{
		name: "header",
		source: "index.html",
		startAnchor: '<header class="theme-main-menu',
		endAnchor: "<!-- /.theme-main-menu -->",
	},
	{
		name: "footer",
		source: "services.html",
		startAnchor: '<div class="footer-',
		endAnchor: "<!-- /.footer-",
	},
];

const read = (p) => fs.readFileSync(p, "utf8").replace(/^﻿/, "");
const write = (p, s) => fs.writeFileSync(p, s, { encoding: "utf8" }); // no BOM, LF preserved

/* Locate a raw (un-wrapped) region by its anchors. Consumes an immediately
   preceding decorative "===" banner comment so it travels with the block. */
function findRawRegion(content, region) {
	const s = content.indexOf(region.startAnchor);
	if (s === -1) return null;

	let start = content.lastIndexOf("\n", s - 1) + 1; // start of the anchor's line
	const above = content.slice(0, start).replace(/[ \t\r\n]+$/, "");
	if (above.endsWith("-->")) {
		const open = above.lastIndexOf("<!--");
		if (open !== -1 && above.slice(open).includes("===")) {
			start = content.lastIndexOf("\n", open - 1) + 1;
		}
	}

	let e = content.indexOf(region.endAnchor, s);
	if (e === -1) return null;
	e = content.indexOf("-->", e) + 3; // through the end of the close comment

	return { start, end: e, text: content.slice(start, e) };
}

/* Replace the body between an installed marker pair with fresh partial text. */
function spliceMarkers(content, name, partial) {
	const openStr = "<!-- FW:INCLUDE " + name;
	const closeStr = "<!-- /FW:INCLUDE " + name;
	const oi = content.indexOf(openStr);
	const ci = content.indexOf(closeStr);
	if (oi === -1 || ci === -1) return null;

	const openLineEnd = content.indexOf("\n", content.indexOf("-->", oi));
	const closeLineStart = content.lastIndexOf("\n", ci);
	return (
		content.slice(0, openLineEnd + 1) +
		partial +
		"\n" +
		content.slice(closeLineStart + 1)
	);
}

/* ------------------------------------------------------------------ */
/* SEO head block (FW:HEAD markers, content from worker/lib/pages-meta) */
/* ------------------------------------------------------------------ */

function esc(s) {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/* Render the generated head block for one page. workerManaged pages
   (listing detail shell) get only title + description — the Worker
   injects canonical/OG/JSON-LD per listing, and emitting them here too
   would duplicate the tags. Pages with path:null (404) likewise.

   When the page's translation pair exists in PAGES_META, both language
   versions emit the identical hreflang triple (el / en / x-default→el),
   derived from the registry keys so the pair can never drift. */
function buildHead(page, meta, { SITE, PAGES_META, pageLang, alternateKey }) {
	const t = "\t";
	const lines = [
		t + "<title>" + esc(meta.title) + "</title>",
		t + '<meta name="description" content="' + esc(meta.description) + '">',
	];
	if (!meta.workerManaged && meta.path) {
		const url = SITE.origin + meta.path;
		const image = SITE.origin + SITE.ogImage;
		const alt = PAGES_META[alternateKey(page)];
		if (alt && alt.path && !alt.workerManaged) {
			const elPath = pageLang(page) === "el" ? meta.path : alt.path;
			const enPath = pageLang(page) === "el" ? alt.path : meta.path;
			lines.push(
				t + '<link rel="alternate" hreflang="el" href="' + esc(SITE.origin + elPath) + '">',
				t + '<link rel="alternate" hreflang="en" href="' + esc(SITE.origin + enPath) + '">',
				t + '<link rel="alternate" hreflang="x-default" href="' + esc(SITE.origin + elPath) + '">'
			);
		}
		lines.push(
			t + '<link rel="canonical" href="' + esc(url) + '">',
			t + '<meta property="og:site_name" content="' + esc(SITE.name) + '">',
			t + '<meta property="og:locale" content="' + esc(SITE.locales[pageLang(page)]) + '">',
			t + '<meta property="og:type" content="website">',
			t + '<meta property="og:url" content="' + esc(url) + '">',
			t + '<meta property="og:title" content="' + esc(meta.title) + '">',
			t + '<meta property="og:description" content="' + esc(meta.description) + '">',
			t + '<meta property="og:image" content="' + esc(image) + '">',
			t + '<meta name="twitter:card" content="summary_large_image">',
			t + '<meta name="twitter:title" content="' + esc(meta.title) + '">',
			t + '<meta name="twitter:description" content="' + esc(meta.description) + '">',
			t + '<meta name="twitter:image" content="' + esc(image) + '">'
		);
	}
	return lines.join("\n");
}

/* Replace the body between an installed FW:HEAD marker pair. */
function spliceHead(content, block) {
	const oi = content.indexOf("<!-- FW:HEAD");
	const ci = content.indexOf("<!-- /FW:HEAD");
	if (oi === -1 || ci === -1) return null;
	const openLineEnd = content.indexOf("\n", content.indexOf("-->", oi));
	const closeLineStart = content.lastIndexOf("\n", ci);
	return (
		content.slice(0, openLineEnd + 1) +
		block +
		"\n" +
		content.slice(closeLineStart + 1)
	);
}

/* First-time install: strip the hand-written head lines the block
   replaces (title, description, keywords, og:/twitter:/canonical), then
   insert the marker pair after <base> when present (property.html needs
   its <base href="/"> to stay first), else after <meta charset>. */
function installHeadMarkers(content, block) {
	const headEnd = content.indexOf("</head>");
	if (headEnd === -1) return null;
	let head = content.slice(0, headEnd);
	const rest = content.slice(headEnd);

	head = head
		.replace(/^[ \t]*<title>[^\n]*<\/title>[ \t]*\r?\n/m, "")
		.replace(/^[ \t]*<meta name=["']description["'][^>]*>[ \t]*\r?\n/m, "")
		.replace(/^[ \t]*<meta name=["']keywords["'][^>]*>[ \t]*\r?\n/m, "")
		.replace(/^[ \t]*<meta (?:property|name)=["']og:[^>]*>[ \t]*\r?\n/gm, "")
		.replace(/^[ \t]*<meta name=["']twitter:[^>]*>[ \t]*\r?\n/gm, "")
		.replace(/^[ \t]*<link rel=["']canonical["'][^>]*>[ \t]*\r?\n/gm, "");

	let m = head.match(/^[ \t]*<base [^>]*>[ \t]*\r?\n/m);
	if (!m) m = head.match(/^[ \t]*<meta charset=[^>]*>[ \t]*\r?\n/m);
	if (!m) return null;
	const at = m.index + m[0].length;
	const wrapped =
		"\t<!-- FW:HEAD — generated by tools/sync-partials.js; page meta in worker/lib/pages-meta.mjs -->\n" +
		block +
		"\n\t<!-- /FW:HEAD -->\n";
	return head.slice(0, at) + wrapped + head.slice(at) + rest;
}

/* Wrap a raw region in markers for the first time. `indent` matches the
   leading whitespace of the region so the markers line up. */
function installMarkers(content, region, partial) {
	const raw = findRawRegion(content, region);
	if (!raw) return null;
	const indent = (content.slice(raw.start).match(/^[ \t]*/) || [""])[0];
	const block =
		indent + "<!-- FW:INCLUDE " + region.name +
		" — generated by tools/sync-partials.js; edit partials/" + region.name + ".html -->\n" +
		partial + "\n" +
		indent + "<!-- /FW:INCLUDE " + region.name + " -->";
	return content.slice(0, raw.start) + block + content.slice(raw.end);
}

/* --- 1. Bootstrap partials from their source pages (never overwrite) --- */
const partialDir = path.join(ROOT, "partials");
if (!fs.existsSync(partialDir)) fs.mkdirSync(partialDir);

const partials = {};
for (const region of REGIONS) {
	const file = path.join(partialDir, region.name + ".html");
	if (fs.existsSync(file)) {
		partials[region.name] = read(file).replace(/\n+$/, "");
		continue;
	}
	const src = read(path.join(ROOT, region.source));
	const raw = findRawRegion(src, region);
	if (!raw) throw new Error("Could not extract " + region.name + " from " + region.source);
	partials[region.name] = raw.text.replace(/\n+$/, "");
	write(file, partials[region.name] + "\n");
	console.log("bootstrapped partials/" + region.name + ".html  (from " + region.source + ")");
}

/* English partial variants (header.en.html / footer.en.html) are
   hand-authored translations — never bootstrapped from a (Greek) source
   page. Loaded read-only when present; en/ pages are skipped with a
   warning until they exist. */
for (const region of REGIONS) {
	const file = path.join(partialDir, region.name + ".en.html");
	if (fs.existsSync(file)) {
		partials[region.name + ".en"] = read(file).replace(/\n+$/, "");
	}
}

/* --- 2. Stamp every region + the SEO head block into every page --- */
(async function main() {
	// ESM registry shared with the Worker; this file is CommonJS, so load
	// it dynamically (pathToFileURL keeps Windows paths working).
	const metaUrl = pathToFileURL(path.join(ROOT, "worker", "lib", "pages-meta.mjs")).href;
	const registry = await import(metaUrl);
	const { SITE, PAGES_META, pageLang } = registry;

	for (const page of PAGES) {
		const file = path.join(ROOT, page);
		let content = read(file);
		const changed = [];
		const lang = pageLang(page);

		for (const region of REGIONS) {
			const partial = partials[region.name + (lang === "el" ? "" : "." + lang)];
			if (!partial) {
				console.warn("  ! " + page + ": partials/" + region.name + "." + lang + ".html missing (skipped)");
				continue;
			}
			let next = spliceMarkers(content, region.name, partial);
			let mode = "updated";
			if (next === null) {
				next = installMarkers(content, region, partial);
				mode = "installed";
			}
			if (next === null) {
				console.warn("  ! " + page + ": no " + region.name + " region found (skipped)");
				continue;
			}
			if (next !== content) changed.push(region.name + " " + mode);
			content = next;
		}

		/* Pages without a PAGES_META entry (template scaffolds) keep their
		   hand-written head untouched. */
		const meta = PAGES_META[page];
		if (meta) {
			const block = buildHead(page, meta, registry);
			let next = spliceHead(content, block);
			let mode = "updated";
			if (next === null) {
				next = installHeadMarkers(content, block);
				mode = "installed";
			}
			if (next === null) {
				console.warn("  ! " + page + ": no head anchor found (skipped)");
			} else {
				if (next !== content) changed.push("head " + mode);
				content = next;
			}
		}

		write(file, content);
		console.log((changed.length ? "✓ " : "· ") + page + (changed.length ? "  [" + changed.join(", ") + "]" : "  (no change)"));
	}

	console.log("\nDone. Hard-refresh the preview (Ctrl+F5).");
})();
