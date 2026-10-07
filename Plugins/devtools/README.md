# DevTools

Enables DevTools with Ctrl+Shift+I or F12. Press the shortcut again to close them.

Remote debugging is optional and off by default. Enable it in the plugin's Settings tab to allow tools such as Chrome DevTools MCP to connect at `http://127.0.0.1:9222`. Changing this setting requires a restart; turning it off or disabling the plugin does not close an already running debugging port until Discord exits.

Restart after enabling. Disabling removes the shortcut handlers immediately and closes DevTools. Fully restoring the original `webPreferences.devTools` option requires another restart though.
