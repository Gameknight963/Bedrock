# Bedrock

VERY wip.

NOTHING permanant is changed, ever. NO files in Discord's installation are modified, 
NO environment variables are modified, NO registry settings are changed. 

The only thing that technically falls under this list is the data folder %LOCALAPPDATA%.

## Get started

Build `Launcher.vcxproj` (C17, Visual Studio v145).

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

The project build copies the runtime and bundled plugins beside the executable.
Keep `Runtime` and `BedrockData` with the launcher when moving it. Plugins live in
`BedrockData\plugins`. Persisted data is stored in the sibling `data`
folder. In Discord settings, **Bedrock → Plugins** provides live enable switches,
search and README details. See [the API documentation](../Runtime/README.md) and
[the example package](../Examples/example/plugin.json).

### What file does what

 - `main.c` owns process creation and the fuse patch
 - `shutdown.c` closes existing instances before launching.
 - `fuse.c` validates the Electron fuse wire and is shared with the native tests.
 - `inspector.c` owns discovery, the WebSocket connection, JSON commands/replies, and shutdown. 
 - WinHTTP handles the handshake and WebSocket framing. 
 - The MIT-licensed jsmn parser is licensed under `lib/jsmn` 
   (at commit `25647e692c7906b96ffd2b05ca54c097948e879c`, latest commit at the time of writing)

Other options:

```powershell
.\Launcher\bin\x64\Debug\BedrockLauncher.exe --check
.\Launcher\bin\x64\Debug\BedrockLauncher.exe --exe 'C:\path\Discord.exe' --port 9230
```

`--check` reads the executable without launching or patching anything. 

### Additional details

 - The launcher must match the target's x86/x64 architecture. 
 - Unknown fuse formats are rejected. 
 - Failures terminate only the process the launcher created. 

Large buffers use the heap. The manifest enables long paths when Windows policy
also enables them. The image-base lookup uses Windows x86/x64 PEB offsets.

Run the inspector integration test with an installed Node.js and Visual Studio:

```powershell
.\Launcher\tests\smoke.ps1
```

It starts a separate Node fixture, loads a bootstrap before the fixture's entry
script (including a Unicode path), verifies inspector shutdown, checks that Node stays alive, and stops only
that fixture. It does not interact with Discord. Override `-MSBuild` or `-Port`
when needed.
