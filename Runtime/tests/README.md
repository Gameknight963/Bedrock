# Runtime tests

## Native plugin smoke test

Build `Native/PluginHost/NativeController.vcxproj` and `Examples/native/NativeExample.vcxproj` with Release/x64. Run `Runtime/tests/native-smoke.cjs` as an Electron application, optionally passing an absolute output-file path as its first argument. Use an isolated stock Electron distribution, not the installed Discord client.

The fixture creates its own profile and plugin packages in a temporary folder. It tests main, sandboxed GPU and sandboxed renderer entry points, settings, disable/re-enable and GPU process replacement. The output ends with `PASS` or a failure stack. Native DLLs remain loaded until the fixture exits.

## Electron integration test

Build the launcher with Release/x64 and package the plugin collection first. Run `Runtime/tests/electron-smoke.ps1` with the isolated Electron test dependencies installed. It exercises the packaged Release runtime; use `-Configuration Debug` to check a Debug build.

The fixture creates its own temporary profile and packages. It does not open Discord or use its profile.

## Renderer settings smoke test

Run `Runtime/tests/settings-ui-smoke.cjs` with the isolated Electron distribution and React test dependencies in `Runtime/tests/obj/node_modules`. It opens the plugin settings UI with a disabled plugin, edits ordinary and custom settings, enables and disables the plugin, and checks UI cleanup, error handling and removal.
