using System.Text.Json;

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
    public virtual void Unload(PluginUnloadContext context) { }
    public virtual Task StartAsync(PluginContext context) { Start(context); return Task.CompletedTask; }
    public virtual Task StopAsync() { Stop(); return Task.CompletedTask; }
    public virtual Task UnloadAsync(PluginUnloadContext context) { Unload(context); return Task.CompletedTask; }
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
    typeof(T) == typeof(double) || typeof(T) == typeof(int) ? "number" :
    throw new ArgumentException("Settings support bool, string, int and double."), defaultValue!) { }

public sealed record PluginEvent(string Id, JsonElement Value);
public sealed record PluginWindow(int Id, string Handle);

public sealed class PluginLog(Action<string, string> write)
{
    public void Info(string message) => write("info", message);
    public void Warning(string message) => write("warn", message);
    public void Error(string message) => write("error", message);
}

public sealed class PluginSettings(Func<string, object?, Task<JsonElement>> request)
{
    public async Task<T> GetAsync<T>(Setting<T> setting) =>
        (await request("settings.get", new { key = setting.Key, fallback = setting.Default })).Deserialize<T>()!;
    public async Task SetAsync<T>(Setting<T> setting, T value) =>
        await request("settings.set", new { key = setting.Key, value });
}

public sealed class PluginWindows(Func<string, object?, Task<JsonElement>> request)
{
    public async Task<IReadOnlyList<PluginWindow>> GetAllAsync() =>
        (await request("windows.all", null)).Deserialize<List<PluginWindow>>(PluginContext.JsonOptions)!;
    public Task<JsonElement> ExecuteJavaScriptAsync(int windowId, string source) =>
        request("windows.execute", new { windowId, source });
}

public sealed class PluginUnloadContext(string id, PluginLog log, Action<string> requireRestart)
{
    public string Id { get; } = id;
    public PluginLog Log { get; } = log;
    public void RequireRestart(string reason) => requireRestart(reason);
}

public sealed class PluginContext : IDisposable
{
    public static JsonSerializerOptions JsonOptions { get; } = new() { PropertyNameCaseInsensitive = true };
    private readonly CancellationTokenSource cancellation = new();
    private readonly Func<string, object?, Task<JsonElement>> request;
    private readonly Func<string, Func<PluginEvent, Task>, IDisposable> subscribe;
    private readonly Func<Action, Task> invokeUi;
    private readonly Action<string> restart;
    public string Id { get; }
    public CancellationToken CancellationToken => cancellation.Token;
    public PluginLog Log { get; }
    public PluginSettings Settings { get; }
    public PluginWindows Windows { get; }

    public PluginContext(string id, PluginLog log, Func<string, object?, Task<JsonElement>> request,
        Func<string, Func<PluginEvent, Task>, IDisposable> subscribe, Func<Action, Task> invokeUi, Action<string> requireRestart)
    {
        Id = id; Log = log; this.request = request; this.subscribe = subscribe;
        this.invokeUi = invokeUi; restart = requireRestart;
        Settings = new(request); Windows = new(request);
    }

    public IDisposable Subscribe(string name, Action<PluginEvent> callback)
    {
        CancellationToken.ThrowIfCancellationRequested();
        return subscribe(name, value => { callback(value); return Task.CompletedTask; });
    }
    public IDisposable Subscribe(string name, Func<PluginEvent, Task> callback)
    {
        CancellationToken.ThrowIfCancellationRequested();
        return subscribe(name, callback);
    }
    public async Task EmitAsync<T>(string name, T value) => await request("events.emit", new { name, value });
    public async Task ReportStatusAsync(string message) => await request("status", new { message });
    public void RequireRestart(string reason) => restart(reason);
    public Task InvokeUIAsync(Action action)
    {
        return invokeUi(action);
    }
    public void Dispose() { if (!cancellation.IsCancellationRequested) cancellation.Cancel(); }
}
