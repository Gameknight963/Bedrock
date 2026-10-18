using Bedrock;

[assembly: BedrockPlugin(typeof(ExamplePlugin), RequiresApi = "1.0.0")]

public sealed class ExamplePlugin : Plugin
{
    private static readonly Setting<bool> Enabled = new("example", true) { Label = "Example setting" };
    public override IReadOnlyList<SettingDefinition> Settings => [Enabled];
    private IDisposable? subscription;
    private PluginContext? context;

    public override async Task StartAsync(PluginContext context)
    {
        this.context = context;
        await context.ReportStatusAsync("Starting the managed example");
        bool enabled = await context.Settings.GetAsync(Enabled);
        context.Log.Info("Example setting: " + enabled);
        subscription = context.Subscribe("settings.changed", SettingsChanged);
        await context.InvokeUIAsync(CheckUIThread);
    }

    private void CheckUIThread()
    {
        using Control control = new();
        _ = control.Handle;
        context!.Log.Info("UI thread: " + Thread.CurrentThread.GetApartmentState());
    }

    private void SettingsChanged(PluginEvent value) => context!.Log.Info("Setting changed: " + value.Value.GetProperty("value"));
    public override void Stop() { subscription?.Dispose(); subscription = null; context?.Log.Info("Example stopped"); context = null; }
    public override void Unload(PluginUnloadContext context) => context.Log.Info("Example unloaded");
}
