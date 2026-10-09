# Backdrop Blur Fix

Prevents sharp content from showing through backdrop blur on transparent backgrounds. For example, text behind a blurred popout should appear blurred rather than remain readable underneath a transparent copy of the effect.

## Using the plugin

Enable **Native GPU hook** in the Settings tab. Turning the option or the plugin on and off changes rendering without a restart.

Use it with a transparent window and a theme that uses CSS `backdrop-filter`. Window transparency is configured through [Window Customization](../window-customization/README.md). You'll need a custom theme to control which elements are transparent and where a blur appears.

## Why the bleeding happens

Chromium uses Skia, a graphics library, to draw Discord's interface. For a backdrop-filtered element, Chromium captures the content behind it, applies the filter, and places the result in a layer. It then draws the element's own content and combines that layer with the existing image.

The combination uses **source-over** (`SrcOver`), the usual way of drawing transparent pixels over other pixels. The new image contributes according to its alpha, while the existing image remains visible wherever the new image is transparent.

Blur spreads both color and alpha. Blurring opaque text on a transparent background produces partially transparent pixels around and inside the text. Drawing that result over the original leaves some of the original sharp text visible beneath it. The blur has been calculated perfectly as intended, but the sharp copy survives the final combination.

This plugin changes that combination so the filtered result replaces the original backdrop within the affected area. This deliberately changes Chromium's backdrop-filter behavior rather than implementing the CSS specification's source-over compositing rule. In practice however, it's almost always if not always the same (except on transparent backgrounds lol.)

## Rounded corners

Simply switching to **source** (`Src`), which fully replaces the destination including its alpha, is pretty easy, and kind of solves the problem.

Chromium **already calls a function to choose the blend mode** in `SkiaRenderer::PrepareCanvasForRPDQ`, at exactly the point we need:

```cpp
layer_paint.setBlendMode(SkBlendMode::kSrcOver);
```

[See that line in Chromium's source](<https://github.com/chromium/chromium/blob/148.0.7778.0/components/viz/service/display/skia_renderer.cc#L1637>)

The Discord executable has it compiled to these instructions:

```asm
084DA21B  lea  rcx, [rsp+70h]
084DA220  mov  edx, 3
084DA225  call 01ECFF30
```
 > _Note: Offsets may be innacurate._

`rcx` holds the paint object’s address, and `edx` holds the blend-mode argument. `SkBlendMode::kSrcOver` is 3 and `SkBlendMode::kSrc` is 1. So replacing the blend mode is just changing a single byte (since the upper bytes are empty either way). Easy right?

The problem is this isn't enough.

Chromium creates a rectangular layer, then clears pixels outside the actual backdrop shape. With source-over, those cleared pixels preserve the original image underneath. With source replacement, they erase it. A rounded popout could therefore erase content in the corners of its rectangular bounds, even though that content lies outside the popout.

The solution is to clip the replacement to the backdrop's visible bounds and rounded shape before Chromium creates the layer. This isn't just patching a byte, so we need an actual hook, which means need an actual DLL injected... we'll come back to that. 

An antialiased clip provides partial coverage along the edges, so the transition follows the rounded boundary. Chromium's later clearing operation is skipped for that layer because the clip already supplies the boundary,since applying both would apply rounded coverage twice.

## Opacity

The transparency of the blurred pixels and the opacity of the effect have different jobs:

- **Blurred pixel alpha** describes the filtered image, including transparent spaces between blurred content.
- **Effect opacity** controls how much of that filtered image replaces the original.

At full effect opacity, transparent pixels in the filtered result must replace the corresponding original pixels. At zero effect opacity, the original must remain unchanged. Using source replacement alone would erase the original even when the effect has faded out.

Conceptually, the replacement is:

```text
result = original * (1 - coverage * opacity)
       + filtered result * coverage * opacity
```

The calculation applies to premultiplied color and alpha: the color channels already include their pixel's alpha. Rounded coverage comes from the clip, independently of the filtered image's transparency.

The implementation uses Skia's arithmetic blender. Skia has already multiplied the layer's source pixels by effect opacity, so the blender computes:

```text
result = source + original * (1 - opacity)
```

The clip limits where that combination applies. At half opacity, some sharp content intentionally returns because the effect is fading back toward the original.

## Hooking Chromium

The implementation was developed against Electron 42.11.8 and its Chromium/Skia code. The main hook intercepts `viz::SkiaRenderer::PrepareCanvasForRPDQ`, where Chromium prepares a render-pass layer and chooses its blend mode. Additional hooks replace that layer's blender and suppress its clearing operation. Other paint calls retain their original behavior.

Functions are located by matching machine-code signatures in the running executable. Address-dependent instruction operands are ignored, and every match must be unique and agree with the function boundaries recorded in the executable's PE unwind information. The code also relies on structure offsets identified from that build.

This avoids depending on a fixed load address, but it is still version-sensitive. If the signatures or function boundaries do not match, the plugin refuses to install the hooks. Matching signatures do not guarantee that every future Electron build has compatible internal layouts.

The source reference is [Chromium's Skia renderer](https://github.com/chromium/chromium/blob/148.0.7778.0/components/viz/service/display/skia_renderer.cc), with [the matching Skia revision](https://github.com/google/skia/tree/2085e414ce371c7f4ef5c86be341ef5428ac535b).

## Loading and disabling

The JavaScript plugin finds GPU processes through Electron and passes their identity to a native controller. The controller manually maps the hook DLL: it reads the file itself, copies its sections into the GPU process, resolves imports and relocations, registers unwind information, and initializes it. This allows the hook to run with Chromium's GPU sandbox enabled. Discord's executable and installation files are never modified.

The DLL uses MinHook to redirect the functions in memory. It uses Windows TLS slots to keep each rendering thread's active layer separate from other threads.

The plugin retains the mapped address alongside the GPU process's PID and creation time. It maps once per GPU process; disabling switches the hooks to their original behavior, and re-enabling reuses the mapping. The DLL and trampolines remain in memory so threads already executing a hook can finish safely. Exiting the GPU process releases that memory.

If Electron restarts the GPU process, the plugin detects its replacement and installs a new mapping. Technical build and controller details are in [the native README](../../Native/BackdropBlur/README.md).

## Current limitations

- **Platform:** x64 only. (Windows)
- **Filter combinations:** layers with forward image/color filters, image masks, non-source-over blend modes, or split draw regions retain Chromium's original behavior. Ordinary bypassed render passes are supported; these are Chromium's optimization for drawing content without a separate render-pass buffer.
- **Foreground bounds:** the rounded clip constrains the whole layer, including foreground content. Content or effects meant to extend outside the backdrop shape may be clipped.
- **Compatibility:** internal function signatures and layouts can change with Electron updates. More themes and compositing cases need visual testing