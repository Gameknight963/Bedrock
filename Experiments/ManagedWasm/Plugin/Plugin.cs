using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Threading.Tasks;

[assembly: SupportedOSPlatform("browser")]

public static partial class ExamplePlugin
{
    private static int counter;

    [JSExport]
    public static int Increment() => ++counter;
    [JSImport("add", "bedrock-test")]
    private static partial int Add(int left, int right);

    [JSImport("writeText", "bedrock-test")]
    private static partial void WriteText(string text);

    [JSImport("addAsync", "bedrock-test")]
    private static partial Task<int> AddAsync(int left, int right);

    [JSExport]
    public static int RoundTrip(int value) => Add(value, 2);

    [JSExport]
    public static void UpdatePage(string text) => WriteText(text);

    [JSExport]
    public static Task<int> AsyncRoundTrip(int value) => AddAsync(value, 2);

    [JSExport]
    public static JSObject Echo(JSObject value)
    {
        value.SetProperty("seenByCSharp", true);
        return value;
    }
}
