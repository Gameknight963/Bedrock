$ErrorActionPreference = 'Stop'
$electron = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../Bedrock/Runtime/tests/obj/node_modules/electron/dist/electron.exe'))
foreach ($mode in @('wrapped-safe','dispose-failure','wrapped-stress','unmanaged','unwrapped-after','unsafe-finalizer','unsafe-cleanup')) {
    $process = Start-Process -FilePath $electron -ArgumentList @('--js-flags=--expose-gc', ('"' + (Join-Path $PSScriptRoot 'wrapped-test.cjs') + '"'), $mode) -WindowStyle Hidden -PassThru
    $null = $process.Handle
    if (-not $process.WaitForExit(45000)) { Stop-Process -Id $process.Id; throw "Timeout: $mode" }
    Write-Output "$mode exit: $($process.ExitCode)"
    Get-Content (Join-Path $PSScriptRoot "runs/$mode/result.txt")
    if ($mode.StartsWith('unsafe-') -or $mode -eq 'unwrapped-after') {
        if ($process.ExitCode -eq 0 -or $process.ExitCode -eq 2) { throw "Expected native crash: $mode" }
    } elseif ($process.ExitCode -ne 0) { throw "Unexpected failure: $mode" }
}


