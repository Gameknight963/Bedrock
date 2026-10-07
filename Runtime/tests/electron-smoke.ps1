param(
    [string]$Electron = (Join-Path $PSScriptRoot 'obj/node_modules/electron/dist/electron.exe'),
    [switch]$ThroughInspector,
    [int]$Port = 19330
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Electron)) {
    throw 'Install the isolated test dependencies first: npm install --prefix Runtime/tests/obj electron@42.7.1 react@18.3.1 react-dom@18.3.1'
}
$fixtureArguments = @()
if ($ThroughInspector) { $fixtureArguments += "--inspect-brk=127.0.0.1:$Port" }
$fixtureArguments += ('"' + (Join-Path $PSScriptRoot 'electron-smoke.cjs') + '"')
$fixtureProcess = Start-Process -FilePath $Electron -ArgumentList $fixtureArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $PSScriptRoot 'obj/electron-stdout.log') -RedirectStandardError (Join-Path $PSScriptRoot 'obj/electron-stderr.log')
$bootstrapRoot = $null
try {
    $null = $fixtureProcess.Handle
    if ($ThroughInspector) {
        $bootstrapRoot = Join-Path ([IO.Path]::GetTempPath()) ('Bedrock-electron-inspector-' + [guid]::NewGuid())
        $bootstrapPath = Join-Path $PSScriptRoot 'obj/inspector-bootstrap.cjs'
        $runtimePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../bootstrap.cjs'))
        $bootstrapSource = 'exports.install = () => require(' + (ConvertTo-Json -Compress $runtimePath) + ').install({root:' + (ConvertTo-Json -Compress $bootstrapRoot) + ',allowURL: url => url.origin === "https://bedrock.test"});'
        Set-Content -LiteralPath $bootstrapPath -Encoding UTF8 -Value $bootstrapSource
        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            if ($fixtureProcess.HasExited) { throw 'Electron exited before inspector attachment' }
            try { $null = Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 1; $ready = $true; break }
            catch { Start-Sleep -Milliseconds 100 }
        }
        if (-not $ready) { throw 'Electron inspector did not become ready' }
        $harness = Join-Path $PSScriptRoot '../../Launcher/tests/bin/x64/Debug/BedrockLauncher.exe'
        if (-not (Test-Path -LiteralPath $harness)) { throw 'Run Launcher/tests/smoke.ps1 first to build the inspector harness' }
        & $harness $Port $fixtureProcess.Id $bootstrapPath
        if ($LASTEXITCODE -ne 0) { throw 'Electron inspector bootstrap failed' }
    }
    if (-not $fixtureProcess.WaitForExit(45000)) { throw 'Electron test timed out' }
    $fixtureExitCode = $fixtureProcess.ExitCode
    Get-Content -LiteralPath (Join-Path $PSScriptRoot 'obj/electron-stdout.log')
    if ($fixtureExitCode -ne 0) {
        Get-Content -LiteralPath (Join-Path $PSScriptRoot 'obj/electron-stderr.log')
        throw "Electron test failed: $fixtureExitCode"
    }
} finally {
    if (-not $fixtureProcess.HasExited) { Stop-Process -Id $fixtureProcess.Id }
    if ($bootstrapRoot -and (Test-Path -LiteralPath $bootstrapRoot)) {
        $resolvedRoot = [IO.Path]::GetFullPath($bootstrapRoot)
        $temporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if (-not $resolvedRoot.StartsWith($temporaryParent, [StringComparison]::OrdinalIgnoreCase) -or
            -not ([IO.Path]::GetFileName($resolvedRoot)).StartsWith('Bedrock-electron-inspector-')) { throw 'Unexpected fixture cleanup path' }
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
