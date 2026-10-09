# Runtime tests

## Native plugin smoke test

Build `Native/PluginHost/Controller.vcxproj` and `Examples/native/NativeExample.vcxproj` with Release/x64. Run `Runtime/tests/native-smoke.cjs` as an Electron application, optionally passing an absolute output-file path as its first argument. Use an isolated stock Electron distribution, not the installed Discord client.

The fixture creates its own profile and plugin packages in a temporary folder. It tests main, sandboxed GPU and sandboxed renderer entry points, settings, disable/re-enable and GPU process replacement. The output ends with `PASS` or a failure stack. Native DLLs remain loaded until the fixture exits.
