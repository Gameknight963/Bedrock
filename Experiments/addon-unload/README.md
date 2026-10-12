# Unloading a Node addon on Windows

This experiment checks whether a main-thread Node addon can be unloaded and deleted while Electron keeps running. It uses a copy of the Console plugin's compiled addon; it does not touch Discord or installed plugins.

## Results

- Ordinary deletion of the loaded addon fails with EPERM.
- Calling FreeLibrary from a separate probe addon unloads Console, and ordinary deletion then succeeds.
- Reloading the addon and calling its exports succeeds.
- 100 load, call, garbage collection, unload and delete cycles complete, followed by normal Electron shutdown.
- Calling a retained export after unloading crashes the fixture process (exit status 0xC0000409).
- POSIX deletion fails with error 5 for the last hard link. After creating a second link, removing the original succeeds; removing the remaining loaded link still fails.

## Limits

These results apply to the tested Console addon and Electron fixture. Console registers four functions and no addon-specific finalizers or cleanup hooks. The experiment calls hide, filter and write; it does not exercise console allocation through show.

FreeLibrary does not notify Node or invalidate JavaScript exports. Removing require.cache is not proof that exports are unreachable: other modules, closures and Node's bookkeeping may retain references. The successful tests show that immediate unloading is possible for this addon, not that arbitrary addons can be safely unloaded by a generic loader.

## Files

- probe.c supplies the WinAPI operations from a separate addon that stays loaded.
- test.cjs runs each case in Electron's main process.
- run.ps1 launches a separate hidden Electron process for each case.
- runs contains each case's results. The stale-call case deliberately crashes its isolated process.

## Cached acquisitions and disposal

`wrapper.cjs` is an experimental native-addon loader layered on Node's ordinary `require`. It associates an exported object with its resolved filename and an acquisition count. Each wrapped require adds one acquisition; each unrequire releases one. The final release calls `dispose()`, frees the DLL and removes its cache entry and parent-module links. A throwing dispose leaves the acquisition and DLL intact for retry.

`fixture.c` builds a small Node-API addon with an exported native function, a wrapped object finalizer and an environment cleanup hook. Its normal dispose removes both callbacks. Two intentionally broken builds leave one callback registered.

Tested with stock Electron 42.7.1 (embedded Node 24.18.0) and standalone Node 25.9.0:

| Case | Result |
| --- | --- |
| Two cached acquisitions return the same object | Passed |
| Releasing the first acquisition keeps the addon usable | Passed |
| Final release disposes once and permits deletion | Passed |
| Dispose throws; DLL remains usable; release can be retried | Passed |
| Replacing the DLL at the same filename loads the new implementation | Passed |
| 300 two-user load/use/dispose/unload/delete cycles, with GC | Passed |
| Normal Node module loading after unloading | Passed |
| Electron creates a sandboxed window and executes renderer JS afterward | Passed |
| Normal process shutdown after correctly removing native callbacks | Passed |
| Addon already cached by an unwrapped require | Wrapper rejects acquisition |
| Unwrapped require obtains an addon already managed by the wrapper | Its retained export crashes after final managed release |
| Dispose leaves an object finalizer registered | Process crashes during shutdown |
| Dispose leaves an environment cleanup hook registered | Process crashes during shutdown |

The deliberately unsafe cases run in separate processes. A JavaScript exit handler printing success does not prove shutdown succeeded: both callback failures occurred later in native teardown. The runners check the actual process exit status.

### Conclusions

Counting cached acquisitions works for the tested Node-API addon when every acquisition uses the wrapper and native disposal removes all callbacks. A dispose method's name alone does not establish that it does this correctly. The wrapper cannot protect exports held by ordinary require callers, or stale function references retained after their acquisition is released.

This experiment does not unregister Node's internal addon records or destroy each addon's Node-API environment. Those survive until environment teardown. After 300 cycles, memory usage increased by roughly 6 MiB RSS / 0.6 MiB heap in Electron and 2 MiB RSS / 1 MiB heap in Node, varying across runs. These observations do not establish leak-free unloading. They also do not establish compatibility with legacy V8 addons or arbitrary third-party addons.

### Running the additional cases

Build the probe and fixtures with `build.cmd`, then run `run-wrapped.ps1` for Electron or `run-node.ps1` for the installed Node executable. The Electron path uses the existing isolated Bedrock test dependency. Per-case logs are in `runs`; standalone Node results are preserved with a `node-` prefix. No production loader or plugin files are changed.
