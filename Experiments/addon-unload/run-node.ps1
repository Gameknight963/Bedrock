$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe).Source
foreach ($mode in @('wrapped-safe','dispose-failure','wrapped-stress','unmanaged','unwrapped-after','unsafe-finalizer','unsafe-cleanup')) {
    $stdout = Join-Path $PSScriptRoot "runs/node-$mode-stdout.txt"
    $stderr = Join-Path $PSScriptRoot "runs/node-$mode-stderr.txt"
    $process = Start-Process -FilePath $node -ArgumentList @('--expose-gc', ('"' + (Join-Path $PSScriptRoot 'wrapped-test.cjs') + '"'), $mode) -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $null = $process.Handle
    if (-not $process.WaitForExit(45000)) { Stop-Process -Id $process.Id; throw "Timeout: $mode" }
    Write-Output "$mode exit: $($process.ExitCode)"
    Copy-Item (Join-Path $PSScriptRoot "runs/$mode/result.txt") (Join-Path $PSScriptRoot "runs/node-$mode-result.txt")
    Get-Content (Join-Path $PSScriptRoot "runs/node-$mode-result.txt")
    if ($mode.StartsWith('unsafe-') -or $mode -eq 'unwrapped-after') {
        if ($process.ExitCode -eq 0 -or $process.ExitCode -eq 2) { throw "Expected native crash: $mode" }
    } elseif ($process.ExitCode -ne 0) { throw "Unexpected failure: $mode" }
}


