# «Ολοκλήρωσα την αναζήτηση» (request-closed)

The opt-out at the bottom of the CRM matchings email. A client who has already
found a property tells us to stop the προτάσεις for that ζήτηση — without
replying, calling, or being ignored.

```
crm/request-matchings.twig.html      request-closed.html    worker/lib/request-closed.mjs
  «Πείτε μας να σταματήσουμε»  ──► /request-closed?e= ──POST──► /api/request-closed
                                   (button + Turnstile)                │
                                              EstatePrime API ◄────────┤ ποια επαφή,
                                              (Basic auth, read-only)  │ ποιες ενεργές
                                                                       │ ζητήσεις της
                                                                       ▼
                                                        Make hook ──► email to info@
                                                        (subject + html έτοιμα)
```

The page takes **two shapes** and switches on the query string:

| Link | Shape | Who sends it |
|---|---|---|
| `?e=<email>` | «Διακοπή προτάσεων» — no ζήτηση shown, the client's email rides to `info@` inside the comment as `[Πελάτης: …]` | **all four CRM emails** since 05/08/2026 (matchings GR/EN + recommendations GR/EN) and the batch page |
| `?r=<id>&c=<id>` | «Ολοκλήρωσα την αναζήτηση» — echoes the ζήτηση code, ids ride as their own fields | the original matchings link; **no template sends it any more**, kept working for links already in inboxes |

Both paths still work, and `?e=` was there first for the recommendations email
(which has no `request` root at all). The matchings templates moved onto it so
all four emails close the same way.

**Ο Worker κάνει πλέον αυτή την αναζήτηση μόνος του** (06/08/2026). Επειδή όλα
τα templates στέλνουν `?e=`, το email στο `info@` έφτανε με «Ζήτηση —» και
«Επαφή —»: ειδοποίηση ότι κάποιος σταμάτησε κάτι. Πριν προωθήσει στο Make, ο
`worker/lib/request-closed.mjs` ρωτάει το EstatePrime ποια επαφή έχει αυτό το
email (`GET /contacts?search=`, ακριβές ταίριασμα μόνο) και ποιες **ενεργές**
ζητήσεις κρατάει (`GET /requests`, `status === 1`, φιλτραρισμένες στο
`contacts[]`), με τα area ids λυμένα σε ονόματα (`GET /locations/{id}`).
Το email βγαίνει με σύνδεσμο επαφής, τηλέφωνο `tel:` και μία γραμμή ανά ζήτηση
με τα κριτήριά της. Στην πράξη η επαφή έχει μία ενεργή ζήτηση, οπότε το κουμπί
πάει κατευθείαν σε αυτήν· με περισσότερες, το κουμπί ανοίγει την επαφή.
Κόστος ~0,6 δευτ. (η πρώτη σελίδα των ζητήσεων λέει πόσες είναι, οι υπόλοιπες
φεύγουν παράλληλα) και **best effort**: αν το CRM αργήσει πάνω από 6 δευτ. ή
σκάσει, το email φεύγει με ό,τι ξέρουμε και μια γραμμή «δεν απάντησε το CRM».

## Why a page and not a one-click link

Two reasons, and the second is the one that decides it:

1. **A bare link is not a confirmation.** Mail scanners (Outlook Safe Links,
   antivirus gateways) fetch every URL in a message — a GET that closes the
   ζήτηση would fire before the client ever reads the email.
2. **Το κλείσιμο της ζήτησης δεν γίνεται με το κλειδί που έχουμε.** Το public
   API δεν ενημερώνει ζητήσεις (`PUT` 403, `PATCH` ψεύτικο 200). Ο μόνος τρόπος
   είναι το εσωτερικό `POST /requests/view/{id}` με `change_status=2` και
   `change_deal_status=withdrawn&close_reason=1` («σταμάτησε την αναζήτηση»),
   που θέλει **session cookie συνδεδεμένου χρήστη** και όχι Basic auth
   ([estateprime-api.md](estateprime-api.md)), δηλαδή δεν το φτάνει ούτε ο
   Worker ούτε το Make. Άρα κλείνει άνθρωπος στο `info@`, και η δουλειά του
   email είναι να του δείξει ακριβώς ποια ζήτηση, ποια επαφή και τον λόγο.

Όταν βγει τρόπος γραψίματος με Basic auth, **αλλάζει μόνο το σενάριο του
Make**: μπαίνει module μετά το mail, με το `resolved_request_id` που στέλνει
ήδη ο Worker. Η σελίδα και η διαδρομή δεν αγγίζονται.

## The pieces

| Piece | Where |
|---|---|
| Link in the email | `crm/request-matchings*.twig.html` + `crm/listing-recommendations*.twig.html` — `?e={{ contact.email\|url_encode }}` (EN points at `/en/request-closed`) |
| Page | [../request-closed.html](../request-closed.html) (`/request-closed`) + [../en/request-closed.html](../en/request-closed.html) (`/en/request-closed`), both `sitemap: false` |
| Styles | `css/fourwalls.css` → «Ολοκλήρωση αναζήτησης» |
| Client JS | `js/fourwalls.js` → «Request closed» |
| Worker route | [../worker/lib/request-closed.mjs](../worker/lib/request-closed.mjs) → `handleRequestClosed()` (CRM lookup + το HTML του email) |
| Secrets | `TURNSTILE_SECRET_KEY` (shared with the contact form), `MAKE_REQUEST_CLOSED_WEBHOOK`, `ESTATEPRIME_*` για το lookup |

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
Zoho Mail **to `info@`, no cc** (from `info@four-walls.gr`, the same
connection). **Το κείμενο του email δεν ζει εδώ**: το module στέλνει
`{{ifempty(1.subject; "ΟΛΟΚΛΗΡΩΣΗ ΑΝΑΖΗΤΗΣΗΣ")}}` και
`{{ifempty(1.html; 1.comment)}}`, δηλαδή ό,τι έφτιαξε ο Worker, ίδιο μοτίβο με
το digest των ματσαρισμάτων (`6722234`). Έτσι κάθε αλλαγή στο email είναι μια
γραμμή κώδικα με `git diff`, όχι formula μέσα σε JSON. Τα `ifempty` είναι
δίχτυ για bundle που θα ερχόταν από παλιό Worker: φεύγει τουλάχιστον το σχόλιο
του πελάτη αντί για κενό email.

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
  "subject": "ΟΛΟΚΛΗΡΩΣΗ ΑΝΑΖΗΤΗΣΗΣ · Αναστάσης Μπόρας",
  "html": "<!DOCTYPE html>…",  // όλο το email, φτιαγμένο στον Worker
  "request_id": "148",     // digits only, "" when the link was tampered with or missing
  "contact_id": "9012",    // από τον σύνδεσμο, αλλιώς όποιο βρήκε το lookup
  "resolved_request_id": "148",  // ΜΟΝΟ όταν η επαφή έχει ακριβώς μία ενεργή ζήτηση
  "active_requests": 1,
  "contact_name": "Αναστάσης Μπόρας",
  "reason": "Βρήκα ακίνητο",   // one of four radio labels, or "" — optional
  "comment": "…",              // free text, ≤2000 chars, optional
  "page": "/request-closed?e=…",
  "received_at": "…"           // our clock
}
```

Το `resolved_request_id` είναι χωριστό από το `request_id` επίτηδες: το ένα
είπε ο πελάτης, το άλλο το βρήκαμε εμείς. Γεμίζει μόνο όταν δεν υπάρχει τίποτα
να διαλέξεις, ώστε ένα μελλοντικό module που κλείνει ζήτηση να μη μαντεύει.

**Make must handle a blank `request_id`.** The ids arrive from the email link's
query string, so they are visitor input; the Worker passes them through only if
they are digits. A blank one means «ψάξ' το από το email του παραλήπτη», never
«πάρε την πρώτη ζήτηση».

Since **all four templates send `?e=`**, a blank `request_id` is now the normal
case, not the exception. Το `?e=` το στέλνει η σελίδα και ως `client_ref` στο
POST, και ο Worker το ψαρεύει και από το `page` για browsers που κρατούν παλιό
`fourwalls.js` από cache. Μένει και ως `[Πελάτης: …]` πρόθεμα στο `comment`:
είναι κείμενο από σύνδεσμο, οπότε το CRM lookup δέχεται **μόνο ακριβές
ταίριασμα email** και ό,τι δεν ταιριάξει μένει ελεύθερο κείμενο που δεν κλειδώνει
τίποτα.

## Abuse surface (deliberately small)

The endpoint is public — the email recipient has no session and the CRM has no
login for clients. So:

- **Turnstile** is verified server-side before anything is forwarded (same
  widget/site key as the contact form) and a hidden honeypot field silently
  eats naive bots.
- **Τίποτα δεν γυρίζει στον browser.** Ο Worker διαβάζει μεν το CRM, αλλά ό,τι
  βρει μπαίνει **μόνο** μέσα στο email προς το `info@`: η απάντηση στη σελίδα
  μένει σκέτο `{success:true}` και η ίδια η σελίδα δεν ζητάει ποτέ τίποτα από
  το CRM (δείχνει τον κωδικό ζήτησης μόνο όταν είναι ψηφία). Μαντεύοντας ξένα
  email ή ids, λοιπόν, κανείς δεν μαθαίνει ποιος είναι ο πελάτης ή τι έψαχνε.
- Worst case, someone files a misleading «σταμάτα τις προτάσεις» email at
  `info@` — a human reads it before anything changes in the CRM. That is why
  the CRM write-back is **not** wired directly to this endpoint.

Each confirmation also logs one structured `request_closed` line (Observability),
next to the `email_click` lines from `/go`. Κουβαλάει και `active_requests` +
`lookup` (`ok`, `δεν βρέθηκε επαφή`, `δεν απάντησε το CRM`), ώστε να φαίνεται
από τα logs αν ένα φτωχό email ήταν πραγματικά άγνωστος πελάτης ή απλώς
σιωπηλή αποτυχία του CRM.

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

**Το email χωρίς αποστολή.** Το `lookupClient()` και το `buildEmail()` είναι
exported, οπότε ένα σκέτο script τα τρέχει με τα `.dev.vars` και γράφει το HTML
σε αρχείο: πραγματικά δεδομένα CRM, μηδέν email. Έτσι επαληθεύτηκε η ροή στις
06/08/2026 (επαφή 274, δύο ενεργές ζητήσεις, lookup 0,55 δευτ.).

## Not done yet

- **CRM write-back**: θέλει γράψιμο με session cookie (παραπάνω). Το
  `resolved_request_id` και το `contact_id` φεύγουν ήδη στο Make, οπότε λείπει
  μόνο ο τρόπος αυθεντικοποίησης.
