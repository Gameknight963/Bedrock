# Native backdrop blur experiment

Build `Launcher/Launcher.vcxproj` for x64. The build produces `backdrop-blur-fix.dll` and copies it and its notices into the Backdrop Blur Fix plugin. The DLL is written in C and statically links MinHook. It exports the [Bedrock C plugin API](../../include/README.md), with a GPU entrypoint declared in its manifest.

## Lifecycle and diagnostics

Bedrock's shared native host loads the DLL into each GPU process and provides settings, logging and lifecycle callbacks. The `allowGpuInjection` setting controls whether the rendering fix is active. Starting with it enabled installs the hooks; changing it updates their behavior. Stopping disables replacement compositing. Re-enabling reuses the DLL and trampolines, and a replacement GPU process receives a fresh instance with saved settings.

Signature failures identify the affected function and whether its signature is missing, ambiguous, lacks unwind information, lies inside another function, or has an unexpected function size. Installation failures identify the TLS or MinHook operation that failed. Diagnostics are sent through Bedrock's logging API.

## Sandbox investigation

A stock Electron 42.11.8 GPU process with its sandbox enabled rejected both `GetFileAttributesW` on the hook DLL and `LoadLibraryW` with error 5 (access denied). Moving the DLL beside the isolated Electron executable did not make loading succeed. This establishes a file-access restriction on the tested path; it does not identify every subsequent loader restriction.

The process also had Microsoft-only binary signature policy enabled, low integrity, and dynamic-code prohibition disabled. A small remote diagnostic stub was allocated, made executable and successfully run while the sandbox remained enabled. Thus remote-thread execution itself was not the blocked operation.

The shared native controller reads the DLL and uses [Simple Manual Map Injector](https://github.com/TheCruZ/Simple-Manual-Map-Injector/tree/c28a45e6ceee9acb1cf25cfeee9bdd707c6a78ea) to supply its bytes without the GPU process opening that file. The isolated rendering fixture passes with the sandbox enabled. Imports, relocations and unwind tables are initialized; headers and sections are retained and receive their normal protections.

The hook uses `TlsAlloc`, `TlsGetValue` and `TlsSetValue` rather than compiler-managed TLS. It has no C runtime dependency: a small memory helper supplies MinHook's copy/fill operations, and its entry point needs no runtime initialization. This avoids the static CRT's TLS requirements. The mapper's copied loader routine is compiled without stack-cookie instrumentation, and the shared controller disables incremental linking so the routine's address is not a linker jump stub. These settings are limited to the code that requires them.

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
& 'path/to/fixture/Discord.exe' "$PWD/Native/BackdropBlurFix/tests/fixture.cjs" "$PWD/Native/BackdropBlurFix/obj/fixture"
```

The fixture defaults to the Release package; set `BEDROCK_TEST_CONFIGURATION=Debug` to test Debug. The fixture uses its own profile and synthetic page. It verifies rounded corners, full/half/zero opacity, GPU process replacement, re-enabling the existing mapped DLL, and restoring the original image when the plugin stops. Captures are written under the supplied output directory. It does not open Discord or access its profile.

The source reference is [Chromium 148's Skia renderer](https://github.com/chromium/chromium/blob/148.0.7778.0/components/viz/service/display/skia_renderer.cc), with [matching Skia](https://github.com/google/skia/tree/2085e414ce371c7f4ef5c86be341ef5428ac535b). Keep the included Chromium, Skia, MinHook notices with distributed plugin binaries; the shared host carries its manual mapper notice.
