# AI photo enhancement pipeline

A consultant uploads a property's photos from their phone; Gemini ("Nano
Banana") declutters / brightens / fixes them per the options ticked; the
originals + edited land in a Google Drive folder; and an email goes to info@
(cc Panos, Manos) with the Drive link and a link to the CRM property (or to
create one). **Nothing auto-publishes** — a human reviews and uploads to the
CRM, because AI edits occasionally warp a scene and a listing photo must not
misrepresent the property.

```
forms.four-walls.gr/enhance.html   (behind Cloudflare Access — staff only)
  pick property (CRM) · tick edits · upload photos
        │  POST /api/photos/init         → batch id + composed prompt (stored in R2)
        │  PUT  /api/photos/upload/<b>/<n> (one per photo)  → R2  photos/<b>/orig/
        │  POST /api/photos/finalize/<b>  → signs each original, forwards to Make
        ▼
Cloudflare Worker  (worker/lib/photos.mjs)
        │  MAKE_PHOTO_WEBHOOK  { batch, property, links, options, prompt, photos[{name,url}] }
        ▼
Make scenario «Photos — AI enhance»
        │  per photo:  GET signed url → Gemini edit → upload original+edited to Drive
        │  once:       email info@ (cc panos, manos) with Drive link + CRM link
        ▼
Google Drive  four-walls/…            +    Zoho email
```

The design mirrors the existing browser→Worker→Make-secret pattern used by
[forms.mjs](../worker/lib/forms.mjs) and `/api/contact`. See the sibling docs
[forms-crm.md](forms-crm.md) and [forms-submit.md](forms-submit.md).

## Live scenario — «Photos — AI enhance» (id 6688477)

Built and maintained **via the Make API** (2026-07-24), not hand-assembled in
the UI. Two things that matters for:

- API-authored modules must explicitly set the "advanced" params the UI
  auto-fills — `stopOnHttpError`/`shareCookies` (HTTP), `convert` (Drive
  upload). Omitting them fails at runtime with `BundleValidationError`.
- The Gemini module's image `data` field takes the **raw binary buffer**
  (`{{4.data}}` straight from HTTP «Download a file») — do NOT wrap it in
  `base64()`: the module encodes internally, and pre-encoding double-encodes,
  which Gemini reports as `400 Unable to process input image` on any photo.
- Drive layout — **one folder per property, one subfolder per upload, and
  separate `enhanced/` + `originals/` inside it**:
  `Four Walls/photos/<code>/<YYYY-MM-DD · batch6>/{enhanced,originals}/`.
  The property folder is found-or-created («Get a Folder ID for a Path» →
  on-error «Create a Folder» → Resume), so later uploads for the same
  property reuse it. Batches without a property go under
  `photos/Χωρίς ακίνητο/`.
- The Gemini API key needs **billing enabled** on its Google Cloud project —
  image models have zero free-tier quota (`429 free_tier_requests, limit: 0`).

**Status 2026-07-24 — COMPLETE and verified end-to-end** with a real listing
photo through the full chain (form → R2 → webhook → per-property folders →
Nano Banana Pro edit → `enhanced/`+`originals/` in Drive → email): 39 s and
~€0.15 for a 1-photo batch. **Model is chosen per batch in the form** («Μοντέλο» radios; output always
capped at 2K), on Panos's personal Gemini connection (billing enabled
2026-07-24). The browser sends only a tier key — `worker/lib/photos.mjs`
`MODEL_TIERS` resolves it to the real model name (so the client can never
inject an arbitrary model) and Make maps `{{1.gemini_model}}` straight in:

| Tier key | Model | ~€/photo @2K | Default |
|----------|-------|--------------|:-------:|
| `lite` | `gemini-3.1-flash-lite-image` | ~0.02–0.05 | |
| `nb2`  | `gemini-3.1-flash-image` | ~0.05–0.08 | ✅ (also the fallback for unknown keys) |
| `pro`  | `gemini-3-pro-image` | ~0.13 | |

(Pro uncapped was hitting the 4K tier at ~€0.22/photo — that is why the
first real batch cost ~€3.) Gemini's **Batch API** (−50%) was considered
and skipped: Make's module has no batch mode, and a polling second
scenario would burn more Make ops than the €1/shoot it saves at current
volume — `batch_id` is ready as the correlation key if volume ever
justifies it.

`blur_windows` (replaced the old sky option, 2026-07-24): privacy feature —
the view through windows becomes a bright defocused glow so the building
can't be located from its θέα; mirrors the office's approximate-address
policy. When OFF, windows are fully locked ("never alter anything seen
through windows").

## Pieces

| Piece | File | Role |
|-------|------|------|
| Form | [forms/enhance.html](../forms/enhance.html) | Property picker (reuses `/api/crm/listings`), 7 edit toggles, client-side downscale to 3840px + HEIC→JPEG, 3-step upload with progress |
| Ingest | [worker/lib/photos.mjs](../worker/lib/photos.mjs) | `init`/`upload`/`finalize` API, R2 staging, HMAC-signed download URLs, **prompt composition from option keys** |
| Routes | [worker/index.mjs](../worker/index.mjs) | Staff API gated by Access on `forms.*`; public `/api/photos/file/` served on the apex, guarded by signature |
| Config | [wrangler.toml](../wrangler.toml) | `PHOTO_BUCKET` R2 binding + `MAKE_PHOTO_WEBHOOK` / `PHOTO_SIGN_KEY` secrets |
| Engine | Make scenario (below) | Gemini calls, Drive upload, email |

## Prompt composition (the toggles)

The form sends **option keys**, never prompt text — the mapping lives in
`composePrompt()` in [photos.mjs](../worker/lib/photos.mjs), version-controlled
and reviewable. Two options change the property's *true condition* and are
**off by default**, and actively clamped when off:

| Key | Greek label | Default | When OFF, the prompt… |
|-----|-------------|:-------:|------------------------|
| `declutter` | Αφαίρεση ακαταστασίας | on | omits the fragment |
| `lighting` | Βελτίωση φωτισμού & χρωμάτων | on | omits |
| `straighten` | Ευθυγράμμιση & προοπτική | on | omits |
| `blur_windows` | Θόλωμα θέας παραθύρων | on | window lockdown: "never alter anything seen through windows" |
| `remove_people` | Αφαίρεση ανθρώπων & αντανακλάσεων | on | omits |
| `repair_damage` | Επιδιόρθωση φθορών | **off** | **actively tells the model to PRESERVE every crack/stain/wear** |
| `virtual_staging` | Εικονική επίπλωση κενών χώρων | **off** | tells the model to add nothing not physically present |

So the default behaviour can never quietly hide a real defect. A permanent HARD
RULES clause forbids altering walls/doors/windows/floors/views regardless.

## Data contract (Worker → Make webhook)

`finalize` POSTs this JSON to `MAKE_PHOTO_WEBHOOK`:

```jsonc
{
  "batch_id": "a1b2…32hex",
  "submitted_by": "consultant@four-walls.gr",   // from the Access JWT
  "submitted_at": "2026-07-24T…Z",
  "has_property": true,
  "property": { "id": "123", "code": "FW-123", "address": "…", "area": "…" }, // or null
  "links": {
    "public": "https://four-walls.gr/properties/FW-123",   // null if blank
    "crm":    "https://fourwalls.estateprime.gr/listings/view/123", // null if blank
    "crmCreate": null                                       // set instead when blank
  },
  "options": ["declutter","lighting","straighten","sky","remove_people"],
  "prompt": "You are a professional real-estate photo editor…",  // ready to use
  "count": 24,
  "photos": [
    { "name": "000-IMG_1.jpg", "content_type": "image/jpeg",
      "url": "https://four-walls.gr/api/photos/file/<batch>/000-IMG_1.jpg?exp=…&sig=…" }
  ]
}
```

Signed URLs live 6 h — the scenario must run within that window.

## Make scenario build recipe — «Photos — AI enhance»

Team **Four Walls** (`2060918`). **Exact wiring values for this account:**

| Thing | Value |
|-------|-------|
| Webhook (already created) | hook `3443497` — URL `https://hook.eu1.make.com/eb8c4s2p14fxne49mxyu0rolo7fbbr2g` |
| Google Drive connection | `9265298` (panos.malliakoudis@gmail.com) |
| Drive parent folder "Four Walls" | id `1LV68zqq7Z54LOUPD9kL1wQi6f_6t5Kbh` |
| Email (send) connection | Zoho SMTP `8845630` (+ IMAP `8845636` for "save to Sent") |
| Recipients | To `info@four-walls.gr`; Cc/Bcc `panos@four-walls.gr`, `manos@four-walls.gr` |
| Gemini model | `gemini-3-pro-image-preview` (paste your key into the HTTP module) |

Modules (mirrors your other Site/CRM scenarios — same email app):

1. **Webhook › Custom webhook** — "Photos — AI enhance". Save the generated URL
   for the setup step. (Optionally set API-key auth and mirror it into the
   `MAKE_PHOTO_APIKEY` Worker secret; the header the Worker sends is
   `x-make-apikey`.)
2. **Google Drive › Create a Folder** — Parent = your `four-walls` folder. Name:
   `{{if(1.has_property; 1.property.code; "Χωρίς ακίνητο")}} — {{formatDate(now; "YYYY-MM-DD")}} — {{substring(1.batch_id;0;6)}}`. Keep its **id** and **webViewLink**.
3. **Flow control › Iterator** — array = `{{1.photos}}`.
4. **HTTP › Get a file** — URL = `{{3.url}}`. Returns the original binary.
5. **HTTP › Make a request** (Gemini):
   - URL `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=YOUR_GEMINI_KEY`
   - Method **POST**, header `Content-Type: application/json`, **Parse response = Yes**
   - Body (raw):
     ```jsonc
     {
       "contents": [{ "parts": [
         { "text": "{{1.prompt}}" },
         { "inline_data": { "mime_type": "{{3.content_type}}", "data": "{{base64(4.data)}}" } }
       ]}],
       "generationConfig": { "responseModalities": ["IMAGE"] }
     }
     ```
6. **Google Drive › Upload a File** (edited) — Folder = `{{2.id}}`; name
   `enhanced-{{replace(3.name; "/\\.\\w+$/"; "")}}.png`; data =
   `{{toBinary(first(map(5.body.candidates[].content.parts[]; "inlineData.data")); "base64")}}`.
7. **Google Drive › Upload a File** (original, for A/B) — Folder = `{{2.id}}`;
   name `original-{{3.name}}`; data = `{{4.data}}`.
8. **Flow control › Array aggregator** — source = the **Iterator (3)**. This
   collapses the per-photo branch back to one bundle so the email fires **once**.
9. **Router**, two routes:
   - **Has property** — filter `{{1.has_property}}` = true → **Zoho Mail › Send an email**
     (connection `My Zoho Mail`): To `info@four-walls.gr`; Cc `panos.malliakoudis@gmail.com, <manos-email>`;
     Subject `Επεξεργασμένες φωτογραφίες — {{1.property.code}}`; HTML body with
     the Drive folder link `{{2.webViewLink}}`, the CRM link `{{1.links.crm}}`,
     `{{1.count}}` photos, and the options list.
   - **No property** — filter `{{1.has_property}}` = false → same email, but the
     body links the Drive folder + **create a listing** `{{1.links.crmCreate}}`,
     noting the property wasn't selected.

> **Why the aggregator (8):** modules after an Iterator run once per photo. Without
> the aggregator you'd send one email per photo. It's the standard Make idiom for
> "do X once after the loop".

**I can build this scenario for you over MCP** once the Google Drive connection
exists (step 2 of the checklist) — it can't be scripted before the connection
is there to reference.

## Setup checklist

**Cloudflare** (deploy = push to `main`; secrets don't need a deploy):
- [ ] `npx wrangler r2 bucket create four-walls-photos`
- [ ] (recommended) R2 → bucket → **lifecycle rule**: expire objects after 7 days (originals are throwaway once Make has them)
- [ ] `npx wrangler secret put PHOTO_SIGN_KEY` — any long random string
- [ ] `npx wrangler secret put MAKE_PHOTO_WEBHOOK` — the webhook URL from Make step 1
- [ ] push to `main` so the `PHOTO_BUCKET` binding + routes deploy

**Make** (team Four Walls):
- [ ] **Create a Google Drive connection** (Add → Google Drive → sign in). You're
      currently Zoho-only there; this is the one manual OAuth only you can do.
- [ ] Have your **Gemini API key** ready (AI Studio) for the HTTP module. Billing
      must be enabled for `gemini-3-pro-image-preview`; for free-tier tests swap to
      `gemini-2.5-flash-image`.
- [ ] Build the scenario above (or tell me the Drive connection is ready and I'll build it via MCP), then **turn it on**.
- [ ] Fill in **Manos's email** in the two email modules.

**Confirm:**
- [ ] EstatePrime link paths `/listings/view/{id}` and `/listings/form` actually open (see the TODO in `propertyLinks`, [photos.mjs](../worker/lib/photos.mjs)).

## Operational notes

- **Limits (Core plan):** 40-min execution (a 25-photo batch ≈ 6–12 min), 10k
  ops/month (~60+ batches at ~150 ops each), BYOK-LLM enabled. Form caps a batch
  at **60 photos / 30 MB each**.
- **Cost:** ~€0.13/photo at 1–2K, ~€0.24 at 4K (Nano Banana Pro). A 25-photo
  batch ≈ €3–6. Make's Batch API halves Gemini cost if you accept up to 24 h.
- **Resolution / HEIC:** the form downscales to 3840px longest edge and re-encodes
  to JPEG (normalises iPhone HEIC, saves mobile data, keeps web-grade detail).
  Nano Banana Pro can emit up to 4K, so no separate upscale step is needed.
- **Security:** upload API is behind Cloudflare Access (only signed-in staff spend
  Gemini credits). The public download route carries no Access — it's guarded by a
  6-hour HMAC signature over `<batch>/<name>` and serves only that batch's
  originals. Client photos are served `no-store`.
- **Privacy of R2 objects:** unguessable batch ids + short-lived signatures; the
  lifecycle rule deletes originals after a week. These photos become public
  listings anyway.
