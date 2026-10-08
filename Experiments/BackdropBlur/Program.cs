using SkiaSharp;

const int width = 400;
const int height = 240;
string output = Path.Combine(AppContext.BaseDirectory, "images");
Directory.CreateDirectory(output);
using SKTypeface typeface = SKTypeface.FromFamilyName("Segoe UI");
using SKFont font = new(typeface, 32);
using SKPaint ink = new() { Color = SKColors.White, IsAntialias = true };
using SKImageFilter blur = SKImageFilter.CreateBlur(8, 8);
using SKBitmap comparison = new(width * 3, height + 40);
using SKCanvas preview = new(comparison);
preview.Clear(new SKColor(25, 25, 25));
using SKPaint checker = new() { Color = new SKColor(70, 70, 70) };
using SKPaint labels = new() { Color = SKColors.White, IsAntialias = true };
using SKFont labelFont = new(typeface, 20);
string[] names = ["Original", "SrcOver", "Src"];

for (int panel = 0; panel < names.Length; panel++)
{
    using SKBitmap bitmap = new(width, height, SKColorType.Bgra8888, SKAlphaType.Premul);
    using SKCanvas canvas = new(bitmap);
    canvas.Clear(SKColors.Transparent);
    canvas.DrawText("Sharp text behind blur", 20, 55, SKTextAlign.Left, font, ink);
    canvas.DrawRect(60, 100, 10, 80, ink);
    canvas.DrawCircle(270, 140, 35, ink);

    if (panel != 0)
    {
        canvas.Save();
        canvas.ClipRect(new SKRect(0, 0, width, height));
        using SKPaint layer = new() { BlendMode = panel == 1 ? SKBlendMode.SrcOver : SKBlendMode.Src };
        // Capture the existing backdrop into the layer; only its restore blend mode differs.
        canvas.SaveLayer(new SKCanvasSaveLayerRec { Paint = layer, Backdrop = blur });
        canvas.Restore();
        canvas.Restore();
    }

    using SKImage image = SKImage.FromBitmap(bitmap);
    using SKData png = image.Encode(SKEncodedImageFormat.Png, 100);
    File.WriteAllBytes(Path.Combine(output, names[panel] + ".png"), png.ToArray());
    Console.WriteLine($"{names[panel]}: alpha at the original bar = {bitmap.GetPixel(65, 140).Alpha}/255");
    for (int y = 40; y < height + 40; y += 20)
        for (int x = 0; x < width; x += 20)
            if (((x / 20 + (y - 40) / 20) & 1) == 0)
                preview.DrawRect(panel * width + x, y, 20, 20, checker);
    preview.DrawText(names[panel], panel * width + 15, 28, SKTextAlign.Left, labelFont, labels);
    preview.DrawImage(image, panel * width, 40, new SKSamplingOptions());
}

using SKImage result = SKImage.FromBitmap(comparison);
using SKData resultPng = result.Encode(SKEncodedImageFormat.Png, 100);
File.WriteAllBytes(Path.Combine(output, "comparison.png"), resultPng.ToArray());

string[] roundedNames = ["Original", "SrcOver + clear", "Src + clear", "Src + rounded clip"];
byte[] opacities = [255, 128, 0];
using SKBitmap roundedComparison = new(width * roundedNames.Length, (height + 40) * opacities.Length);
using SKCanvas roundedPreview = new(roundedComparison);
roundedPreview.Clear(new SKColor(25, 25, 25));
using SKRoundRect roundedBounds = new(new SKRect(30, 30, 370, 210), 55, 55);
using SKPathBuilder roundedBuilder = new();
roundedBuilder.AddRoundRect(roundedBounds);
using SKPath roundedPath = roundedBuilder.Detach();
using SKPaint foreground = new() { Color = new SKColor(255, 180, 60), IsAntialias = true };

for (int row = 0; row < opacities.Length; row++)
{
    for (int panel = 0; panel < roundedNames.Length; panel++)
    {
        using SKBitmap bitmap = new(width, height, SKColorType.Bgra8888, SKAlphaType.Premul);
        using SKCanvas canvas = new(bitmap);
        canvas.Clear(SKColors.Transparent);
        canvas.DrawText("Sharp text behind blur", 20, 95, SKTextAlign.Left, font, ink);
        canvas.DrawRect(60, 100, 10, 80, ink);
        canvas.DrawCircle(270, 140, 35, ink);
        // This marker is inside the rectangular bounds but outside the rounded shape.
        canvas.DrawRect(35, 35, 15, 15, ink);

        if (panel != 0)
        {
            canvas.Save();
            canvas.ClipRect(roundedBounds.Rect);
            if (panel == 3) canvas.ClipRoundRect(roundedBounds, SKClipOperation.Intersect, true);
            using SKPaint layer = new()
            {
                BlendMode = panel == 1 ? SKBlendMode.SrcOver : SKBlendMode.Src,
                Color = SKColors.White.WithAlpha(opacities[row])
            };
            canvas.SaveLayer(new SKCanvasSaveLayerRec { Paint = layer, Backdrop = blur });
            if (panel != 3)
            {
                // Model Chromium's clear outside backdrop bounds inside the saved layer.
                canvas.Save();
                canvas.ClipPath(roundedPath, SKClipOperation.Difference, true);
                canvas.Clear(SKColors.Transparent);
                canvas.Restore();
            }
            canvas.DrawRect(140, 160, 80, 20, foreground);
            canvas.Restore();
            canvas.Restore();
        }

        int left = panel * width;
        int top = row * (height + 40);
        for (int y = 0; y < height; y += 20)
            for (int x = 0; x < width; x += 20)
                if (((x / 20 + y / 20) & 1) == 0)
                    roundedPreview.DrawRect(left + x, top + 40 + y, 20, 20, checker);
        roundedPreview.DrawText($"{roundedNames[panel]} ({opacities[row]}/255)", left + 10, top + 28,
            SKTextAlign.Left, labelFont, labels);
        using SKImage image = SKImage.FromBitmap(bitmap);
        roundedPreview.DrawImage(image, left, top + 40, new SKSamplingOptions());
        using SKData png = image.Encode(SKEncodedImageFormat.Png, 100);
        File.WriteAllBytes(Path.Combine(output, $"rounded-{panel}-{opacities[row]}.png"), png.ToArray());
        Console.WriteLine($"{roundedNames[panel]}, opacity {opacities[row]}/255: " +
            $"outside corner alpha = {bitmap.GetPixel(42, 42).Alpha}/255, " +
            $"original bar alpha = {bitmap.GetPixel(65, 140).Alpha}/255");
    }
}

using SKImage roundedResult = SKImage.FromBitmap(roundedComparison);
using SKData roundedPng = roundedResult.Encode(SKEncodedImageFormat.Png, 100);
File.WriteAllBytes(Path.Combine(output, "rounded-comparison.png"), roundedPng.ToArray());
Console.WriteLine($"Images: {output}");
