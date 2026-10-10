using System;
using System.Linq;
using System.IO;
using System.Runtime.Loader;
using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;

[assembly: SupportedOSPlatform("browser")]

public static partial class Host
{
    [JSExport]
    public static string LoadPlugin(byte[] bytes)
    {
        using MemoryStream stream = new(bytes);
        Assembly assembly = AssemblyLoadContext.Default.LoadFromStream(stream);
        return assembly.GetName().Name ?? throw new InvalidOperationException("The plugin has no assembly name.");
    }

    [JSExport]
    public static string LoadedAssemblies() => string.Join(",", AppDomain.CurrentDomain.GetAssemblies().Select(assembly => assembly.GetName().Name));

    [JSExport]
    public static double ManagedBytes() => GC.GetTotalMemory(false);

    public static void Main() { }
}
