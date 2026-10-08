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
Console.WriteLine($"Images: {output}");
