using System.Text.Json;
using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data.Entities;
using static TorrentFlow.Search.EpisodeParser;
using static TorrentFlow.Core.ReleaseEpisodeParser;

namespace TorrentFlow.Search;

public static class DownloadRouting
{
    public static TorrentResult Attach(TorrentResult r, string category, ClientSetting? settings = null)
    {
        var ep = r.Episode ?? Parse(r.Title);
        var kind = ContentKinds.Detect(r, category);
        var label = ContentClassifier.CategoryLabel(kind, ParseJson<string[]>(settings?.Categories));
        var clean = ContentClassifier.ShowFolder(r.Title, r.Metadata);
        var film = kind == "movies" || kind == "anime" && ContentKinds.IsFilm(r.Title, r.Metadata);
        var show = !string.IsNullOrWhiteSpace(clean) && kind is "tv" or "anime" or "movies" ? clean : null;
        var season = !film && kind is "tv" or "anime" ? SeasonFolder(ep) : null;
        var year = film ? MediaFolders.FilmYear(r.Title, r.Metadata?.Year) : null;
        var rule = ParseJson<Dictionary<string, string>>(settings?.PathRules)?.GetValueOrDefault(label);
        var savePath = MediaFolders.SavePath(settings?.BaseDownloadPath, rule, label, kind, film, show, year, season)
            ?? (string.IsNullOrWhiteSpace(settings?.SavePath) ? null : settings.SavePath);
        var relative = savePath == null ? MediaFolders.Item(MediaFolders.LibraryName(label, kind, film), film, show, year, season) : null;
        return r with { Route = new(kind, label, ContentKinds.Confidence(r, kind), string.IsNullOrEmpty(clean) ? null : clean, savePath, relative) };
    }
    private static T? ParseJson<T>(string? json)
    {
        try { return string.IsNullOrWhiteSpace(json) ? default : JsonSerializer.Deserialize<T>(json); }
        catch (JsonException) { return default; }
    }
}
