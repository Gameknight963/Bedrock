# Window Customization

Open this plugin's Settings tab to enable the Windows title bar or restore the resizable frame. Both settings apply immediately to Discord windows; disabling the plugin restores the window styles it changed.

Use Window Transparency and a transparent CSS theme separately if you want transparency. This plugin does not change your theme or hide Discord's own title bar controls.

F11 toggles borderless fullscreen and restores the previous window position and maximized state when you leave. Window maximize and restore calls use the same native Windows state as the caption buttons.

The plugin handles window fullscreen. HTML fullscreen requests, such as a video's fullscreen button, use a separate Chromium path and are not covered by this handling.

The launcher build includes the compiled native module automatically. When installing the plugin elsewhere, copy its whole folder, including `native`. The module is written in C and uses Node-API to call WinAPI from Discord's main process.

The native frame message handling follows the approach used by Ingan121's MIT-licensed [Titlebar For Everyone](https://windhawk.net/mods/titlebar-for-everyone).
