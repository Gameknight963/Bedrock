# Example plugin

This plugin adds an accent along the top of the plugin cards. Enabling or disabling it takes effect immediately.

The renderer loads `style.css` relative to its own entry point, then calls `ctx.styles.add(css)`. Bedrock owns that style element and removes it when the plugin stops. A separate `stop()` function is unnecessary here.