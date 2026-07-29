# Εγχειρίδιο γραφείου · docs.four-walls.gr

Το εσωτερικό εγχειρίδιο της γραμματείας: **τι φτάνει, τι σημαίνει, τι
κάνουμε**. Γράφτηκε για την Αφεντούλα (νέα γραμματέας, 2026-07) και τον
Μάνο. **Μηδέν τεχνικές λεπτομέρειες**: καμία αναφορά σε Make, Worker,
webhook, API. Ό,τι δεν βλέπει ο άνθρωπος στην οθόνη του, δεν μπαίνει.

```
docs.four-walls.gr/…   ──►  worker/index.mjs  ──►  /manual/…   (assets)
      (Cloudflare Access, όταν ετοιμαστεί)          ίδιο μοτίβο με forms.*
```

| Κομμάτι | Πού |
|---|---|
| Σελίδες | [../manual/](../manual/) · `index.html` (περιεχόμενα) + ένα αρχείο ανά κεφάλαιο |
| Στυλ | [../manual/manual.css](../manual/manual.css) · αυτόνομο, **δεν** φορτώνει το theme του site |
| Rewrite | `worker/index.mjs` → `if (url.hostname.startsWith("docs."))` |
| Route | `wrangler.toml` → `docs.four-walls.gr` custom domain |

## Γιατί ξεχωριστό subdomain και όχι σελίδα του site

Ίδιος λόγος με τα έντυπα: **μπαίνει Cloudflare Access μπροστά σε ολόκληρο
το hostname**, όχι σε path. Οι σελίδες συνδέονται μεταξύ τους με απλά
σχετικά links (`emails.html`), οπότε το `/manual` prefix φεύγει στο
rewrite και το εγχειρίδιο ζει στη ρίζα του δικού του domain.

Μέχρι να μπει το Access είναι **δημόσια αναγνώσιμο** αλλά αθέατο: κάθε
σελίδα έχει `noindex`, το `robots.txt` απαντά Disallow-all σε κάθε host
εκτός των production, και το `/manual/` αποκλείεται και από το robots του
apex (`worker/lib/seo.mjs`). Μην βάλεις εκεί κωδικούς ή στοιχεία πελατών
πριν μπει το Access.

## Setup που μένει

- [ ] **DNS**: το `wrangler.toml` route φτιάχνει μόνο του την εγγραφή
      `docs.four-walls.gr` με το πρώτο deploy (Workers Builds).
- [ ] **Cloudflare Access**: νέα self-hosted εφαρμογή για
      `docs.four-walls.gr`, ίδια πολιτική με τα έντυπα (allow
      `@four-walls.gr` + το gmail του Πάνου). Δεν χρειάζεται αλλαγή
      κώδικα, ο Worker δεν ελέγχει JWT εδώ, το Access κόβει μπροστά.

## Κεφάλαια

| Αρχείο | Θέμα | Κατάσταση |
|---|---|---|
| `emails.html` | Τα email που φτάνουν στο info@ | ✅ λίστα ειδών· το «Τι κάνουμε» **κενό** |
| (κενό) | Το CRM βήμα-βήμα | placeholder στην αρχική |
| (κενό) | Τα Έντυπα στο tablet | placeholder στην αρχική |

### emails.html · πώς προέκυψε η λίστα

Διασταύρωση **τριών** πηγών, όχι μόνο του κώδικα:

1. τα σενάρια Make (ποιος στέλνει, σε ποιον, με τι θέμα),
2. τα ίδια τα εισερχόμενα του `info@` 21 ημερών μέσω του Spark CLI
   (memory `spark-cli-email`), εκεί φάνηκαν τα είδη που **δεν** παράγουμε
   εμείς (Spitogatos, τιμολόγια, ειδοποιήσεις ασφαλείας),
3. τα docs των ροών ([forms-submit.md](forms-submit.md),
   [request-closed.md](request-closed.md),
   [request-matchings.md](request-matchings.md),
   [photo-enhance.md](photo-enhance.md)).

Κάθε κάρτα έχει ένα κίτρινο πλαίσιο **«Τι κάνουμε»** που μένει σκόπιμα
κενό: η διαδικασία γράφεται με τον Μάνο, δεν την εφευρίσκουμε εμείς.

**Η ενότητα «Τι ΔΕΝ έρχεται στο info@» δεν είναι γέμισμα**, είναι το
συχνότερο σημείο σύγχυσης: η ανάθεση/υπόδειξη/απόδειξη φεύγουν κατευθείαν
στον πελάτη με bcc στους Μάνο/Πάνο, και οι ειδοποιήσεις «ΝΕΟ LEAD» /
«ΕΝΔΙΑΦΕΡΟΜΕΝΟΣ SPITOGATOS» πάνε **μόνο** στον Μάνο. Στο `info@` φτάνει
το *αρχικό* email του Spitogatos, όχι η δική μας ειδοποίηση.

> ⚠️ Το [forms-submit.md](forms-submit.md) γράφει ότι τα τρία έντυπα
> πέφτουν πίσω στο `info@` όταν λείπει το email του πελάτη. **Στο live
> blueprint (σενάριο 6600035) δεν υπάρχει τέτοιο fallback**. Το `to` είναι
> σκέτο `{{1.data.entoleas_email}}` / `{{1.data.katavallon_email}}`.
> Κενό email σημαίνει αποτυχία στο DLQ, όχι αντίγραφο στη γραμματεία.

## Τοπική προεπισκόπηση

Ο `tools/preview-server.js` σερβίρει τη ρίζα του repo, οπότε οι σελίδες
ζουν στο `localhost:5173/manual/` και τα **root-absolute links δείχνουν
λάθος** (`/emails` πάει στο site, όχι στο εγχειρίδιο). Είναι αναμενόμενο:
τα links γράφονται για το `docs.four-walls.gr`, όπου το `/manual` prefix
δεν υπάρχει. Για πιστό έλεγχο διαδρομών χρειάζεται `wrangler dev` με
hostname `docs.*`· για έλεγχο εμφάνισης αρκεί ο preview server.

## Συντήρηση

- Οι σελίδες είναι **αυτοτελείς**: δεν περνούν από `sync-partials.js`,
  δεν έχουν `FW:HEAD` μπλοκ, δεν μπαίνουν στο `pages-meta.mjs` και δεν
  υπάρχει αγγλικό δίδυμο (απόφαση Πάνου: **μόνο ελληνικά**).
- Τα εικονίδια/λογότυπα δεν είναι τοπικά αρχεία: το wordmark είναι
  κείμενο (το `fourwalls_logo.svg` έχει **μαύρο** wordmark και δεν
  διαβάζεται στο navy header) και το favicon δείχνει στο `four-walls.gr`.
- Όταν αλλάζει μια ροή που στέλνει email στο `info@`, **ενημέρωσε και το
  αντίστοιχο κεφάλαιο**, η γραμματεία δουλεύει από αυτό, όχι από τα docs.
