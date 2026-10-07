param(
    [string]$MSBuild = 'C:/Program Files/Microsoft Visual Studio/18/Community/MSBuild/Current/Bin/MSBuild.exe',
    [int]$Port = 19329
)
$ErrorActionPreference = 'Stop'
& $MSBuild (Join-Path $PSScriptRoot 'InspectorSmoke.vcxproj') /p:Configuration=Debug /p:Platform=x64 /verbosity:minimal /nologo
if ($LASTEXITCODE -ne 0) { throw 'Smoke harness build failed' }
$fixtureDirectory = Join-Path $PSScriptRoot 'obj'
New-Item -ItemType Directory -Path $fixtureDirectory -Force | Out-Null
$fixturePath = Join-Path $fixtureDirectory 'fixture.cjs'
Set-Content -LiteralPath $fixturePath -Value 'if (!globalThis.bedrockSmokeInstalled) throw new Error("Bootstrap did not run before entry point"); setInterval(() => {}, 1000);'
$bootstrapPath = Join-Path $fixtureDirectory "bootstrap-quote'-$([char]0x2603).cjs"
Set-Content -LiteralPath $bootstrapPath -Encoding UTF8 -Value 'exports.install = () => { globalThis.bedrockSmokeInstalled = true; return true; };'
$fixtureProcess = Start-Process -FilePath (Get-Command node).Source -ArgumentList @("--inspect-brk=127.0.0.1:$Port", ('"' + $fixturePath + '"')) -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $fixtureDirectory 'stderr.log') -RedirectStandardOutput (Join-Path $fixtureDirectory 'stdout.log')
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        if ($fixtureProcess.HasExited) { throw 'Node fixture exited before debugger attachment' }
        try {
            $null = Invoke-RestMethod "http://127.0.0.1:$Port/json/list" -TimeoutSec 1
            $ready = $true
            break
        } catch { Start-Sleep -Milliseconds 100 }
    }
    if (-not $ready) { throw 'Node inspector did not become ready' }
    & (Join-Path $PSScriptRoot 'bin/x64/Debug/BedrockLauncher.exe') $Port $fixtureProcess.Id $bootstrapPath
    if ($LASTEXITCODE -ne 0) { throw 'Inspector smoke test failed' }
    Start-Sleep -Milliseconds 200
    $fixtureProcess.Refresh()
    if ($fixtureProcess.HasExited) { throw 'Node fixture unexpectedly exited after inspector shutdown' }
    Write-Output 'PASS: Bootstrap ran before application entry, Unicode path worked, inspector port closed, and Node stayed alive.'
} finally {
    if (-not $fixtureProcess.HasExited) { Stop-Process -Id $fixtureProcess.Id }
}
