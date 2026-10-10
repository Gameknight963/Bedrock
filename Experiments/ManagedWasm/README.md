# Shared C# WebAssembly runtime experiment

This tests whether independently built C# plugins can share a browser-hosted .NET runtime and use its JavaScript interop. It is a standalone experiment, not a Bedrock plugin loader.

## What worked

The host is published first, with no plugin references. Two plugin DLLs are then built separately and downloaded after the runtime starts. The validation script hashes the published host before and after building the plugins to confirm that it stays unchanged.

Both assemblies load through `AssemblyLoadContext.Default.LoadFromStream()`. JavaScript obtains their generated bindings through `runtime.getAssemblyExports(assemblyName)`.

The fixture verifies:

- Two plugin assemblies share one runtime, with one native WASM runtime download.
- `[JSExport]` methods call `[JSImport]` functions and return their results.
- Async imports and exports complete normally.
- C# updates the page through an imported JavaScript function.
- `JSObject` preserves a JavaScript object's identity and permits property access.
- The two assemblies retain separate static state, even though they contain identically named classes.

Each plugin ships an ordinary managed DLL. The WASM runtime and framework assemblies belong to the host; no runtime is bundled with either plugin.

## Loading detail

`Assembly.Load(byte[])` loaded the plugin, but the subsequent `getAssemblyExports()` call crashed with a WASM memory access error in this test. Using the default assembly load context passed. This establishes a working loading path; it does not establish why the other path crashes.

## Run

Requires the .NET 10 SDK and a stock Electron executable. The projects disable native rebuilding and trimming, so this test does not require the `wasm-tools` workload.

```powershell
.\Experiments\ManagedWasm\validate.ps1 -ElectronPath 'path\to\electron.exe'
```

The fixture starts a hidden, sandboxed renderer, serves files on an ephemeral loopback port and uses a separate temporary browser profile. Results are written to `obj/results.json`. It does not open Discord's profile or change Discord's files.

## Findings and limits

Tested with .NET SDK 10.0.400, browser runtime 10.0.11 and Electron 42.11.10.

- The plugin DLL was 11.5 KiB.
- The shared runtime's WASM linear memory was about 46 MiB before and after loading both plugins. This is a memory buffer size, not total renderer memory usage.
- Managed allocations reported by `GC.GetTotalMemory(false)` were about 4 MiB and are part of the runtime's memory, not an additional footprint to add to the buffer size.
- The untrimmed host's framework files occupied about 25 MiB, excluding compressed copies and source maps. These measurements describe this small fixture, not a production budget.

This uses managed plugin assemblies with the runtime's interpreter/JITerpreter. Independently compiled AOT WASM plugins are a different problem: .NET's normal AOT build links compiled code into the host's `dotnet.native.wasm`. Trimming also needs care because the host cannot predict which framework members future plugins will use. See [.NET's runtime documentation](https://github.com/dotnet/runtime/blob/v10.0.0/src/mono/wasm/features.md#AOT).

Plugin dependency resolution, assembly unloading and integration with Bedrock's lifecycle remain outside this experiment. The result validates sharing a runtime and using the existing interop bindings.
