param([long]$WindowHandle, [uint32]$Message, [uint32]$WParam)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WindowMessages {
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool PostMessageW(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
}
'@
if (-not [WindowMessages]::PostMessageW([IntPtr]::new($WindowHandle), $Message, [UIntPtr]::new($WParam), [IntPtr]::Zero)) {
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
}
