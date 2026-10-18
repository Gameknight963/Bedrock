# Desktop C# plugins

Desktop plugins run inside Discord's main process. Bedrock starts one shared .NET runtime when the first desktop plugin is enabled. The .NET 10 Windows Desktop Runtime (x64) must be installed; a missing runtime appears as a plugin loading error.

## Package and project

Declare a main entry point in `plugin.json`:

```json
{
  "manifestVersion": 3,
  "id": "example.desktop",
  "name": "Desktop example",
  "version": "1.0.0",
  "entrypoints": {
    "main": { "runtime": "dotnet", "path": "Example.dll" }
  }
}
```

Build a `net10.0-windows` class library referencing [Bedrock.Desktop.csproj](Bedrock.Desktop.csproj) with `Private="false"`. Set `UseWindowsForms` to `true` when using WinForms. Package dependency assemblies beside the entry DLL; include the generated `.deps.json` when present. Bedrock supplies `Bedrock.Desktop.dll`.

Declare `[assembly: BedrockPlugin(typeof(ExamplePlugin), RequiresApi = "1.0.0")]`. Bedrock reads the entry attribute from metadata before loading plugin code. Desktop API 1.0.0 accepts requirements in the same major version that are no newer than the host.

## Lifecycle

Derive from `Bedrock.Plugin`. Override `Start(PluginContext)`, `Stop()` and `Unload(PluginUnloadContext)`, or their asynchronous counterparts.

- Enabling creates a fresh instance. The assembly remains loaded across disable/re-enable.
- Disabling cancels `context.CancellationToken`, removes Bedrock event subscriptions, waits for event handlers and calls stop. Release windows, timers and native resources in stop.
- Removing or replacing calls unload on each instance created during the session, including disabled instances. Its context provides logging and `RequireRestart(reason)`.
- Each package has a collectible assembly load context. Managed assemblies are read into memory, allowing their files to be replaced. Assembly unloading is cooperative: remaining references, callbacks and threads can keep code alive. Plugins must release them before returning from unload.
- Plugin lifecycle and event handlers run on managed worker threads. The desktop runtime remains loaded until Discord exits.

## Settings, events and UI

- Declare `Setting<T>` definitions through `Plugin.Settings`. `context.Settings.GetAsync(setting)` and `SetAsync(setting, value)` use Bedrock's existing settings storage and validation.
- `context.Subscribe(name, callback)` returns an `IDisposable` subscription. Both synchronous and asynchronous callbacks are supported. Events are processed in order per subscription. Settings events identify the affected plugin and contain `key`, `value` or `deleted` in their JSON value.
- `context.EmitAsync(name, value)` sends a serializable plugin event.
- `context.Log.Info`, `Warning` and `Error` write to Bedrock's log feed. `ReportStatusAsync(message)` displays initialization progress. `RequireRestart(reason)` adds a restart notice.
- `context.InvokeUIAsync(action)` runs on Bedrock's shared STA thread and WinForms message loop. Use it to create, update and dispose WinForms controls. It remains available during stop so UI resources can be disposed after cancellation. Check cancellation before applying late activation work.
- `context.Windows.GetAllAsync()` returns Discord window IDs and native handles. `ExecuteJavaScriptAsync(windowId, source)` executes renderer JavaScript and returns a JSON-serializable result. It does not expose browser `JSImport` or `JSExport` bindings.

The [desktop example](../../Examples/dotnet-desktop/ExamplePlugin.cs) demonstrates settings, events, UI dispatch and lifecycle. Build the launcher and the example in Debug, then run `node Managed/tests/desktop-fixture.cjs` with `BEDROCK_TEST_RUNTIME` set to the built Runtime directory. The same fixture can run under stock Electron. It uses an isolated plugin directory and does not launch Discord.
