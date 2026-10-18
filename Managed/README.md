# C# plugins

Bedrock supports two managed execution environments:

- `dotnet`: desktop .NET 10 in Discord's main process, with WinForms and WinAPI access. See [desktop plugins](Desktop/README.md).
- `dotnet-wasm`: a shared .NET 10 WebAssembly runtime in the renderer, with browser JavaScript interop. See [WebAssembly plugins](Wasm.md).

Both use manifest version 3 and an assembly-level `BedrockPlugin` attribute to identify the entry class and required API. A package can combine a managed main entry point with a JavaScript renderer entry point.

Desktop and WebAssembly plugins reference their respective API assemblies. Their runtime versions and Bedrock API requirements are separate.
