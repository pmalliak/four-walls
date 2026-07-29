# Τα σενάρια του Make (snapshot)

Παράγεται από `node tools/make-pull.mjs` — **μην το γράφεις στο χέρι**.
Τα blueprints είναι στο [scenarios/](scenarios/). Οδηγίες: [../docs/make-scenarios.md](../docs/make-scenarios.md).

| ID | Σενάριο | Ενεργό | Χρονισμός | Modules | Αρχείο |
|---|---|---|---|---|---|
| `6405443` | Spitogatos - Αίτηση ανάθεσης | ναι | άμεσα (webhook/mailhook) | 22 | [6405443-spitogatos-aitisi-anathesis.blueprint.json](scenarios/6405443-spitogatos-aitisi-anathesis.blueprint.json) |
| `6530594` | Site - Φόρμα επικοινωνίας | ναι | άμεσα (webhook/mailhook) | 4 | [6530594-site-forma-epikoinonias.blueprint.json](scenarios/6530594-site-forma-epikoinonias.blueprint.json) |
| `6600035` | Έντυπα — υποβολή φόρμας | ναι | άμεσα (webhook/mailhook) | 8 | [6600035-entypa-ypovoli-formas.blueprint.json](scenarios/6600035-entypa-ypovoli-formas.blueprint.json) |
| `6604242` | Spitogatos - Ενδιαφέρον για ακίνητο | ναι | άμεσα (webhook/mailhook) | 21 | [6604242-spitogatos-endiaferon-gia-akinito.blueprint.json](scenarios/6604242-spitogatos-endiaferon-gia-akinito.blueprint.json) |
| `6683649` | Site - Ολοκλήρωση αναζήτησης | ναι | άμεσα (webhook/mailhook) | 2 | [6683649-site-oloklirosi-anazitisis.blueprint.json](scenarios/6683649-site-oloklirosi-anazitisis.blueprint.json) |
| `6688477` | Photos — AI enhance | ναι | άμεσα (webhook/mailhook) | 21 | [6688477-photos-ai-enhance.blueprint.json](scenarios/6688477-photos-ai-enhance.blueprint.json) |
| `6722234` | CRM - Νέα ακίνητα σε ζητήσεις | ναι | άμεσα (webhook/mailhook) | 2 | [6722234-crm-nea-akinita-se-zitiseis.blueprint.json](scenarios/6722234-crm-nea-akinita-se-zitiseis.blueprint.json) |

## Spitogatos - Αίτηση ανάθεσης `6405443`

- Ενεργό: ναι · χρονισμός: άμεσα (webhook/mailhook)
- Hook: `3326123` (Four Walls Leads - info@)
- DLQ: όχι · maxErrors: 3 · sequential: όχι

```
2   gateway:CustomMailHook · Mailhook
3   util:SetVariables · Set Variables
50  builtin:BasicRouter
  ├─ route 1
    45  http:ActionSendDataBasicAuth · EstatePrime: Αναζήτηση επαφής · [onerror: builtin:Ignore]
    60  builtin:BasicIfElse
      ├─ condition «Νέα επαφή»
        40  http:ActionSendDataBasicAuth · EstatePrime: Δημιουργία επαφής · [onerror: builtin:Ignore]
        55  http:ActionSendDataBasicAuth · EstatePrime: Επικοινωνία (νέα επαφή) · [onerror: builtin:Ignore]
        57  http:ActionSendDataBasicAuth · EstatePrime: Απάντηση (νέα επαφή) · [onerror: builtin:Ignore]
      ├─ condition «Υπάρχουσα επαφή»
        56  http:ActionSendDataBasicAuth · EstatePrime: Επικοινωνία (υπάρχουσα) · [onerror: builtin:Ignore]
        58  http:ActionSendDataBasicAuth · EstatePrime: Απάντηση (υπάρχουσα) · [onerror: builtin:Ignore]
      ├─ else
        65  placeholder:Placeholder
  ├─ route 2
    30  zoho-mail:sendMail · Notification · [onerror: builtin:Resume]
    35  builtin:BasicIfElse
      ├─ condition «Πώληση»
        4   zoho-mail:sendMail · Send to Client (Sale)
      ├─ condition «Ενοικίαση»
        7   zoho-mail:sendMail · Send to Client (Rent)
      ├─ else
        25  zoho-mail:sendMail · Send to Client (Fallback)
```

## Site - Φόρμα επικοινωνίας `6530594`

- Ενεργό: ναι · χρονισμός: άμεσα (webhook/mailhook)
- Hook: `3379174` (Four Walls contact form)
- DLQ: όχι · maxErrors: 3 · sequential: όχι

```
1   gateway:CustomWebHook · Φόρμα επικοινωνίας / ζήτησης
10  builtin:BasicRouter
  ├─ route 1
    3   zoho-mail:sendMail · Email ζήτησης στη γραμματεία · [φίλτρο: Μόνο ζητήσεις]
  ├─ route 2
    2   zoho-mail:sendMail · Email στον Πάνο · [φίλτρο: Κανονική επικοινωνία]
```

## Έντυπα — υποβολή φόρμας `6600035`

- Ενεργό: ναι · χρονισμός: άμεσα (webhook/mailhook)
- Hook: `3407683` (Έντυπα PWA — υποβολή φόρμας)
- DLQ: ναι · maxErrors: 3 · sequential: όχι

```
1   gateway:CustomWebHook · Έντυπα PWA
2   builtin:BasicRouter · Ποιο έντυπο;
  ├─ route 1
    3   email:ActionSendEmail · Email · ανάθεση · [φίλτρο: ανάθεση]
  ├─ route 2
    4   email:ActionSendEmail · Email · υπόδειξη · [φίλτρο: υπόδειξη]
  ├─ route 3
    6   email:ActionSendEmail · Email · απόδειξη · [φίλτρο: απόδειξη]
  ├─ route 4
    5   email:ActionSendEmail · Υπενθύμιση · γραφείο · [φίλτρο: καταχώριση]
    15  email:ActionSendEmail · Αντίγραφο · ιδιοκτήτης · [φίλτρο: και στον ιδιοκτήτη;]
  ├─ route 5
    16  email:ActionSendEmail · Προσφορά · γραφείο · [φίλτρο: προσφορά]
```

## Spitogatos - Ενδιαφέρον για ακίνητο `6604242`

- Ενεργό: ναι · χρονισμός: άμεσα (webhook/mailhook)
- Hook: `3409412` (Spitogatos - Ενδιαφερόμενοι πελάτες)
- DLQ: όχι · maxErrors: 3 · sequential: όχι

```
1   gateway:CustomMailHook · Mailhook
4   util:SetVariables · Body text (text ή HTML) · [φίλτρο: Μόνο Spitogatos ενδιαφέρον]
5   util:SetVariables · Όνομα/τηλέφωνο από το κείμενο
2   util:SetVariables · Parse email
3   util:SetVariables · Derive / guard
10  builtin:BasicRouter
  ├─ route 1
    20  http:ActionSendDataBasicAuth · EstatePrime: Αναζήτηση επαφής · [onerror: builtin:Ignore]
    25  builtin:BasicIfElse
      ├─ condition «Νέα επαφή»
        21  http:ActionSendDataBasicAuth · EstatePrime: Δημιουργία επαφής · [onerror: builtin:Ignore]
        22  http:ActionSendDataBasicAuth · EstatePrime: Επικοινωνία (νέα επαφή) · [onerror: builtin:Ignore]
      ├─ condition «Υπάρχουσα επαφή»
        23  http:ActionSendDataBasicAuth · EstatePrime: Επικοινωνία (υπάρχουσα επαφή) · [onerror: builtin:Ignore]
      ├─ else
        29  placeholder:Placeholder
  ├─ route 2
    30  zoho-mail:sendMail · Notification · [onerror: builtin:Ignore]
  ├─ route 3
    60  http:ActionSendData · Site: φτιάξε το email απάντησης · [φίλτρο: Μόνο με email πελάτη + κωδικό αγγελίας] · [onerror: builtin:Ignore]
    61  zoho-mail:sendMail · Απάντηση στον πελάτη (προς έγκριση: πάει στο info@) · [φίλτρο: Μόνο αν γύρισε HTML] · [onerror: builtin:Ignore]
```

## Site - Ολοκλήρωση αναζήτησης `6683649`

- Ενεργό: ναι · χρονισμός: άμεσα (webhook/mailhook)
- Hook: `3441770` (Site — ολοκλήρωση αναζήτησης)
- DLQ: ναι · maxErrors: 3 · sequential: όχι

```
1   gateway:CustomWebHook · Ολοκλήρωση αναζήτησης
2   zoho-mail:sendMail · Email στο info@
```

## Photos — AI enhance `6688477`

- Ενεργό: ναι · χρονισμός: άμεσα (webhook/mailhook)
- Hook: `3443497` (Photos — AI enhance)
- DLQ: ναι · maxErrors: 3 · sequential: όχι

```
1   gateway:CustomWebHook · Photo batch (enhance.html)
10  google-drive:recognizeAFileFolderPath · Φάκελος ακινήτου (find-or-create) · [onerror: google-drive:createAFolder, builtin:Resume]
2   google-drive:createAFolder · Φάκελος upload
13  google-drive:createAFolder · Υποφάκελος enhanced
14  google-drive:createAFolder · Υποφάκελος originals
3   builtin:BasicFeeder · Κάθε φωτογραφία
4   http:DownloadFile · Λήψη από R2
20  builtin:BasicRouter · AI; Λογότυπο; Αρχειοθέτηση;
  ├─ route 1
    18  gemini-ai:makeApiCall · 1. Καταγραφή χώρου (Pro vision) · [φίλτρο: με AI]
    5   gemini-ai:generateAnImageV2 · 2. Gemini · επεξεργασία @ 2K (κλειδωμένες αναλογίες)
    15  http:MakeRequest · Υδατογράφημα / σήμανση
    6   google-drive:uploadAFile · → enhanced/
    7   google-drive:uploadAFile · → originals/
  ├─ route 2
    21  http:MakeRequest · Υδατογράφημα στο πρωτότυπο · [φίλτρο: μόνο λογότυπο]
    22  google-drive:uploadAFile · → enhanced/
    23  google-drive:uploadAFile · → originals/
  ├─ route 3
    24  google-drive:uploadAFile · → originals/ (μόνο) · [φίλτρο: σκέτη αρχειοθέτηση]
8   builtin:BasicAggregator · Όλες μαζί
9   email:ActionSendEmail · Email · info@ (cc Πάνος, Μάνος)
```

## CRM - Νέα ακίνητα σε ζητήσεις `6722234`

- Ενεργό: ναι · χρονισμός: άμεσα (webhook/mailhook)
- Hook: `3457244` (CRM — νέα ακίνητα σε ζητήσεις)
- DLQ: ναι · maxErrors: 3 · sequential: όχι

```
1   gateway:CustomWebHook · Νέα ακίνητα σε ζητήσεις
2   zoho-mail:sendMail · Email στο info@
```
