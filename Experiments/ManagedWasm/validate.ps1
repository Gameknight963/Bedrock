param(
    [Parameter(Mandatory = $true)]
    [string] $ElectronPath
)

$ErrorActionPreference = 'Stop'
$experiment = $PSScriptRoot
$electron = (Resolve-Path -LiteralPath $ElectronPath).Path
$hostProject = Join-Path $experiment 'Host/Host.csproj'
$pluginProject = Join-Path $experiment 'Plugin/Plugin.csproj'
$framework = Join-Path $experiment 'Host/bin/Release/net10.0/publish/wwwroot/_framework'
$secondPlugin = Join-Path $experiment 'obj/second-plugin'

function Get-FrameworkHashes {
    $hashes = @{}
    foreach ($file in Get-ChildItem -LiteralPath $framework -File -Recurse) {
        $hashes[$file.FullName] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    }
    return $hashes
}

& dotnet publish $hostProject -c Release --nologo
if ($LASTEXITCODE -ne 0) { throw 'WASM host publish failed.' }
$before = Get-FrameworkHashes

& dotnet build $pluginProject -c Release --nologo
if ($LASTEXITCODE -ne 0) { throw 'First plugin build failed.' }
& dotnet build $pluginProject -c Release -p:AssemblyName=SecondPlugin -o $secondPlugin --nologo
if ($LASTEXITCODE -ne 0) { throw 'Second plugin build failed.' }

$after = Get-FrameworkHashes
if ($before.Count -ne $after.Count) { throw 'Building plugins changed the host files.' }
foreach ($file in $before.Keys) {
    if ($before[$file] -ne $after[$file]) { throw 'Building plugins changed the host files.' }
}

# Waiting is necessary for GUI executables; invoking Electron directly can return before the test exits.
$fixture = Join-Path $experiment 'fixture.cjs'
$process = Start-Process -FilePath $electron -ArgumentList ('"' + $fixture + '"') -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) { throw 'WASM integration test failed. See obj/results.json.' }
$result = Get-Content -LiteralPath (Join-Path $experiment 'obj/results.json') -Raw | ConvertFrom-Json
if (!$result.passed) { throw 'WASM integration test did not pass.' }
Write-Host 'Passed: two independent plugins, one shared runtime, and unchanged host files.'
$result | ConvertTo-Json -Depth 5
