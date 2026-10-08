# Backdrop Blur

An experimental fix for sharp content bleeding through backdrop blur on transparent backgrounds. It uses rounded coverage and effect opacity independently of the blurred pixels' transparency.

## Enabling

Enable **Native GPU hook** in this plugin's settings and restart Discord through Bedrock. This option is off by default because loading the native DLL requires disabling Chromium's GPU sandbox for the Discord instance. It does not disable renderer sandboxing or change system settings.

The plugin checks for GPU processes once per second and installs the hook when one appears. If the GPU process restarts, it installs the hook in the new process. Disabling the plugin restores the original compositing behavior. Restart afterward to restore the GPU sandbox.

Discord's executable and installation files are never modified. The helper loads our DLL into the GPU process, and MinHook redirects the relevant functions in memory. The DLL and pass-through hooks remain resident when disabled so rendering threads can finish safely; exiting the process removes them.

## Current limitations

- Windows x64 only. The function signatures and structure offsets were identified from Electron 42.11.8. If signatures or function boundaries do not match, no hooks are installed.
- The experiment covers plain backdrop-filter layers using normal source-over blending. Combined forward filters, image masks and BSP draw regions retain Chromium's original behavior.
- The rounded clip also constrains content in the same layer. Effects whose foreground content extends outside their backdrop shape need further work.
- This is experimental rendering behavior, rather than an implementation of the CSS backdrop-filter specification. More themes and compositing cases need visual testing.

## Implementation

Skia applies the layer's opacity to its source pixels. The hook uses an arithmetic blender that adds those pixels to the original backdrop multiplied by `1 - opacity`. An antialiased clip supplies the rounded coverage at restore, independently of source alpha. At full opacity the filtered result replaces the original; at zero opacity the original remains.

Chromium's internal clearing of pixels outside the backdrop shape is skipped for these layers, since the outer clip already represents that boundary. Other layers and unsupported combinations use the original functions.
