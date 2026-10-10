using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;

[assembly: SupportedOSPlatform("browser")]
namespace Bedrock;

[AttributeUsage(AttributeTargets.Assembly)]
public sealed class BedrockPluginAttribute(Type entryType) : Attribute
{
    public Type EntryType { get; } = entryType;
    public string RequiresApi { get; set; } = "1.0.0";
}

public abstract class Plugin
{
    public virtual IReadOnlyList<SettingDefinition> Settings => [];
    public virtual void Start(PluginContext context) { }
    public virtual void Stop() { }
    public virtual Task StartAsync(PluginContext context) { Start(context); return Task.CompletedTask; }
    public virtual Task StopAsync() { Stop(); return Task.CompletedTask; }
}

public abstract class SettingDefinition(string key, string type, object defaultValue)
{
    public string Key { get; } = key;
    public string Type { get; } = type;
    public object Default { get; } = defaultValue;
    public string? Label { get; init; }
    public string? Description { get; init; }
    public bool RestartNeeded { get; init; }
}
public sealed class Setting<T>(string key, T defaultValue) : SettingDefinition(key,
    typeof(T) == typeof(bool) ? "boolean" : typeof(T) == typeof(string) ? "string" :
    typeof(T) == typeof(double) || typeof(T) == typeof(int) ? "number" : throw new ArgumentException("Settings support bool, string, int and double."), defaultValue!) { }

public sealed class PluginSettings(string id)
{
    public T Get<T>(Setting<T> setting) => JsonSerializer.Deserialize<T>(Bindings.GetSetting(id, setting.Key, JsonSerializer.Serialize(setting.Default)))!;
    public Task SetAsync<T>(Setting<T> setting, T value) => Bindings.SetSetting(id, setting.Key, JsonSerializer.Serialize(value));
}
public sealed class PluginLog(string id)
{
    public void Info(string message) => Bindings.Log(id, "info", message);
    public void Warning(string message) => Bindings.Log(id, "warn", message);
    public void Error(string message) => Bindings.Log(id, "error", message);
}
public sealed class PluginContext : IDisposable
{
    private readonly CancellationTokenSource cancellation = new();
    private readonly List<Action> cleanup = [];
    public string Id { get; }
    public PluginSettings Settings { get; }
    public PluginLog Log { get; }
    public CancellationToken CancellationToken => cancellation.Token;
    public PluginContext(string id) { Id = id; Settings = new(id); Log = new(id); }
    public void ReportStatus(string message) => Bindings.ReportStatus(Id, message);
    public void RequireRestart(string reason) => Bindings.RequireRestart(Id, reason);
    public void Cleanup(Action action) { if (cancellation.IsCancellationRequested) action(); else cleanup.Add(action); }
    public void Cleanup(IDisposable resource) => Cleanup(resource.Dispose);
    public Action AddStyle(string css) => Bindings.AddStyle(Id, css);
    public void Subscribe(string name, Action<string> callback) => Bindings.Subscribe(Id, name, callback);
    public Task EmitAsync<T>(string name, T value) => Bindings.Emit(Id, name, JsonSerializer.Serialize(value));
    public Task<JSObject> ImportModuleAsync(string name, string relativePath) => JSHost.ImportAsync(name, Bindings.ModuleUrl(Id, relativePath), CancellationToken);
    public void Dispose()
    {
        if (cancellation.IsCancellationRequested) return;
        try { cancellation.Cancel(); } catch (Exception error) { Log.Error(error.ToString()); }
        for (int index = cleanup.Count - 1; index >= 0; index--)
            try { cleanup[index](); } catch (Exception error) { Log.Error(error.ToString()); }
        cleanup.Clear();
    }
}
internal static partial class Bindings
{
    [JSImport("getSetting", "bedrock")] internal static partial string GetSetting(string id, string key, string fallback);
    [JSImport("setSetting", "bedrock")] internal static partial Task SetSetting(string id, string key, string json);
    [JSImport("log", "bedrock")] internal static partial void Log(string id, string level, string message);
    [JSImport("reportStatus", "bedrock")] internal static partial void ReportStatus(string id, string message);
    [JSImport("requireRestart", "bedrock")] internal static partial void RequireRestart(string id, string reason);
    [JSImport("addStyle", "bedrock")]
    [return: JSMarshalAs<JSType.Function>] internal static partial Action AddStyle(string id, string css);
    [JSImport("subscribe", "bedrock")] internal static partial void Subscribe(string id, string name, [JSMarshalAs<JSType.Function<JSType.String>>] Action<string> callback);
    [JSImport("emit", "bedrock")] internal static partial Task Emit(string id, string name, string json);
    [JSImport("moduleUrl", "bedrock")] internal static partial string ModuleUrl(string id, string path);
}
