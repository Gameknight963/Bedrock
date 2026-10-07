using System.ComponentModel;
using System.Text;
using System.Text.Json;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Bedrock.Mcp;

[McpServerToolType]
public static class ServerTools
{
    [McpServerTool(Name = "status", ReadOnly = true)]
    [Description("List running Bedrock development bridges and their windows. Returns process and window IDs for inspection tools.")]
    public static async Task<string> Status(CancellationToken cancellationToken)
    {
        List<object> instances = [];
        foreach (int processId in DiscordBridge.Instances())
        {
            try
            {
                JsonElement result = await DiscordBridge.RequestAsync(processId, new { operation = "status" }, cancellationToken);
                instances.Add(result);
            }
            catch (Exception error) when (error is IOException or TimeoutException or InvalidOperationException)
            {
                instances.Add(new { processId, error = error.Message });
            }
        }
        return JsonSerializer.Serialize(new { server = "Bedrock", instances });
    }

    [McpServerTool(Name = "inspect_element", ReadOnly = true)]
    [Description("Inspect live Discord elements matching a CSS selector: classes, attributes, text, bounds, ancestor chain and selection styles. Defaults to the only connected instance and web window.")]
    public static async Task<string> InspectElement(string selector, CancellationToken cancellationToken,
        int processId = 0, int windowId = 0, int limit = 20)
    {
        JsonElement result = await DiscordBridge.RequestAsync(processId,
            new { operation = "inspect", selector, windowId, limit }, cancellationToken);
        return result.GetRawText();
    }

    [McpServerTool(Name = "get_styles", ReadOnly = true)]
    [Description("Read computed CSS and matching declarations on Discord elements and ancestors. Reports inaccessible stylesheets and truncated results. Defaults to selection, visibility and layout properties.")]
    public static async Task<string> GetStyles(string selector, CancellationToken cancellationToken,
        int processId = 0, int windowId = 0, int limit = 1, string[]? properties = null)
    {
        JsonElement result = await DiscordBridge.RequestAsync(processId,
            new { operation = "styles", selector, windowId, limit, properties }, cancellationToken);
        return result.GetRawText();
    }

    [McpServerTool(Name = "screenshot", ReadOnly = true)]
    [Description("Capture a Discord window as a PNG image. Use IDs from status when multiple instances or windows are available.")]
    public static async Task<CallToolResult> Screenshot(CancellationToken cancellationToken, int processId = 0, int windowId = 0)
    {
        JsonElement result = await DiscordBridge.RequestAsync(processId, new { operation = "screenshot", windowId }, cancellationToken);
        return new() { Content = [new ImageContentBlock { MimeType = "image/png", Data = Encoding.UTF8.GetBytes(result.GetProperty("data").GetString()!) }] };
    }
}
