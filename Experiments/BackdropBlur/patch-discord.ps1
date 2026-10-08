param([switch]$Restore)
# Patch process memory only; never open the executable for writing.
$ErrorActionPreference = 'Stop'
if ([IntPtr]::Size -ne 8) { throw 'Run this experiment in 64-bit PowerShell.' }
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BlurMemory {
    public static int FindSignature(byte[] data, byte[] signature, byte[] mask, int start, int length) {
        int found = -1;
        for (int offset = start; offset <= start + length - signature.Length; offset++) {
            if (data[offset] != signature[0]) continue;
            int index = 1;
            while (index < signature.Length && (mask[index] == 0 || data[offset + index] == signature[index])) index++;
            if (index != signature.Length) continue;
            if (found >= 0) throw new InvalidOperationException("Multiple function matches; refusing to patch.");
            found = offset;
        }
        return found;
    }
} 
public static class BlurNative {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] data, UIntPtr size, out UIntPtr read);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteProcessMemory(IntPtr process, IntPtr address, byte[] data, UIntPtr size, out UIntPtr written);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool VirtualProtectEx(IntPtr process, IntPtr address, UIntPtr size, uint protection, out uint previous);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FlushInstructionCache(IntPtr process, IntPtr address, UIntPtr size);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
}
'@
function Check-Native($Success, $Operation) {
    if (-not $Success) { throw "$Operation failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
}
$targets = @(Get-CimInstance Win32_Process -Filter "Name = 'Discord.exe'" | Where-Object { $_.CommandLine -match '--type=gpu-process' })
if ($targets.Count -ne 1) { throw "Expected one Discord GPU process, found $($targets.Count)." }
$target = Get-Process -Id $targets[0].ProcessId
$path = $target.MainModule.FileName
$file = [IO.File]::ReadAllBytes($path)
$peOffset = [BitConverter]::ToInt32($file, 0x3c)
$sections = [BitConverter]::ToUInt16($file, $peOffset + 6)
$optionalSize = [BitConverter]::ToUInt16($file, $peOffset + 20)
# Electron 42.11.8 PrepareCanvasForRPDQ: 428 bytes, with address operands masked.
$signatureHex = '415741565657534881ece00000000f29b424d00000004c89c64889d74889cb488b05dadfb6044831e048898424c800000048837a10007424488b8b0804000083beb800000000410f95c1488d978000000041b801000000e8847d8af90f57c04c8d742470410f294640410f294630410f294620410f294610410f29064889f14c89f24531c0e826010000c786c00000000000803f48837f10007411488d4c2470ba03000000e8f6fa1df9eb0ac786bc00000003000000488b57084885d27518488b174885d2741ef0ff4208488d4c2470e89bc404faeb0ef0ff4208488d4c2470e85bc404fa0f57f64c8d7c2460410f2937488d87bc000000488d969800000080bfcc00000000480f45d04c89f9e81ebba2f9488b8b08040000f30f108790000000488b4710488d5424204c893a4c8972080f1172104889422031c089422848c7423000000000894238f30f11423ce8dde8c2f9488b93080400004889f94989f0e84b96ffff4c89f1e8c3fa1df9488b8424c80000004831e0488b0d81deb6044839c175170f28b424d00000004881c4e00000005b5f5e415e415fc3488b8c24c80000004831e1e865922bfacc'
$maskHex = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000000ffffffffffffffffffffffffffffffffff00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000000ffffffffffffffffffffffffffffffff00ffffffffffffffffffffff00000000ff00ffffffffffffffffffffffffffffffffffff00ffffffffffffff00ffffffffffffffffffff00000000ff00ffffffffffffffffffff00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000000ffffffffffffffffffffffffffff00000000ffffffff00000000ffffffffffffffffffffffffffff00000000ffffffff00ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00000000ff'
$signature = New-Object byte[] 428
$mask = New-Object byte[] 428
for ($index = 0; $index -lt 428; $index++) {
    $signature[$index] = [Convert]::ToByte($signatureHex.Substring($index * 2, 2), 16)
    $mask[$index] = [Convert]::ToByte($maskHex.Substring($index * 2, 2), 16)
}
if ([BitConverter]::ToUInt16($file, $peOffset + 4) -ne 0x8664) { throw 'Only x64 executables are supported by this signature.' }
$rva = -1
$fileOffset = -1
for ($index = 0; $index -lt $sections; $index++) {
    $section = $peOffset + 24 + $optionalSize + 40 * $index
    $sectionRva = [BitConverter]::ToUInt32($file, $section + 12)
    $sectionSize = [BitConverter]::ToUInt32($file, $section + 16)
    $rawOffset = [BitConverter]::ToUInt32($file, $section + 20)
    $flags = [BitConverter]::ToUInt32($file, $section + 36)
    if (($flags -band 0x20000000) -eq 0) { continue }
    $found = [BlurMemory]::FindSignature($file, $signature, $mask, $rawOffset, $sectionSize)
    if ($found -lt 0) { continue }
    if ($fileOffset -ge 0) { throw 'Multiple executable sections contain a match.' }
    $fileOffset = $found
    $rva = $sectionRva + $found - $rawOffset
}
if ($fileOffset -lt 0) { throw 'Function signature not found. Discord code may have changed; nothing was patched.' }
# x64 exception directory entries record function boundaries independently of the signature.
$exceptionRva = [BitConverter]::ToUInt32($file, $peOffset + 24 + 112 + 3 * 8)
$exceptionSize = [BitConverter]::ToUInt32($file, $peOffset + 24 + 112 + 3 * 8 + 4)
$boundary = $false
for ($index = 0; $index -lt $sections; $index++) {
    $section = $peOffset + 24 + $optionalSize + 40 * $index
    $sectionRva = [BitConverter]::ToUInt32($file, $section + 12)
    $sectionSize = [BitConverter]::ToUInt32($file, $section + 16)
    if ($exceptionRva -lt $sectionRva -or $exceptionRva + $exceptionSize -gt $sectionRva + $sectionSize) { continue }
    $offset = [BitConverter]::ToUInt32($file, $section + 20) + $exceptionRva - $sectionRva
    for ($entry = 0; $entry + 12 -le $exceptionSize; $entry += 12) {
        if ([BitConverter]::ToUInt32($file, $offset + $entry) -eq $rva -and
            [BitConverter]::ToUInt32($file, $offset + $entry + 4) -eq $rva + 428) { $boundary = $true; break }
    }
}
if (-not $boundary) { throw 'Function boundary did not match; nothing was patched.' }
Write-Output ('Unique signature match at RVA 0x{0:X}; function boundary verified.' -f $rva)
$handle = [BlurNative]::OpenProcess(0x438, $false, $target.Id)
if ($handle -eq [IntPtr]::Zero) { throw "OpenProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
try {
    $address = [IntPtr]($target.MainModule.BaseAddress.ToInt64() + $rva)
    $code = New-Object byte[] 428
    $read = [UIntPtr]::Zero
    Check-Native ([BlurNative]::ReadProcessMemory($handle, $address, $code, [UIntPtr]::new([uint32]428), [ref]$read)) 'Read function'
    if ($read.ToUInt64() -ne 428) { throw 'Incomplete function read.' }
    for ($index = 0; $index -lt 428; $index++) {
        if ($index -eq 0xa1 -and $code[$index] -eq 1) { continue }
        if ($code[$index] -ne $file[$fileOffset + $index]) { throw "Runtime code differs at function offset $index." }
    }
    if ($code[0xa0] -ne 0xba -or $code[0xa1] -notin 1,3) { throw 'Unexpected blend instruction.' }
    $value = if ($Restore) { 3 } else { 1 }
    $patchAddress = [IntPtr]($address.ToInt64() + 0xa1)
    Write-Output ('Verified 428-byte function in GPU PID {0}, address 0x{1:X}.' -f $target.Id, $address.ToInt64())
    if ($code[0xa1] -eq $value) { Write-Output 'Requested blend mode already applied.'; return }
    $previous = [uint32]0
    Check-Native ([BlurNative]::VirtualProtectEx($handle, $patchAddress, [UIntPtr]::new([uint32]1), 0x40, [ref]$previous)) 'Allow memory write'
    try {
        $written = [UIntPtr]::Zero
        Check-Native ([BlurNative]::WriteProcessMemory($handle, $patchAddress, [byte[]]@($value), [UIntPtr]::new([uint32]1), [ref]$written)) 'Write blend mode'
        if ($written.ToUInt64() -ne 1) { throw 'Incomplete memory write.' }
        Check-Native ([BlurNative]::FlushInstructionCache($handle, $patchAddress, [UIntPtr]::new([uint32]1))) 'Flush instruction cache'
    } finally {
        $unused = [uint32]0
        Check-Native ([BlurNative]::VirtualProtectEx($handle, $patchAddress, [UIntPtr]::new([uint32]1), $previous, [ref]$unused)) 'Restore page protection'
    }
    $verified = New-Object byte[] 1
    Check-Native ([BlurNative]::ReadProcessMemory($handle, $patchAddress, $verified, [UIntPtr]::new([uint32]1), [ref]$read)) 'Verify blend mode'
    if ($verified[0] -ne $value) { throw 'Blend mode verification failed.' }
    Write-Output ('Changed blend argument {0} -> {1} at 0x{2:X}; page protection restored. Disk unchanged.' -f $code[0xa1], $value, $patchAddress.ToInt64())
} finally {
    [void][BlurNative]::CloseHandle($handle)
}
