using Bedrock;
[assembly: BedrockPlugin(typeof(FuturePlugin), RequiresApi = "1.0.1")]
public sealed class FuturePlugin : Plugin
{
    public FuturePlugin() => throw new System.InvalidOperationException("Incompatible plugin code was executed.");
}
