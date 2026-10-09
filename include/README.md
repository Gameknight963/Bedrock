# Native plugin API

Include `<bedrock/plugin.h>` and export `Bedrock_GetPlugin`. The returned descriptor declares the native API requirement, lifecycle callbacks and optional settings. No Bedrock import library is required.

The current native API is **1.0.0**. The requirement must share its major version and be no newer than the host. `size` fields describe the structures supplied by the plugin; settings array entries are traversed using each entry's size.

## Package

```json
"entrypoints": {
    "gpu": { "runtime": "native", "path": "native/win32-x64/example.dll" }
}
```

Native entry points support `main`, `gpu` and `renderer`. Renderer targets are processes hosting the Discord pages accepted by Bedrock, excluding the splash screen and DevTools. A package can combine native and JavaScript entry points in different environments. A single environment has one entry point.

Native binaries currently require Windows x64. Use the default C ABI, structure packing and enum sizes. The header also compiles as C++. The portability macros do not imply a working loader on other operating systems.

## Settings and values

Declare a static settings array and set each definition's `size`. Optional text can be `NULL`. Boolean, string, number, select and slider controls use Bedrock's normal settings UI and persistence. Slider definitions require minimum and maximum flags. Numeric flags distinguish omitted constraints from zero-valued constraints. Select definitions supply choices with string, boolean or numeric values.

Saved settings are available during startup. `settings_get` returns an owned value; call `value_release` for every successful result, including scalar values. `settings_set` copies its input and validates it locally before queuing the change for main-process validation and persistence. It does not synchronously write the file. Confirmed changes update the local snapshot and invoke `settings_changed`; failed writes appear in plugin logs. Strings are UTF-8; embedded NUL characters cannot be represented.

Logging copies its input. Callback values are borrowed until the callback returns. Definitions remain valid for the DLL's lifetime. Native definitions become available after the plugin is first enabled; disabled plugins are not mapped solely to inspect their settings.

## Lifecycle

Initialization occurs outside `DllMain`. `start`, `settings_changed` and `stop` run serially on the host worker thread. Rendering hooks and plugin-created threads are separate and must synchronize their own state. Host services are callable from those threads while the context remains valid.

A failed `start` must undo its partial initialization before returning. `stop` must remove hooks and finish outstanding work before returning; the context is valid through that call. Never throw exceptions across the C boundary.

Disabling stops behavior but retains the DLL and host connection. Re-enabling reuses the mapping. Updating loaded DLLs requires restarting the target process. Main-process DLLs are loaded with `LoadLibraryW`; sandboxed renderer and GPU DLLs are manually mapped. Mapped plugins must use Windows TLS slots (`TlsAlloc`/`TlsGetValue`) rather than compiler-managed `thread_local` or `__declspec(thread)` storage. The current mapper invokes TLS callbacks but does not register static TLS templates with the Windows loader. Native code continues to run with its target process's restrictions. Imports are resolved through the target's Windows loader, so sandboxed plugins should statically link non-system dependencies rather than assume their companion DLLs can be loaded. The loader method is not part of the public API.

The manager watches target process identities, including creation time, and initializes replacements after a process restart. A failed instance is not repeatedly retried in the same process. Re-enabling can retry a failed start, but a disconnected host requires a target process restart.

## Example

`Examples/native/NativeExample.vcxproj` builds the C example. Its output folder contains the DLL, manifest and README for a plugin package. It is not bundled into the normal plugin list.
