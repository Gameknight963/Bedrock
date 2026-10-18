using System.Collections.Concurrent;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Runtime.Loader;
using System.Text;
using System.Text.Json;
using Bedrock;

namespace Bedrock.DesktopHost;

public static class Host
{
    [StructLayout(LayoutKind.Sequential)]
    private unsafe struct Bootstrap
    {
        public delegate* unmanaged[Cdecl]<byte*, int, nint, void> Publish;
        public nint State;
    }
    private sealed class LoadContext(string path) : AssemblyLoadContext(isCollectible: true)
    {
        private readonly AssemblyDependencyResolver resolver = new(path);
        private readonly string directory = Path.GetDirectoryName(path)!;
        protected override Assembly? Load(AssemblyName name)
        {
            if (name.Name == typeof(Plugin).Assembly.GetName().Name) return typeof(Plugin).Assembly;
            string? file = resolver.ResolveAssemblyToPath(name);
            if (file == null && File.Exists(Path.Combine(directory, name.Name + ".dll"))) file = Path.Combine(directory, name.Name + ".dll");
            return file == null ? null : LoadFromStream(new MemoryStream(File.ReadAllBytes(file)));
        }
        protected override nint LoadUnmanagedDll(string name)
        {
            string? file = resolver.ResolveUnmanagedDllToPath(name);
            return file == null ? 0 : LoadUnmanagedDllFromPath(file);
        }
    }
    private sealed class Package(LoadContext loadContext, Type type)
    {
        public LoadContext LoadContext { get; } = loadContext;
        public Type Type { get; } = type;
        public Plugin? Active;
        public PluginContext? Context;
        public List<Plugin> Retired { get; } = [];
        public ConcurrentDictionary<string, Func<PluginEvent, Task>> Listeners { get; } = new();
        public ConcurrentDictionary<string, Task> EventWork { get; } = new();
    }
    private sealed class Subscription(Action dispose) : IDisposable
    {
        private Action? release = dispose;
        public void Dispose() => Interlocked.Exchange(ref release, null)?.Invoke();
    }
    private static unsafe Bootstrap bootstrap;
    private static readonly ConcurrentDictionary<string, Package> packages = new();
    private static readonly ConcurrentDictionary<long, TaskCompletionSource<JsonElement>> requests = new();
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> transitions = new();
    private static readonly object uiLock = new();
    private static Task<Control>? ui;
    private static long sequence;
    private static bool shuttingDown;

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    public static unsafe int Initialize(nint data, int size)
    {
        if (size != sizeof(Bootstrap)) return -1;
        bootstrap = *(Bootstrap*)data;
        return 0;
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    public static unsafe int Dispatch(nint data, int length)
    {
        try
        {
            JsonElement message = JsonDocument.Parse(new ReadOnlySpan<byte>((void*)data, length).ToArray()).RootElement.Clone();
            string op = message.GetProperty("op").GetString()!;
            if (op == "reply")
            {
                if (requests.TryRemove(message.GetProperty("id").GetInt64(), out TaskCompletionSource<JsonElement>? completion))
                {
                    if (message.TryGetProperty("error", out JsonElement error)) completion.TrySetException(new InvalidOperationException(error.GetString()));
                    else completion.TrySetResult(message.GetProperty("value").Clone());
                }
            }
            else if (op == "shutdown") Shutdown();
            else if (op == "event") QueueEvent(message);
            else _ = Task.Run(() => Handle(message));
            return 0;
        }
        catch { return -1; }
    }

    private static unsafe void Publish(object message)
    {
        if (shuttingDown) return;
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(message);
        fixed (byte* pointer = bytes) bootstrap.Publish(pointer, bytes.Length, bootstrap.State);
    }

    private static async Task<JsonElement> Request(string plugin, string op, object? args)
    {
        if (shuttingDown) throw new OperationCanceledException("Bedrock is shutting down.");
        long id = Interlocked.Increment(ref sequence);
        TaskCompletionSource<JsonElement> completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
        requests[id] = completion;
        try
        {
            Publish(new { kind = "request", id, plugin, op, args });
            return await completion.Task.WaitAsync(TimeSpan.FromSeconds(10));
        }
        finally { requests.TryRemove(id, out _); }
    }

    private static async Task Handle(JsonElement message)
    {
        long id = message.GetProperty("id").GetInt64();
        string plugin = message.GetProperty("plugin").GetString()!;
        SemaphoreSlim transition = transitions.GetOrAdd(plugin, _ => new(1));
        await transition.WaitAsync();
        try
        {
            string op = message.GetProperty("op").GetString()!;
            object? result = null;
            switch (op)
            {
                case "load": result = Load(plugin, message.GetProperty("path").GetString()!); break;
                case "start": await Start(plugin); break;
                case "stop": await Stop(plugin); break;
                case "unload": await Unload(plugin); break;
                default: throw new InvalidOperationException("Unknown managed operation: " + op);
            }
            Publish(new { kind = "reply", id, value = result });
        }
        catch (Exception error) { Publish(new { kind = "reply", id, error = error.ToString() }); }
        finally { transition.Release(); }
    }

    private static object Load(string id, string path)
    {
        string? entryName = null;
        string requirement = "1.0.0";
        using (MemoryStream stream = new(File.ReadAllBytes(path)))
        using (PEReader pe = new(stream))
        {
            MetadataReader metadata = pe.GetMetadataReader();
            foreach (CustomAttributeHandle handle in metadata.GetAssemblyDefinition().GetCustomAttributes())
            {
                CustomAttribute attribute = metadata.GetCustomAttribute(handle);
                if (attribute.Constructor.Kind != HandleKind.MemberReference) continue;
                MemberReference constructor = metadata.GetMemberReference((MemberReferenceHandle)attribute.Constructor);
                if (constructor.Parent.Kind != HandleKind.TypeReference) continue;
                TypeReference type = metadata.GetTypeReference((TypeReferenceHandle)constructor.Parent);
                if (metadata.GetString(type.Namespace) != "Bedrock" || metadata.GetString(type.Name) != "BedrockPluginAttribute") continue;
                if (entryName != null) throw new InvalidOperationException("An assembly must declare exactly one BedrockPlugin attribute.");
                BlobReader blob = metadata.GetBlobReader(attribute.Value);
                if (blob.ReadUInt16() != 1) throw new InvalidOperationException("Invalid BedrockPlugin attribute.");
                entryName = blob.ReadSerializedString();
                int count = blob.ReadUInt16();
                for (int index = 0; index < count; index++)
                {
                    byte kind = blob.ReadByte(), valueType = blob.ReadByte();
                    string? name = blob.ReadSerializedString();
                    if (kind != 0x54 || valueType != 0x0e || name != "RequiresApi") throw new InvalidOperationException("Unknown BedrockPlugin attribute field.");
                    requirement = blob.ReadSerializedString() ?? "";
                }
            }
        }
        if (entryName == null) throw new InvalidOperationException("The assembly needs an assembly-level BedrockPlugin attribute.");
        if (!System.Text.RegularExpressions.Regex.IsMatch(requirement,
            @"^1\.0\.0(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"))
            throw new InvalidOperationException($"Plugin requires desktop managed API {requirement}; Bedrock provides 1.0.0.");
        LoadContext context = new(path);
        try
        {
            using MemoryStream stream = new(File.ReadAllBytes(path));
            Assembly assembly = context.LoadFromStream(stream);
            Type type = assembly.GetType(entryName.Split(',')[0], true)!;
            if (!typeof(Plugin).IsAssignableFrom(type) || type.IsAbstract) throw new InvalidOperationException("Entry type must be a concrete Bedrock.Plugin.");
            if (!packages.TryAdd(id, new(context, type))) throw new InvalidOperationException("The managed package is already loaded.");
        }
        catch { context.Unload(); throw; }
        return new { api = "1.0.0" };
    }

    private static async Task Start(string id)
    {
        Package package = packages[id];
        if (package.Active != null) throw new InvalidOperationException("The managed plugin is already active.");
        Plugin plugin = (Plugin)Activator.CreateInstance(package.Type)!;
        PluginLog log = new((level, message) => Publish(new { kind = "log", plugin = id, level, message }));
        PluginContext context = new(id, log, (op, args) => Request(id, op, args),
            (name, callback) => Subscribe(id, package, name, callback), InvokeUI,
            reason => Publish(new { kind = "restart", plugin = id, reason }));
        package.Active = plugin; package.Context = context;
        try
        {
            await Request(id, "settings.define", plugin.Settings.ToDictionary(setting => setting.Key, setting => new {
                type = setting.Type, @default = setting.Default, label = setting.Label ?? setting.Key,
                description = setting.Description ?? "", restartNeeded = setting.RestartNeeded }));
            await plugin.StartAsync(context);
        }
        catch
        {
            try { await Stop(id); } catch (Exception error) { log.Error(error.ToString()); }
            throw;
        }
    }

    private static IDisposable Subscribe(string id, Package package, string name, Func<PluginEvent, Task> callback)
    {
        string token = Guid.NewGuid().ToString("N");
        package.Listeners[token] = callback;
        // Requests from this thread retain their order in Node's message queue.
        _ = Request(id, "events.subscribe", new { name, token });
        return new Subscription(() => {
            package.Listeners.TryRemove(token, out _);
            _ = Request(id, "events.unsubscribe", new { token });
        });
    }

    private static void QueueEvent(JsonElement message)
    {
        string id = message.GetProperty("plugin").GetString()!, token = message.GetProperty("token").GetString()!;
        if (!packages.TryGetValue(id, out Package? package)) return;
        PluginEvent value = new(message.GetProperty("sender").GetString()!, message.GetProperty("value").Clone());
        package.EventWork.AddOrUpdate(token, _ => Task.Run(() => DeliverEvent(package, token, value)),
            (_, previous) => previous.ContinueWith(_ => DeliverEvent(package, token, value), TaskScheduler.Default).Unwrap());
    }

    private static async Task DeliverEvent(Package package, string token, PluginEvent value)
    {
        if (package.Context?.CancellationToken.IsCancellationRequested != false || !package.Listeners.TryGetValue(token, out Func<PluginEvent, Task>? callback)) return;
        try { await callback(value); }
        catch (Exception error) { package.Context?.Log.Error(error.ToString()); }
    }

    private static async Task Stop(string id)
    {
        Package package = packages[id];
        Plugin? plugin = package.Active;
        if (plugin == null) return;
        List<Exception> errors = [];
        try { package.Context!.Dispose(); } catch (Exception error) { errors.Add(error); }
        try { await Request(id, "events.clear", null); } catch (Exception error) { errors.Add(error); }
        package.Listeners.Clear();
        try { await Task.WhenAll(package.EventWork.Values); } catch (Exception error) { errors.Add(error); }
        package.EventWork.Clear();
        try { await plugin.StopAsync(); }
        catch (Exception error) { errors.Add(error); }
        finally { package.Retired.Add(plugin); package.Active = null; package.Context = null; }
        if (errors.Count != 0) throw new AggregateException(errors);
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static async Task Unload(string id)
    {
        Package package = packages[id];
        await Stop(id);
        PluginLog log = new((level, message) => Publish(new { kind = "log", plugin = id, level, message }));
        List<Exception> errors = [];
        foreach (Plugin plugin in package.Retired)
            try { await plugin.UnloadAsync(new(id, log, reason => Publish(new { kind = "restart", plugin = id, reason }))); }
            catch (Exception error) { errors.Add(error); }
        if (errors.Count != 0) throw new AggregateException(errors);
        package.Retired.Clear();
        packages.TryRemove(id, out _);
        transitions.TryRemove(id, out _);
        package.LoadContext.Unload();
    }

    private static Task<Control> GetUI()
    {
        lock (uiLock)
        {
            if (ui != null) return ui;
            TaskCompletionSource<Control> ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
            ui = ready.Task;
            Thread thread = new(() => RunUI(ready)) { IsBackground = true, Name = "Bedrock managed UI" };
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            return ui;
        }
    }

    private static void RunUI(TaskCompletionSource<Control> ready)
    {
        try
        {
            // The process DPI mode belongs to Electron; do not reset it from WinForms.
            Application.EnableVisualStyles();
            using Control dispatcher = new();
            _ = dispatcher.Handle;
            ready.TrySetResult(dispatcher);
            Application.Run();
        }
        catch (Exception error) { ready.TrySetException(error); }
    }

    private static async Task InvokeUI(Action action)
    {
        Control control = await GetUI();
        TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
        control.BeginInvoke(new Action(() => {
            try { action(); completion.TrySetResult(); }
            catch (Exception error) { completion.TrySetException(error); }
        }));
        await completion.Task;
    }

    private static void Shutdown()
    {
        shuttingDown = true;
        foreach (TaskCompletionSource<JsonElement> completion in requests.Values) completion.TrySetCanceled();
        foreach (Package package in packages.Values)
            try { package.Context?.Dispose(); } catch { }
        if (ui?.IsCompletedSuccessfully == true) ui.Result.BeginInvoke(new Action(Application.ExitThread));
    }
}
