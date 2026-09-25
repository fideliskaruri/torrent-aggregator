using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Engine.Settings;

namespace TorrentFlow.Engine.Clients.External;

public sealed class QBittorrentClient(HttpClient http) : IExternalTorrentClient
{
    private static string Host(ClientConfig config) => config.Host.TrimEnd('/');

    private async Task<string> LoginAsync(ClientConfig config, CancellationToken ct)
    {
        var host = Host(config);
        if (host.Length == 0) throw new InvalidOperationException("qBittorrent host URL is empty — set it in Settings");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(8));
        using var request = new HttpRequestMessage(HttpMethod.Post, host + "/api/v2/auth/login")
        {
            Content = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["username"] = config.Username ?? "", ["password"] = config.Password ?? "",
            }),
        };
        HttpResponseMessage response;
        try { response = await http.SendAsync(request, timeout.Token); }
        catch (Exception ex) when (!ct.IsCancellationRequested && ex is HttpRequestException or OperationCanceledException)
        {
            var message = ExternalClientErrors.Message(ex);
            throw new InvalidOperationException($"qBittorrent unreachable at {host}" +
                (message.Contains("fetch", StringComparison.Ordinal) ? $" ({message})" : $": {message}"), ex);
        }
        using var responseScope = response;
        var text = await response.Content.ReadAsStringAsync(timeout.Token);
        if (!response.IsSuccessStatusCode || text.Trim().Equals("fails.", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"qBittorrent login failed at {host} — check username/password (HTTP {(int)response.StatusCode})");
        if (!response.Headers.TryGetValues("Set-Cookie", out var headers)) return "";
        var parts = headers.SelectMany(h => Regex.Split(h, @",(?=\s*[^;]+=)"))
            .SelectMany(h => h.Split(';')).Select(h => h.Trim()).Where(h => h.Length > 0).ToList();
        return parts.FirstOrDefault(h => h.StartsWith("SID=", StringComparison.OrdinalIgnoreCase)) ?? parts.FirstOrDefault() ?? "";
    }

    private async Task<HttpResponseMessage> SendAsync(ClientConfig config, string path, Dictionary<string, string>? form, int seconds, CancellationToken ct)
    {
        // Cookies belong to this operation, not a pooled handler shared with other connections.
        var cookie = await LoginAsync(config, ct);
        for (var attempt = 0; ; attempt++)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(seconds));
            using var request = new HttpRequestMessage(form is null ? HttpMethod.Get : HttpMethod.Post, Host(config) + "/api/v2/" + path);
            if (cookie.Length > 0) request.Headers.Add("Cookie", cookie);
            if (form is not null) request.Content = new FormUrlEncodedContent(form);
            HttpResponseMessage response;
            try { response = await http.SendAsync(request, timeout.Token); }
            catch (Exception ex) when (path == "torrents/add" && !ct.IsCancellationRequested && ex is HttpRequestException or OperationCanceledException)
            {
                throw new InvalidOperationException($"qBittorrent unreachable at {Host(config)} — is WebUI running? ({ExternalClientErrors.Message(ex)})", ex);
            }
            if (attempt != 0 || response.StatusCode is not (HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized)) return response;
            response.Dispose();
            cookie = await LoginAsync(config, ct);
        }
    }

    public Task<EngineActionResult> TestAsync(ClientConfig config, CancellationToken ct = default) =>
        ExternalClientErrors.Capture(async () =>
        {
            using var response = await SendAsync(config, "app/version", null, 8, ct);
            return response.IsSuccessStatusCode
                ? new(true, $"Connected to qBittorrent {await response.Content.ReadAsStringAsync(ct)}")
                : new(false, $"qBittorrent version check failed ({(int)response.StatusCode})");
        }, ct);

    public static Dictionary<string, string>? BuildAddForm(ClientConfig config, EngineAddRequest request)
    {
        var source = !string.IsNullOrEmpty(request.Magnet) ? request.Magnet : request.TorrentUrl;
        if (string.IsNullOrEmpty(source)) return null;
        var target = ClientSettingsStore.ResolveDownloadTarget(config, request.Category, request.SavePath);
        var form = new Dictionary<string, string> { ["urls"] = source };
        if (target.Category is not null) form["category"] = target.Category;
        if (target.SavePath is not null)
        {
            form["savepath"] = target.SavePath;
            // Smart paths already include the title/season; never add another torrent-name directory.
            form["autoTMM"] = "false";
            form["contentLayout"] = "NoSubfolder";
        }
        return form;
    }

    public Task<EngineActionResult> AddAsync(ClientConfig config, EngineAddRequest request, CancellationToken ct = default) =>
        ExternalClientErrors.Capture(async () =>
        {
            var form = BuildAddForm(config, request);
            if (form is null) return new(false, "No magnet or torrent URL provided");
            using var response = await SendAsync(config, "torrents/add", form, 15, ct);
            var text = await response.Content.ReadAsStringAsync(ct);
            if (!response.IsSuccessStatusCode || text.Contains("fail", StringComparison.OrdinalIgnoreCase))
                return new(false, text.Length > 0 ? text : $"qBittorrent add failed ({(int)response.StatusCode})");
            var target = ClientSettingsStore.ResolveDownloadTarget(config, request.Category, request.SavePath);
            return new(true, AddedMessage("qBittorrent", "category", target));
        }, ct);

    internal static string AddedMessage(string name, string categoryLabel, DownloadTarget target)
    {
        var where = string.Join(", ", new[]
        {
            target.Category is null ? null : $"{categoryLabel} “{target.Category}”",
            target.SavePath is null ? null : $"folder {target.SavePath}",
        }.OfType<string>());
        return $"Torrent added to {name}" + (where.Length > 0 ? $" ({where})" : "");
    }

    public async Task<IReadOnlyList<EngineTorrentInfo>> ListAsync(ClientConfig config, CancellationToken ct = default)
    {
        using var response = await SendAsync(config, "torrents/info", null, 12, ct);
        if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"qBittorrent list failed ({(int)response.StatusCode})");
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        return document.RootElement.EnumerateArray().Select(t => new EngineTorrentInfo
        {
            Hash = t.GetProperty("hash").GetString()!, Name = t.GetProperty("name").GetString()!,
            Progress = t.GetProperty("progress").GetDouble(), SizeBytes = t.GetProperty("size").GetInt64(),
            Dlspeed = t.GetProperty("dlspeed").GetInt64(), Upspeed = t.GetProperty("upspeed").GetInt64(),
            State = t.GetProperty("state").GetString()!,
            Eta = Number(t, "eta") is { } eta && eta < 8640000 ? eta : null,
            Peers = (int)((Number(t, "num_seeds") ?? 0) + (Number(t, "num_leechs") ?? 0)),
            Category = Text(t, "category"),
            SavePath = NonEmpty(Text(t, "save_path")) ?? NonEmpty(Text(t, "content_path")),
        }).ToList();
    }

    internal static string? Text(JsonElement e, string key) => e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    internal static long? Number(JsonElement e, string key) => e.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : null;
    private static string? NonEmpty(string? value) => string.IsNullOrEmpty(value) ? null : value;

    public Task<EngineActionResult> ActAsync(ClientConfig config, string action, string hash, bool deleteFiles, CancellationToken ct = default) =>
        ExternalClientErrors.Capture(async () =>
        {
            var form = new Dictionary<string, string> { ["hashes"] = hash };
            if (action == "delete") form["deleteFiles"] = deleteFiles ? "true" : "false";
            var message = action switch { "pause" => "Paused", "resume" => "Resumed", _ => "Removed from qBittorrent" };
            using var response = await SendAsync(config, "torrents/" + action, form, 10, ct);
            return response.IsSuccessStatusCode ? new(true, message)
                : new(false, $"{(action == "delete" ? "Delete" : message)} failed ({(int)response.StatusCode})");
        }, ct);
}
