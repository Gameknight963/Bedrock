using Bedrock;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;

[assembly: SupportedOSPlatform("browser")]
[assembly: BedrockPlugin(typeof(ExamplePlugin), RequiresApi = "1.0.0")]
public sealed partial class ExamplePlugin : Plugin
{
    private static readonly Setting<bool> Accent = new("accent", true) { Label = "Accent", Description = "Add a blue accent to plugin cards." };
    public override IReadOnlyList<SettingDefinition> Settings => [Accent];
    private PluginContext? context;
    private Action? removeAccent;
    public override async Task StartAsync(PluginContext context)
    {
        this.context = context;
        context.ReportStatus("Loading JavaScript bindings");
        using JSObject module = await context.ImportModuleAsync("managed-example", "renderer.mjs");
        context.CancellationToken.ThrowIfCancellationRequested();
        context.Log.Info($"JavaScript returned {Add(1, 2)}.");
        ApplyAccent();
        context.Subscribe("settings.changed", SettingsChanged);
    }
    private void SettingsChanged(string json) => ApplyAccent();
    private void ApplyAccent()
    {
        if (context == null) return;
        removeAccent?.Invoke();
        removeAccent = context.AddStyle(context.Settings.Get(Accent) ? ".bedrock-card { border-color: #5865f2; }" : "");
    }
    public override void Stop() { context = null; removeAccent = null; }
    [JSExport] public static int Multiply(int left, int right) => left * right;
    [JSImport("add", "managed-example")] private static partial int Add(int left, int right);
}
