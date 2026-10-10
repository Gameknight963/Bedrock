using Bedrock;
[assembly: BedrockPlugin(typeof(IncompatiblePlugin), RequiresApi = "1.0.1")]
public sealed class IncompatiblePlugin : Plugin
{
    public IncompatiblePlugin() { throw new System.InvalidOperationException("Incompatible plugin code executed."); }
}
