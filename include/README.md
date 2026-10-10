# Native plugin API

Include `<bedrock/plugin.h>` and export `Bedrock_GetPlugin`. The returned descriptor declares the native API requirement, lifecycle callbacks and optional settings. No Bedrock import library is required.

The current native API is **1.2.0**. The requirement must share its major version and be no newer than the host. `size` fields describe extensible structures supplied by the plugin; settings array entries are traversed using each entry's size. Small value types, including `BedrockSymbolError`, have fixed layouts within API major version 1.

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

## Resolving Electron symbols

Plugins using `resolve_symbol` require native API **1.1.0**. It takes one exact, case-sensitive UTF-8 name from the reference symbol file and returns the matching function's address in the current process's main executable. It installs no hooks and tries no alternative names.

```c
typedef void (*ClipRect)(void *canvas, const void *rect, int operation, bool antialias);

BedrockSymbolError error = {0};
ClipRect clip_rect = (ClipRect)ctx->resolve_symbol(
    ctx->host,
    "SkCanvas::clipRect(SkRect const &,SkClipOp,bool)",
    &error
);
if (!clip_rect) {
    ctx->log(ctx->host, BEDROCK_LOG_ERROR, error.message);
    return BEDROCK_ERROR;
}
```

The example's first argument is the C++ method's implicit `this` pointer under Windows x64's calling convention. The plugin must supply the correct function prototype; a cast does not validate it.

- **Results:** success returns an address and clears the optional error output. Failure returns `NULL`. Error codes distinguish invalid arguments, stopped contexts, unavailable or invalid reference data, absent or ambiguous reference names, absent or ambiguous target functions, and invalid function boundaries. Messages are NUL-terminated UTF-8. Neither the address nor the error message needs freeing.
- **Preparation:** before starting an API 1.1.0 plugin, the main runtime downloads the matching Windows x64 Electron release binary and Breakpad `.sym` file if needed. It verifies the archives against the release's SHA-256 checksums and caches the extracted files under `BedrockData/cache/symbols/electron/VERSION/win32-x64`. The native host also checks that the symbol file's PDB identity matches the reference executable. Downloading and extraction happen outside the sandbox.
- **Lookup:** the controller supplies read-only file mappings to the native host. On the first request for a name, the host reads its function record, decodes the reference bytes, masks address-dependent operands and PE relocations, then scans executable sections in the current process. Success requires one match agreeing with PE unwind function boundaries and size. Results, including failures, are cached for that host instance and reused when re-enabling a plugin.
- **Timing:** lookup is synchronous and can scan a large executable. Call it during initialization on the host worker, not inside rendering hooks. Disabling cancels waiting for reference preparation; a shared download already in progress can finish and populate the cache.
- **Limits:** the current decoder supports the legacy x64 instruction encodings handled by HDE; unsupported instructions, including VEX/EVEX encodings, are rejected. Leaf functions without PE unwind records are also rejected. Matching code does not establish compatibility of private C++ layouts or calling conventions.

List exact function names from a cached reference file with:

```text
node Runtime/symbols.cjs list path/to/electron.exe.sym SkCanvas::clipRect
```

The final argument is an optional substring filter for listing; resolution itself always uses an exact name.

## Example

`Examples/native/NativeExample.vcxproj` builds the C example. Its output folder contains the DLL, manifest and README for a plugin package. It is not bundled into the normal plugin list.

## Initialization status

Native API 1.2.0 adds `ctx->report_status(ctx->host, message)`. Pass plain UTF-8 text describing the current initialization task; Bedrock copies it before returning. Format variable content in your own buffer if needed. JavaScript contexts provide `ctx.reportStatus(message)`. Status appears while initialization is in progress and clears from the UI when startup finishes. Errors are reported separately.
