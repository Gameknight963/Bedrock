# Native backdrop blur experiment

Build `Launcher/Launcher.vcxproj` for x64. The build produces `blur-controller.exe` and `blur-hook.dll`, then copies them and their notices into the Backdrop Blur plugin. The controller is written in C and the DLL statically links MinHook.

## Controller

The plugin supplies a GPU PID obtained from Electron's `app.getAppMetrics()`. For manual testing:

```text
blur-controller.exe --pid PID
blur-controller.exe --pid PID --restore
blur-controller.exe --pid PID --status
```

Without `--pid`, the controller looks for a unique Discord GPU process. It checks the process name, command line and x64 architecture before loading the adjacent DLL. A different DLL path can be supplied with `--dll` using an absolute path. It changes process memory only.

The GPU sandbox blocked DLL loading in the stock Electron fixture. The plugin has an explicit, disabled-by-default setting to disable that sandbox before startup. Do not expect manual injection to work in a sandboxed GPU process.

The plugin logs native counters shortly after installation. `--status` reads the counters without changing the hook: `calls` counts intercepted layers, `backdrop` counts those with backdrop filters, and `replaced` counts actual blender replacements. The `bypass` counter counts optimized render-pass geometry, which is supported when there is no split draw region. Other counters show why layers were skipped; several reasons can apply to one layer. Counters contain no page contents.

## Rendering

The hook searches executable code for six functions from Electron 42.11.8. Address-dependent operands are masked; each match must be unique and agree with PE unwind function boundaries. No fixed load address is assumed. An unmatched build is rejected.

The verified function signatures also guard the ABI assumptions: renderer canvas at offset `0x408`, backdrop shape and bounds in the render-pass parameters, paint blender at `0x28`, and blend-mode call at `PrepareCanvasForRPDQ + 0xaa`. These assumptions need revisiting when Electron changes; a signature match is not a promise of compatibility with every Discord build.

For supported backdrop layers, the DLL clips to their visible bounds and rounded shape, then replaces source-over with Skia's arithmetic blender:

```text
result = source + destination * (1 - effect opacity)
```

Skia has already multiplied source pixels by layer opacity. The rounded clip supplies coverage. Chromium's later clearing operation is skipped for this layer to avoid applying rounded coverage twice. At full opacity this replaces the backdrop; at zero opacity it retains it.

Layers with combined filters, shader masks or split draw regions use the original implementation. Foreground content extending outside the backdrop shape remains a limitation of clipping the whole layer.

Disabling switches the hooks to pass-through behavior. The DLL and trampolines stay loaded so rendering threads already executing them can return safely. A process restart releases them.

## Isolated test

Use a stock Electron 42.11.8 Windows x64 distribution in a scratch directory, with a copy of `electron.exe` named `Discord.exe` there. Build the Release x64 launcher first, then run from the repository root:

```powershell
& 'path/to/fixture/Discord.exe' --disable-gpu-sandbox "$PWD/Native/BackdropBlur/tests/fixture.cjs" "$PWD/Native/BackdropBlur/obj/fixture"
```

The fixture defaults to the Release package; set `BEDROCK_TEST_CONFIGURATION=Debug` to test Debug. The fixture uses its own profile and synthetic page. It verifies rounded corners, full/half/zero opacity, GPU process replacement, and restoring the original image when the plugin stops. Captures are written under the supplied output directory. It does not open Discord or access its profile.

The source reference is [Chromium 148's Skia renderer](https://github.com/chromium/chromium/blob/148.0.7778.0/components/viz/service/display/skia_renderer.cc), with [matching Skia](https://github.com/google/skia/tree/2085e414ce371c7f4ef5c86be341ef5428ac535b). Keep the included Chromium, Skia and MinHook notices with distributed binaries.
