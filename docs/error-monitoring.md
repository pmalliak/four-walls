# Error monitoring (Bugsnag)

Και τα δύο front-ends στέλνουν JavaScript errors στο Bugsnag (λογαριασμός
του Πάνου, ο ίδιος που εξυπηρετεί και τα άλλα projects). Δύο projects:

| Project | Τι καλύπτει | API key (δημόσιο, μπαίνει στο HTML) |
|---------|-------------|--------------------------------------|
| **four walls site** | το marketing site (και το `/en/`) | `c3df8735e51f09e3ff7975d08c7a8c71` |
| **four walls forms** | το Έντυπα PWA | `ace8302eac48c976cd2272512e9e04f3` |

Τα notifier API keys **δεν είναι μυστικά**· το personal auth token του
λογαριασμού (για API/MCP πρόσβαση στα δεδομένα) **είναι** και μένει εκτός repo.

## Πώς είναι στημένο

- **Self-hosted notifier:** το `bugsnag.min.js` (browser notifier v8, από
  `https://d2wy8f7a9ursnm.cloudfront.net/v8/bugsnag.min.js`) ζει σε **δύο
  αντίγραφα**: [js/bugsnag.min.js](../js/bugsnag.min.js) για το site και
  [forms/bugsnag.min.js](../forms/bugsnag.min.js) για το PWA (δικό του
  αντίγραφο ώστε να το κασάρει ο service worker και το
  `forms.four-walls.gr` mount να μη χρειάζεται `/js/*`). Για αναβάθμιση:
  ξανακατέβασμα στο ίδιο URL, αντιγραφή και στα δύο, bump στο `VERSION`
  του [forms/sw.js](../forms/sw.js).
- **Site:** τα δύο `<script>` (notifier + [js/bugsnag.fw.js](../js/bugsnag.fw.js))
  μπαίνουν σε κάθε σελίδα μέσα από τα **header partials**
  ([partials/header.html](../partials/header.html) και το `.en` αδερφάκι του),
  οπότε νέα σελίδα που μπαίνει στο sync τα παίρνει αυτόματα.
- **PWA:** κάθε σελίδα φορτώνει στο `<head>` της το notifier και το
  [forms/_errors.fw.js](../forms/_errors.fw.js) (πριν από κάθε άλλο script,
  ώστε να πιάνονται και τα σφάλματα της εκκίνησης). Και τα δύο είναι στο
  `SHELL` του service worker (v26+).

## Συμπεριφορά

- **Μόνο production αναφέρει** (`enabledReleaseStages: ['production']`,
  με βάση το hostname `*.four-walls.gr`). Localhost / preview δεν στέλνουν
  ποτέ, οπότε τα δοκιμαστικά μας δεν λερώνουν το dashboard.
- `collectUserIp: false` και στα δύο (GDPR φιλικό, δεν χρειαζόμαστε IP).
- Metadata: το site στέλνει `page.path` και `page.lang`, το PWA στέλνει
  `app.form` (ποιο έντυπο).
- **Offline queue (μόνο PWA):** το Bugsnag δεν έχει δικό του offline
  buffer, οπότε το `_errors.fw.js` κρατά σε `localStorage`
  (`fw-err-queue`, έως 20 εγγραφές, 7 μέρες) όσα σφάλματα συμβούν χωρίς
  σύνδεση και τα ξαναστέλνει με `Bugsnag.notify` στο επόμενο `online` ή
  άνοιγμα σελίδας. Προσοχή: το event τότε έχει ώρα το replay· η
  πραγματική ώρα του σφάλματος είναι στο metadata `offline.thrownAt`.

## Δοκιμή ότι τα κλειδιά δουλεύουν

Ένα test event χωρίς browser (ίδιο για το άλλο key):

```powershell
Invoke-WebRequest -Uri 'https://notify.bugsnag.com/' -Method Post -ContentType 'application/json' `
  -Headers @{ 'Bugsnag-Api-Key' = '<key>'; 'Bugsnag-Payload-Version' = '5' } `
  -Body '{"notifier":{"name":"test","version":"1","url":"x"},"events":[{"exceptions":[{"errorClass":"FWSetupTest","message":"test","stacktrace":[{"file":"setup","lineNumber":1,"method":"verify"}]}],"app":{"releaseStage":"setup-test"}}]}'
```

Απάντηση `200 OK` σημαίνει ότι το event γράφτηκε στο project.

## MCP (ανάγνωση σφαλμάτων από AI)

Ο επίσημος SmartBear MCP server (`@smartbear/mcp`) δίνει εργαλεία
`bugsnag_*` (λίστα projects, errors, events, releases). Είναι
καταχωρημένος σε δύο σημεία, με διαφορετικό μηχανισμό το καθένα:

| Πελάτης | Πού | Πώς παίρνει το token |
|---------|-----|----------------------|
| **VS Code** (Copilot) | `%APPDATA%\Code\User\mcp.json`, entry `smartbear` | ρωτάει τον χρήστη (`${input:bugsnag_auth_token}`) |
| **Claude Code** | [.mcp.json](../.mcp.json) στη ρίζα του repo | από το `.dev.vars`, μέσω [tools/mcp-smartbear.mjs](../tools/mcp-smartbear.mjs) |

Το `.mcp.json` δείχνει σε έναν μικρό launcher, [tools/mcp-smartbear.mjs](../tools/mcp-smartbear.mjs),
που διαβάζει το **`BUGSNAG_AUTH_TOKEN`** από το `.dev.vars` (gitignored,
δίπλα στα `BW_SESSION` / `MAKE_API_TOKEN`) και μετά παραδίδει το stdio
στο `npx @smartbear/mcp`. Έτσι το token δεν μπαίνει ποτέ ούτε στο repo
ούτε σε αρχείο ρυθμίσεων.

Το token είναι **personal auth token** του Bugsnag: dashboard → My
account → Personal auth tokens → Generate. Χωρίς αυτό ο server ξεκινά
κανονικά αλλά τα εργαλεία Bugsnag είναι ανενεργά (ο launcher το γράφει
ως προειδοποίηση στο stderr). Μετά την προσθήκη του token θέλει
`/mcp reconnect` ή restart του Claude Code.
