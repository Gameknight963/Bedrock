$ErrorActionPreference = 'Stop'
$electron = Join-Path $PSScriptRoot 'obj/node_modules/electron/dist/electron.exe'
$output = Join-Path $PSScriptRoot 'obj/addons-stdout.log'
$errors = Join-Path $PSScriptRoot 'obj/addons-stderr.log'
$process = Start-Process -FilePath $electron -ArgumentList @('--js-flags=--expose-gc', ('"' + (Join-Path $PSScriptRoot 'addons-smoke.cjs') + '"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput $output -RedirectStandardError $errors
$null = $process.Handle
try {
    if (-not $process.WaitForExit(45000)) { throw 'Addon smoke test timed out.' }
    Get-Content -LiteralPath $output
    if ($process.ExitCode -ne 0) { Get-Content -LiteralPath $errors; throw "Addon smoke test failed: $($process.ExitCode)" }
    $result = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'obj/addons-result.json') | ConvertFrom-Json
    if (-not $result.passed) { throw "Addon smoke test did not complete: $($result.error)" }
    Write-Output 'PASS: Real addon acquisition, disposal, unloading, deletion and normal Electron shutdown.'
} finally { if (-not $process.HasExited) { Stop-Process -Id $process.Id } }
