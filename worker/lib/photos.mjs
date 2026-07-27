/* =====================================================================
   Four Walls — AI photo enhancement pipeline (forms.four-walls.gr)
   ---------------------------------------------------------------------
   A consultant opens forms/enhance.html, optionally picks a property
   from the CRM, ticks which edits they want (declutter, lighting, …),
   and uploads the listing photos. This module is the ingest half:

     POST /api/photos/init            create a batch, compose the AI
                                      prompt from the ticked options
     PUT  /api/photos/upload/<b>/<n>  stream one original into R2
     POST /api/photos/finalize/<b>    hand Make signed URLs + the prompt

   Make then pulls each original by its signed URL, runs it through
   Gemini ("Nano Banana"), drops originals + edited into a Google Drive
   folder, and emails info@ (cc panos, manos) with the Drive link and a
   link to the CRM property (or to create one, when left blank).

   WHY R2 IN THE MIDDLE: a listing shoot is 15-40 photos / 50-300 MB —
   far past what a Make webhook payload will swallow. The browser stages
   the full-res originals here (behind Access, so staff-only), and Make
   fetches them one at a time from:

     GET /api/photos/file/<b>/<name>?exp=&sig=

   That download route is reached by Make (a server with no Access
   cookie), so it lives on the apex host (no Access) and is guarded by a
   short-lived HMAC signature instead — same "the URL is the credential"
   idea as the Make webhooks, but expiring and per-object.

   Mirrors the browser→Worker→Make-secret pattern already used by
   worker/lib/forms.mjs and the /api/contact relay in worker/index.mjs.
   ===================================================================== */

import { json } from "./access.mjs";

/* ------------------------------------------------------------ limits */

const MAX_FILES = 60;                       // a generous single-shoot cap
const MAX_FILE_BYTES = 30 * 1024 * 1024;    // 30 MB per original
const SIGNED_URL_TTL = 6 * 3600;            // Make must fetch within 6 h
const ALLOWED_MIME = new Set([
	"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
]);
const EXT_FOR_MIME = {
	"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
	"image/heic": "heic", "image/heif": "heif",
};

/* -------------------------------------------------- prompt composition

   The form sends OPTION KEYS, never prompt text — the mapping stays here
   (version-controlled, reviewable) instead of being hand-typed into a
   Make module. Two options change what the buyer sees as the property's
   true condition, so they are OFF by default in the form AND actively
   clamped here: when «repair damage» is off we tell the model to PRESERVE
   every defect, so the default can never quietly hide a real fault. */

const SAFE_FRAGMENTS = {
	declutter:
		"Remove clutter and personal items — dishes, food, cables, chargers, laundry, shoes, toiletries, bins, fridge magnets, loose papers and small objects on counters, tables, beds and floors. Tidy and neatly arrange whatever furniture and textiles remain: straighten cushions, make beds, align chairs. Remove only OBJECTS: the pattern of a material is never clutter — veining in marble or stone, grain in wood, speckle in terrazzo, the variation between tiles and the grout lines between them must all survive untouched. Do not smooth, even out, polish or clean any patterned surface.",
	lighting:
		"Improve exposure and colour: brighten the scene so it reads clean and airy, correct white balance to neutral, gently recover detail in blown-out windows and dark shadows, and keep colour natural and realistic — never oversaturated.",
	// "Remove keystoning" alone was read as "re-shoot this room head-on": a
	// kitchen photographed from an angle came back as a flat elevation, with
	// everything in it re-drawn to match (2026-07-27). The correction has to
	// be bounded to the lens, or it becomes a new photograph.
	straighten:
		"Correct the geometry: level the horizon and straighten vertical lines (walls, door frames) so the shot no longer looks tilted. This is a MILD LENS CORRECTION ONLY. The camera does not move: viewpoint, angle, height, distance, focal length and framing stay exactly as photographed. A room shot from an angle stays shot from that angle — never re-project it into a straight-on, flat or one-point view, never rotate or swing the room to face the camera, never reveal a surface the original frame did not show, and never change how much of any wall, unit or object is visible. If honouring this would mean redrawing the scene, leave the geometry alone.",
	// Privacy, not beautification: the office publishes approximate addresses
	// only (display_address="fake" in the CRM), and a recognizable view
	// through a window lets a viewer pinpoint the building and bypass the
	// agency. The glow/blur keeps the photo bright without revealing it.
	blur_windows:
		"Privacy: obscure whatever is visible through every window, balcony door and glass railing — replace the outside view with a bright, heavily defocused daylight glow so that no buildings, streets, balconies, landmarks or landscape outside are recognizable. Keep the window frames, curtains and glass reflections crisp and natural, and keep the light spilling into the room consistent.",
	remove_people:
		"Remove any people and pets from the scene, and remove the photographer's reflection from mirrors, windows and glossy surfaces.",
};

/* Everything the model is asked to do. `watermark` is deliberately NOT one
   of these: a generative model reproduces logos unreliably (and declutter
   would happily "clean" one off), so the logo is drawn deterministically by
   applyWatermark() below, AFTER Gemini, via the Cloudflare Images binding. */
const AI_OPTIONS = new Set([
	...Object.keys(SAFE_FRAGMENTS), "repair_damage", "virtual_staging",
	"finish_works", "render_finished",
]);
/* `staging_notice` is an overlay too, not an AI edit: when a room has been
   virtually furnished the photo should SAY so, so the form offers it
   (ticked) the moment «Εικονική επίπλωση» is chosen. Drawn bottom-left by
   applyWatermark(), opposite the logo. */
const KNOWN_OPTIONS = new Set([
	...AI_OPTIONS, "watermark", "staging_notice", "works_notice", "render_notice",
]);

/* Model tiers the form may pick. The CLIENT sends only the tier key; the
   real Gemini model name is resolved HERE, so the browser can never inject
   an arbitrary (pricier) model. Make just uses payload.gemini_model.
   Prices ≈ per photo at 2K output. */
const MODEL_TIERS = {
	lite: { model: "gemini-3.1-flash-lite-image", label: "Nano Banana 2 Lite (πολύ οικονομικό)" },
	nb2: { model: "gemini-3.1-flash-image", label: "Nano Banana 2 (οικονομικό)" },
	pro: { model: "gemini-3-pro-image", label: "Nano Banana Pro (κορυφαίο)" },
};
const DEFAULT_TIER = "nb2";

/* Pass 1 of the edit: a cheap vision call that writes down what the room
   ACTUALLY contains, which pass 2 then treats as ground truth. Grounding
   the editor in an inventory of the real photo is what stops it inventing
   a bathtub or swapping one shower for a nicer one — feeding it the other
   photos of the property as references would do the opposite, since a
   fixture seen in a reference tends to bleed into the edit. */
// NOTE: no double quotes anywhere in this string — Make interpolates it
// into a hand-written JSON body, and a stray " would break the request.
const INVENTORY_PROMPT = [
	"You are surveying ONE photograph of a property for a real-estate listing, so that a photo editor can retouch it WITHOUT changing anything that is really there. Be precise and exhaustive; plain text only, no markdown.",
	"Use exactly these labelled sections, each on its own line:",
	"ROOM: the room type.",
	// The editor kept closing up an empty fridge/washing-machine recess while
	// tidying, and kept re-projecting angled shots into flat elevations. It
	// cannot protect what the survey never wrote down.
	"VIEWPOINT: where the camera is and how the room sits in the frame — say whether the shot is straight on or from an angle, roughly how oblique, which walls are seen face on and which recede, and whether the camera is low, at eye level or high.",
	"OPENINGS AND EMPTY SPACES: every doorway, opening, pass-through, recess, alcove and niche, and every deliberately empty gap — a slot left for a fridge, washing machine, dishwasher, oven or boiler, an open space under a worktop, an unfitted run of wall. For each one say where it is, roughly how big, and that it is currently open and empty. These gaps are part of the property and must survive the edit exactly as they are.",
	"SURFACES: every visible surface — floor, walls, ceiling, tiling, splashback, worktops, stair treads — naming for each one its material, finish and pattern, its colour, and the format or layout where it applies. Say for example: floor in large 60x60 grey marble-effect porcelain tiles with soft white veining, laid straight; walls in matt ivory paint; splashback in small white gloss metro tiles with grey grout.",
	"FIXTURES AND FITTINGS: every permanent item and every significant piece of furniture, each with its type, style, material, colour and finish. Be especially exact about small metalwork and lighting, because that is what gets silently redesigned: for every tap say whether it is a single-lever mixer or two separate taps, whether it is mounted on the basin, on the worktop or on the wall, its spout shape and its finish. For a shower, list its parts one by one and say which of them exist: a hand shower on a hose, a sliding rail, a fixed overhead or rain head, a bath spout, a thermostatic bar, a glass screen or curtain, the tray or tub. If the shower has only a wall mixer and a hand shower and NO overhead or rain head, say exactly that. Do the same for light fittings (shape, arm count, material, shade, warm or cool light), door and cupboard handles, radiators, sockets and switches, window frames, curtains or blinds, and the kitchen or bathroom units. Say for example: brushed-nickel single-lever basin mixer with a curved spout, mounted on the basin; chrome wall mixer with a hand shower on a 60 cm sliding rail and no overhead head; three-arm black metal ceiling pendant with opal glass globes.",
	"ABSENT: name explicitly whichever of these are NOT in the room, so the editor knows not to invent them: bathtub, shower, toilet, bidet, basin, kitchen counter, cooker or hob, extractor hood, fireplace, radiator, air-conditioning unit, balcony door.",
	"GLASS AND MIRRORS: list every glass or mirrored surface — shower screen, mirror, glazed door, window — and say what is reflected in it or seen through it. A reflection belongs to the glass; it is not a real object standing in the room, and it must be reproduced as the same reflection, not turned into something solid.",
	"Three cautions. Natural pattern is not dirt: veining in marble or stone, grain in wood, speckle in terrazzo, variation between tiles and visible grout lines are all features of the material — record them as such rather than as stains. If the room is unfinished or mid-renovation, say so plainly and name what is unfinished (bare plaster, exposed cabling, missing skirting, protective film, dust or debris), because the editor must not tidy that away. And report only what is visible in this photograph: never guess at what lies out of frame, and never mention anything you cannot actually see.",
].join(" ");

/* Greek labels for the handoff email («Επεξεργασίες» row) — keep in sync
   with the OPTIONS array in forms/enhance.html. */
const OPTION_LABELS_EL = {
	declutter: "Αφαίρεση ακαταστασίας",
	lighting: "Βελτίωση φωτισμού & χρωμάτων",
	straighten: "Ευθυγράμμιση & προοπτική",
	blur_windows: "Θόλωμα θέας παραθύρων",
	remove_people: "Αφαίρεση ανθρώπων & αντανακλάσεων",
	repair_damage: "Επιδιόρθωση φθορών",
	virtual_staging: "Εικονική επίπλωση κενών χώρων",
	staging_notice: "Σήμανση εικονικής επίπλωσης",
	finish_works: "Αποπεράτωση εργασιών σε εξέλιξη",
	works_notice: "Σήμανση εργασιών σε εξέλιξη",
	render_finished: "Απεικόνιση ολοκληρωμένου χώρου",
	render_notice: "Σήμανση απεικόνισης",
	watermark: "Λογότυπο κάτω δεξιά",
};

function composePrompt(options) {
	const on = new Set(options);
	const lines = [
		"You are a professional real-estate photo editor preparing this photograph for a property listing.",
		// It once answered a portrait photo with a landscape three-panel
		// contact sheet of variations. Say this first and unmistakably.
		"OUTPUT EXACTLY ONE IMAGE: the supplied photograph, retouched. Never a collage, grid, triptych, split screen, before-and-after pair or set of alternatives — one single edited frame, nothing beside it. Keep the original orientation and aspect ratio exactly: a portrait photo stays portrait, a landscape photo stays landscape, and you must not add borders, padding or panels.",
		"Apply only the edits listed below. Keep the result fully photorealistic, keep the exact same framing, and output the entire scene.",
		// The failure mode behind almost every complaint: given enough
		// instructions the model stops retouching and starts re-rendering the
		// room from scratch, at which point everything in it drifts.
		"THIS IS A RETOUCH OF AN EXISTING PHOTOGRAPH, NOT A NEW RENDERING OF THE ROOM. Start from the supplied pixels and change only what is asked. The camera stays exactly where it was: same viewpoint, same angle, same height, same distance, same lens and same framing, so every object stays at the same place, size and orientation in the frame as in the original. If you catch yourself redrawing the scene rather than editing it, stop and edit instead.",
		// A half-built room must not come back finished — unless the office
		// deliberately asked for the after-the-works view, which then gets
		// stamped with its own disclaimer (see finish_works / works_notice).
		on.has("render_finished")
			? "THIS PROPERTY IS AN UNFINISHED SHELL AND YOU ARE ASKED FOR A VISUALISATION OF IT COMPLETED. Deliver the finishes a developer would hand over, plainly and neutrally: level and finish the floors, plaster and paint walls and ceilings in a warm neutral white, fit skirting and door and window frames, glaze the openings, add simple ceiling lighting, and tile wet areas in plain neutral tiles. KEEP THE ARCHITECTURE UNTOUCHED: every column, beam, wall position, opening, staircase, level change and ceiling height stays exactly where it is, and the view through every opening is unchanged. You are dressing the shell, never redesigning the building. Restrained and photorealistic — an indicative standard finish, not a luxury showpiece."
			// "Hide exposed cabling" was read as licence to build a cupboard in
			// front of it: an empty fridge/washing-machine recess came back
			// panelled over with a full-height unit (2026-07-27). A gap left
			// for an appliance is information the buyer needs, not a defect.
			: on.has("finish_works")
			? "THIS PROPERTY IS MID-WORKS AND YOU ARE ASKED TO SHOW IT COMPLETED. Present the room as it will look once the current works are finished: hide exposed cabling and conduit behind the finished surface, fit the missing skirting and trims, finish and paint bare plaster in the same colour as the finished walls, remove protective film, building dust, debris, tools and materials, and complete the ceiling and lighting that are evidently being installed. Complete ONLY what is plainly already under way, and change nothing else: keep the exact same layout, dimensions, openings, fixtures, sanitary ware, tiles, marble, flooring and every material and colour already in place. EVERY EMPTY SPACE STAYS EMPTY: a recess, alcove, niche or gap left for a fridge, washing machine, dishwasher, oven or boiler is part of the design and the buyer needs to see it — never close it up, panel it over, fit a door across it or fill it with a cabinet, and never add a unit, worktop, shelf or appliance that is not already installed. Deal with cabling by concealing it against the surface it runs on, never by building something in front of it. You are finishing the works that were started, never redesigning, filling in or upgrading the property."
			: "THIS IS A REAL, POSSIBLY UNFINISHED PROPERTY. If the room is mid-renovation or under construction — bare plaster, exposed cabling, missing skirting, unpainted or unfinished surfaces, protective film, building dust or debris — it must STAY that way. Never complete the works, never finish, paint, tile or install anything, and never present the space as more finished than it is.",
		// The rule the model breaks most eagerly: it "upgrades" what it sees
		// — one shower tray becomes a nicer shower tray, a tap becomes a
		// different tap. That is a misrepresentation even though nothing was
		// added or removed, so it is stated before any of the edits.
		"PRESERVE EVERY OBJECT YOU KEEP, EXACTLY AS PHOTOGRAPHED: same type, model, shape, size, material, colour, finish, pattern and position. Never swap, restyle, modernise, upgrade or 'improve' anything that is already in the room — a shower stays that exact shower, a tap that exact tap, a tile that exact tile, a sofa that exact sofa, a light fitting that exact light fitting, a door handle that exact door handle. This applies just as strictly to surfaces: the marble or stone veining, the wood grain, the tile layout and its grout lines are the material's own pattern, NOT dirt to be cleaned away — reproduce them faithfully. Your only permitted changes are the ones listed below; everything else must survive the edit unchanged and recognisable as the same physical object.",
	];

	for (const key of Object.keys(SAFE_FRAGMENTS)) {
		if (on.has(key)) lines.push("- " + SAFE_FRAGMENTS[key]);
	}

	// Damage — the honesty clamp. Off (the default) must actively preserve.
	// A shell being visualised complete is the one case where "keep every
	// scuff" is self-contradictory (it is about to be plastered and painted),
	// so there the clamp narrows to defects in the building's fabric.
	lines.push(on.has("repair_damage")
		? "- Repair visible surface damage: fill cracks, remove stains and water marks, and touch up peeling or scuffed paint so walls and surfaces look sound and freshly maintained."
		: on.has("render_finished")
		? "- Beyond the finishing authorised above, hide nothing: structural cracks, damp patches, water staining and any defect in the fabric of the building must remain clearly visible in the result."
		: "- Preserve ALL visible damage exactly as it is: cracks, stains, water marks, peeling paint, scuffs and wear must remain clearly visible and unaltered. Do not hide or repair any defect.");

	// Staging — off (the default) must add nothing. When on, the spec is
	// deliberately detailed: v1's one-liner staged rooms too sparsely (a
	// lone sofa, a bathroom with just a mirror) and let the model invent
	// doors / turn a window into a balcony door (feedback 2026-07-25).
	// On a bare shell the old wording talked the model out of the job: it
	// forbade touching any surface (which the visualisation is explicitly
	// completing) and keyed the room type off "visible fixtures", of which a
	// shell has none — so it staged nothing and the notice went on a photo
	// with no furniture in it (feedback 2026-07-27).
	const stageLead = on.has("render_finished")
		? "- Virtual staging: furnish the completed space with LOOSE, MOVABLE FURNISHINGS — things a stager could carry in and out in an afternoon. The completion authorised above gives you finished floors, walls and openings; dress that finished space, but build nothing further yourself. This room is an unfinished shell, so read its intended use from its size, shape, position, openings and any plumbing or electrical rough-ins, and furnish it as that room — a shell with no fixtures is still a bedroom, a living room or a kitchen, and must be furnished as one. Furnish fully and realistically, the way a professional home stager would present a listing — welcoming and lived-in, never minimal, never cluttered:"
		: "- Virtual staging: add LOOSE, MOVABLE FURNISHINGS ONLY — things a stager could carry in and out in an afternoon. You are dressing the room, never building it: do not finish, renovate, retile, repaint or complete anything, and do not touch a single fixed surface or installation. Within that limit, furnish an empty or sparse room fully and realistically, the way a professional home stager would present a listing — welcoming and lived-in, never minimal, never cluttered. First identify each room's type from its visible fixtures, then furnish accordingly:";
	lines.push(on.has("virtual_staging")
		? [
			stageLead,
			"  * Living room: a full sofa arrangement with cushions and a throw, coffee table, area rug, TV unit or bookcase, floor lamp, wall art and a plant.",
			"  * Bedroom: a properly sized bed with made-up linens and pillows, nightstands with lamps, a rug and wall art.",
			"  * Kitchen: small countertop appliances (coffee machine, kettle, toaster), a fruit bowl, a cutting board and a few tasteful jars — on existing counters only.",
			"  * Bathroom: folded towels on existing rails or shelves, a bath mat, soap dispensers and cosmetics by the basin, a small plant or candles — NEVER a bathtub, shower, basin, toilet, bidet or any other sanitary fixture: dress only what is already installed.",
			"  * Dining area: a dining table with chairs and a simple centerpiece.",
			"  In every room, also add curtains on the existing windows, a tasteful ceiling light fixture if the room lacks one, and rugs or plants as accents.",
			"  STRICT while staging: add loose furniture, textiles, light fixtures and decor ONLY — NEVER invent doors, balcony doors, windows, openings or passages that are not in the photo; never turn a window into a balcony door or vice versa; NEVER add plumbing or built-in equipment (bathtub, shower, basin, toilet, bidet, radiator, fireplace, kitchen counter, cupboards, sink, oven, hob, extractor hood, air-conditioning unit); every wall, opening and room dimension stays exactly as photographed; keep all furniture realistically scaled and do not misrepresent the room's true size or layout.",
		].join("\n")
		: "- Do not add any furniture, appliances or decorative objects that are not already physically present in the photo.");

	// blur_windows deliberately REPLACES what is seen through windows — the
	// only sanctioned exception to the windows rule. Spell it out both ways,
	// or the two instructions contradict and the model resolves it
	// unpredictably.
	// Make substitutes the pass-1 survey for the token (see INVENTORY_PROMPT).
	// Placed last so it is the freshest thing before the hard rules.
	// The blanket "never add what is absent" is right for a normal listing
	// photo and fatal for the three options that exist precisely to add
	// something: on a shell the survey lists floors, paint and furniture as
	// absent, and the model then refuses to stage or finish anything. Carve
	// the sanctioned additions out instead of dropping the grounding.
	const adding = on.has("virtual_staging") || on.has("finish_works") || on.has("render_finished");
	lines.push(
		"VERIFIED INVENTORY OF THIS EXACT PHOTOGRAPH, from a prior inspection of it — treat it as ground truth and trust it over your own expectations of what such a room usually contains: __INVENTORY__",
		adding
			? "That inventory records the property's true condition; it is not a limit on the edits authorised above. Anything it lists as absent really is missing from the property, so never present it as an existing feature and never add it unless an instruction above explicitly asks you to. Whatever it lists as present must still be there afterwards, as the very same item — same type, style and material as described. The surfaces it describes are binding except where an instruction above explicitly asks you to finish them: otherwise keep every tile, marble or stone pattern, floor covering, worktop and wall finish exactly as it is — do not re-tile, re-pattern, polish or otherwise restyle a single surface."
			: "Whatever that inventory lists as absent does not exist here: never add it. Whatever it lists as present must still be there afterwards, as the very same item — same type, style and material as described. The surfaces it describes are binding too: keep every tile, marble or stone pattern, floor covering, worktop and wall finish exactly as it is — do not re-tile, re-pattern, polish or otherwise restyle a single surface.",
	);

	// Last word in the prompt, so it has to agree with the options above.
	// The default list forbids adding floors, ceilings and cabinetry — which
	// is exactly what a visualisation is asked to do, so that variant locks
	// the STRUCTURE instead and leaves the surfaces to the clause above.
	const windowRule = on.has("blur_windows")
		? "The ONLY permitted change through windows is the privacy obscuring requested above."
		: "Never alter anything seen through windows.";
	const noEquipment = "Never invent plumbing or installed equipment (bathtub, shower, basin, toilet, bidet, radiator, fireplace, kitchen counter, sink, oven, hob, extractor hood, air-conditioning unit).";
	// An empty appliance slot is a fact about the property, and closing it up
	// is the kind of change a buyer only discovers on the viewing. It gets its
	// own sentence in both variants because "do not add cabinetry" was not
	// read as covering it.
	const gapsStay = "AN EMPTY GAP STAYS AN EMPTY GAP: any recess, alcove, niche or unfitted space — for a fridge, washing machine, dishwasher, oven, boiler or anything else — must still be open and empty afterwards, at the same size. Never close, panel, board, door or cabinet it over, and never park an appliance or unit in it.";
	// Repeated at the very end because it is the rule that fails first: once
	// the model re-frames the shot, every other rule quietly goes with it.
	const cameraRule = "And the camera never moves: same viewpoint, angle, distance and framing as the original photograph.";
	lines.push(on.has("render_finished")
		? "HARD RULES: never add, remove, resize, relocate or reinterpret any part of the building itself — walls, columns, beams, doors, balcony doors, windows, other openings, staircases, level changes, ceiling heights, room dimensions or the layout. Finishing the SURFACES of what is already there is authorised above; changing what is there is not. " + noEquipment + " An unfinished bathroom or kitchen is handed over tiled and empty, not fitted out. " + gapsStay + " A window stays a window; a door stays a door; an opening stays exactly the size and shape it is. " + windowRule + " The edited photo must not misrepresent the property itself. " + cameraRule
		: "HARD RULES: never add, remove, resize, relocate or reinterpret any permanent feature — walls, doors, balcony doors, windows, other openings, floors, ceilings, stairs, built-in cabinetry, or any plumbing/installed equipment (bathtub, shower, basin, toilet, bidet, radiator, fireplace, kitchen counter, sink, oven, hob, extractor hood, air-conditioning unit). Never REPLACE an existing one with a different type, model or style, and never ADD A PART to something that is already there: if a shower has only a wall mixer and a hand shower, do NOT give it an overhead or rain head; do not add a second tap, an extra radiator panel, another cupboard door or an extra lamp to a fitting. If a bathroom has no bathtub the edited photo must still have no bathtub, and if it has a corner shower tray that exact tray must still be there — not a nicer one. " + gapsStay + " A window stays a window; a door stays a door. " + windowRule + " The edited photo must not misrepresent the property. " + cameraRule);
	return lines.join("\n");
}

/* ------------------------------------------------------ signed URLs */

function b64url(bytes) {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(env, message) {
	const key = await crypto.subtle.importKey(
		"raw", new TextEncoder().encode(env.PHOTO_SIGN_KEY),
		{ name: "HMAC", hash: "SHA-256" }, false, ["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return b64url(new Uint8Array(sig));
}

async function signedFileUrl(env, origin, batchId, name) {
	const exp = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL;
	const sig = await hmac(env, `${batchId}/${name}\n${exp}`);
	return `${origin}/api/photos/file/${batchId}/${encodeURIComponent(name)}?exp=${exp}&sig=${sig}`;
}

/* Constant-ish time compare — the batch id is already unguessable, but no
   reason to leak signature bytes through early-return timing. */
function safeEqual(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/* --------------------------------------------------------- helpers */

function newBatchId() {
	const b = crypto.getRandomValues(new Uint8Array(16));
	return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const isBatchId = (s) => /^[0-9a-f]{32}$/.test(s);

function sanitizeName(name, mime) {
	let base = String(name || "photo").split(/[\\/]/).pop().slice(0, 80);
	base = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "photo";
	if (!/\.[A-Za-z0-9]+$/.test(base)) base += "." + (EXT_FOR_MIME[mime] || "jpg");
	return base;
}

/* CRM/site links the email needs. The back-office paths follow EstatePrime's
   `/<resource>/view/<id>` + `/<resource>/form` UI scheme (docs/estateprime-
   crm-ui.md: /requests/view/{id}, /requests/form) applied to the `listings`
   resource. TODO(estateprime): confirm /listings/view + /listings/form open
   correctly (some edit deep-links there redirect to the list) and fix HERE. */
function propertyLinks(env, property) {
	const site = "https://four-walls.gr";
	const crmBase = `https://${env.ESTATEPRIME_SUBDOMAIN || "fourwalls"}.estateprime.gr`;
	if (!property || !property.id) {
		return { public: null, crm: null, crmCreate: `${crmBase}/listings/form` };
	}
	return {
		public: property.code ? `${site}/properties/${encodeURIComponent(property.code)}` : null,
		crm: `${crmBase}/listings/view/${encodeURIComponent(property.id)}`,
		crmCreate: null,
	};
}

/* ----------------------------------------------------- API routing

   Every route here is already past the Access gate (see worker/index.mjs)
   — the caller is a named consultant. `email` is who Access says they are
   (null only on a local `wrangler dev` run). */

export async function handlePhotoApi(request, env, url, email) {
	if (!env.PHOTO_BUCKET) {
		console.error("photos: PHOTO_BUCKET (R2) not bound");
		return json({ error: "not_configured" }, 503);
	}
	const parts = url.pathname.split("/").filter(Boolean); // api photos <action> ...

	if (request.method === "POST" && parts[2] === "init") {
		return initBatch(request, env, url, email);
	}
	if (request.method === "PUT" && parts[2] === "upload") {
		return uploadOne(request, env, parts[3], parts[4]);
	}
	if (request.method === "POST" && parts[2] === "finalize") {
		return finalizeBatch(request, env, url, parts[3]);
	}
	return json({ error: "not_found" }, 404);
}

async function initBatch(request, env, url, email) {
	let body;
	try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }

	const count = Number(body?.count || 0);
	if (!Number.isInteger(count) || count < 1 || count > MAX_FILES) {
		return json({ error: "bad_count", max: MAX_FILES }, 400);
	}

	const options = Array.isArray(body?.options)
		? [...new Set(body.options.filter((o) => KNOWN_OPTIONS.has(o)))]
		: [];

	// Unknown/absent tier silently falls back to the cheap default — a typo
	// must never buy the expensive model.
	const tier = MODEL_TIERS[body?.model] ? body.model : DEFAULT_TIER;

	// property: keep only the fields we trust and the email needs. A blank
	// property is legitimate — the email then links to "create a listing".
	let property = null;
	if (body?.property && body.property.id) {
		property = {
			id: String(body.property.id).slice(0, 40),
			code: body.property.code ? String(body.property.code).slice(0, 40) : null,
			address: body.property.address ? String(body.property.address).slice(0, 200) : null,
			area: body.property.area ? String(body.property.area).slice(0, 120) : null,
		};
	}

	const batchId = newBatchId();
	const meta = {
		batch_id: batchId,
		created_at: new Date().toISOString(),
		submitted_by: email || null,
		property,
		links: propertyLinks(env, property),
		options,
		// Ready-made Greek list for the email's «Επεξεργασίες» row.
		options_label: options.map((k) => OPTION_LABELS_EL[k] || k).join(", "),
		model_tier: tier,
		gemini_model: MODEL_TIERS[tier].model,
		model_label: MODEL_TIERS[tier].label,
		// Lets the Make scenario route: no AI edit ticked -> skip Gemini
		// entirely (watermark-only, or a plain archive-to-Drive run).
		ai: options.some((o) => AI_OPTIONS.has(o)),
		watermark: options.includes("watermark"),
		prompt: composePrompt(options),
		inventory_prompt: INVENTORY_PROMPT,
		count,
	};
	await env.PHOTO_BUCKET.put(`photos/${batchId}/meta.json`, JSON.stringify(meta), {
		httpMetadata: { contentType: "application/json" },
	});
	return json({ ok: true, batch_id: batchId });
}

async function uploadOne(request, env, batchId, seqRaw) {
	if (!isBatchId(batchId)) return json({ error: "bad_batch" }, 400);
	const seq = Number(seqRaw);
	if (!Number.isInteger(seq) || seq < 0 || seq >= MAX_FILES) return json({ error: "bad_seq" }, 400);

	// Only a batch that init created can be written to (also blocks stray PUTs).
	if (!(await env.PHOTO_BUCKET.head(`photos/${batchId}/meta.json`))) {
		return json({ error: "unknown_batch" }, 404);
	}

	const mime = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
	if (!ALLOWED_MIME.has(mime)) return json({ error: "bad_type", got: mime }, 415);
	if (Number(request.headers.get("Content-Length") || 0) > MAX_FILE_BYTES) {
		return json({ error: "too_large", max: MAX_FILE_BYTES }, 413);
	}

	const bytes = await request.arrayBuffer();
	if (bytes.byteLength === 0) return json({ error: "empty" }, 400);
	if (bytes.byteLength > MAX_FILE_BYTES) return json({ error: "too_large", max: MAX_FILE_BYTES }, 413);

	const safe = sanitizeName(request.headers.get("X-Filename"), mime);
	const name = String(seq).padStart(3, "0") + "-" + safe;
	// The browser measured the photo, so it can name the closest Gemini
	// output ratio; pinning it stops the model reshaping a portrait shot
	// (it once returned a landscape three-panel sheet). Whitelisted, since
	// it is client input that ends up in an API request.
	const rawAspect = String(request.headers.get("X-Aspect") || "");
	const aspect = /^(1:1|2:3|3:2|3:4|4:3|4:5|5:4|9:16|16:9|21:9)$/.test(rawAspect) ? rawAspect : "";
	await env.PHOTO_BUCKET.put(`photos/${batchId}/orig/${name}`, bytes, {
		httpMetadata: { contentType: mime },
		customMetadata: aspect ? { aspect } : undefined,
	});
	return json({ ok: true, name });
}

async function finalizeBatch(request, env, url, batchId) {
	if (!isBatchId(batchId)) return json({ error: "bad_batch" }, 400);
	if (!env.MAKE_PHOTO_WEBHOOK) {
		console.error("photos: MAKE_PHOTO_WEBHOOK secret not configured");
		return json({ error: "not_configured" }, 503);
	}

	const metaObj = await env.PHOTO_BUCKET.get(`photos/${batchId}/meta.json`);
	if (!metaObj) return json({ error: "unknown_batch" }, 404);
	const meta = await metaObj.json();

	// Enumerate what actually landed (the browser may have dropped a file).
	const objects = [];
	let cursor;
	do {
		const page = await env.PHOTO_BUCKET.list({ prefix: `photos/${batchId}/orig/`, cursor });
		objects.push(...page.objects);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	if (!objects.length) return json({ error: "no_photos" }, 400);

	// Signed URLs point at the apex (no Access) so Make can fetch them; on a
	// local dev run there is no Make, so the request origin is fine.
	const origin = url.hostname === "localhost" || url.hostname === "127.0.0.1"
		? url.origin
		: `https://${url.hostname.replace(/^forms\./, "")}`;

	const photos = [];
	for (const o of objects.sort((a, b) => (a.key < b.key ? -1 : 1))) {
		const name = o.key.slice(`photos/${batchId}/orig/`.length);
		photos.push({
			name,
			content_type: o.httpMetadata?.contentType || "image/jpeg",
			aspect: o.customMetadata?.aspect || "",
			url: await signedFileUrl(env, origin, batchId, name),
		});
	}

	const wmExp = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL;
	const payload = {
		batch_id: batchId,
		submitted_by: meta.submitted_by,
		submitted_at: new Date().toISOString(),
		has_property: !!meta.property,
		property: meta.property,
		links: meta.links,
		options: meta.options,
		options_label: meta.options_label || (meta.options || []).join(", "),
		model_tier: meta.model_tier || DEFAULT_TIER,
		gemini_model: meta.gemini_model || MODEL_TIERS[DEFAULT_TIER].model,
		model_label: meta.model_label || MODEL_TIERS[DEFAULT_TIER].label,
		ai: meta.ai ?? (meta.options || []).some((o) => AI_OPTIONS.has(o)),
		watermark: !!(meta.options || []).includes("watermark"),
		// Make POSTs every AI-edited image here; the endpoint draws the logo
		// only when this batch ticked the option, else passes through — so
		// the scenario needs no router. Signed like the file URLs.
		watermark_url: `${origin}/api/photos/watermark/${batchId}?exp=${wmExp}&sig=${await hmac(env, `watermark/${batchId}\n${wmExp}`)}`,
		prompt: meta.prompt,
		count: photos.length,
		photos,
	};

	const fwd = await fetch(env.MAKE_PHOTO_WEBHOOK, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(env.MAKE_PHOTO_APIKEY ? { "x-make-apikey": env.MAKE_PHOTO_APIKEY } : {}),
		},
		body: JSON.stringify(payload),
	});
	if (!fwd.ok) {
		console.error(`photos: Make forward failed for ${batchId} (HTTP ${fwd.status})`);
		return json({ error: "forward_failed" }, 502);
	}
	console.log(JSON.stringify({
		event: "photo_batch", batch_id: batchId, count: photos.length,
		has_property: !!meta.property, options: meta.options, by: meta.submitted_by,
		ts: new Date().toISOString(),
	}));
	return json({ ok: true, count: photos.length });
}

/* --------------------------------------------------- signed download

   Reached by Make on the apex host (no Access cookie). Guarded by the
   HMAC signature + expiry minted in finalizeBatch — nothing else. Serves
   ONLY originals under this batch's orig/ prefix; the signed name carries
   no slash, so it cannot walk out to meta.json or another batch. */
export async function servePhotoFile(request, env, url) {
	if (!env.PHOTO_BUCKET || !env.PHOTO_SIGN_KEY) {
		return new Response("Not configured", { status: 503 });
	}
	const m = url.pathname.match(/^\/api\/photos\/file\/([0-9a-f]{32})\/([^/]+)$/);
	if (!m) return new Response("Not Found", { status: 404 });
	const batchId = m[1];
	const name = decodeURIComponent(m[2]);

	const exp = Number(url.searchParams.get("exp") || 0);
	const sig = url.searchParams.get("sig") || "";
	if (!exp || exp < Math.floor(Date.now() / 1000)) {
		return new Response("Link expired", { status: 410 });
	}
	const expected = await hmac(env, `${batchId}/${name}\n${exp}`);
	if (!safeEqual(sig, expected)) return new Response("Forbidden", { status: 403 });

	const obj = await env.PHOTO_BUCKET.get(`photos/${batchId}/orig/${name}`);
	if (!obj) return new Response("Not Found", { status: 404 });
	return new Response(obj.body, {
		headers: {
			"Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
			"Content-Length": String(obj.size),
			// Client photos: keep proxies/CDN from retaining a copy.
			"Cache-Control": "private, no-store",
		},
	});
}

/* ----------------------------------------------------- watermarking

   POST /api/photos/watermark/<batch>?exp=&sig=  (apex, HMAC-guarded)

   Make POSTs every AI-edited image here before uploading it to Drive.
   The batch's meta decides what happens:
     - option ticked   -> the Four Walls logo is drawn bottom-right via
                          the Cloudflare Images binding (deterministic —
                          never ask a generative model to render a logo)
     - option off      -> the bytes pass through untouched (zero Images
                          transformations billed)
   FAIL-OPEN on any hiccup (missing binding, logo asset, Images error):
   an unwatermarked photo in Drive beats a dead batch — the failure is
   logged for the Observability tab. */
export async function applyWatermark(request, env, url) {
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", { status: 405, headers: { "Allow": "POST" } });
	}
	if (!env.PHOTO_BUCKET || !env.PHOTO_SIGN_KEY) {
		return new Response("Not configured", { status: 503 });
	}
	const m = url.pathname.match(/^\/api\/photos\/watermark\/([0-9a-f]{32})$/);
	if (!m) return new Response("Not Found", { status: 404 });
	const batchId = m[1];

	const exp = Number(url.searchParams.get("exp") || 0);
	const sig = url.searchParams.get("sig") || "";
	if (!exp || exp < Math.floor(Date.now() / 1000)) {
		return new Response("Link expired", { status: 410 });
	}
	const expected = await hmac(env, `watermark/${batchId}\n${exp}`);
	if (!safeEqual(sig, expected)) return new Response("Forbidden", { status: 403 });

	// Buffer the image so pass-through/fail-open can always replay it.
	const bytes = await request.arrayBuffer();
	if (!bytes.byteLength) return new Response("Empty body", { status: 400 });
	const contentType = (request.headers.get("Content-Type") || "image/png").split(";")[0].trim();
	const passthrough = () =>
		new Response(bytes, {
			headers: { "Content-Type": contentType, "Cache-Control": "private, no-store" },
		});

	const meta = await env.PHOTO_BUCKET.get(`photos/${batchId}/meta.json`).then((o) => o?.json()).catch(() => null);
	const opts = meta?.options || [];
	const wantsLogo = opts.includes("watermark");
	const notices = [
		// Order matters when several apply: they stack down the top-left
		// corner, whole-scene claims first. A visualisation supersedes the
		// mid-works notice — it is the stronger statement about the photo.
		opts.includes("render_notice") ? "fourwalls_render_notice.png"
			: opts.includes("works_notice") ? "fourwalls_works_notice.png" : null,
		opts.includes("staging_notice") ? "fourwalls_staged_notice.png" : null,
	].filter(Boolean);
	if (!wantsLogo && !notices.length) return passthrough();

	if (!env.IMAGES) {
		console.warn("photos: overlay requested but IMAGES binding missing — passing through");
		return passthrough();
	}
	try {
		// Size overlays RELATIVE to the frame, not in fixed pixels: the AI
		// route hands us a 2K render while the logo-only route carries
		// whatever the phone shot, and a fixed width would look twice as
		// big on one as on the other. Insets scale too, so a crop that
		// removes a mark costs a big slice of the photo with it.
		let frameW = 2048, frameH = 1536;
		try {
			const info = await env.IMAGES.info(new Blob([bytes]).stream());
			if (info?.width) frameW = info.width;
			if (info?.height) frameH = info.height;
		} catch { /* not a format info() understands — keep the 2K assumption */ }
		// Scale off the LONG edge, not the width: a portrait shot is just as
		// big on screen as a landscape one, but its width is ~25% smaller, so
		// a width-based mark came out visibly too small on verticals. The cap
		// keeps it sane on extremely tall/narrow crops.
		const base = Math.max(frameW, frameH);
		const markW = (share, cap) => Math.min(Math.round(base * share), Math.round(frameW * cap));
		const inset = Math.round(Math.min(frameW, frameH) * 0.035);

		let pipeline = env.IMAGES.input(new Blob([bytes]).stream());

		if (wantsLogo) {
			// Transparent PNG, white wordmark + pink cube, soft shadow baked
			// in so it reads on a bright floor and on dark furniture alike —
			// no solid box (docs/brand.md covers how it is generated).
			const logoRes = await env.ASSETS.fetch(new URL("/images/logo/fourwalls_watermark.png", url.origin));
			if (!logoRes.ok) throw new Error(`logo asset HTTP ${logoRes.status}`);
			pipeline = pipeline.draw(
				env.IMAGES.input(logoRes.body).transform({ width: markW(0.29, 0.42) }),
				{ bottom: inset, right: inset, opacity: 0.9 },
			);
		}

		// TOP-left, not bottom-left: side by side at the bottom the marks
		// leave only ~120 px between them on a phone-portrait shot and read
		// as one cramped strip. Up here a notice also reads as a label on
		// the photo rather than as branding. Kept smaller than the logo
		// (25% vs 29%) — brand first, notice second.
		const noticeW = markW(0.25, 0.40);
		const noticeH = Math.round(noticeW * (232 / 800)); // plate aspect
		for (let i = 0; i < notices.length; i++) {
			const res = await env.ASSETS.fetch(new URL(`/images/logo/${notices[i]}`, url.origin));
			if (!res.ok) throw new Error(`notice asset HTTP ${res.status}`);
			pipeline = pipeline.draw(
				env.IMAGES.input(res.body).transform({ width: noticeW }),
				{ top: inset + i * (noticeH + Math.round(inset * 0.4)), left: inset, opacity: 0.92 },
			);
		}

		const out = await pipeline.output({ format: "image/png" });
		return out.response();
	} catch (err) {
		console.warn(`photos: overlay failed for ${batchId}, passing through: ${String(err)}`);
		return passthrough();
	}
}
