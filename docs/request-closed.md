# «Ολοκλήρωσα την αναζήτηση» (request-closed)

The opt-out at the bottom of the CRM matchings email. A client who has already
found a property tells us to stop the προτάσεις for that ζήτηση — without
replying, calling, or being ignored.

```
crm/request-matchings.twig.html        request-closed.html         worker/index.mjs
  «Πείτε μας να σταματήσουμε»  ──►  /request-closed?r=&c=  ──POST──►  /api/request-closed
                                    (button + Turnstile)                     │
                                                                             ▼
                                                              Make hook ──► email to info@
                                                              (later: close the ζήτηση in the CRM)
```

## Why a page and not a one-click link

Two reasons, and the second is the one that decides it:

1. **A bare link is not a confirmation.** Mail scanners (Outlook Safe Links,
   antivirus gateways) fetch every URL in a message — a GET that closes the
   ζήτηση would fire before the client ever reads the email.
2. **EstatePrime has no update endpoint for requests** (asked 2026-07-17; same
   gap as contacts, see [forms-crm.md](forms-crm.md)). Nothing can be written
   back automatically yet, so a human at `info@` has to close the ζήτηση by
   hand. The page's job is to make that email trustworthy and complete —
   which ζήτηση, which επαφή, and the reason.

When the API grows an update endpoint, **only the Make scenario changes**: add a
module after the mail one. The page, the Worker route and the email stay as they
are.

## The pieces

| Piece | Where |
|---|---|
| Link in the email | `crm/request-matchings*.twig.html` — `?r={{ request.id }}&c={{ contact.id }}` (EN points at `/en/request-closed`) |
| Page | [../request-closed.html](../request-closed.html) (`/request-closed`) + [../en/request-closed.html](../en/request-closed.html) (`/en/request-closed`), both `sitemap: false` |
| Styles | `css/fourwalls.css` → «Ολοκλήρωση αναζήτησης» |
| Client JS | `js/fourwalls.js` → «Request closed» |
| Worker route | `worker/index.mjs` → `handleRequestClosed()` |
| Secrets | `TURNSTILE_SECRET_KEY` (shared with the contact form), `MAKE_REQUEST_CLOSED_WEBHOOK` |

Live since 2026-07-24: pushing to `main` deployed it (Workers Builds), and
`POST /api/request-closed` with no token answers `400 missing_token` — the
one-line check that the route is up and the secrets are configured (a missing
secret answers `500 not_configured` instead).

## Make

| | |
|---|---|
| Scenario | **Site - Ολοκλήρωση αναζήτησης** (`6683649`) |
| Hook | `Site — ολοκλήρωση αναζήτησης` (`3441770`) |
| Secret | `MAKE_REQUEST_CLOSED_WEBHOOK` — the URL itself is the credential |

Two modules, cloned from the contact-form scenario (`6530594`): webhook →
Zoho Mail **to `info@`, cc `manos@` + `panos@`** (from `info@four-walls.gr`, the
same connection). The mail says in plain words that the ζήτηση is **not** closed
automatically and links to `/requests/view/<request_id>` in the CRM. When the API
grows a request-update endpoint, a module goes **after** the mail one — nothing
else moves.

**Its own scenario, deliberately not a branch of the contact-form one.** Make
deactivates a whole scenario after `maxErrors` consecutive failures — the trap
that took every έντυπο down once ([forms-submit.md](forms-submit.md)). Sharing
the contact form's scenario would mean a failing opt-out also kills the site's
contact form. Separate scenario = separate blast radius, separate DLQ, separate
logs, and the same operation cost. **Incomplete executions (DLQ) are ON**, same
reasoning as the έντυπα scenario: a bad bundle parks and is replayable instead
of burning the error budget.

## The payload

```jsonc
{
  "request_id": "148",     // digits only, "" when the link was tampered with or missing
  "contact_id": "9012",    // same
  "reason": "Βρήκα ακίνητο",   // one of four radio labels, or "" — optional
  "comment": "…",              // free text, ≤2000 chars, optional
  "page": "/request-closed?r=148&c=9012",
  "received_at": "…"           // our clock
}
```

**Make must handle a blank `request_id`.** The ids arrive from the email link's
query string, so they are visitor input; the Worker passes them through only if
they are digits. A blank one means «ψάξ' το από το email του παραλήπτη», never
«πάρε την πρώτη ζήτηση».

## Abuse surface (deliberately small)

The endpoint is public — the email recipient has no session and the CRM has no
login for clients. So:

- **Turnstile** is verified server-side before anything is forwarded (same
  widget/site key as the contact form) and a hidden honeypot field silently
  eats naive bots.
- **Nothing is read back.** The page never fetches the ζήτηση or the επαφή, and
  renders the request code only when it is digits. Guessing an id cannot reveal
  who the client is or what they were looking for.
- Worst case, someone files a misleading «σταμάτα τις προτάσεις» email at
  `info@` — a human reads it before anything changes in the CRM. That is why
  the CRM write-back is **not** wired directly to this endpoint.

Each confirmation also logs one structured `request_closed` line (Observability),
next to the `email_click` lines from `/go`.

## Local testing

```bash
node tools/preview-server.js 5199
```

Open `http://localhost:5199/request-closed?r=148&c=9012`. On localhost the POST
is **simulated** (`IS_LOCAL` in the handler) so the confirmation state can be
seen without sending mail; the Turnstile widget still renders. To exercise the
real route, `npx wrangler dev` with both secrets in `.dev.vars` — that sends a
real email.

Both languages are live: the Greek email links to `/request-closed`, the English
one to `/en/request-closed`. The page's own strings switch on `<html lang>` in
`js/fourwalls.js`, like the contact form.

## Not done yet

- **CRM write-back** — blocked on the EstatePrime API (above).
