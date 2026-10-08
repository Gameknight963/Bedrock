# Backdrop blur experiment

Run `dotnet run --project Experiments/BackdropBlur`. Requires the .NET 10 SDK; NuGet supplies SkiaSharp and its native Skia library.

The program draws white text and shapes on a transparent surface, then uses a Skia backdrop layer to blur them. It compares the original with the same filtered layer restored using `SrcOver` (draw over existing pixels) or `Src` (replace existing pixels).

PNG files are written under the executable's `images` folder in `bin`. `comparison.png` shows all three over a checkerboard. The individual images retain transparency. The console also prints the alpha at a pixel inside the original white bar.

This isolates the blend operation. It does not reproduce Chromium's GPU rendering, CSS opacity, masks, rounded corners, or nested filters, and does not modify Discord.

In this experiment, `SrcOver` leaves the sharp original visible under the blur. `Src` removes that sharp copy while retaining the blurred result's transparency. At the original bar's center, alpha is 255 with `SrcOver` and 121 with `Src`.
