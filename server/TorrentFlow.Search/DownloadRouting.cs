using System.Text.Json;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data.Entities;
using static TorrentFlow.Search.EpisodeParser;

namespace TorrentFlow.Search;

public static class DownloadRouting
{
    public static TorrentResult Attach(TorrentResult r, string category, ClientSetting? settings = null)
    {
        var ep = r.Episode ?? Parse(r.Title);
        var kind = ContentClassifier.Detect(r, category);
        var configured = ParseJson<string[]>(settings?.Categories);
        var label = ContentClassifier.CategoryLabel(kind, configured);
        var clean = ContentClassifier.ShowFolder(r.Title, r.Metadata);
        var parts = new List<string> { label };
        if (!string.IsNullOrWhiteSpace(clean) && kind is "tv" or "anime" or "movies")
        {
            parts.Add(clean);
            if (kind is "tv" or "anime" && SeasonFolder(ep) is { } season) parts.Add(season);
        }
        string? savePath = null;
        var rules = ParseJson<Dictionary<string, string>>(settings?.PathRules);
        if (rules?.TryGetValue(label, out var root) == true && !string.IsNullOrWhiteSpace(root))
            savePath = Join(root, parts.Skip(1));
        else if (!string.IsNullOrWhiteSpace(settings?.BaseDownloadPath)) savePath = Join(settings.BaseDownloadPath, parts);
        else if (!string.IsNullOrWhiteSpace(settings?.SavePath)) savePath = settings.SavePath;
        return r with { Route = new(kind, label, ContentClassifier.Confidence(r, kind), string.IsNullOrEmpty(clean) ? null : clean, savePath, savePath == null ? string.Join('/', parts) : null) };
    }
    private static string Join(string root, IEnumerable<string> parts) => root.TrimEnd('/', '\\') + (root.Contains('\\') ? "\\" : "/") + string.Join(root.Contains('\\') ? "\\" : "/", parts);
    private static T? ParseJson<T>(string? json)
    {
        try { return string.IsNullOrWhiteSpace(json) ? default : JsonSerializer.Deserialize<T>(json); }
        catch (JsonException) { return default; }
    }
}
