# Καταχώριση ακινήτου — CRM-aligned schema

Η φόρμα [../forms/katachorisi.html](../forms/katachorisi.html) είναι από
2026-07-25 ένα **1:1 αντίγραφο της φόρμας «Νέο ακίνητο» του EstatePrime**:
κάθε πεδίο έχει το όνομα του αντίστοιχου CRM πεδίου και κάθε επιλογή
αποθηκεύει το CRM slug (`sale`, `individual`, `bp`, `has_fireplace`…). Στόχος:
όταν έρθει η αυτοματοποίηση, το ακίνητο να δημιουργείται στο CRM **χωρίς καμία
αντιστοίχιση** — το payload είναι ήδη στη γλώσσα του.

## Πού βρέθηκε το σχήμα (μην το ξανα-ανακαλύψεις)

Captured live 2026-07-25 από τον fourwalls λογαριασμό:

- **Η ίδια η φόρμα του CRM** (`/listings/form`, logged-in Edge CDP :9222):
  328 named πεδία — όλα τα select options με τα values τους, τα ~80 feature
  checkboxes, τα radios `frames` (wood/aluminum/synthetic/pvc) και
  `frames_glass` (single/double/triple). Το API **δεν** εκθέτει αυτές τις
  λίστες· μόνο η φόρμα τις έχει πλήρεις.
- **`GET /api/listings`** (125 ακίνητα): το πραγματικό σχήμα του Listing
  object και οι τιμές που όντως χρησιμοποιούνται.
- **`GET /api/locations`** (15.095 εγγραφές): τα area ids. Θεσσαλονίκη -
  Δήμος = **108** (12 υποπεριοχές), Περιφ/κοί δήμοι = **109** (27
  υποπεριοχές) — hardcoded στη φόρμα ως tap-able pills με τα **πραγματικά
  level-2 ids** (π.χ. Τούμπα 499121, Καλαμαριά 2907).
- **`GET /api/listings/subtypes`**: μόνο το Διαμέρισμα έχει ειδικούς τύπους —
  1=Στούντιο, 2=Γκαρσονιέρα.
- Custom fields listings: κανένα (άδειο).

Gotchas του CRM που κληρονομεί το σχήμα: `energy_class` slugs είναι λατινικά
γράμματα (**`ap`=Α+, `bp`=Β+, `c`=Γ, `f`=Ζ, `g`=Η**)· ο όροφος είναι αριθμός
(**-1=Υπόγειο, -0.5=Ημιυπόγειο, 0=Ισόγειο, 0.5=Ημιώροφος, 1.5=1ος
υπερυψωμένος**)· το `wood` είναι τρία διαφορετικά πράγματα σε τρία namespaces
(κουφώματα/δάπεδα/μέσο θέρμανσης).

## Το payload

Στο γνωστό envelope του submit ([forms-submit.md](forms-submit.md))
προστέθηκαν `schema: "crm-v1"` και το `crm` object:

```jsonc
{
  "form": "katachorisi",
  "schema": "crm-v1",
  "data": { /* αναγνώσιμα ελληνικά — για το email/άνθρωπο */ },
  "crm": {
    "availability": "sale", "category": "residential",
    "subcategory": "apartment", "subtype": 2,
    "price": 165000, "size": 55, "floor": 5, "energy_class": "bp",
    "heating_type": "individual", "heating_source": "natural_gas",
    "features": ["has_elevator", "is_furnished"],
    "view": ["sea"], "flooring": ["wood"], "positioning": ["is_corner"],
    "location": { "address_el": "…", "postal_code": "54646",
                  "area_level1": 108, "area_level2": 499121,
                  "display_address": "fake" },
    "contact": { "name": "…", "phone": "…", "email": "…" }
  }
}
```

- `crm.*` = έτοιμες τιμές για το CRM· αριθμοί ως numbers, slugs ως strings,
  features/view/flooring/positioning ως arrays (όπως τα επιστρέφει το API).
- `crm.contact` = ο ιδιοκτήτης, για `POST /api/contacts` (δες τα required
  extras στο [estateprime-api.md](estateprime-api.md)).
- `data.*` κρατά τις ελληνικές ετικέτες **και τα παλιά aliases που διαβάζει
  το Make scenario 6600035** (`transaction_type`, `subtype`, `address`, `tk`,
  `region`, `area`) — μην τα αφαιρέσεις χωρίς να αλλάξεις το scenario.
  Ειδικά το `data.send_to_client` μένει **boolean**: το φίλτρο του email προς
  τον ιδιοκτήτη συγκρίνει με το κείμενο `"true"`.

## UI (iPad + Apple Pencil)

Όλα επιλέγονται με tap — πληκτρολόγηση μόνο σε διεύθυνση/τιμή/εμβαδά/έτη:
segmented κουμπιά για τα enums, pill grids πολλαπλής επιλογής για
χαρακτηριστικά/θέα/δάπεδα, steppers −/+ για δωμάτια/μπάνια/όροφους, tap-able
υποπεριοχές Θεσσαλονίκης. Τα τμήματα εμφανίζονται **υπό συνθήκη** όπως στο
CRM: «Γη & δόμηση» μόνο για οικόπεδα (ή μονοκατοικίες/βίλες/μεζονέτες),
«Επαγγελματικός χώρος» μόνο για commercial, βραχυχρόνια/πλειστηριασμός μόνο
όταν επιλεγούν, «Παροχές ενοικίασης» μόνο σε ενοικίαση. Το draft
(localStorage κλειδί `fw_draft_kx2`) επιβιώνει reload· το παλιό `fw_draft`
καθαρίζεται στο boot.

Το schema ζει σε ένα σημείο μέσα στο `katachorisi.html` (`SECTIONS` + τις
λίστες επιλογών από πάνω του). Νέο πεδίο = μία γραμμή εκεί· τα widgets, το
PDF, το draft και το `crm` payload τα παίρνουν όλα από εκεί.

## Η αυτοματοποίηση που έρχεται (TODO)

Το δημόσιο API **δεν έχει `POST /listings`** (μόνο GET — ελεγμένο στο yaml
και live). Ο δρόμος είναι ο ίδιος με τις ζητήσεις
([estateprime-api.md](estateprime-api.md)): το internal
**`POST /listings/form`** (session cookie, urlencoded — τα ονόματα των πεδίων
της φόρμας του CRM είναι ακριβώς αυτά που στέλνει το `crm` object, με τα
features ως `name=1` checkboxes και `levels_data[…]` για πολυεπίπεδα).
Βήματα όταν στηθεί: βρες/φτιάξε την επαφή (`?search=` με το τηλέφωνο →
`POST /api/contacts` με `is_active:true`), μετά το ακίνητο, μετά σύνδεση
ιδιοκτήτη (`contact_ids[]`). Μέχρι τότε το email «ΓΙΑ ΚΑΤΑΧΩΡΙΣΗ» στο info@
κουβαλά το PDF και πλέον και το `crm` JSON στο payload του Make.
