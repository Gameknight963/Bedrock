param(
    [Parameter(Mandatory)]
    [ValidatePattern('^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$')]
    [string]$Version
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$build = Join-Path $repository 'Launcher/bin/x64/Release'
$output = Join-Path $repository '.artifacts/releases'
$name = "Bedrock-$Version-win-x64"
$archive = Join-Path $output "$name.zip"
if (Test-Path -LiteralPath $archive) { throw "Package already exists: $archive" }
$required = @(
    'BedrockLauncher.exe',
    'Runtime/bootstrap.cjs',
    'Runtime/preload.cjs',
    'Runtime/modules/esbuild.exe',
    'Runtime/modules/system.js',
    'Runtime/modules/renderer-compiler.cjs',
    'Runtime/modules/THIRD_PARTY_NOTICES.txt',
    'Runtime/native/win32-x64/addons.node',
    'Runtime/native/win32-x64/dotnet.node',
    'Runtime/dotnet-desktop/Bedrock.Desktop.dll',
    'Runtime/dotnet-desktop/Bedrock.DesktopHost.dll',
    'Runtime/dotnet-desktop/Bedrock.DesktopHost.runtimeconfig.json',
    'Runtime/native/win32-x64/native-controller.exe',
    'Runtime/native/win32-x64/native-host.dll',
    'Runtime/native/win32-x64/LICENSE',
    'Runtime/native/win32-x64/manual-map-LICENSE.txt',
    'Runtime/native/win32-x64/minhook-LICENSE.txt',
    'Runtime/dotnet/_framework/dotnet.js',
    'Runtime/dotnet/licenses/LICENSE.TXT',
    'Runtime/dotnet/licenses/THIRD-PARTY-NOTICES.TXT'
)
foreach ($file in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $build $file) -PathType Leaf)) {
        throw "Release build is missing $file. Build Launcher with Release/x64 first."
    }
}
$null = New-Item -ItemType Directory -Path $output -Force
$staging = Join-Path ([IO.Path]::GetTempPath()) ('Bedrock-package-' + [guid]::NewGuid())
$package = Join-Path $staging $name
$null = New-Item -ItemType Directory -Path $package
try {
    Copy-Item -LiteralPath (Join-Path $build 'BedrockLauncher.exe') -Destination $package
    Copy-Item -LiteralPath (Join-Path $build 'Runtime') -Destination $package -Recurse
    foreach ($file in @('LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md')) {
        Copy-Item -LiteralPath (Join-Path $repository $file) -Destination $package
    }
    Get-ChildItem -LiteralPath $package -Filter '*.pdb' -Recurse -File | Remove-Item
    [IO.Compression.ZipFile]::CreateFromDirectory($staging, $archive)
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath "$archive.sha256" -Encoding ascii -Value "$hash  $name.zip"
    Write-Output $archive
} finally {
    $resolvedStaging = [IO.Path]::GetFullPath($staging)
    $temporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedStaging.StartsWith($temporaryParent, [StringComparison]::OrdinalIgnoreCase) -or
        -not ([IO.Path]::GetFileName($resolvedStaging)).StartsWith('Bedrock-package-')) {
        throw 'Unexpected package staging path.'
    }
    Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
}
