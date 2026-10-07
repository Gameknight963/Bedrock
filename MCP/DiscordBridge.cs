using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace Bedrock.Mcp;

internal static class DiscordBridge
{
    public static int[] Instances()
    {
        if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("Discord inspection currently requires Windows.");
        List<int> processes = [];
        foreach (string path in Directory.EnumerateFiles(@"\\.\pipe\"))
        {
            string name = Path.GetFileName(path);
            if (name.StartsWith("Bedrock-Dev-", StringComparison.Ordinal) && int.TryParse(name[12..], out int processId))
                processes.Add(processId);
        }
        processes.Sort();
        return processes.ToArray();
    }

    public static async Task<JsonElement> RequestAsync(int processId, object request, CancellationToken cancellationToken)
    {
        if (processId < 0) throw new ArgumentOutOfRangeException(nameof(processId));
        if (processId == 0)
        {
            int[] instances = Instances();
            if (instances.Length != 1) throw new InvalidOperationException(instances.Length == 0
                ? "Enable MCP Bridge in Bedrock and load its main entrypoint before inspecting Discord."
                : "Multiple Bedrock instances are available; specify processId from status.");
            processId = instances[0];
        }
        using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        await using NamedPipeClientStream pipe = new(".", $"Bedrock-Dev-{processId}", PipeDirection.InOut,
            PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
        try
        {
            await pipe.ConnectAsync(1000, timeout.Token);
            using StreamWriter writer = new(pipe, new UTF8Encoding(false), leaveOpen: true);
            using StreamReader reader = new(pipe, Encoding.UTF8, leaveOpen: true);
            await writer.WriteLineAsync(JsonSerializer.Serialize(request).AsMemory(), timeout.Token);
            await writer.FlushAsync(timeout.Token);
            string? response = await reader.ReadLineAsync(timeout.Token);
            if (response is null) throw new IOException("Discord closed the inspection connection without a response.");
            using JsonDocument document = JsonDocument.Parse(response);
            if (document.RootElement.TryGetProperty("error", out JsonElement error))
                throw new InvalidOperationException(error.GetString() ?? "Discord inspection failed.");
            return document.RootElement.GetProperty("result").Clone();
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException("Discord inspection did not respond within ten seconds.");
        }
    }
}
