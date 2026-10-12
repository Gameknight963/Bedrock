$ErrorActionPreference = 'Stop'
$electron = Join-Path $PSScriptRoot '../../Runtime/tests/obj/node_modules/electron/dist/electron.exe'
$runs = Join-Path $PSScriptRoot 'runs'
New-Item -ItemType Directory -Force -Path $runs | Out-Null
$taskProcess = Start-Process -FilePath $electron -ArgumentList ('"' + (Join-Path $PSScriptRoot 'test.cjs') + '"') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runs 'stdout.log') -RedirectStandardError (Join-Path $runs 'stderr.log')
$null = $taskProcess.Handle
try {
    if (-not $taskProcess.WaitForExit(45000)) { throw 'Plugin reload experiment timed out.' }
    Get-Content -LiteralPath (Join-Path $runs 'stdout.log')
    $result = Get-Content -Raw -LiteralPath (Join-Path $runs 'result.json') | ConvertFrom-Json
    if ($taskProcess.ExitCode -ne 0 -or -not $result.passed) { Get-Content -LiteralPath (Join-Path $runs 'stderr.log'); throw $result.error }
} finally { if (-not $taskProcess.HasExited) { Stop-Process -Id $taskProcess.Id } }
