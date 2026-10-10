# Native plugin API

Include `<bedrock/plugin.h>` and export `Bedrock_GetPlugin`. The returned descriptor declares the native API requirement, lifecycle callbacks and optional settings. No Bedrock import library is required.

The current native API is **1.3.0**. The requirement must share its major version and be no newer than the host. `size` fields describe extensible structures supplied by the plugin; settings array entries are traversed using each entry's size. Small value types, including `BedrockSymbolError` and the JavaScript value/error types, have fixed layouts within API major version 1.

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

Plugins using `resolve_symbol` require native API **1.1.0**. With API 1.3.0 or newer, set the descriptor's `flags` to `BEDROCK_PLUGIN_REQUIRES_SYMBOLS` to prepare the reference before startup. API 1.1/1.2 plugins retain automatic preparation. It takes one exact, case-sensitive UTF-8 name from the reference symbol file and returns the matching function's address in the current process's main executable. It installs no hooks and tries no alternative names.

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
- **Preparation:** before starting a plugin that requires symbols, the main runtime downloads the matching Windows x64 Electron release binary and Breakpad `.sym` file if needed. It verifies the archives against the release's SHA-256 checksums and caches the extracted files under `BedrockData/cache/symbols/electron/VERSION/win32-x64`. The native host also checks that the symbol file's PDB identity matches the reference executable. Downloading and extraction happen outside the sandbox.
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

## Executing JavaScript

Native API 1.3.0 provides `execute_js`, `execute_js_async` and `release_js_value` on the context. Main plugins execute in Node's main environment; renderer plugins execute in the page. These pointers are `NULL` in GPU contexts.

Pass a **function body**, with input values available through `args`. Use `return` to obtain a result; a body without a return produces `BEDROCK_JS_UNDEFINED`. Main code also has `require`, resolved relative to Bedrock's runtime folder. This example returns the number 3:

```c
BedrockJsValue result = {0};
BedrockJsError error = {0};
BedrockResult status = ctx->execute_js(
    ctx->host, "return 1 + 2", NULL, 0, 0, &result, &error);
if (status == BEDROCK_OK) {
    ctx->release_js_value(ctx->host, &result);
} else {
    ctx->log(ctx->host, BEDROCK_LOG_ERROR, error.message);
}
```

### Values and ownership

- Undefined, null, booleans and numbers are returned directly. Numbers preserve `NaN`, infinities and negative zero.
- Strings contain UTF-8 bytes and an explicit length, allowing embedded NULs. BigInts use the same text fields for their decimal integer representation.
- Objects, functions, symbols and promises return opaque `BedrockJsHandle` references. Pass a reference back as an argument to access its properties or call it in another body. Handles belong to one plugin instance and JavaScript context; they become invalid when released, disabled or navigated away.
- Release every successful result once with `release_js_value`. It frees text or releases the retained JavaScript reference and clears the container. It is also safe for scalar results. Copying a value does not create another ownership share.
- Arguments are copied before submission returns. Once prepared in JavaScript, a queued request holds its argument objects even if their original handles are released.
- Neither method awaits promises. Returning a promise gives you a reference to that promise. JavaScript may attach handlers itself.

### Synchronous and asynchronous calls

`execute_js` queues work on the JavaScript thread and blocks the calling native thread until completion. A zero timeout selects five seconds; another finite value sets the wait in milliseconds. The timeout covers queueing and execution, but does not interrupt JavaScript. Queued work is cancelled where possible; already running code may still cause side effects, and its late result is discarded. The current loader invokes native plugins on worker threads, so it does not offer an inline call on the JavaScript thread.

Use `execute_js_async` for work whose completion should not block your thread. Its return value reports whether the request was accepted. Rejected requests receive no callback; accepted requests receive exactly one callback with the execution status, result and error. Exception messages and other failure details live in `BedrockJsError`; it needs no release.

Async callbacks run serially on a separate native callback thread. They may call `execute_js`, but must synchronize shared plugin state with lifecycle callbacks and other threads. A callback must not wait for another async callback on that same callback thread.

```c
static void BEDROCK_CALL finished(void *user_data, BedrockResult status,
    BedrockJsValue *result, const BedrockJsError *error)
{
    const BedrockContext *ctx = user_data;
    if (status != BEDROCK_OK)
        ctx->log(ctx->host, BEDROCK_LOG_ERROR, error->message);
    ctx->release_js_value(ctx->host, result);
}

/* Called from the plugin's start callback. */
BedrockResult status = ctx->execute_js_async(
    ctx->host, "return 1 + 2", NULL, 0, finished, (void *)ctx);
```

The callback's result container and error pointer are borrowed until it returns. Successful result contents belong to the plugin: release them in the callback, or copy the value into plugin-owned storage and release that copy later.

### Shutdown and limits

Disabling rejects new requests, wakes synchronous waiters and completes pending async callbacks with `BEDROCK_STOPPED` before calling `stop()`. Callbacks must finish so shutdown can proceed. Release retained values and join plugin-created threads before `stop()` returns. Re-enabling creates a fresh JavaScript context. Executed code's DOM changes, listeners and other side effects need their own cleanup; releasing a handle only releases the reference.

Requests and replies are limited to one MiB on the internal transport. Oversized requests are rejected as invalid arguments; oversized results report a transport error. Neither closes the plugin connection. Avoid synchronous calls where JavaScript is waiting on your native thread: the timeout bounds the wait, but cannot resolve the underlying dependency.
