# Backdrop blur experiment

## Purpose

On a transparent background, CSS backdrop blur can leave sharp content visible underneath the blurred result. This experiment tests whether that bleeding comes from drawing the blurred result over the original pixels instead of replacing them.

Skia is Chromium's graphics library. `SrcOver` draws new pixels over existing pixels, allowing the existing content to show through wherever the new pixels are transparent. `Src` replaces the existing pixels, including their alpha. For a transparent blur, that difference determines whether the sharp original remains underneath.

## Running the comparison

Run `dotnet run --project Experiments/BackdropBlur`. Requires the .NET 10 SDK; NuGet supplies SkiaSharp and its native Skia library.

The program draws white text and shapes on a transparent surface, then uses a Skia backdrop layer to blur them. It compares the original with the same filtered layer restored using `SrcOver` (draw over existing pixels) or `Src` (replace existing pixels).

PNG files are written under the executable's `images` folder in `bin`. `comparison.png` shows all three over a checkerboard. The individual images retain transparency. The console also prints the alpha at a pixel inside the original white bar.

The comparison program isolates the blend operation. It does not reproduce Chromium's GPU rendering, CSS opacity, masks, rounded corners, or nested filters, and does not modify Discord.

## Findings

![generated comparison image](comparison.png)

A perfect replicatation of the bleeding effect you see when using backdrop blur over a transparent background.

In this experiment, `SrcOver` leaves the sharp original visible under the blur. `Src` removes that sharp copy while retaining the blurred result's transparency. At the original bar's center, alpha is 255 with `SrcOver` and 121 with `Src`.

We also tested the change in Discord's actual GPU process:

- Official Electron 42.11.8 symbols identified `viz::SkiaRenderer::PrepareCanvasForRPDQ`, a 428-byte function that selects `SrcOver` when a backdrop filter is present.
- We extracted the function from stock Electron and searched Discord's executable, ignoring address-dependent instruction operands. There was exactly one match, with 373 fixed bytes matching. Discord's PE unwind metadata confirmed the same function boundary and length.
- We verified all 428 bytes in the running GPU process, then changed one byte in the blend-mode argument from `3` (`SrcOver`) to `1` (`Src`). The original memory protection was restored afterward.
- The bleeding disappeared in initial visual testing. Further testing found incorrect rendering around rounded corners and other affected elements, so changing the blend mode alone is not a complete fix.

Chromium first restricts the backdrop layer to rectangular bounds. After capturing the filtered backdrop, `ClearOutsideBackdropBounds` clears pixels outside the actual backdrop shape to transparent. `SrcOver` preserves the destination under those cleared pixels; `Src` replaces it with transparency instead. This explains why removing the bleeding also breaks rounded corners. The layer also carries opacity and other filter effects, which need separate investigation before treating the patch as generally usable.

Chromium explicitly selects this blend mode in [PrepareCanvasForRPDQ](https://github.com/chromium/chromium/blob/148.0.7778.0/components/viz/service/display/skia_renderer.cc). Source-over compositing is also prescribed by the [CSS backdrop-filter specification](https://drafts.csswg.org/filter-effects-2/#backdrop-filter-operation), so this experiment deliberately changes that behavior.
