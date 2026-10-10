using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Loader;
using System.Runtime.Versioning;
using System.Text.Json;
using Bedrock;

[assembly: SupportedOSPlatform("browser")]
public static partial class Host
{
    private sealed record Instance(Plugin Plugin, PluginContext Context);
    private static readonly Dictionary<string, Type> types = [];
    private static readonly Dictionary<string, Instance> instances = [];
    public static void Main() { }

    [JSExport]
    public static string Load(string id, byte[] bytes)
    {
        using MemoryStream stream = new(bytes);
        using PEReader pe = new(stream, PEStreamOptions.LeaveOpen);
        MetadataReader metadata = pe.GetMetadataReader();
        string? entryName = null;
        string requirement = "1.0.0";
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
                byte kind = blob.ReadByte();
                byte valueType = blob.ReadByte();
                string? name = blob.ReadSerializedString();
                if (kind != 0x54 || valueType != 0x0e || name != "RequiresApi") throw new InvalidOperationException("Unknown BedrockPlugin attribute field.");
                requirement = blob.ReadSerializedString() ?? "";
            }
        }
        if (entryName == null) throw new InvalidOperationException("The assembly needs an assembly-level BedrockPlugin attribute.");
        System.Text.RegularExpressions.Match semantic = System.Text.RegularExpressions.Regex.Match(requirement,
            @"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$");
        string core = requirement.Split('-', '+')[0];
        bool invalidPrerelease = semantic.Success && semantic.Groups[4].Value.Split('.').Any(part =>
            part.Length > 1 && part[0] == '0' && part.All(char.IsDigit));
        if (!semantic.Success || invalidPrerelease || !Version.TryParse(core, out Version? version) || version.Major != 1 || version > new Version(1, 0, 0))
            throw new InvalidOperationException($"Plugin requires managed API {requirement}; Bedrock provides 1.0.0.");
        stream.Position = 0;
        // The default load context also makes dynamically loaded JSExport methods discoverable.
        Assembly assembly = AssemblyLoadContext.Default.LoadFromStream(stream);
        Type entry = assembly.GetType(entryName.Split(',')[0], true)!;
        if (!typeof(Plugin).IsAssignableFrom(entry) || entry.IsAbstract) throw new InvalidOperationException("Entry type must be a concrete Bedrock.Plugin.");
        types.Add(id, entry);
        return assembly.GetName().Name!;
    }
    [JSExport]
    public static string Prepare(string id)
    {
        if (instances.ContainsKey(id)) throw new InvalidOperationException("Plugin is already starting or running.");
        Plugin plugin = (Plugin)Activator.CreateInstance(types[id])!;
        PluginContext context = new(id);
        instances.Add(id, new(plugin, context));
        return JsonSerializer.Serialize(plugin.Settings.ToDictionary(setting => setting.Key, setting => new {
            type = setting.Type, @default = setting.Default, label = setting.Label ?? setting.Key,
            description = setting.Description ?? "", restartNeeded = setting.RestartNeeded
        }));
    }
    [JSExport] public static Task Start(string id) => instances[id].Plugin.StartAsync(instances[id].Context);
    [JSExport] public static void Cancel(string id) { if (instances.TryGetValue(id, out Instance? instance)) instance.Context.Dispose(); }
    [JSExport]
    public static async Task Stop(string id)
    {
        if (!instances.Remove(id, out Instance? instance)) return;
        instance.Context.Dispose();
        await instance.Plugin.StopAsync();
    }
}
