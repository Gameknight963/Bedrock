# Launcher experiment

Build `Launcher.vcxproj` (C17, Visual Studio v145). Quit Discord before running:

```powershell
.\Launcher\bin\x64\Debug\BedrockLauncher.exe
```

The launcher locates Discord, starts it suspended, enables only the inspector
fuse in memory, and resumes the initial thread. It discovers the Node inspector
through `/json/list`, upgrades a GET request to a WebSocket, enables the debugger,
and releases the initial debugger wait. Node then pauses at its JavaScript entry
point, before the application script executes.

The launcher evaluates `({value: 1 + 2, pid: process.pid})` on the paused frame.
It requires the value `3` and the PID of its own child. It then schedules Node's
`inspector.close()` with `setImmediate`, resumes JavaScript, disconnects, and
checks that the local debugger port refuses new connections. No browser debugger
is needed. This is a fixed execution test, not yet a plugin bootstrap loader.

`main.c` owns process creation and the fuse patch. `inspector.c` owns discovery,
the WebSocket connection, JSON commands/replies, and shutdown. WinHTTP handles
the handshake and WebSocket framing. The MIT-licensed jsmn parser is vendored
under `lib/jsmn` at commit `25647e692c7906b96ffd2b05ca54c097948e879c`.

Other options:

```powershell
.\Launcher\bin\x64\Debug\BedrockLauncher.exe --check
.\Launcher\bin\x64\Debug\BedrockLauncher.exe --exe 'C:\path\Discord.exe' --port 9230
```

`--check` reads the executable without launching or patching anything. The
launcher must match the target's x86/x64 architecture. Unknown fuse formats are
rejected. Failures terminate only the process the launcher created. No files in
Discord's installation are modified and no environment variables or registry
settings are changed. Discord may write its usual user data after startup.

Large buffers use the heap. The manifest enables long paths when Windows policy
also enables them. The image-base lookup uses Windows x86/x64 PEB offsets.

Run the inspector integration test with an installed Node.js and Visual Studio:

```powershell
.\Launcher\tests\smoke.ps1
```

It starts a separate Node fixture, executes JavaScript before the fixture's entry
script, verifies inspector shutdown, checks that Node stays alive, and stops only
that fixture. It does not interact with Discord. Override `-MSBuild` or `-Port`
when needed.
