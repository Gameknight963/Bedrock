# Window Customization

Customize Discord's window from this plugin's Settings tab. Frame changes apply immediately; transparency requires a restart.

## Settings

- **Window transparency:** allows transparent CSS themes to show through Discord's window. Enable it, then restart Discord using Bedrock's restart button. Changing it back also requires a restart.
- **Native title bar:** adds the Windows caption and system menu. Windows draws the title bar and handles its buttons, dragging, and double-clicking.
- **Restore resizable frame:** adds `WS_THICKFRAME`, the Windows style that enables resizing from the window edges. This is useful for transparent windows, where Electron removes that style.

These settings are independent. The plugin's maximize/restore and F11 handling applies while the plugin is enabled, even with Native title bar turned off.

Use a CSS theme with transparent backgrounds in Bedrock's Themes page. The transparency option makes the window support transparency; it does not change Discord's CSS or fade text and images. This plugin does not hide Discord's own title bar controls.

## How it works

The implementation details below refer to Electron 42.11.8, the version used by Discord when this plugin was developed. Source links are pinned to that version.

### Transparency

The plugin changes Electron's window creation options to enable transparency, set a transparent background, and remove the frame, which Electron requires for transparency on Windows. These options must be set before the window is created, so changing transparency requires a restart. The native title bar and resizable frame settings can add their styles afterward.

### Resizable frame

`WS_THICKFRAME` is a window style in Windows that controls whether a window should be resizable or not.


Electron forcibly disables its `thickFrame` window creation option for transparent windows, which causes it to remove `WS_THICKFRAME`. Its source explains that Chromium adding this style can break transparency on layered windows. As part of that workaround, Electron simulates maximizing and fullscreen by resizing the window instead of relying on the usual native window handling. Setting `thickFrame: true` in Electron's window options does not override the restriction when transparency is enabled. See where Electron [overrides the option](https://github.com/electron/electron/blob/v42.11.8/shell/browser/native_window_views.cc#L218-L221), [removes the style](https://github.com/electron/electron/blob/v42.11.8/shell/browser/native_window_views.cc#L394-L396), and [explains the transparency problem](https://github.com/electron/electron/blob/v42.11.8/shell/browser/native_window_views.cc#L993-L997).

Since Discord doesn't use layered windows, we don't have this issue. (`transparent: true` doesn’t necessarily use layered windows). So this plugin just adds the style directly through the Windows API after window creation. That restores native resizing without changing Electron's internal frame flag.

This will probably break `setOpacity()` if anyone uses it though, since that makes the window layered.

### Maximizing and restoring

Restoring `WS_THICKFRAME` fixes edge resizing, but Electron explicitly consumes `SC_MAXIMIZE` for transparent windows without maximizing them:

    if (transparent() && (cmd == SC_MAXIMIZE))
      return true;

See [Electron’s Windows message handler](https://github.com/electron/electron/blob/v42.11.8/shell/browser/native_window_views_win.cc#L479-L483).

Adding a native title bar therefore leaves a maximize button that does nothing.

The plugin sends maximize and restore commands directly to the function `DefWindowProcW`, which is short for 'Default Window Procedure.' It implements Windows’ standard window behavior. This bypasses Electron’s handler, which would otherwise discard the maximize command.

Discord’s JavaScript controls would otherwise continue using Electron’s resize workaround. The plugin redirects their maximize and restore calls to the same native handler, so both sets of controls use the same window state. It also reads maximized status and normal bounds from Windows rather than Electron’s separate bookkeeping

## F11 fullscreen

Fullscreen is separate from maximizing: it fills the entire monitor, including the taskbar area, and removes the title bar and resize border.

- On entry, the plugin saves the window placement, including whether it was maximized, and temporarily restores it before removing the frame and sizing it to the monitor.
- On exit, it restores the frame and saved placement. A previously maximized window returns to maximized, with its normal restore position preserved.
- F11 toggles this operation directly. The plugin also redirects the window's fullscreen methods and emits the fullscreen entry and exit events.

The plugin handles window fullscreen. HTML fullscreen requests, such as a video's fullscreen button, use a separate Chromium path and are not covered by this handling.

## Disabling

Disabling the plugin exits its fullscreen mode, restores the frame styles it changed, removes its window message handler and F11 listener, and restores the JavaScript methods it patched.

If transparency was enabled when the window was created, disabling the plugin requires a restart to restore an opaque window.

## Native implementation

The native module is written in C and uses Node-API to call WinAPI from Discord's main process.

The native frame message handling follows the approach used by Ingan121's MIT-licensed [Titlebar For Everyone](https://windhawk.net/mods/titlebar-for-everyone).
