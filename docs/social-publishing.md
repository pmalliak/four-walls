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
2. Select photos only from the synchronized feed. Use an explicit public-field
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
node --test tests/social.test.mjs tests/social-diagnostics.test.mjs
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

Emergency stop: set `SOCIAL_LIVE_PUBLISH=0`. Keep D1/R2 for audit and recovery;
do not delete published history or reset `publishing` rows to `scheduled`.
CRM availability can change in the final milliseconds between verification and
Meta accepting a post; no cross-service transaction can prevent that race.
Reconciliation records later changes, but does not delete existing Meta posts.
