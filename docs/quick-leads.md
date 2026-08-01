# Γρήγορο lead από πινακίδα (forms/lead.html)

Ο σύμβουλος περπατάει, βλέπει ένα **ΠΩΛΕΙΤΑΙ** ή **ΕΝΟΙΚΙΑΖΕΤΑΙ**, το
φωτογραφίζει και συνεχίζει τη δουλειά του. Ένα vision μοντέλο διαβάζει την
πινακίδα, η τοποθεσία γίνεται διεύθυνση, και ένα email με **όλη τη βόλτα**
πάει στο `info@four-walls.gr`.

```
forms.four-walls.gr/lead.html   (πίσω από Cloudflare Access — μόνο προσωπικό)
  φωτό τώρα (κάμερα + στίγμα)  ή  παλιές φωτό (EXIF)  ή  διεύθυνση με το χέρι
        │  POST /api/leads/init             → batch id
        │  PUT  /api/leads/upload/<b>/<n>   → R2  leads/<b>/orig/
        │  POST /api/leads/finalize/<b>     → { photos:[{seq,lat,lng,source,address,…}] }
        ▼
Cloudflare Worker  (worker/lib/leads.mjs)
        │  ανά φωτογραφία: Gemini vision → JSON (τηλέφωνο, είδος, ιδιώτης/γραφείο, …)
        │  ανά σημείο:     Nominatim reverse geocode → «Φραγκίνη 9, Κέντρο»
        │  μία φορά:       χτίζει subject + html + text
        │  MAKE_LEADS_WEBHOOK  { batch_id, leads[], subject, html, text }
        ▼
Make «Leads — γρήγορη καταχώριση»  →  ένα email στο info@ (cc ο αποστολέας)
```

Ίδιο μοτίβο browser→Worker→Make-secret με το
[photo-enhance.md](photo-enhance.md) και το [forms-submit.md](forms-submit.md).
Μοιράζεται το R2 bucket (`PHOTO_BUCKET`, prefix `leads/`) και το κλειδί
υπογραφής (`PHOTO_SIGN_KEY`, άλλο namespace στο μήνυμα HMAC) με το photo
pipeline, ώστε το feature να μη χρειάζεται δικό του bucket.

## Οι δύο εγγυήσεις

Το email πρέπει να έχει **τηλέφωνο και τοποθεσία**. Οι δύο αντιμετωπίζονται
διαφορετικά, επίτηδες.

### Τοποθεσία: πάντα — και κλειδώνει πάνω στον δρόμο

**Το EXIF GPS λείπει πολύ συχνά.** Δεν είναι σπάνια περίπτωση, είναι ο
κανόνας:

| Περίπτωση | Τι γίνεται με το EXIF |
|---|---|
| Φωτογραφία τραβηγμένη μέσα από browser / canvas | **δεν υπάρχει καθόλου** |
| Android photo picker | το σύστημα κόβει την τοποθεσία πριν δώσει το αρχείο |
| Φωτό από WhatsApp / Viber / Messenger | σβησμένο κατά την αποστολή |
| Κλειστό location στην κάμερα, ή χωρίς fix (κέντρο, υπόγειο) | κενό |
| Screenshot αγγελίας | μηδέν metadata |
| **Το δικό μας `enhance.html`** | το `canvas.toBlob()` το πετάει ολόκληρο |

Γι' αυτό η φόρμα **δεν στηρίζεται σε αυτό**. Η σκάλα, με σειρά
προτεραιότητας:

1. **Στίγμα συσκευής** (`navigator.geolocation`) όταν η φωτογραφία τραβιέται
   από το κουμπί «Φωτογραφία τώρα». Το κινητό είναι μπροστά στο ακίνητο —
   ±10-30 m. Δεν χρειάζεται κανένα metadata.
2. **EXIF** για φωτογραφίες από τη συλλογή. Διαβάζεται
   [client-side](../forms/_exif.fw.js) **πάνω στο πρωτότυπο αρχείο, πριν από
   το resize** — αν σμικρύνεις πρώτα, το GPS έχει ήδη χαθεί.
3. **Χειρόγραφη διεύθυνση**, όταν λείπουν και τα δύο. Είναι πλήρως αποδεκτή
   τοποθεσία και **υπερισχύει** του reverse geocoding: ο άνθρωπος που
   στεκόταν εκεί ξέρει καλύτερα από το OSM.

Το κουμπί «Αποστολή» **δεν ενεργοποιείται** όσο υπάρχει φωτογραφία χωρίς
τοποθεσία, και ο Worker κάνει τον ίδιο έλεγχο (`no_location`, HTTP 400). Αυτό
είναι το κρίσιμο σχεδιαστικό σημείο: το πρόβλημα λύνεται **εκεί που μπορεί
να λυθεί** — στον δρόμο, από τον σύμβουλο — και όχι το βράδυ στο γραφείο,
όπου κανείς δεν θυμάται ποιο κτίριο ήταν.

Το `_exif.fw.js` είναι δικός μας parser (~5 KB) και όχι έτοιμη βιβλιοθήκη:
θέλουμε τρία tags, και ο service worker κατεβάζει ό,τι μπει εκεί μέσα σε
κάθε συσκευή. Καλύπτει JPEG, HEIC/HEIF, PNG και WebP εντοπίζοντας το TIFF
header μέσα στα bytes. Απορρίπτει το `0,0` («Null Island»), που το γράφουν
κάμερες με GPS field αλλά χωρίς fix.

### Τηλέφωνο: όχι πάντα — και δεν το κρύβουμε

Θολή, μακρινή ή σκοτεινή πινακίδα δεν διαβάζεται. Το email φεύγει **έτσι κι
αλλιώς**, με τη φωτογραφία και σήμανση «**ΧΩΡΙΣ ΤΗΛΕΦΩΝΟ** — δες τη
φωτογραφία». Σιωπηλή απόρριψη σημαίνει χαμένο lead που κανείς δεν ξέρει ότι
χάθηκε.

Τα τηλέφωνα κανονικοποιούνται σε 10 ψηφία (κινητό `69XXXXXXXX`, σταθερό
`2XXXXXXXXX`), με `+30`/`0030` και σημεία στίξης να φεύγουν. Ό,τι δεν περνάει
αυτόν τον έλεγχο **πέφτει**: κενό πεδίο δεν κοστίζει τίποτα, λάθος νούμερο
κοστίζει ένα τηλέφωνο σε άγνωστο.

## Τι διαβάζει το AI

Το prompt και το schema ζουν στο [worker/lib/leads.mjs](../worker/lib/leads.mjs)
(`EXTRACT_PROMPT`, `EXTRACT_SCHEMA`) — **σε κώδικα μέσα στο git**, όχι σε IML
μέσα στο Make· ίδιο σκεπτικό με το `composePrompt()` του photos.mjs και το
valuation.mjs. Το μοντέλο απαντάει με `responseSchema`, οπότε το JSON είναι
εγγυημένο και δεν ψάχνουμε αγκύλες μέσα σε πεζό κείμενο.

| Πεδίο | Τι είναι |
|---|---|
| `phones[]` | κάθε τηλέφωνο όπως είναι τυπωμένο |
| `listing_type` | `sale` / `rent` / `unknown` |
| `advertiser` | `private` / `agency` / `unknown` **(+ `agency_name`)** |
| `property_type`, `size_sqm`, `floor`, `price` | ό,τι γράφει η πινακίδα |
| `street_hint` | οδός ή αριθμός ορατός **οπουδήποτε** στη φωτογραφία |
| `sign_text` | όλο το κείμενο, για να ελέγξει ο άνθρωπος την ανάγνωση |
| `is_sign` | αν η φωτογραφία δείχνει όντως πινακίδα |
| `confidence` | `high` / `medium` / `low` |

Δύο από αυτά αξίζουν όσο όλα τα υπόλοιπα μαζί:

- **`advertiser`** — οι μισές πινακίδες στη Θεσσαλονίκη είναι συναδέλφων.
  Χωρίς αυτό το γραφείο παίρνει τηλέφωνο τον ανταγωνισμό. Το email το δείχνει
  με πορτοκαλί «Μεσιτικό γραφείο».
- **`is_sign`** — φρένο για τη λάθος λήψη. Χωρίς αυτό το μοντέλο «βρίσκει»
  τηλέφωνα σε μια σκέτη πρόσοψη.

Το `street_hint` είναι το τελευταίο δίχτυ της διεύθυνσης: όταν δεν υπάρχει
ούτε geocoding, μπαίνει αυτό.

## Ένα email ανά βόλτα

Όχι ανά φωτογραφία — μια βραδινή βόλτα αλλιώς γεμίζει το info@ με δεκαπέντε
μηνύματα. Το HTML το χτίζει ο Worker (όπως το `lead-reply.mjs`), οπότε το
σενάριο του Make είναι **δύο modules**: webhook → email.

Οι φωτογραφίες μπαίνουν **μέσα** στο email ως `<img>` με υπογεγραμμένο URL
(`/api/leads/file/…`, apex, χωρίς Access, HMAC + λήξη). Γι' αυτό η λήξη είναι
**30 ημέρες** και όχι 6 ώρες όπως στο photo pipeline: εκεί το Make τραβάει το
αρχείο μία φορά, εδώ το ανοίγει άνθρωπος όποτε διαβάσει το email.

Το ίδιο τηλέφωνο σε δύο φωτογραφίες σημαίνεται ως «ίδιο με προηγούμενο»
αντί να αφαιρεθεί — η δεύτερη λήψη μπορεί να δείχνει κάτι που η πρώτη έκοψε.

## Reverse geocoding

Nominatim (OSM), `zoom=18`, `accept-language=el`, με τον `User-Agent` που
απαιτεί η πολιτική χρήσης — ίδια σύμβαση με το
[accessibility.mjs](../worker/lib/accessibility.mjs). Τα σημεία
ομαδοποιούνται σε πλέγμα ~11 m (δύο λήψεις της ίδιας πινακίδας = ένα ερώτημα)
και οι κλήσεις σειριοποιούνται με 1,1 δευτ. ανάμεσά τους (όριο 1/δευτ.), με
ταβάνι 20 ανά βόλτα. **Αποτυχία δεν είναι πρόβλημα**: μένουν οι
συντεταγμένες και ο σύνδεσμος χάρτη.

## Κομμάτια

| Κομμάτι | Αρχείο | Ρόλος |
|---|---|---|
| Φόρμα | [forms/lead.html](../forms/lead.html) | κάμερα/συλλογή, σκάλα τοποθεσίας, κλείδωμα αποστολής, 3-step upload |
| EXIF | [forms/_exif.fw.js](../forms/_exif.fw.js) | GPS + ημερομηνία + συσκευή από JPEG/HEIC/PNG/WebP |
| Ingest + AI | [worker/lib/leads.mjs](../worker/lib/leads.mjs) | init/upload/finalize, Gemini, geocoding, HTML email, HMAC URLs |
| Routes | [worker/index.mjs](../worker/index.mjs) | staff API πίσω από Access στο `forms.*`· `/api/leads/file/` δημόσιο στο apex με υπογραφή |
| Config | [wrangler.toml](../wrangler.toml) | `PHOTO_BUCKET` + `MAKE_LEADS_WEBHOOK` / `PHOTO_SIGN_KEY` / `GEMINI_API_KEY` |
| Αποστολή | Make «Leads — γρήγορη καταχώριση» | webhook → email |

## Setup

**Cloudflare** (deploy = push στο `main`· τα secrets δεν θέλουν deploy):

- [ ] `npx wrangler secret put MAKE_LEADS_WEBHOOK` — το URL του νέου hook
- [x] `PHOTO_SIGN_KEY`, `GEMINI_API_KEY`, `PHOTO_BUCKET` — υπάρχουν ήδη
- [ ] **R2 lifecycle rule** για το prefix `leads/`: **30 ημέρες** (όχι 7 όπως
      το `photos/` — οι φωτογραφίες ζουν μέσα στο email):
      `npx wrangler r2 bucket lifecycle add four-walls-photos --name expire-leads --prefix leads/ --expire-days 30`

**Make** (ομάδα Four Walls): το σενάριο «Leads — γρήγορη καταχώριση» είναι
**έτοιμο για import** στο
[make/pending/leads-grigori-katachorisi.blueprint.json](../make/pending/leads-grigori-katachorisi.blueprint.json)
— webhook + ένα Zoho email module (To `info@four-walls.gr`, Cc
`{{1.submitted_by}}`, Subject `{{1.subject}}`, HTML `{{1.html}}`). Οδηγίες
βήμα-βήμα: [make/pending/README.md](../make/pending/README.md).

- [ ] Import + δημιουργία του webhook (το `hook` είναι `null` στο αρχείο)
- [ ] Το URL του webhook → `MAKE_LEADS_WEBHOOK`
- [ ] Ενεργοποίηση του σεναρίου
- [ ] `node tools/make-pull.mjs` + commit, και σβήσιμο του αρχείου από το
      `make/pending/`

## Κόστος και όρια

- **AI**: ~0,005 € ανά φωτογραφία (`gemini-3.5-flash`, vision). Μια βόλτα
  με 10 πινακίδες κοστίζει κάτω από 5 λεπτά του ευρώ. Το μοντέλο αλλάζει με
  τη μεταβλητή `LEADS_GEMINI_MODEL`.
- **Όρια φόρμας**: 20 φωτογραφίες ανά αποστολή, 25 MB η καθεμία· ο browser
  σμικρύνει στα 3072 px (αρκετά για να διαβαστεί τηλέφωνο από απέναντι
  πεζοδρόμιο, αρκετά λίγα για 4G).
- **Χρόνος**: το `finalize` τρέχει τα vision calls τέσσερα-τέσσερα — μια
  βόλτα 12 φωτογραφιών τελειώνει σε ~15 δευτερόλεπτα, με τη μπάρα προόδου
  ανοιχτή.

## Τι ΔΕΝ κάνει (και γιατί)

- **Δεν γράφει στο CRM.** Τα στοιχεία τα διάβασε AI από φωτογραφία· μια
  λάθος ανάγνωση θα γινόταν μόνιμη εγγραφή. Το email είναι το σημείο όπου
  ένας άνθρωπος αποφασίζει. (Ο έλεγχος «υπάρχει ήδη αυτό το τηλέφωνο στο
  EstatePrime;» είναι το προφανές επόμενο βήμα — το `leads[]` στο payload
  είναι ήδη δομημένο γι' αυτό.)
- **Δεν περνάει από το `_outbox.fw.js`.** Το outbox επαναλαμβάνει ένα POST·
  εδώ το finalize τρέχει AI και geocoding. Χωρίς σύνδεση η φόρμα το λέει
  καθαρά και κρατάει τις φωτογραφίες με τις τοποθεσίες τους για να ξαναπατηθεί.
