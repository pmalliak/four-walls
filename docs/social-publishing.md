# Social publishing

## Repository-based plan

The existing `fourwalls-site` Worker hosts buildless HTML and JavaScript,
verifies Cloudflare Access JWTs through `worker/lib/access.mjs`, rebuilds the
EstatePrime feed in KV every 15 minutes, and already binds R2 and Images.
There is no framework or package manager to replace.

1. Add a Greek internal dashboard at `forms.four-walls.gr/social`, using the
   same Access application. Guard both HTML/assets and `/api/social/*` in the
   Worker; exclude it from offline caching. Use D1 for revisioned drafts,
   approvals, scheduling, publish attempts and property-change history.
2. Select original photos only from the synchronized feed. Use an explicit public-field
   allowlist, deterministic Greek captions, square/portrait brand templates,
   Images JPEG rendering and immutable R2 assets. Edits invalidate approval.
   Export Marketplace text and photographs for manual publication only.
3. Use Meta Graph APIs for Instagram professional account images/carousels and
   Facebook Page photo posts. One draft targets one channel, avoiding partial
   cross-channel successes. Cron processes due posts every 15 minutes. Atomic
   D1 claims prevent concurrent publication; ambiguous outcomes require manual
   reconciliation, never blind retry. Live publication starts disabled.
4. Test access, input validation, revisions, approval, availability, cron claims,
   API adapters and failure recovery; document configuration and rollout.

EstatePrime remains authoritative: no CRM writes or duplicated editable stock.
Feed removal/content changes invalidate queued approvals. A direct authenticated
CRM read must report explicit `active` status and matching public content just
before every external publication. CRM failure fails closed. This narrows, but
cannot eliminate, the race between a CRM status change and Meta accepting a post.
Already published posts stay in history; removal from Meta is an operator task.

## Implementation and rollout

The MVP implements all four phases without a new runtime dependency or build
step. New code lives in `worker/lib/social*.mjs`, `forms/social*`, and the D1
migration. The original marketing feed and private CRM APIs are unchanged.

### Creative presets and original photos

Drafts offer three numbered presets: **Editorial**, **Architectural**, and
**Neighbourhood**. The existing square/portrait choice controls output size;
the preset controls the layout. Architectural uses the official portrait logo
(symbol above the name), and decorative illustrations never assert a floor
plan, view or neighbourhood fact. No AI image API is called at publication time.

The design preview uses the selected property's photos and public facts. It is
an approximate layout preview, clearly separated from the exact generated JPEGs
reviewed for approval. Users select/reorder photos, choose optional property-facts
and closing contact slides, edit the caption, save, then generate the final images.
The carousel remains at most 10 slides including facts/contact slides (normally
up to 8 photographs). Slides are ordered: cover, second photo if present, optional
facts, remaining photos, optional contact card. Missing facts are omitted.

`creative` is versioned JSON stored in D1 alongside the format and selected photos.
Every creative edit clears approval, rendered assets and scheduling. Migration
`0002_social_creative.sql` keeps pre-existing drafts/history on the legacy classic
layout; new drafts default to Architectural with facts and a closing contact card.
Previously rendered files remain immutable history.

Social sources come exclusively from public EstatePrime `original_image` values,
stored as `originalImages` in KV. The general website feed keeps its existing
fallback behavior. Social never falls back to `watermark_image`, including after
a failed download, and never guesses a clean URL or removes a watermark with AI.
`original_image` is source metadata, not image detection: if the original upload
includes footer branding, the social crop can exclude that footer from the output.
Staff review the resulting JPEGs before approval. There is no separate clean-photo
checkbox or automatic watermark-detection claim; the legacy confirmation field is
not a rendering or publication gate. If branding remains inside the retained photo,
adjust the crop or choose a suitable original in EstatePrime. Footer trimming does
not remove a watermark across the center of a photo and does not use AI removal.

New drafts trim the bottom **16% of landscape/square photos** and **10% of portrait
photos** before the preset's cover fit. Percentages refer to the displayed,
EXIF-oriented source. The Worker first materializes its upright orientation as a
lossless PNG, capped at 4096 pixels per side, then trims the bottom edge. The browser
preview uses the same crop rules. The EstatePrime original remains unchanged.

Staff can change each orientation default or override a selected photo from
**0–40%**; 0 keeps its full source frame. Each override is associated with the exact
photo URL, so it follows that photograph when reordered. Existing drafts without
a saved crop retain their uncropped behavior until staff explicitly apply cropping.
Saving a crop change creates a new creative revision and clears generated images,
approval and scheduling; regenerate and approve the final images again.

The closing slide/caption can direct visitors to the property page, `/request`
(buyer/tenant enquiry), or `/list-property` (owner enquiry), or retain a direct-message
call to action. Links are restricted to these public Four Walls destinations and
carry `utm_source`, `utm_medium=social`, `utm_campaign` and `utm_content` tags.
New captions contain the selected link; later changes offer an explicit insert-link
action that preserves edited text. The selected destination and its final graphic
are part of the saved, approved revision.

Facebook Page captions can carry the URL in their post text. This module does not
assume that a URL in an Instagram API caption is clickable: staff can copy it for
their profile or manually use a Story link sticker. It never changes a profile or
publishes a Story automatically. A website address drawn on a JPEG is not an
interactive button. UTM tags support attribution in an analytics tool that records
them; this release does not add a click-counting dashboard or change enquiry forms.

After the first deployment, wait for the next successful 15-minute feed refresh
to populate originals metadata. Until then the dashboard reports that photo
sources are awaiting synchronization. Properties without originals are excluded
from the social picker. The source-policy fingerprint invalidates old approvals;
open affected drafts, review/reselect original photographs, save, regenerate and
approve again. Removed selections are shown as an unsaved change, never silently
saved or replaced. Published/cancelled history is retained.

For this release, apply `npx.cmd wrangler d1 migrations apply four-walls-social
--remote` **before** merging the feature PR. Then let Workers Builds deploy main;
no new binding or publishing switch is needed. Keep live Meta publication disabled
while validating each preset and format, long Greek titles, missing prices,
photo ordering, and the final review/approval flow. Run all social tests with
`node --test tests/social*.test.mjs` (or explicit filenames in PowerShell).

### Staff workflow

Open **Έντυπα → Δημοσιεύσεις**, or `/social` on the forms hostname. Search the
synchronized active stock, choose Instagram, Facebook Page or Marketplace, and
create a draft. Select 1–10 photographs, order them with the left arrows, edit
the Greek caption (maximum 2,200 characters), and choose a square or portrait
template. Save changes, then submit to generate reviewable JPEGs.

An email in `SOCIAL_APPROVERS` can approve the exact saved revision. Approvers
may approve their own work in this MVP; a mandatory second-person rule is not
implemented. Any authenticated human in the existing Access app can edit drafts
and schedule approved posts. Service-token sessions without email are rejected.
Editing any approved content returns it to draft and clears rendered assets,
approval and schedule. Concurrent edits return 409 and require a reload.

Use **Διαγραφή δημιουργίας** to permanently remove an unpublished creation and
its history after confirmation, including scheduled or cancelled creations.
Published posts, posts currently publishing, and uncertain Meta outcomes cannot
be deleted. Resolve uncertain outcomes first. Deletion checks the saved revision
atomically so a concurrent scheduler claim cannot lose a publishing record.

The schedule picker displays the browser's timezone and sends UTC. Cron runs
at the existing quarter-hour cadence, processing at most three posts per tick.
Disabled publishing keeps schedules queued; **review overdue schedules before
enabling the live switch**, since they become due immediately. A property
change/removal blocks unpublised drafts and schedules; reappearing properties
never restore approval automatically. Refresh, save and reapprove explicitly.

Marketplace export requires approval and a direct live CRM availability check.
It downloads a ZIP with `listing.txt` and the reviewed JPEGs in selection order.
An export event is recorded, not a successful publication. Staff choose the
supported Marketplace category, review the current property, and publish
manually in Facebook. No login automation or Marketplace posting API exists
in this module. The exported file cannot enforce availability after download.

### Database and runtime configuration

Do not deploy this branch automatically. After code review, an operator:

1. Creates D1 with `npx wrangler d1 create four-walls-social`.
2. Adds this top-level binding to `wrangler.toml` using the returned ID:

   ```toml
   [[d1_databases]]
   binding = "SOCIAL_DB"
   database_name = "four-walls-social"
   database_id = "<returned D1 id>"
   migrations_dir = "worker/migrations"
   ```

3. Applies the migration before release:
   `npx wrangler d1 migrations apply four-walls-social --remote`.
   For isolated Wrangler development, use `--local` instead.
4. Sets `SOCIAL_APPROVERS` to comma-separated Access user email addresses.
   Keep the existing `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. Never set
   `CRM_DEV_BYPASS` on a deployed Worker. The social route ignores this bypass
   outside literal localhost/127.0.0.1; the publisher also refuses to run with it.
5. Confirms the existing `PHOTO_BUCKET`, `IMAGES`, and `PHOTO_SIGN_KEY` bindings.
   R2 objects use the **`social/` prefix**. Exclude this prefix from the existing
   7-day photo staging lifecycle: approved posts may be scheduled much later.
   Retain assets needed for publication history. Monitor storage and clean only
   unreferenced abandoned render batches under a documented retention policy.
6. Verifies the forms domain remains protected by the existing Cloudflare Access
   application. The Worker additionally validates the session and exact host for
   dashboard files and APIs. Mutations require a same-origin JSON request.

Without D1 the social API returns 503 and the original application continues to
work. No fictitious database ID is committed. Source, migrations, tests and
preview tooling are excluded from static asset uploads.

### Meta setup and activation

This adapter uses **Instagram API with Facebook Login**, a linked professional
Instagram account, and Facebook Page publishing. It does not use Instagram
consumer accounts, personal Facebook profiles, ads, videos, Stories or Reels.
Instagram uses single image containers or up to 10 carousel children followed by
`media_publish`; Facebook uploads unpublished photos, then attaches their IDs to
a Page feed post. Facebook multi-photo posts are not paid carousel ads.

Use a Meta app and Page access token with the appropriate Page task and approved
permissions: `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`,
and `instagram_content_publish`; Page discovery during setup also requires
`pages_show_list`. Complete the app review/business verification/access-level
steps that apply to your app and accounts. Confirm exact requirements against
the version selected in the Meta dashboard before activation. Token acquisition
and rotation are an operator setup task, not a browser OAuth flow in this MVP.

Configure these server-side values:

| Setting | Purpose |
| --- | --- |
| `META_GRAPH_VERSION` | Explicit supported Graph version, e.g. the version selected for the app; no implicit latest version |
| `META_PAGE_ID` | Destination Facebook Page ID |
| `META_IG_USER_ID` | Linked Instagram professional account ID |
| `META_PAGE_ACCESS_TOKEN` | Worker **secret**, via `npx wrangler secret put META_PAGE_ACCESS_TOKEN` |
| `SOCIAL_META_PERMISSIONS_CONFIRMED` | Keep `0` until permissions and account linkage have been verified; then `1` |
| `SOCIAL_LIVE_PUBLISH` | Committed as `0`; only explicitly set `1` after release validation |

Both account IDs are required by the MVP activation gate, even for Facebook-only
use. `SAMPLE_DATA=1`, missing configuration or a dev bypass disables publication.
The token is sent only in a server-side Authorization header to
`graph.facebook.com`; response bodies/errors containing tokens are never
returned to the browser or stored in history. Meta retrieves only rendered JPEGs
through a namespaced HMAC URL on the public apex, expiring after 24 hours.
Signed URLs are bearer capabilities for those images; never log or share them.

References: [Meta's official Instagram collection](https://www.postman.com/meta/instagram/collection/6yqw8pt/instagram-api),
[Instagram publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/content-publishing/),
[Facebook Page posts](https://developers.facebook.com/docs/pages-api/posts/),
[Cloudflare Images binding](https://developers.cloudflare.com/images/optimization/binding/),
[image border options](https://developers.cloudflare.com/images/optimization/features/#border).
The Meta developer pages were rate-limited during implementation; the official
Meta collection was accessible. Real account/API compatibility remains a release
check, not a claimed live integration test.

### Validation and release checklist

Run with Node 24+:

```sh
node --test tests/social.test.mjs tests/social-diagnostics.test.mjs tests/social-creative.test.mjs
node --check worker/index.mjs
node --check forms/social.fw.js
git diff --check
node tools/preview-social.mjs
```

The optional preview opens on `http://localhost:5174/social` and uses ephemeral
SQLite with synthetic stock. It never reads secrets or contacts Meta/CRM; actual
Cloudflare image rendering is deliberately unavailable there. Restarting resets
the preview. The plain repository preview server cannot serve the social API.

Automated tests execute the real migration and SQL in Node SQLite behind a small
D1-compatible adapter. They cover access/host guards, CSRF, private-field
projection, invalid photos, captions, stale feed/revisions, approvals, concurrent
mutations/cron claims, availability checks before and after media preparation,
Meta payloads, interrupted/ambiguous results, signed URLs and ZIP contents.
Cloudflare Images and external network responses are stubbed in tests.

Preset validation on 2026-10-31 also exercised the real Cloudflare Images binding
in an isolated temporary preview with no D1, R2 or Meta access. All three presets
produced 1080×1080 and 1080×1350 JPEGs; Greek long-title wrapping, missing-price
text and website CTA cards were checked visually. Text/art composition is flattened
into intermediate PNG batches to respect the service's ten-transform graph limit;
only the final JPEGs are saved to production R2. Staff review the final crop and
branding as part of image approval; a separate photo-review checkbox is not required.

Source-crop validation also used the real Images binding with public
`recurser/exif-orientation-examples` fixtures (Landscape/Portrait, EXIF 1 and 6).
All 16 combinations of default, explicit 0%, 40% override and legacy no-crop
matched the upright reference pixels exactly. Default landscape output was
1800×1008 from 1800×1200; portrait output was 1200×1620 from 1200×1800, including
the rotated sources. This isolated check used no D1, R2 or Meta bindings and
did not modify source images.

The MVP trusts fixed domains: the dashboard/API accepts `forms.four-walls.gr`
(plus localhost for development), and signed media URLs are generated and served
on `four-walls.gr`. An unchanged deployment to a separate staging hostname or
`workers.dev` cannot run this flow. To validate the current implementation, use
the existing Worker with **dedicated Meta test accounts**, confirm their IDs,
and ensure the schedule contains only approved test posts before enabling the
publishing switches. Local preview never publishes.

A separate staging Worker is future setup work: it first needs configurable,
explicitly trusted dashboard and media origins, a matching Access application,
and isolated D1/R2 resources. Do not disable the host or Access checks to make a
staging hostname work.

Before activating the real Four Walls social accounts:

- Verify Access, D1 migration/batch behavior, R2 storage and the real Images
  output (1080×1080 and 1080×1350 JPEG; check logo, crop and image readability).
- Verify ordinary staff cannot approve and logged-out users cannot retrieve
  dashboard/API/image responses on forms, public aliases or workers.dev.
- Confirm Meta permissions and publish one approved image and one carousel on
  the test Instagram account, plus a multi-photo post on the test Facebook Page.
- Mark a scheduled test property inactive; confirm it is blocked. Exercise
  interrupted publication and manual reconciliation with the operator.
- Review all outstanding schedules, confirm the intended account IDs, then
  explicitly activate publishing. No production publication was performed as
  part of implementation.

The repository's normal deployment is an authorized merge/push to `main` through
Workers Builds. This implementation only prepares a feature branch and PR.
Do **not** run `wrangler deploy` or push `main` as part of local validation.

### Operations and recovery

Unexpected API failures and service errors are recorded in the Worker's
Observability logs as `social_operation_failed`. Search for the error reference
shown by the dashboard (`errorId`) to find the operation, processing stage and
allowlisted provider code. Raw exception messages, credentials, request bodies,
captions and private CRM fields are excluded. Validation errors are not logged.

Photo fetches use `redirect: 'manual'` and reject non-2xx responses. Workers does
not implement `redirect: 'error'`; Node accepts it, so a Node-only test is not
sufficient to validate this runtime behavior. See the
[Workers Request reference](https://developers.cloudflare.com/workers/runtime-apis/request/).

Missing CRM titles are filled from public type, size and area/city fields in
the social projection. Authored CRM titles are preserved. Drafts saved before
this fix with blank titles may be blocked by reconciliation: save them again
to refresh the snapshot, review their captions, regenerate images and request
approval. Existing caption text and published history are not rewritten.
Deploy this fix through the normal feature PR and Workers Builds path; no new
binding, migration or publishing switch change is required.

History includes actor, revision, approval, schedule, property observations,
container/photo IDs, publish requests and final remote IDs. A conditional D1
update claims a schedule once. There is no automatic retry after contacting Meta:
even a timeout may have published successfully. Interrupted claims older than
20 minutes move to `needs_review` on a subsequent cron, including when the live
switch is off. An approver checks Meta, then records the remote ID as published
or confirms cancellation. To try again, create a new draft only after confirming
the old attempt did not publish. Unpublished Meta uploads may require cleanup.

Instagram containers are checked up to five times with one-second intervals.
If still processing, the conservative MVP holds the post for review. Large batch
throughput, resumable processing and automated token renewal are future work.
The dashboard lists the 100 most recently updated posts; older history remains
in D1. There are no background notifications in this MVP: staff inspect the queue.

The preset chooser and its enlargement dialog use the same pure composition
module as the image renderer (`forms/social-design.mjs`). Text wraps using
advance widths from the exact self-hosted fonts, so short and long Greek fields
share the same line breaks in both views. The browser loads design modules,
fonts and artwork through the authenticated social asset routes. Preview
loading failures are shown explicitly; the generated JPEG remains the final
approval target.

New preset typography follows the website: Montserrat with Manrope for missing
Greek heading glyphs, and Manrope for body text. The server and browser share
one renamed heading font that preserves this fallback deterministically, rather
than relying on a computer's installed fonts. Headings use weight 600; body copy
uses 400 and emphasis uses 600. Font coverage, pinned source files, licenses and
rebuild instructions are documented in `images/social/ARTWORK.txt`. Existing
Noto assets remain available for compatibility; stored approved JPEGs do not
change when fonts are updated.

The compact portrait logo retains the original outlined symbol and name,
without the small Real Estate tagline. Architectural uses this stacked mark;
Editorial and Neighbourhood use its horizontal variant. Pencil illustrations
follow the website's existing illustration style. They are generic decoration,
not representations of the listed home. Source notes and generation prompts
are in `images/social/ARTWORK.txt`. No image-generation API runs when staff
creates a post; the Worker combines these reusable assets with selected CRM
photos and public property facts.

For design QA with a public-property fixture, run
`node tools/preview-social.mjs 5175 path/to/public-property.json`. This preview
uses in-memory data and always disables publishing. Review cover, details,
photo and CTA slides at both output sizes, including a long location, missing
price and each destination. Then verify representative JPEGs through the real
Cloudflare Images binding before merging through Workers Builds. The design
refinement needs no additional migration or publishing-switch change.

Emergency stop: set `SOCIAL_LIVE_PUBLISH=0`. Keep D1/R2 for audit and recovery;
do not delete published history or reset `publishing` rows to `scheduled`.
CRM availability can change in the final milliseconds between verification and
Meta accepting a post; no cross-service transaction can prevent that race.
Reconciliation records later changes, but does not delete existing Meta posts.

## Test without publishing

For a saved draft, pending or approved Facebook/Instagram creation, an approver can
choose **Δοκιμή στο Meta**. This uploads the rendered images using the production
Page token even while `SOCIAL_LIVE_PUBLISH=0`. The dedicated adapter never calls
Instagram `media_publish`. Facebook photo uploads and the final draft explicitly
use `published=false`; the feed request also uses `unpublished_content_type=DRAFT`
and has no scheduled publication time. A read-back must confirm `is_published=false`.

Instagram containers are processing tests, not drafts visible in the Instagram
app. Facebook draft visibility in Meta's management UI must be checked separately.
History records safe object IDs and the verified result; it never records tokens,
signed image URLs, or raw Meta errors. The creation's status and approval stay unchanged.
Drafts use separate test renders with their saved crop; testing does not approve
those images for public publishing.
One attempt per saved revision is claimed before network mutations; ambiguous
failures are not automatically retried. Check recorded IDs before editing and
reapproving a new attempt. Deleting the local creation does not delete Meta drafts.

## Platform management and statistics

The **Ανάρτηση & στατιστικά στο Meta** section lists published post IDs and
verified Facebook draft IDs from this creation's audit history. Instagram test
containers are explicitly labelled as tests with no app link or audience stats.
Facebook drafts link to Business Suite's draft list for the configured Page;
published links use verified platform permalinks. Instagram needs a refresh to
resolve its permalink (an Instagram numeric media ID is not a shortcode).

Authenticated operators may refresh metadata and statistics. Approvers may edit
Facebook text or permanently delete a Facebook post after confirmation. Media
replacement and Instagram edits/deletions use native platform links. Server-side
ownership verification, stored-target validation and optimistic revision claims
precede every write. Only `message` is accepted for an edit; management never
publishes or schedules a draft. An uncertain write locks that target against
retries. Refresh can reconcile an uncertain edit when its text matches; uncertain
deletions require review in Meta. Audit history is retained for linked Facebook
creations, even after platform deletion; local and remote deletion are distinct.

Statistics are fetched on request, cached in audit snapshots, and refreshed at
most once a minute per saved target under normal sequential use. No cron polling.
Each value retains null versus zero and independent permission/unavailable status.
Facebook v26 uses `post_media_view`, `post_total_media_view_unique`, `post_clicks`
and the link-click component of `post_clicks_by_type`, plus reaction/comment/share
counts. Instagram uses likes/comments and `views`, `reach`, `saved`, `shares`.
These are lifetime metrics where available; no unsupported reach/impressions
fallbacks, synthetic totals or invented zeroes. Meta may update data only daily.

The existing token needs `read_insights` for Facebook and
`instagram_manage_insights` for Instagram in addition to existing scopes.
Reauthorize the existing Four Walls assets, then refresh/store the Page token;
never commit it. Follow any additional requirements Meta presents for the account.
Missing scopes do not prevent existing links and Facebook management from working.
No public post needs to be created just to validate this UI.

References checked on 2026-10-31:
- https://developers.facebook.com/documentation/pages-api/posts/
- https://developers.facebook.com/docs/graph-api/reference/v26.0/insights
- https://developers.facebook.com/documentation/instagram-platform/insights
- https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights
