using System.Collections.Immutable;
using System.Text.Json;
using TorrentFlow.Domain;

namespace TorrentFlow.Sources;

public static class SourceSettingsContract
{
    public static string Endpoint(SourceSettings source) =>
        source.BaseUrl ?? SourceDefaults.Endpoints.GetValueOrDefault(source.Id) ??
        MetadataEndpoints.GetValueOrDefault(source.Id) ?? "";

    public static readonly IReadOnlyDictionary<string, string> MetadataEndpoints = new Dictionary<string, string>
    {
        ["tmdb"] = "https://api.themoviedb.org/3", ["anilist"] = "https://graphql.anilist.co",
        ["cinemeta"] = "https://v3-cinemeta.strem.io", ["tvmaze"] = "https://api.tvmaze.com",
        ["itunes"] = "https://itunes.apple.com",
    };

    public static IEnumerable<SourceSettings> MetadataDefaults(IEnumerable<string> enabled) =>
        MetadataEndpoints.Select((entry, index) => new SourceSettings(entry.Key, enabled.Contains(entry.Key),
            SourceTier.OptIn, 100 + index, "metadata", entry.Key, entry.Value, [], ["all"],
            10000, 2, 250, ImmutableDictionary<string, string>.Empty, null));

    public static bool Custom(SourceSettings source) =>
        source.Type == "torznab" && source.Id != "torznab";

    public static SourceSettings Update(SourceSettings? source, string id, JsonElement input,
        SecretReference? credential)
    {
        if (input.ValueKind != JsonValueKind.Object || id.Length is < 1 or > 64 ||
            id.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_'))
            throw new ArgumentException("Enter a source ID using letters, numbers, hyphens or underscores.");
        string[] allowed = ["enabled", "priority", "baseUrl", "mirrors", "timeoutMs", "categories", "options", "credential", "kind", "type"];
        if (input.EnumerateObject().Any(p => !allowed.Contains(p.Name)))
            throw new ArgumentException("Unknown source field.");
        if (source is null)
        {
            if (input.GetProperty("type").GetString() != "torznab" || input.GetProperty("kind").GetString() != "torrent")
                throw new ArgumentException("Only custom Torznab sources can be added.");
            source = new(id, true, SourceTier.OptIn, 100, "torrent", "torznab", null, [], ["all"],
                6000, 2, 250, ImmutableDictionary<string, string>.Empty, null);
        }
        else if (input.TryGetProperty("type", out _) || input.TryGetProperty("kind", out _))
            throw new ArgumentException("Source implementation and kind cannot be changed.");
        var next = source;
        if (input.TryGetProperty("enabled", out var enabled)) next = next with { Enabled = enabled.GetBoolean() };
        if (input.TryGetProperty("priority", out var priority))
        {
            var n = priority.GetInt32();
            if (n is < 0 or > 10000) throw new ArgumentException("Priority must be between 0 and 10000.");
            next = next with { Priority = n };
        }
        if (input.TryGetProperty("timeoutMs", out var timeout))
        {
            var n = timeout.GetInt32();
            if (n is < 500 or > 60000) throw new ArgumentException("Timeout must be between 500 and 60000 milliseconds.");
            next = next with { TimeoutMilliseconds = n };
        }
        if (input.TryGetProperty("baseUrl", out var url)) next = next with { BaseUrl = Url(url.GetString()!) };
        if (input.TryGetProperty("mirrors", out var mirrors))
            next = next with { Mirrors = [.. mirrors.EnumerateArray().Select(v => Url(v.GetString()!))] };
        if (input.TryGetProperty("categories", out var categories))
            next = next with { Categories = [.. categories.EnumerateArray().Select(v => v.GetString()!.Trim())] };
        if (input.TryGetProperty("options", out var options))
            next = next with { Options = options.EnumerateObject().ToImmutableDictionary(p => p.Name, p => p.Value.GetString()!) };
        if (input.TryGetProperty("credential", out _)) next = next with { Credential = credential };
        return next;
    }

    private static string Url(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https") ||
            uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0)
            throw new ArgumentException("Enter an HTTP or HTTPS base URL without credentials or a query.");
        return value.TrimEnd('/');
    }
}
