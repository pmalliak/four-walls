# Σενάρια που δεν υπάρχουν ακόμη στο Make

Blueprints **έτοιμα προς import**, γραμμένα στο χέρι επειδή το σενάριο δεν
έχει δημιουργηθεί ακόμη στον λογαριασμό. Ο φάκελος [../scenarios/](../scenarios/)
είναι snapshot του live — ό,τι είναι εδώ **δεν** έχει τρέξει ποτέ.

Το `tools/make-pull.mjs` δεν αγγίζει αυτόν τον φάκελο (καθαρίζει μόνο το
`scenarios/`), οπότε ένα blueprint μπορεί να περιμένει εδώ όσο χρειάζεται.

## Πώς μπαίνει ένα από αυτά στο Make

1. Make → **Create a new scenario** → μενού (⋯) → **Import Blueprint** → επίλεξε
   το `.json`.
2. Στο πρώτο module (Webhook) πάτα **Add** για να δημιουργηθεί το webhook — το
   `hook` είναι σκόπιμα `null` στο αρχείο. Αντίγραψε το URL.
3. Έλεγξε τη σύνδεση Zoho στο email module (το `__IMTCONN__` δείχνει στην
   υπάρχουσα, αλλά ένα import μπορεί να τη ζητήσει ξανά).
4. Βάλε το URL του webhook στο αντίστοιχο secret του Worker
   (`npx wrangler secret put …` — δες το doc του feature).
5. **Ενεργοποίησε** το σενάριο.
6. `node tools/make-pull.mjs` και commit — αλλιώς το επόμενο push γράφει από
   πάνω δουλειά που δεν έφτασε ποτέ στο git.
7. Σβήσε το αρχείο από εδώ: πλέον ζει στο `scenarios/`.

## Τι περιμένει

| Αρχείο | Σενάριο | Feature | Secret του Worker |
|---|---|---|---|
| [leads-grigori-katachorisi.blueprint.json](leads-grigori-katachorisi.blueprint.json) | Leads — γρήγορη καταχώριση | [docs/quick-leads.md](../../docs/quick-leads.md) | `MAKE_LEADS_WEBHOOK` |
