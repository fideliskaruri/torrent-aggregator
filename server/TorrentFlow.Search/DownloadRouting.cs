using System.Text.Json;
using TorrentFlow.Core.Contracts.Engine;
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
        var film = kind == "movies" || kind == "anime" && ContentClassifier.IsFilm(r.Title, ep, r.Metadata);
        var show = !string.IsNullOrWhiteSpace(clean) && kind is "tv" or "anime" or "movies" ? clean : null;
        var season = !film && kind is "tv" or "anime" ? SeasonFolder(ep) : null;
        var year = film ? MediaFolders.FilmYear(r.Title, r.Metadata?.Year) : null;
        var rule = ParseJson<Dictionary<string, string>>(settings?.PathRules)?.GetValueOrDefault(label) is { } set && !string.IsNullOrWhiteSpace(set) ? set : null;
        var root = kind == "anime" ? MediaFolders.AnimeRoot(settings?.BaseDownloadPath, rule)
            : rule ?? (string.IsNullOrWhiteSpace(settings?.BaseDownloadPath) ? null : settings.BaseDownloadPath);
        string? savePath = root != null ? MediaFolders.Path(root, kind == "anime" || rule != null ? "" : label, kind, film, show, year, season, root.Contains('\\') ? "\\" : "/")
            : string.IsNullOrWhiteSpace(settings?.SavePath) ? null : settings.SavePath;
        var relative = savePath == null ? MediaFolders.Path("", label, kind, film, show, year, season, "/") : null;
        return r with { Route = new(kind, label, ContentClassifier.Confidence(r, kind), string.IsNullOrEmpty(clean) ? null : clean, savePath, relative) };
    }
    private static T? ParseJson<T>(string? json)
    {
        try { return string.IsNullOrWhiteSpace(json) ? default : JsonSerializer.Deserialize<T>(json); }
        catch (JsonException) { return default; }
    }
}
