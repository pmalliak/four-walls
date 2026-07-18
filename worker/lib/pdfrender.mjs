/* =====================================================================
   Four Walls — server-side PDF for the Έντυπα (Browser Rendering REST)
   ---------------------------------------------------------------------
   The client's html2pdf attachment is a PHOTOGRAPH of the document —
   viewers OCR it, and Greek OCR pastes as greeklish. This renders the
   SAME document HTML in Cloudflare's headless Chrome instead, producing
   a real-text PDF (selectable, searchable, ~10× smaller).

   TRIAL WIRING — deliberately fail-open: the form still sends its own
   pdf_base64, and forms.mjs only swaps it when this returns bytes. Any
   failure here (flag off, missing secrets, API error, timeout) just
   keeps the client PDF. Rollback = PDF_RENDER "0". Needs:
     PDF_RENDER=1            wrangler.toml [vars] — the switch
     CF_ACCOUNT_ID           wrangler.toml [vars]
     BROWSER_RENDER_TOKEN    secret — API token, Account → Browser
                             Rendering → Edit
   ===================================================================== */

const MAX_HTML = 2 * 1024 * 1024; // a doc with logo+signatures is ~300KB

export async function renderDocPdf(env, docHtml) {
	if (env.PDF_RENDER !== "1") return null;
	if (!env.CF_ACCOUNT_ID || !env.BROWSER_RENDER_TOKEN) {
		console.warn("pdfrender: PDF_RENDER=1 but CF_ACCOUNT_ID/BROWSER_RENDER_TOKEN missing");
		return null;
	}
	if (typeof docHtml !== "string" || !docHtml.trim() || docHtml.length > MAX_HTML) return null;

	// The renderer does not fetch the document's Google-Fonts <link> (the
	// first trial printed serif fallbacks), so the type ships inline: our
	// own asset with Manrope 400/700/800 as base64 @font-face. Read via
	// the ASSETS binding — no network involved.
	let fontsCss = "";
	try {
		const r = await env.ASSETS.fetch("https://assets.local/css/doc-fonts.fw.css");
		if (r.ok) fontsCss = await r.text();
		else console.warn(`pdfrender: doc-fonts asset HTTP ${r.status}`);
	} catch (err) {
		console.warn(`pdfrender: doc-fonts asset unreadable: ${String(err)}`);
	}

	const res = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/pdf`,
		{
			method: "POST",
			headers: {
				"Authorization": `Bearer ${env.BROWSER_RENDER_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				html: docHtml,
				...(fontsCss ? { addStyleTag: [{ content: fontsCss }] } : {}),
				gotoOptions: { waitUntil: "networkidle0", timeout: 30000 },
				pdfOptions: {
					format: "a4",
					printBackground: true,
					// The real margin authority is the @page rule DOCHTML appends
					// (CSS @page beats these in Chromium print — with a lone
					// margin:12mm from the forms' print CSS the right margin was
					// silently dropped and the page clipped). Keep both at
					// 10/10/12/10 so whichever wins, the page is the same.
					margin: { top: "10mm", right: "10mm", bottom: "12mm", left: "10mm" },
				},
			}),
		},
	);
	if (!res.ok) {
		console.warn(`pdfrender: API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
		return null;
	}
	// The endpoint answers with the PDF bytes themselves; a JSON body means
	// an error envelope slipped through with a 200.
	if ((res.headers.get("Content-Type") || "").includes("json")) {
		console.warn(`pdfrender: JSON where PDF expected: ${(await res.text()).slice(0, 200)}`);
		return null;
	}
	const bytes = new Uint8Array(await res.arrayBuffer());
	if (bytes.length < 1000 || String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") {
		console.warn(`pdfrender: response is not a PDF (${bytes.length} bytes)`);
		return null;
	}
	// btoa in chunks — the whole file as one string argument overflows.
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(bin);
}
