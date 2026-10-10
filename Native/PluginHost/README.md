# Native plugin host

Implements the public C interface in `include/bedrock/plugin.h`. The JavaScript plugin manager owns settings storage, UI state and target discovery. A native host worker in each target executes the plugin lifecycle and holds a settings snapshot.

`native-controller.exe` maps the host and, for sandboxed targets, the plugin DLL. Main-process plugins are loaded by the host through `LoadLibraryW`. The controller uses the existing MIT-licensed manual mapper; Backdrop Blur Fix uses this shared host.

Two anonymous pipes carry JSON messages. Their handles are duplicated into the target before starting the host worker, so opening an IPC endpoint does not depend on sandbox file-access permissions. The controller forwards between the host pipes and its own standard streams. Messages are limited to one MiB.

Each entry-point instance has a host worker and controller connection. Commands are serialized on that worker. Plugin log calls and setting reads/writes can originate on other threads; output and the settings snapshot have separate locks. The host frees returned string values through its own allocator.

Disabling keeps the controller connection and mapped images resident. Removing a plugin closes its connection after stopping it. Disconnecting IPC also asks the host to stop before releasing its context. Images remain resident until the target process exits. If a callback hangs, the manager reports a timeout; it does not terminate the target thread or unload its code.

The controller and host support Windows x64. Controller mapping code is C++ because the vendored mapper uses C++; the host and controller logic are C.

## Symbol references

Native entrypoints requiring API 1.1 receive reference files before `start()`. The JavaScript manager downloads the matching Electron release and Breakpad symbols into `BedrockData/cache/symbols`, checks release SHA-256 checksums, and verifies cached files on reuse. Download preparation runs outside the target process.

The controller opens the reference files and duplicates read-only mapping handles into the target. The host maps those handles, validates the reference PE and symbol identity, and implements `ctx->resolve_symbol` locally. Sandboxed targets do not open reference paths or perform network requests. Resolved addresses and failures are cached for that host instance; absolute addresses are never persisted.

See [the public API documentation](../../include/README.md#resolving-electron-symbols) for names, errors and signature limitations.
