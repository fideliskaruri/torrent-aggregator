using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Engine.Settings;

namespace TorrentFlow.Engine.Clients.External;

public sealed class TransmissionClient(HttpClient http) : IExternalTorrentClient
{
    private async Task<JsonElement> RpcAsync(ClientConfig config, string method, object args, CancellationToken ct)
    {
        var url = config.Host.TrimEnd('/');
        if (!url.EndsWith("/transmission/rpc", StringComparison.Ordinal)) url += "/transmission/rpc";
        string? session = null;
        for (var attempt = 0; ; attempt++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, url)
            {
                Content = JsonContent.Create(new { method, arguments = args }),
            };
            if (!string.IsNullOrEmpty(config.Username) || !string.IsNullOrEmpty(config.Password))
                request.Headers.Authorization = new AuthenticationHeaderValue("Basic",
                    Convert.ToBase64String(Encoding.UTF8.GetBytes($"{config.Username ?? ""}:{config.Password ?? ""}")));
            if (session is not null) request.Headers.Add("X-Transmission-Session-Id", session);
            using var response = await http.SendAsync(request, ct);
            if (response.StatusCode == HttpStatusCode.Conflict)
            {
                if (!response.Headers.TryGetValues("X-Transmission-Session-Id", out var values) || values.FirstOrDefault() is not { Length: > 0 } sid)
                    throw new InvalidOperationException("Transmission CSRF handshake failed");
                if (attempt != 0) throw new InvalidOperationException("Transmission rejected the refreshed session");
                session = sid;
                continue;
            }
            if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"Transmission RPC HTTP {(int)response.StatusCode}");
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("Transmission returned an invalid RPC response");
            if (QBittorrentClient.Text(root, "result") is not { } result) throw new InvalidOperationException("Transmission RPC response is missing result");
            if (result != "success") throw new InvalidOperationException(result.Length > 0 ? result : "Transmission RPC error");
            return root.Clone();
        }
    }

    public Task<EngineActionResult> TestAsync(ClientConfig config, CancellationToken ct = default) =>
        ExternalClientErrors.Capture(async () =>
        {
            var result = await RpcAsync(config, "session-get", new { }, ct);
            var version = result.TryGetProperty("arguments", out var args) && args.ValueKind == JsonValueKind.Object
                ? QBittorrentClient.Text(args, "version") : null;
            return new(true, $"Connected to Transmission {version ?? "unknown"}");
        }, ct);

    public static Dictionary<string, object>? BuildAddArguments(ClientConfig config, EngineAddRequest request)
    {
        var source = request.Magnet ?? request.TorrentUrl;
        if (string.IsNullOrEmpty(source)) return null;
        var target = ClientSettingsStore.ResolveDownloadTarget(config, request.Category, request.SavePath);
        var args = new Dictionary<string, object> { ["filename"] = source };
        if (target.SavePath is not null) args["download-dir"] = target.SavePath;
        if (target.Category is not null) args["labels"] = new[] { target.Category };
        return args;
    }

    public Task<EngineActionResult> AddAsync(ClientConfig config, EngineAddRequest request, CancellationToken ct = default) =>
        ExternalClientErrors.Capture(async () =>
        {
            var args = BuildAddArguments(config, request);
            if (args is null) return new(false, "No magnet or torrent URL provided");
            await RpcAsync(config, "torrent-add", args, ct);
            return new(true, QBittorrentClient.AddedMessage("Transmission", "label",
                ClientSettingsStore.ResolveDownloadTarget(config, request.Category, request.SavePath)));
        }, ct);

    public async Task<IReadOnlyList<EngineTorrentInfo>> ListAsync(ClientConfig config, CancellationToken ct = default)
    {
        var result = await RpcAsync(config, "torrent-get", new
        {
            fields = new[] { "hashString", "name", "percentDone", "totalSize", "rateDownload", "rateUpload", "status", "eta", "labels", "downloadDir" },
        }, ct);
        if (!result.TryGetProperty("arguments", out var args) || args.ValueKind != JsonValueKind.Object
            || !args.TryGetProperty("torrents", out var rows) || rows.ValueKind != JsonValueKind.Array) return [];
        var torrents = new List<EngineTorrentInfo>();
        foreach (var t in rows.EnumerateArray())
        {
            if (t.ValueKind != JsonValueKind.Object
                || QBittorrentClient.Text(t, "hashString") is not { } hash || QBittorrentClient.Text(t, "name") is not { } name
                || !t.TryGetProperty("percentDone", out var progress) || progress.ValueKind != JsonValueKind.Number
                || QBittorrentClient.Number(t, "totalSize") is not { } size || QBittorrentClient.Number(t, "rateDownload") is not { } down
                || QBittorrentClient.Number(t, "rateUpload") is not { } up || QBittorrentClient.Number(t, "status") is not { } status) continue;
            var path = QBittorrentClient.Text(t, "downloadDir");
            torrents.Add(new EngineTorrentInfo
            {
                Hash = hash, Name = name, Progress = progress.GetDouble(), SizeBytes = size, Dlspeed = down, Upspeed = up,
                State = Status(status), Eta = QBittorrentClient.Number(t, "eta") is > 0 and var eta ? eta : null,
                Category = t.TryGetProperty("labels", out var labels) && labels.ValueKind == JsonValueKind.Array
                    && labels.GetArrayLength() > 0 && labels[0].ValueKind == JsonValueKind.String ? labels[0].GetString() : null,
                SavePath = string.IsNullOrEmpty(path) ? null : path,
            });
        }
        return torrents;
    }

    public static string Status(long code) => code switch
    {
        0 => "stopped", 1 => "queuedCheck", 2 => "checking", 3 => "queuedDownload",
        4 => "downloading", 5 => "queuedSeed", 6 => "seeding", _ => $"status_{code}",
    };

    public Task<EngineActionResult> ActAsync(ClientConfig config, string action, string hash, bool deleteFiles, CancellationToken ct = default) =>
        ExternalClientErrors.Capture(async () =>
        {
            var args = new Dictionary<string, object> { ["ids"] = new[] { hash } };
            if (action == "delete") args["delete-local-data"] = deleteFiles;
            await RpcAsync(config, action switch { "pause" => "torrent-stop", "resume" => "torrent-start", _ => "torrent-remove" }, args, ct);
            return new(true, action switch { "pause" => "Paused", "resume" => "Resumed", _ => "Removed" });
        }, ct);
}
