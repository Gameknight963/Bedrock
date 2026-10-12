> todo: logo / slop banner up here

# Bedrock

NOTHING permanant is changed, ever. NO files in Discord's installation are modified, 
NO environment variables are modified, and NO registry settings are changed. 

[Take that, Equicord.](https://github.com/Equicord/Equilotl/issues/21)

## Install

 - Get the latest release from [Releases](https://github.com/bedrock-client/Bedrock/releases).
 - Extract the ZIP to a writable folder and run `BedrockLauncher.exe`. 
 - Keep the adjacent `Runtime` folder with it. 
 - Bedrock creates `BedrockData` beside the launcher, don't delete that either.

## Bugs

[Report an issue](https://github.com/bedrock-client/Bedrock/issues) asap, thank you!

## Build

Build `Launcher.vcxproj` (C17, Visual Studio v145, .NET 10 SDK, Node.js and npm).
The build packages the JavaScript loaders and converters -  users running a built launcher do not need Node.js installed.

### How it works

The launcher first closes processes using the selected Discord executable in your
Windows session. Existing Bedrock instances receive a graceful quit request over
a local named pipe, with a two-second timeout. If the bootstrap cannot be reached
or Discord stays running, the launcher terminates the matching processes.
`--check` remains read-only and leaves running instances alone.

The launcher then starts Discord suspended. It enables the inspector
fuse in memory, and resumes the initial thread. 

Then it discovers the Node inspector through `/json/list`, enables the debugger,
and releases the initial debugger wait. Node then pauses at its JavaScript entry
point for us, before the application script executes.

The launcher evaluates `({value: 1 + 2, pid: process.pid})` on the paused frame.
(1 + 2 is Super Necessary.) It requires the value is `3` and the PID is of its own child. 
It loads the adjacent `Runtime/bootstrap.cjs` through Node's module loader, 
installing Bedrock before Discord's entry point executes. It then schedules Node's
`inspector.close()` with `setImmediate`, resumes JavaScript, disconnects, and
checks that the local debugger port refuses new connections. The installed bootstrap 
hosts plugins after that port closes.

The project build copies the runtime beside the executable. Plugins are packaged separately in [bedrock-plugins](https://github.com/bedrock-client/bedrock-plugins); a fresh build does not include plugins.
Keep `Runtime` and `BedrockData` with the launcher when moving it. Plugins live in
`BedrockData\plugins`. Persisted data is stored in the sibling `data`
folder. In Discord settings, **Bedrock → Plugins** provides live enable switches,
search and README details. See [the API documentation](Runtime/README.md) and
[the example package](Examples/example/plugin.json).

Other options:

```powershell
.\Launcher\bin\x64\Debug\BedrockLauncher.exe --check
.\Launcher\bin\x64\Debug\BedrockLauncher.exe --exe 'C:\path\Discord.exe' --port 9230
```

`--skip-plugins` launches Bedrock without automatically starting plugins. Open the plugin manager to disable a suspected plugin or enable plugins individually. Saved enable states are unchanged until you toggle a plugin. Launch normally to restore automatic startup.

`--check` reads the executable without launching or patching anything. 

### Additional details

 - The launcher supports x64 Discord executables.
 - Unknown fuse formats are rejected. 
 - Failures terminate only the process the launcher created. 

Large buffers use the heap. The manifest enables long paths when Windows policy
also enables them. The image-base lookup uses Windows x64 PEB offsets.

Native unit tests use Google Test. Build `BedrockTests` in the solution, then run
them from **Test → Test Explorer** or with `Tests\bin\x64\Debug\BedrockTests.exe`.
See [the test README](Tests/README.md) for details.

Run the inspector integration test with an installed Node.js and Visual Studio:

```powershell
.\Launcher\tests\smoke.ps1
```

It starts a separate Node fixture, loads a bootstrap before the fixture's entry
script (including a Unicode path), verifies inspector shutdown, checks that Node stays alive, and stops only
that fixture. It does not interact with Discord. Override `-MSBuild` or `-Port`
when needed.

### Licensing

Bedrock uses the [MIT license](LICENSE). Dependency licenses and attributions
are collected in [third-party notices](third_party_notices.md).