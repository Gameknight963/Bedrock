# Example plugin

This plugin adds an accent along the top of the plugin cards. Enabling or disabling it takes effect immediately.

Open its **Settings** tab to switch the accent on or off and choose a color. Changes apply immediately and survive restarts.

The renderer exports a `definePluginSettings()` definition and reads its values through `settings.store`. It loads `style.css` relative to its own entry point and subscribes to setting changes to update the style. Bedrock owns the style elements and removes them when the plugin stops. A separate `stop()` function is unnecessary here.
