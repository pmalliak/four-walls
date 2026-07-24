# EstatePrime CRM — UI map (browser automation)

Notes for **driving the CRM's own web UI** (logged-in session at
`https://fourwalls.estateprime.gr`) when the API can't do the job. The API
reference is [estateprime-api.md](estateprime-api.md); this file is the
**ground-truth for the pages** so future browser runs don't have to re-discover
the forms. Captured 2026-07-24 while building the Spitogatos lead intake
(contact 72 → ζήτηση 18).

**When you need the UI (not the API):**

- **Activating a contact** — API-created contacts land «Ανενεργό» with no API
  fix. (You can avoid this entirely by sending `is_active: true` on
  `POST /contacts`; the UI toggle is only for repair.)
- **Creating a ζήτηση/request** — ~~UI-only~~ **NO LONGER needs the UI**
  (2026-07-24). The public `POST /api/requests` is broken, but the CRM's own
  internal **`POST /requests/form`** (urlencoded, session-cookie auth, no CSRF)
  creates it headlessly and returns `{"success":true,"id":"N"}`. Call it via a
  same-origin `fetch` from the logged-in browser tab. Full field map in
  [estateprime-api.md](estateprime-api.md). The manual form-fill steps below are
  kept only as a fallback / field reference.
- **Linking a communication to a request** — ~~UI-only~~ **solved headlessly**
  (2026-07-24). The public `POST /api/communication` `request_id` → `500`, but
  the internal **`POST /communication/form`** (session, urlencoded) accepts
  `request_id` and links both contact + request. See
  [estateprime-api.md](estateprime-api.md).

**The whole intake is now headless — the UI is no longer on the critical path.**
Contact → `POST /api/contacts`; ζήτηση → `POST /requests/form`; communication
(both links) → `POST /communication/form`. The manual form-fill steps below are
kept only as a field reference / fallback if an internal endpoint changes.

## Navigation quirks

- **`/contacts/view/{id}`** is the contact detail page. **`/contacts/{id}` and
  `/contacts/edit/{id}` both redirect to the list** — don't deep-link them;
  either use `view`, or click the row.
- Edit a contact's basic info from the detail page: **pencil icon on the
  «Βασικές πληροφορίες» card** → modal. The modal's **Κατάσταση** toggle
  defaults to **Ενεργό** (so a UI-created contact is active); flip + «Αποθήκευση».
- `/requests/view/{id}` is the ζήτηση detail; `/requests/form` is «Νέα ζήτηση».
- `/settings/email-templates/view/{type}/1` edits an email template: two
  CodeMirrors (`#code-editor` = the Twig, `#variables-editor` = the sample JSON
  used for the live preview) and a debounced preview POST to the same URL. A
  **blank preview is usually Cloudflare 403-ing that POST**, not a Twig error —
  see [../crm/README.md](../crm/README.md).
- The single-contact/-request API `GET`s are fine, but the **`GET
  /communication/{id}` and `GET /requests/{id}` single endpoints can `500`** —
  read back via the paginated list instead.

## «Νέα ζήτηση» form (`/requests/form`)

Three sections. Everything not listed can be skipped.

**Στοιχεία ζήτησης**
- **Πηγή** (single select): `Spitogatos.gr` | `xe.gr`.
- **Πελάτες ζήτησης**: search box — **search by phone** (e.g. `6948824999`)
  reliably finds the contact regardless of Greek/Latin name; click the result
  to add a chip. (A romanized name won't match once the contact is renamed to
  Greek — phone always does.)
- **Συνεργάτες ζήτησης** (multi-select): **defaults to the logged-in user**
  (Πάνος). For Spitogatos leads, remove Πάνος and add **Χριστινάκης Μάνος**.
- **Ετικέτες**: type the name, click the highlighted match. Add **claude**
  then **spitogatos**. (Tag pills render in click order, but the API stores ids
  ascending — order isn't persisted.)
- **Κατάσταση ζήτησης**: defaults **Ενεργή**.

**Περιοχές ζήτησης** (cascading location picker)
- **Περιοχή** (level 1): type `Θεσσαλονίκη - Δήμος`, click match → chip.
- **Υποπεριοχή** (level 2, multi-select): the dropdown lists the subareas;
  **clicking one adds a chip and removes it from the list, so the list reorders
  and the top row now points at a different item** — click the topmost row
  repeatedly (verify by screenshot), don't reuse a fixed coordinate blindly.
  The 12 Θεσσαλονίκη-Δήμος subareas are: 40 Εκκλησιές-Ευαγγελίστρια,
  Ανάληψη-Μπότσαρη-Νέα Παραλία, Άνω Πόλη, Βαρδάρης-Λαχανόκηποι,
  Βούλγαρη-Ντεπώ-Μαρτίου, Κέντρο Θεσσαλονίκης, Ξηροκρήνη-Παναγία Φανερωμένη,
  Σφαγεία-Ιχθυόσκαλα, Τούμπα, Τριανδρία-Δόξα, Φάληρο-Ιπποκράτειο, Χαριλάου.
- **Γειτονιά** (level 3): skip unless the lead names one.

**Βασικά κριτήρια ζήτησης** (two-column grid) → maps to request columns + `extra_fields`
- **Διαθέσιμο προς**: defaults Πώληση → set **Ενοικίαση** for a rental lead.
- **Κατηγορία**: defaults **Κατοικία**.
- **Υποκατηγορία**: **Studio/Γκαρσονιέρα → `Διαμέρισμα`** (apartment). No
  standalone studio subcategory.
- **Ειδικός τύπος** (multi-select) — **only appears after Υποκατηγορία is
  chosen**. For studio/γκαρσονιέρα add both **Γκαρσονιέρα** (value 2) and
  **Στούντιο** (value 1).
- **Τιμή** Από/Έως → indicative €500 rental → **Έως 500**.
- **Εμβαδόν ακινήτου** Από/Έως → indicative 35 τ.μ. → **Από 30** (a floor).
- **Επιπλωμένο**: Επιλογή/Ναι/Όχι → **Ναι** (message «επιπλωμένο»).
- **Όροφος** Από/Έως (dropdowns: Υπόγειο/Ημιυπόγειο/Ισόγειο/Ημιώροφος/1ος/…)
  → «1ος όροφος και πάνω» → **Από 1ος**.
- **Ασανσέρ** checkbox → check (message «ανελκυστήρας απαραίτητος»); checking it
  reveals «Ασανσέρ από όροφο» = Οποιοδήποτε.
- **Τύπος θέρμανσης**: Ατομική/Αυτόνομη/Κεντρική/Χωρίς → **Ατομική**.
- **Μέσο θέρμανσης** (multi-select): Πετρέλαιο/Φυσικό αέριο/Υγραέριο/Κλιματισμός/
  Αντλία θερμότητας/Ξύλο/Pellet/Fan coil → **Φυσικό αέριο**.

**Επιπλέον χαρακτηριστικά ζήτησης** (checkbox grid → `extra_fields.features`)
- **Μπαλκόνι / Βεράντα** → `has_balcony` (message «βεράντα»).
- **Για φοιτητές** → `suitable_for_students` (χρήση «Φοιτητικό»).

**Save**: «Αποθήκευση» (bottom-right) → redirects to `/requests/view/{id}`.

### What the message maps to

The teaser email carries only type/areas/price/size; the free-text **Μήνυμα**
and the **Χρήση** field on the Live dashboard are what populate the criteria.
For lead #507856, «Θέρμανση ατομική φυσικού αερίου, βεράντα, επιπλωμένο, 1ος
όροφος και πάνω» + «Φοιτητικό» became: heating Ατομική/Φυσικό αέριο,
Μπαλκόνι/Βεράντα, Επιπλωμένο Ναι, Όροφος Από 1ος, Για φοιτητές. The resulting
`extra_fields` object read back as
`{heating_type:["individual"], heating_source:["natural_gas"],
is_furnished:"yes", features:["has_balcony","suitable_for_students"]}`.

## General browser-automation tips for this CRM

- Multi-select widgets (tags, areas, ειδικός τύπος, μέσο θέρμανσης) re-render
  their dropdown after each pick — screenshot between clicks rather than firing
  a fixed coordinate repeatedly.
- Native `<select>`/text inputs take `form_input` by `ref`; the custom
  overlay dropdowns (tags, areas, Επιπλωμένο, θέρμανση) need a real click on the
  option, and `form_input` on their hidden combobox may silently no-op.
- A stray click into an empty area or a `<select>` can pop its list open —
  press **Escape** to dismiss without changing the value before moving on.
