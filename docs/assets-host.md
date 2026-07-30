# `assets.four-walls.gr` — δημόσια αρχεία από τον ίδιο Worker

Χρειαζόμαστε σταθερά URL για αρχεία που τα ζητάει κάτι **έξω** από το site: το
logo στην υπογραφή των email, εικόνες μέσα σε πρότυπα EstatePrime/Zoho/Make
(εκεί δεν περνούν `data:` URIs — θέλουν κανονικό URL), logo για συνεργάτες.

Αυτά ζούσαν σε **ξεχωριστό Worker/project** στο Cloudflare, εκτός git. Πλέον
είναι ένας απλός φάκελος του repo, [`assets/`](../assets/), που τον σερβίρει ο
ίδιος `four-walls` Worker — ίδια λογική με το `forms.` (φάκελος `forms/`) και το
`docs.` (φάκελος `manual/`).

## Πώς δουλεύει

```
assets/signature-logo.png   →   https://assets.four-walls.gr/signature-logo.png
                                https://four-walls.gr/assets/signature-logo.png
```

Ρίχνεις το αρχείο στο [`assets/`](../assets/), commit + push, και μέσα σε ένα
λεπτό είναι live. Δεν υπάρχει upload, dashboard ή ξεχωριστό deploy — **το git
είναι η μοναδική πηγή**, οπότε φαίνεται και τι άλλαξε και πότε.

Ο κώδικας είναι ένα μπλοκ στο [`worker/index.mjs`](../worker/index.mjs)
(αναζήτησε `hostname.startsWith("assets.")`):

- ο φάκελος `assets/` γίνεται η **ρίζα** του hostname, ώστε τα URL να μένουν
  σύντομα·
- `Cache-Control: public, max-age=3600, s-maxage=86400` — το assets layer από
  μόνο του γυρίζει `max-age=0, must-revalidate`, που είναι λάθος για αρχεία που
  τραβάνε email proxies και τρίτα συστήματα. Μία ώρα στον browser, μία μέρα στο
  edge: ένα ανέβασμα με το **ίδιο** όνομα φαίνεται παντού την ίδια μέρα·
- `Access-Control-Allow-Origin: *` — δημόσια assets, να τα φορτώνει και άλλο
  origin χωρίς CORS εμπόδιο·
- σκέτο `404` αντί για τη branded σελίδα του site·
- `robots.txt` σε αυτό το hostname είναι ήδη `Disallow: /` (το `robotsResponse`
  στο [`worker/lib/seo.mjs`](../worker/lib/seo.mjs) επιτρέπει crawling μόνο στα
  production hosts).

### Η γυμνή ρίζα δεν σερβίρει τίποτα

`https://assets.four-walls.gr/` (χωρίς path) γυρίζει **404**. Ο παλιός Worker
σέρβιρε εκεί το logo της υπογραφής· κρατήθηκε για λίγο ως alias και μετά
βγήκε, όταν η υπογραφή πέρασε στο κανονικό URL με το πλήρες όνομα αρχείου.

Κάθε αρχείο ζητιέται με το όνομά του. Ένα URL χωρίς κατάληξη αρχείου το
μπερδεύει ο browser (κυρίως στο κινητό): εικονίδιο «?» και κατέβασμα αντί για
προβολή — άλλος ένας λόγος να μη γράφουμε τέτοια links.

## Setup (μία φορά)

Το hostname μπορεί να είναι custom domain σε **έναν μόνο** Worker. Με τη σειρά:

1. **Ελευθέρωσε το hostname από τον παλιό Worker.** Cloudflare dashboard →
   Workers & Pages → ο παλιός (αυτός που σερβίρει σήμερα το
   `assets.four-walls.gr`) → Settings → Domains & Routes → remove το
   `assets.four-walls.gr`. Αν δεν κάνει τίποτα άλλο, σβήσε ολόκληρο τον Worker.
2. **Πρόσθεσε το route** στο [`wrangler.toml`](../wrangler.toml), στη λίστα
   `routes`:

   ```toml
   { pattern = "assets.four-walls.gr", custom_domain = true },
   ```

3. **push** → το Workers Builds φτιάχνει και το DNS record μόνο του.

> **Σειρά, όχι λεπτομέρεια:** αν μπει το route ενώ το hostname ανήκει ακόμη στον
> παλιό Worker, το build **αποτυγχάνει** (το προηγούμενο deploy μένει live, άρα
> δεν πέφτει το site, αλλά κάθε επόμενο push σκάει μέχρι να λυθεί).

Rollback: βγάζεις το route, ξαναδίνεις το custom domain στον παλιό Worker.

## Όρια & πότε ΔΕΝ το χρησιμοποιούμε

- **25 MiB / αρχείο**, 20.000 αρχεία σύνολο (Workers Static Assets). Για βίντεο,
  βαριά PDF ή ό,τι ανεβαίνει συχνά και αυτόματα → R2 (υπάρχει ήδη bucket
  `four-walls-photos`, βλ. [photo-enhance.md](photo-enhance.md)).
- Ό,τι μπει εδώ **μπαίνει στο git για πάντα** — μη ρίχνεις πρόχειρα binaries.
- Ό,τι μπει εδώ είναι **δημόσιο**. Τίποτα με στοιχεία πελατών· τα ιδιωτικά
  περνούν από Cloudflare Access (`forms.`, `docs.`).
