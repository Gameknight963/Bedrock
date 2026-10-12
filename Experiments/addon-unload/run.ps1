$ErrorActionPreference = 'Stop'
$electron = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../Bedrock/Runtime/tests/obj/node_modules/electron/dist/electron.exe'))
foreach ($mode in @('free', 'reload', 'stress', 'posix', 'stale-call')) {
    $process = Start-Process -FilePath $electron -ArgumentList @('--js-flags=--expose-gc', ('"' + (Join-Path $PSScriptRoot 'test.cjs') + '"'), $mode) -WindowStyle Hidden -PassThru
    $null = $process.Handle
    if (-not $process.WaitForExit(15000)) { Stop-Process -Id $process.Id; throw "Timeout: $mode" }
    Write-Output "$mode exit: $($process.ExitCode)"
    Get-Content (Join-Path $PSScriptRoot "runs/$mode/result.txt")
}

