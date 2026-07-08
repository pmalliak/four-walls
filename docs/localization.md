# Greek localization

The site is Greek. Two rules that are easy to get wrong:

## 1. `<html lang="el">` on every page

Besides being correct, this makes the browser apply **Greek-aware casing** to
CSS `text-transform: uppercase`, which strips accents.

## 2. Greek capitals take no accent (τόνος)

When Greek text is shown in all-caps it must be **accent-free**:

- «Αναζήτηση» → **ΑΝΑΖΗΤΗΣΗ** ✅ — never «ΑΝΑΖΉΤΗΣΗ» ❌

With `lang="el"` set, CSS-uppercased text handles this automatically. When you
type text that is **already uppercase** in the HTML, omit the accents yourself.

## 3. Currency & numbers

- Currency symbol **€** (never `$`).
- Thousands separator is a dot: `€100.000`.
- Compact ranges use a plain hyphen, single symbol: `€100.000-200.000`,
  `€900-1.500/μήνα`.
