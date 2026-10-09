# Native plugin host

Implements the public C interface in `include/bedrock/plugin.h`. The JavaScript plugin manager owns settings storage, UI state and target discovery. A native host worker in each target executes the plugin lifecycle and holds a settings snapshot.

`native-controller.exe` maps the host and, for sandboxed targets, the plugin DLL. Main-process plugins are loaded by the host through `LoadLibraryW`. The controller uses the existing MIT-licensed manual mapper; Backdrop Blur Fix retains its separate controller.

Two anonymous pipes carry JSON messages. Their handles are duplicated into the target before starting the host worker, so opening an IPC endpoint does not depend on sandbox file-access permissions. The controller forwards between the host pipes and its own standard streams. Messages are limited to one MiB.

Each entry-point instance has a host worker and controller connection. Commands are serialized on that worker. Plugin log calls and setting reads/writes can originate on other threads; output and the settings snapshot have separate locks. The host frees returned string values through its own allocator.

Disabling keeps the controller connection and mapped images resident. Removing a plugin closes its connection after stopping it. Disconnecting IPC also asks the host to stop before releasing its context. Images remain resident until the target process exits. If a callback hangs, the manager reports a timeout; it does not terminate the target thread or unload its code.

The controller and host support Windows x64. Controller mapping code is C++ because the vendored mapper uses C++; the host and controller logic are C.
