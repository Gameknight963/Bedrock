# Bedrock MCP server

A C# console application using the official MCP SDK. It runs separately from
Discord and communicates with an MCP client over standard input and output.
Logs go to standard error.

## Build and run

Requires the .NET 10 SDK to build:

```powershell
dotnet build MCP/Bedrock.Mcp.csproj
```

Configure your MCP client to launch `dotnet` with these arguments, replacing
the DLL path with the absolute path on your machine:

```text
C:\path\to\Bedrock\MCP\bin\Debug\net10.0\Bedrock.Mcp.dll
```

The built executable can also be launched directly. It requires the .NET 10
runtime. Running it in a terminal waits for MCP requests; it has no interactive
console menu.

## Connect to Discord

Copy `Plugins/developer-tools` into `%LOCALAPPDATA%\Bedrock\plugins` and choose
**Load missing plugins**. The plugin can be enabled and disabled without a restart.
It has both main and renderer entrypoints; the main entrypoint hosts the named pipe.

Start the MCP executable through your MCP client, then call `status`. It lists
connected process IDs and window IDs. Tools automatically choose the only
available instance and web window; otherwise, pass the IDs explicitly.

## Tools

- `status`: list connected development plugins and their windows.
- `inspect_element`: inspect a CSS selector, including classes, attributes,
  text, bounds, ancestor chain, and selection styles.
- `get_styles`: read computed properties and matching stylesheet declarations
  on an element and its ancestors. Inaccessible stylesheets and truncated
  results are reported. These are matching declarations, not a complete CSS
  cascade explanation.
- `screenshot`: return a PNG image of the selected window.

The tools inspect the UI without changing it. Arbitrary JavaScript evaluation
is not exposed. Requests time out after ten seconds; disabling MCP Bridge
closes its pipe and removes the renderer inspector.

## Test

```powershell
.\Runtime\tests\electron-smoke.ps1 -WithMcp
```

This builds the server and loads the real plugin in an isolated Electron app.
It checks MCP initialization, tool discovery, DOM and CSS inspection, screenshots,
invalid selectors, and plugin cleanup. It does not start or close Discord.
