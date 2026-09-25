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
        var t = Replace(r.Title, @"[._]+");
        var anime = r.Metadata?.MediaType == "anime" || Match(t, @"\b(subsplease|erai-?raws|horriblesubs|judas|asw|ember|anime|ova|oad)\b").Success
            || r.Metadata?.OriginalLanguage == "ja" && (r.Metadata.Genres?.Contains("Animation") ?? false);
        var kind = ep.Season != null || ep.IsSeasonPack ? anime ? "anime" : "tv"
            : Match(t, @"\b(epub|mobi|azw3?|djvu|ebook|e-book|audiobook|audio\s?book|unabridged|abridged|m4b|comic|cbr|cbz)\b").Success ? "books"
            : Match(t, @"\b(software|windows|macos|installer|portable|keygen|adobe|photoshop|office|ubuntu|linux|vmware|crack|activated)\b").Success ? "software"
            : Match(t, @"\b(gog|steam|fitgirl|dodi|pc\s*repack|nsw|xci|nsp|ps[345]|xbox|switch|roms?|goty|denuvo)\b").Success ? "games"
            : Match(t, @"\b(flac|alac|320kbps|vinyl|discography|ost|soundtrack|album|single|lossless|cd\s*rip)\b").Success ? "music"
            : anime || r.Source == "nyaa" && ep.Episode != null ? "anime"
            : r.Metadata?.MediaType == "movie" || r.Source == "yts" ? "movies"
            : r.Metadata?.MediaType == "tv" ? "tv"
            : category != "all" ? category == "apps" ? "software" : category
            : ReleaseRanking.ReleaseYear(r.Title) != null || ReleaseQuality.ParseResolution(r.Title) != null ? "movies" : "other";
        var label = kind switch { "anime" => "Anime", "movies" => "Movies", "tv" => "TV", "music" => "Music", "games" => "Games", "software" => "Software", "books" => "Books", _ => "Other" };
        var configured = ParseJson<string[]>(settings?.Categories);
        if (configured?.FirstOrDefault(c => c.Equals(label, StringComparison.OrdinalIgnoreCase)) is { } chosen) label = chosen;
        var clean = r.Metadata?.Title;
        if (string.IsNullOrWhiteSpace(clean))
        {
            clean = ReleaseRanking.StripReleaseGroup(r.Title);
            clean = Replace(clean, @"[._]+");
            clean = Replace(clean, @"\b(?:s\d{1,3}(?:e\d{1,4})?|seasons?\s*\d+|series\s*\d+|episode\s*\d+|ep\s*\d+)\b.*$", "");
            clean = Replace(clean, @"\b(?:19|20)\d{2}\b.*$", "");
            clean = Replace(clean, @"\b(?:\d{3,4}p|web-?dl|webrip|bluray|x26[45]|hevc)\b.*$", "");
            if (ep.Episode != null) clean = Replace(clean, $@"[-–]?\s*\b0*{ep.Episode}\b.*$", "");
            clean = Replace(clean, @"[<>:""/\\|?*]", "").Trim(' ', '-', '.', '(', ')');
        }
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
        return r with { Route = new(kind, label, kind == "other" ? "low" : "high", clean, savePath, savePath == null ? string.Join('/', parts) : null) };
    }
    private static string Join(string root, IEnumerable<string> parts) => root.TrimEnd('/', '\\') + (root.Contains('\\') ? "\\" : "/") + string.Join(root.Contains('\\') ? "\\" : "/", parts);
    private static T? ParseJson<T>(string? json)
    {
        try { return string.IsNullOrWhiteSpace(json) ? default : JsonSerializer.Deserialize<T>(json); }
        catch (JsonException) { return default; }
    }
}
