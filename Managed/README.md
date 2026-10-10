# C# plugins

C# plugins run in the renderer through a shared .NET 10 WebAssembly runtime. Bedrock starts it when the first managed plugin is enabled. Plugins are ordinary managed assemblies; they do not include their own runtime.

## Package

A plugin folder contains `plugin.json`, its assembly, and any JavaScript modules or README it uses:

```json
{
  "manifestVersion": 2,
  "id": "example.managed",
  "name": "Managed example",
  "version": "1.0.0",
  "entrypoints": {
    "renderer": { "runtime": "dotnet", "path": "Example.dll" }
  }
}
```

Declare the entry type in the assembly:

```csharp
[assembly: BedrockPlugin(typeof(ExamplePlugin), RequiresApi = "1.0.0")]
```

Bedrock reads the attribute from assembly metadata before loading the assembly or constructing the plugin. The required API must have the same major version and cannot be newer than the host API, currently `1.0.0`.

## Project

Use an ordinary `Microsoft.NET.Sdk` class library targeting `net10.0`, with `AllowUnsafeBlocks` enabled for generated JavaScript bindings. Reference `Managed/Bedrock/Bedrock.csproj` with `Private="false"`; the runtime already includes `Bedrock.dll`. The [example project](../Examples/dotnet/ManagedExample.csproj) copies its manifest, README and JavaScript module beside the built DLL.

Building the launcher publishes the shared host into `Runtime/dotnet`. The build needs the .NET 10 SDK and restores its browser runtime pack. The current interpreter build does not require the `wasm-tools` workload. Users running a packaged Bedrock build do not need .NET installed.

## Lifecycle

Derive the entry type from `Bedrock.Plugin`. Override `Start(PluginContext)` and `Stop()`, or their asynchronous counterparts `StartAsync` and `StopAsync`.

- Each enable creates a new plugin instance and context.
- `context.CancellationToken` is cancelled when disabling begins.
- Register managed resources with `context.Cleanup(Action)` or `Cleanup(IDisposable)`.
- Styles and event subscriptions belong to the context and are removed on disable.
- Stop runs after cleanup, with the renderer's ten-second limit. Respect cancellation during asynchronous work.

Assemblies stay loaded until the renderer exits. Disabling stops a plugin; it does not unload its assembly or reset static fields. Updating an assembly requires restarting Discord. All managed plugins share one runtime and assembly namespace. The current loader supports the framework libraries included by the host and a plugin's own DLL; additional managed dependency DLLs are not loaded automatically.

## Settings and status

Declare `Setting<bool>`, `Setting<string>`, `Setting<int>` or `Setting<double>` definitions in the plugin's `Settings` property. Labels, descriptions and `RestartNeeded` appear in the existing settings UI.

- `context.Settings.Get(setting)` reads the persisted value or its default.
- `context.Settings.SetAsync(setting, value)` validates and saves through Bedrock's existing settings owner.
- Subscribe to `settings.changed` to react to edits. Event callbacks receive JSON; renderer settings events contain `id` and `settings`.
- `context.ReportStatus(message)` describes initialization work in the integrated task UI.
- `context.RequireRestart(reason)` supplies the plugin's restart notice.

Logging uses `context.Log.Info`, `Warning` and `Error`.

## JavaScript

Use .NET's `JSImport`, `JSExport` and `JSObject` APIs. `context.ImportModuleAsync(name, relativePath)` imports a module from the plugin folder and registers it under the name used by `JSImport`. JavaScript can import `getPluginExports(id)` from `bedrock://api/dotnet.mjs` to obtain a loaded plugin's generated `JSExport` bindings. Choose a module name unique to your plugin. Imported modules are cached by .NET; re-enabling does not evaluate their top-level code again.

`context.AddStyle(css)` returns a removal action and also registers it for cleanup. `context.Subscribe(name, callback)` owns its event subscription; `EmitAsync(name, value)` sends a serializable event value.

The runtime is a browser sandbox. Managed plugins do not get WinAPI access or Node's main-process APIs. Framework assemblies are currently untrimmed so independently built plugins can use them; the shared runtime and framework therefore add to the renderer's download size and memory use.

## Validation

Publish `Managed/Host/Host.csproj` and build `Examples/dotnet/ManagedExample.csproj` and `Managed/tests/Incompatible/Incompatible.csproj` in Release. Run a stock Electron executable with `Managed/tests/fixture.cjs` as its application path. The fixture uses an isolated profile and checks the real Bedrock protocol, sandboxed renderer, shared runtime loading, API version rejection, JavaScript imports, settings changes, cleanup and re-enable. It does not launch Discord.
