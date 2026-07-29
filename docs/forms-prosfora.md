# Προσφορά — the form with no έντυπο

A client says «δίνω 150.000 για το ΚΩΔ123». The consultant taps this in, the
office gets an email, and it is recorded in EstatePrime. That is the whole
feature.

```
forms/prosfora.html ──► /api/forms/submit ──► Make router (filter form=prosfora)
   pick listing               (worker/lib/forms.mjs)          │
   pick contact                                               ▼
   amount + notes                            «ΝΕΑ ΠΡΟΣΦΟΡΑ» email to info@
```

## Why it is not a document

The other four έντυπα produce a signed PDF because they are contracts. An
offer is not: it is information travelling from the viewing to the office, and
it dies the moment it is entered in the CRM. So this page has no signature
pad, no preview step, no html2pdf, and its payload carries no `pdf_base64`.
The Make branch is the only one with an empty `attachments` array.

That also makes it the cheapest page in the PWA: no fonts to embed, no canvas,
no 900 KB PDF library.

## What it reuses

Everything else is shared, deliberately:

- **`/api/forms/submit`** with `form: "prosfora"`, so it inherits the Access
  stamp (`submitted_by`), the `received_at` audit clock and the Make router.
  See [forms-submit.md](forms-submit.md).
- **`FWOutbox.submit()`**, so an offer taken inside a basement flat with no
  signal is queued in IndexedDB and sent on the way out, exactly like a signed
  contract.
- **`FWCrm.pickListing()` / `FWCrm.pickContact()`** from
  [../forms/_crm.fw.js](../forms/_crm.fw.js). Those two entry points were
  added for this page: the auto-attach in that file anchors on `data-k` fields
  that a form page has and this one does not, so the sheets are exposed as a
  callback API instead of being copy-pasted (which is what `enhance.html` did,
  and it is now the only page carrying a second copy). Same search, same «↻»
  refresh, same serve-stale-on-error behaviour. See
  [forms-crm.md](forms-crm.md).

## Fields

| Field | Source | Required |
|---|---|---|
| Ακίνητο | CRM picker (`/api/crm/listings`) | yes |
| Ενδιαφερόμενος | CRM picker (`/api/crm/contacts`) **or** hand-typed | yes |
| Ποσό προσφοράς | typed, formatted live as `150.000` | yes, > 0 |
| Παρατηρήσεις | free text | no |

**The hand-typed contact is not a workaround, it is the common case.** A
first-time caller who offers on a listing is usually not in EstatePrime yet.
Blocking on «διάλεξε επαφή» would send the consultant off to create a CRM
record mid-conversation, so the name and phone can be typed instead and the
email says **(ΔΕΝ ΕΙΝΑΙ ΣΤΟ CRM)** next to the name, which is the office's cue
to create the contact along with the offer. Picking from the CRM and typing by
hand are one slot: choosing either clears the other, so the payload can never
carry two answers.

`data.contact_source` is `"crm"` or `"manual"`, and `data.contact_id` is empty
for a manual entry. Nothing is written back to the CRM from here (EstatePrime
has no contact update endpoint, see [forms-crm.md](forms-crm.md)).

## The percentage next to the asking price

The page computes the offer's distance from `listing.price` and shows it live
(`-12,5%` in red, `+2%` in green), and ships it as `data.diff_pct` for the
email. It is the first thing anyone asks about an offer, so having it computed
beats two numbers printed next to each other.

**Hidden-price listings get nothing**, not a `0%`: `hiddenPrice` means there
is no asking price to compare against, and a fabricated 0 would read as «στην
τιμή».

## Money format

Greek: `.` for thousands, no decimals anywhere. Offers are whole euros, and a
decimal separator on a touch keyboard is a typo waiting to be signed off, so
the input strips everything but digits and reformats on every keystroke. The
payload carries both `amount` (`"150.000 €"`, what the email prints) and
`amount_num` (`"150000"`, for whatever reads it next).

## Make

Branch **«προσφορά»** of scenario **Έντυπα — υποβολή φόρμας** (`6600035`),
module id 16, filter `{{1.form}} = prosfora`. One email module:

- **to** `info@four-walls.gr`, **cc** `panos@` + `manos@`
- subject `ΝΕΑ ΠΡΟΣΦΟΡΑ · {{1.summary}}` (code · address · amount · name)
- no attachment

The client is never mailed from this branch. See the recipients table in
[forms-submit.md](forms-submit.md).

## Adding a field later

Add it to `payload.data` in `prosfora.html` **and** to the email HTML in the
Make branch. A field that only exists in the payload is invisible, and the
office will keep asking for it by phone.
