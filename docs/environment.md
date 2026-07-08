# Dev environment & editing gotchas

Windows 11. Primary shell is **PowerShell 5.1**; a Bash tool is also available.

- **No `python`.** `node` is installed but frequently **not on PATH** in a fresh
  shell — see [preview.md](preview.md) for the full-path fallback.

## File format — match the repo

- Source files are **UTF-8 without BOM**, **LF** line endings.
- **HTML is TAB-indented.** `fourwalls.css` / `fourwalls.js` use 2 spaces.

## Editing Greek text via PowerShell scripts

Two separate encodings, easy to mix up:

- The **`.ps1` script itself** must be saved **UTF-8 _with_ BOM**, or PowerShell
  5.1 reads its Greek string literals as ANSI and corrupts them.
- The **target file** you write back must be **UTF-8 _without_ BOM** to match
  the repo:
  ```powershell
  $enc = New-Object System.Text.UTF8Encoding($false)   # $false = no BOM
  [System.IO.File]::WriteAllText($path, $text, $enc)
  ```

## Reliable edits in TAB-indented HTML

Exact-string edits are fragile against tab/space mismatches. The dependable
pattern used in this repo: a small PS script that finds an **anchor substring**
(e.g. a unique Greek label), locates the nearby markup with
`IndexOf` / `LastIndexOf`, splices the replacement, and writes back BOM-less
UTF-8. Keep such scripts in the scratchpad, not the repo.
