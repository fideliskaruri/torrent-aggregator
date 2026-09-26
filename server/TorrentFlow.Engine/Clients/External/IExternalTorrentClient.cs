using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Engine.Settings;

namespace TorrentFlow.Engine.Clients.External;

public interface IExternalTorrentClient
{
    Task<EngineActionResult> TestAsync(ClientConfig config, CancellationToken ct = default);
    Task<EngineActionResult> AddAsync(ClientConfig config, EngineAddRequest request, CancellationToken ct = default);
    Task<IReadOnlyList<EngineTorrentInfo>> ListAsync(ClientConfig config, CancellationToken ct = default);
    Task<byte[]?> ReadTorrentAsync(ClientConfig config, string hash, CancellationToken ct = default) => Task.FromResult<byte[]?>(null);
    Task<EngineActionResult> ActAsync(ClientConfig config, string action, string hash, bool deleteFiles, CancellationToken ct = default);
}

internal static class ExternalClientErrors
{
    public static string Message(Exception ex) => ex switch
    {
        OperationCanceledException => "The operation was aborted (timeout).",
        HttpRequestException => $"fetch failed: {ex.Message}",
        _ => ex.Message,
    };

    public static async Task<EngineActionResult> Capture(Func<Task<EngineActionResult>> action, CancellationToken ct)
    {
        try { return await action(); }
        catch (Exception ex) when (!ct.IsCancellationRequested && ex is HttpRequestException or OperationCanceledException or InvalidOperationException or System.Text.Json.JsonException)
        {
            return new(false, Message(ex));
        }
    }

    public static (bool Offline, string Message, string Code) Format(Exception ex, string type)
    {
        var raw = Message(ex);
        var label = ExternalClientRegistry.Label(type);
        if (type == "builtin") return (false, raw, "ENGINE_ERROR");
        if (IsOffline(raw))
            return (true, $"Cannot reach {label}. Is it running, and is the Host URL in Settings correct? " +
                "(Connection refused usually means qBittorrent/Transmission is not listening on that port.) " +
                "Or switch Client to Built-in for one-app downloads.", "CLIENT_OFFLINE");
        if (raw.Contains("login failed", StringComparison.OrdinalIgnoreCase))
            return (false, $"{label} login failed — check username/password in Settings.", "CLIENT_AUTH");
        return (false, raw, "CLIENT_ERROR");
    }

    public static bool IsOffline(string message) =>
        new[] { "econnrefused", "enotfound", "econnreset", "etimedout", "networkerror", "fetch failed", "aborted", "timeout", "und_err_connect", "unreachable", "cannot reach", "not listening" }
            .Any(s => message.Contains(s, StringComparison.OrdinalIgnoreCase));
}
