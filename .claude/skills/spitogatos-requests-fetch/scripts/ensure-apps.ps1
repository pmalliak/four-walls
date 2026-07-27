# Step 0: make sure the two apps this skill drives are up. Idempotent — safe to
# re-run; anything already running is left untouched (and NOT re-minimized, so we
# never steal a window Panos is using).
#
#   1. Spark Desktop  -> its bundled spark.exe CLI reads the lead emails + 2FA codes.
#                        Started MINIMIZED (we only ever talk to it via the CLI).
#   2. Edge :9222      -> dedicated CDP profile that passes Cloudflare + Imperva.
#                        Started NORMAL on purpose: a minimized window makes every
#                        tab "hidden", which triggers intensive timer throttling and
#                        hangs the eval-based steps. Use -EdgeMinimized only if you
#                        accept that risk.
#
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File .claude/skills/spitogatos-requests-fetch/scripts/ensure-apps.ps1
#   ... -SkipSpark        # dashboard-enumeration fallback, no email sweep
#   ... -SkipEdge         # e.g. only re-checking Spark
#   ... -EdgeMinimized    # not recommended, see above
#
# Exit 0 = every requested app is ready. Exit 1 = something is not — read the output.

param(
	[switch]$SkipSpark,
	[switch]$SkipEdge,
	[switch]$EdgeMinimized
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$SPARK_EXE = Join-Path $env:LOCALAPPDATA 'Programs\SparkDesktop\Spark Desktop.exe'
$SPARK_CLI = Join-Path $env:LOCALAPPDATA 'Programs\SparkDesktop\resources\app.asar.unpacked\node_modules\@readdle\sparkcore-win\bin\Release\SparkCore.bundle\spark.exe'
$EDGE_EXE = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$EDGE_PROFILE = Join-Path $env:LOCALAPPDATA 'FourWalls\edge-claude-profile'
$CDP = 'http://127.0.0.1:9222'

$ok = $true
function Say($mark, $msg) { Write-Host "$mark $msg" }

# --- Win32 minimize (Electron apps ignore Start-Process -WindowStyle) -------
if (-not ('FW.Win32' -as [type])) {
	Add-Type -Namespace FW -Name Win32 -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);
'@
}
function Minimize-Proc($name, $timeoutSec = 20) {
	# Poll: an Electron main window takes a few seconds to exist.
	$deadline = (Get-Date).AddSeconds($timeoutSec)
	while ((Get-Date) -lt $deadline) {
		$wins = @(Get-Process -Name $name -ErrorAction SilentlyContinue |
			Where-Object { $_.MainWindowHandle -ne [System.IntPtr]::Zero })
		if ($wins.Count -gt 0) {
			Start-Sleep -Milliseconds 700   # let it finish painting, else it pops back
			foreach ($w in $wins) { [void][FW.Win32]::ShowWindowAsync($w.MainWindowHandle, 6) }  # SW_MINIMIZE
			return $true
		}
		Start-Sleep -Milliseconds 400
	}
	return $false
}

# --- 1. Spark Desktop -------------------------------------------------------
function Test-SparkCli($timeoutMs = 25000) {
	# The real readiness test is the CLI answering, not the process existing.
	if (-not (Test-Path $SPARK_CLI)) { return $false }
	$psi = New-Object System.Diagnostics.ProcessStartInfo
	$psi.FileName = $SPARK_CLI
	$psi.Arguments = 'accounts'
	$psi.UseShellExecute = $false
	$psi.RedirectStandardOutput = $true
	$psi.RedirectStandardError = $true
	$psi.CreateNoWindow = $true
	$p = [System.Diagnostics.Process]::Start($psi)
	$out = $p.StandardOutput.ReadToEndAsync()
	if (-not $p.WaitForExit($timeoutMs)) { try { $p.Kill() } catch {}; return $false }
	return ($p.ExitCode -eq 0 -and $out.Result -match '@')
}

if ($SkipSpark) {
	Say '-' 'Spark: skipped (-SkipSpark) — enumerate from the dashboard instead, see SKILL.md.'
} else {
	$running = @(Get-Process -Name 'Spark Desktop' -ErrorAction SilentlyContinue).Count -gt 0
	if ($running) {
		Say '=' 'Spark: already running (left as-is).'
	} elseif (-not (Test-Path $SPARK_EXE)) {
		Say '!' "Spark: not installed at $SPARK_EXE"
		$ok = $false
	} else {
		Say '+' 'Spark: starting minimized...'
		Start-Process -FilePath $SPARK_EXE -WindowStyle Minimized | Out-Null
		if (Minimize-Proc 'Spark Desktop') { Say ' ' '  window minimized.' }
		else { Say ' ' '  no window appeared yet (tray start?) — continuing.' }
	}

	if (-not $SkipSpark) {
		if (Test-SparkCli) {
			Say '=' 'Spark CLI: responding (mailbox reachable).'
		} else {
			# Known 2026-07-27 failure: launches from a shell exit 0 instantly and silently.
			Say '!' 'Spark CLI: NOT responding.'
			Say ' ' '  Ask Panos to click the Spark icon himself (it has refused shell'
			Say ' ' '  launches before), or re-run with -SkipSpark and enumerate from the'
			Say ' ' '  spitogatos dashboard (see the 2026-07-27 gotcha in SKILL.md).'
			$ok = $false
		}
	}
}

# --- 2. Dedicated Edge on :9222 --------------------------------------------
function Test-Cdp($timeoutSec = 3) {
	try {
		$r = Invoke-RestMethod -Uri "$CDP/json/version" -TimeoutSec $timeoutSec
		return [bool]$r.Browser
	} catch { return $false }
}

if ($SkipEdge) {
	Say '-' 'Edge :9222: skipped (-SkipEdge).'
} elseif (Test-Cdp) {
	Say '=' 'Edge :9222: already listening (left as-is).'
} elseif (-not (Test-Path $EDGE_EXE)) {
	Say '!' "Edge: not found at $EDGE_EXE"
	$ok = $false
} else {
	Say '+' 'Edge :9222: starting dedicated CDP profile...'
	$edgeArgs = @(
		'--remote-debugging-port=9222',
		"--user-data-dir=$EDGE_PROFILE",
		'--no-first-run',
		'--no-default-browser-check',
		'--window-size=1280,900',
		'about:blank'
	)
	Start-Process -FilePath $EDGE_EXE -ArgumentList $edgeArgs | Out-Null

	$deadline = (Get-Date).AddSeconds(30)
	$up = $false
	while ((Get-Date) -lt $deadline) {
		Start-Sleep -Milliseconds 600
		if (Test-Cdp 2) { $up = $true; break }
	}
	if ($up) {
		Say ' ' '  CDP up.'
		if ($EdgeMinimized) {
			if (Minimize-Proc 'msedge' 15) {
				Say '!' '  minimized on request — expect timer throttling on long steps.'
			}
		}
	} else {
		Say '!' 'Edge :9222: did not come up within 30s.'
		Say ' ' '  A stale msedge holding the profile is the usual cause — close it and re-run.'
		$ok = $false
	}
}

Write-Host ''
if ($ok) { Say 'OK' 'apps ready.'; exit 0 }
Say 'XX' 'one or more apps are NOT ready — do not start the pipeline blind.'
exit 1
