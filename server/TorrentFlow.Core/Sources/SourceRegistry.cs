using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Configuration;

namespace TorrentFlow.Core.Sources;

public sealed record SourceEntry
{
    public required string Id { get; init; }
    public required string Kind { get; init; }
    public required string Type { get; init; }
    public string[] Categories { get; init; } = [];
    public bool Enabled { get; init; } = true;
    public int Priority { get; init; } = 50;
    public string BaseUrl { get; init; } = "";
    public string[] Mirrors { get; init; } = [];
    public int TimeoutMs { get; init; } = 10000;
    public Dictionary<string, JsonElement> Options { get; init; } = [];
    public string? Credential { get; init; }
}

public sealed class SourceRegistry
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly object gate = new();
    private readonly string path;
    private readonly IConfiguration configuration;
    private readonly JsonArray defaults;
    private JsonArray overlay = [];
    private SourceEntry[] entries = [];
    private string? lastContent;
    private long revision = Random.Shared.NextInt64(1, long.MaxValue / 2);
    public string? LoadError { get; private set; }

    public SourceRegistry(IConfiguration configuration)
    {
        this.configuration = configuration;
        path = Path.Combine(configuration["TorrentFlow:DataDirectory"] ?? Path.Combine(AppContext.BaseDirectory, "data"), "sources.json");
        using var stream = typeof(SourceRegistry).Assembly.GetManifestResourceStream("TorrentFlow.Core.Sources.sources.default.json")!;
        defaults = JsonNode.Parse(stream)!.AsArray();
        var legacy = new Dictionary<string, string> { ["nyaa"] = "NYAA_BASE_URL", ["apibay"] = "APIBAY_BASE_URL",
            ["torrentscsv"] = "TORRENTS_CSV_BASE_URL", ["yts"] = "YTS_BASE_URL", ["eztv"] = "EZTV_BASE_URL",
            ["1337x"] = "X1337_BASE_URL", ["archive"] = "ARCHIVE_BASE_URL", ["tmdb"] = "TMDB_BASE_URL" };
        foreach (var item in defaults.OfType<JsonObject>())
        {
            var id = item["id"]!.GetValue<string>();
            if (legacy.TryGetValue(id, out var setting) && (configuration[$"TorrentFlow:Search:{setting}"] ?? configuration[setting]) is { Length: > 0 } url)
            {
                var urls = url.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                item["baseUrl"] = urls[0];
                if (urls.Length > 1) item["mirrors"] = new JsonArray(urls.Skip(1).Select(v => (JsonNode?)JsonValue.Create(v)).ToArray());
            }
            var flag = id == "1337x" ? "ENABLE_1337X" : id == "archive" ? "ENABLE_ARCHIVE" : null;
            if (flag is not null && (configuration[$"TorrentFlow:Search:{flag}"] ?? configuration[flag]) is { } enabled)
                item["enabled"] = enabled == "1";
        }
        entries = Merge([]);
        Reload();
    }

    public long Revision { get { lock (gate) { Reload(); return revision; } } }
    public IReadOnlyList<SourceEntry> Snapshot()
    {
        lock (gate)
        {
            Reload();
            return entries.OrderBy(e => e.Priority).ThenBy(e => e.Id, StringComparer.Ordinal).Select(Clone).ToArray();
        }
    }
    private static SourceEntry Clone(SourceEntry e) => e with { Categories = [.. e.Categories], Mirrors = [.. e.Mirrors], Options = new(e.Options) };
    public SourceEntry? Find(string id) => Snapshot().FirstOrDefault(e => e.Id == id);
    public static string Category(string value) => value switch { "movies" => "movie", "tv" => "series", _ => value };
    public bool IsEnabled(SourceEntry e) => e.Enabled && (e.Type != "tmdb" || TmdbCredentials.IsUsable(Credential(e)));
    public string? Credential(SourceEntry e) => e.Credential ?? (e.Type == "tmdb" ?
        configuration["TorrentFlow:Metadata:TmdbApiKey"] ?? configuration["TMDB_API_KEY"] : null);
    public IReadOnlyList<SourceEntry> Active(string kind, string category = "all") =>
        Snapshot().Where(e => e.Kind == kind && IsEnabled(e) && (category == "all" || e.Categories.Contains(Category(category)))).ToArray();
    public bool IsDefault(string id) => defaults.Any(n => n?["id"]?.GetValue<string>() == id);

    public object Public(SourceEntry e)
    {
        var credential = Credential(e);
        return new { e.Id, e.Kind, e.Type, e.Categories, enabled = e.Enabled, active = IsEnabled(e), e.Priority,
            e.BaseUrl, e.Mirrors, e.TimeoutMs, e.Options, custom = !IsDefault(e.Id),
            credential = new { configured = !string.IsNullOrEmpty(credential),
                hint = string.IsNullOrEmpty(credential) ? "" : credential.Length <= 4 ? "••••" : "••••" + credential[^4..] } };
    }

    private SourceEntry[] Merge(JsonArray patches)
    {
        var map = defaults.OfType<JsonObject>().ToDictionary(n => n["id"]!.GetValue<string>(), n => n.DeepClone().AsObject(), StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in patches)
        {
            if (node is not JsonObject patch || patch["id"] is not JsonValue idValue || !idValue.TryGetValue<string>(out var id) ||
                !seen.Add(id)) throw new ArgumentException("Each source needs a unique id.");
            if (!map.TryGetValue(id, out var item)) map[id] = item = new JsonObject();
            foreach (var pair in patch) item[pair.Key] = pair.Value?.DeepClone();
        }
        var result = map.Values.Select(n => n.Deserialize<SourceEntry>(Json) ?? throw new ArgumentException("Invalid source.")).ToArray();
        foreach (var e in result) Validate(e);
        return result;
    }

    private static void Validate(SourceEntry e)
    {
        string[] torrent = ["nyaa", "apibay", "torrentscsv", "yts", "eztv", "1337x", "archive", "torznab"];
        string[] metadata = ["tvmaze", "anilist", "cinemeta", "tmdb", "itunes"];
        if (e.Id is null || !Regex.IsMatch(e.Id, "^[a-z0-9][a-z0-9-]{0,63}$") ||
            !(e.Kind == "torrent" ? torrent.Contains(e.Type) : e.Kind == "metadata" && metadata.Contains(e.Type)))
            throw new ArgumentException("Invalid source id, kind or implementation type.");
        if (e.TimeoutMs is < 500 or > 60000 || e.Priority is < 0 or > 10000 || e.Categories is not { Length: > 0 and <= 20 } ||
            e.Categories.Any(c => c is null || !Regex.IsMatch(c, "^[a-z0-9-]{1,30}$")) || e.Mirrors is null || e.Mirrors.Length > 10)
            throw new ArgumentException("Invalid source categories, priority or timeout.");
        foreach (var url in new[] { e.BaseUrl }.Concat(e.Mirrors))
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") ||
                uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0)
                throw new ArgumentException("Use an HTTP(S) base URL without credentials, query or fragment.");
        if (e.Credential is { } key && (key.Length > 4096 || key.Any(char.IsControl))) throw new ArgumentException("Invalid credential.");
        if (e.Options is null || e.Options.Keys.Any(k => k.Contains("key", StringComparison.OrdinalIgnoreCase) ||
                k.Contains("token", StringComparison.OrdinalIgnoreCase) || k.Contains("secret", StringComparison.OrdinalIgnoreCase) ||
                k.Contains("password", StringComparison.OrdinalIgnoreCase)))
            throw new ArgumentException("Use the credential field for secrets, not options.");
    }

    private void Reload()
    {
        try
        {
            var content = File.Exists(path) ? File.ReadAllText(path) : "[]";
            if (content == lastContent) return;
            if (content.Length > 256 * 1024) throw new ArgumentException("Source configuration is too large.");
            var next = JsonNode.Parse(content) as JsonArray ?? throw new ArgumentException("Expected a source array.");
            var merged = Merge(next);
            overlay = next; entries = merged; lastContent = content; revision++; LoadError = null;
        }
        catch (Exception e) when (e is JsonException or ArgumentException or InvalidOperationException or IOException or UnauthorizedAccessException)
        { LoadError = "Could not read sources.json. Keeping the last valid configuration."; }
    }

    public void Update(string id, JsonObject patch)
    {
        lock (gate)
        {
            Reload();
            if (LoadError is not null) throw new ArgumentException("Fix sources.json before saving changes.");
            var next = overlay.DeepClone().AsArray();
            var target = next.OfType<JsonObject>().FirstOrDefault(n => n["id"]?.GetValue<string>() == id);
            if (target is null) { target = new JsonObject { ["id"] = id }; next.Add(target); }
            foreach (var pair in patch) if (pair.Key != "id") target[pair.Key] = pair.Value?.DeepClone();
            Save(next);
        }
    }

    public void Remove(string id)
    {
        lock (gate)
        {
            Reload();
            if (LoadError is not null) throw new ArgumentException("Fix sources.json before saving changes.");
            if (IsDefault(id)) throw new ArgumentException("Disable built-in sources instead of removing them.");
            var next = overlay.DeepClone().AsArray();
            var item = next.FirstOrDefault(n => n?["id"]?.GetValue<string>() == id);
            if (item is not null) next.Remove(item);
            Save(next);
        }
    }

    private void Save(JsonArray next)
    {
        var merged = Merge(next);
        var content = next.ToJsonString(Json);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var pending = path + ".pending";
        try { File.WriteAllText(pending, content); File.Move(pending, path, true); }
        finally { if (File.Exists(pending)) File.Delete(pending); }
        overlay = next; entries = merged; lastContent = content; revision++; LoadError = null;
    }
}

public static class SourceExecution
{
    private static readonly AsyncLocal<SourceEntry?> CurrentEntry = new();
    public static SourceEntry? Current => CurrentEntry.Value;
    public static async Task<T> RunAsync<T>(SourceEntry entry, Func<CancellationToken, Task<T>> action, CancellationToken ct)
    {
        var previous = CurrentEntry.Value;
        CurrentEntry.Value = entry;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(entry.TimeoutMs);
        try { return await action(timeout.Token).ConfigureAwait(false); }
        finally { CurrentEntry.Value = previous; }
    }
}
