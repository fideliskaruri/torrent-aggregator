using System.Text.RegularExpressions;
using TorrentFlow.Core.Contracts.Search;
using static TorrentFlow.Search.EpisodeParser;

namespace TorrentFlow.Search;

public sealed record WorkIdentity(string Key, string Name,
    [property: System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.Never)] int? Year, bool IsSeries);
public sealed record WorkMatchTarget(string Title, int? Year = null, bool IsSeries = false);

public static class WorkIdentityParser
{
    public static string Normalize(string value) => Replace(Replace(Replace(value.ToLowerInvariant(), "['’`]", ""), @"[^\p{L}\p{N}]+"), @"\s+").Trim();
    public static bool CatalogAgrees(string releaseName, string catalogTitle)
    {
        var a = Normalize(releaseName); var b = Normalize(catalogTitle);
        if (a.Length == 0 || b.Length == 0) return false;
        if (a == b) return true;
        if (!b.Contains(a)) return false;
        return Normalize(Regex.Split(catalogTitle, @":\s*|\s+[-–—]\s+")[0]) != a;
    }
    public static bool MetadataAgrees(string releaseName, MediaMetadata? metadata)
    {
        if (string.IsNullOrWhiteSpace(metadata?.Title)) return false;
        if (CatalogAgrees(releaseName, metadata.Title)) return true;
        var release = Normalize(releaseName);
        if (metadata.Aliases?.Any(alias => Normalize(alias) == release) == true) return true;
        var anime = metadata.MediaType == "anime" || metadata.OriginalLanguage?.ToLowerInvariant() == "ja"
            && metadata.Genres?.Any(g => g.Equals("animation", StringComparison.OrdinalIgnoreCase)) == true;
        if (!anime || string.IsNullOrWhiteSpace(metadata.ExternalId) || metadata.ExternalId.Trim() == "0" || SpecialType(releaseName) != null || release.Split(' ').Length < 4) return false;
        string[] stop = ["the", "that", "this", "with", "from", "season", "series", "part"];
        var tokens = release.Split(' ').Where(t => t.Length >= 5 && !stop.Contains(t)).ToHashSet();
        return Normalize(metadata.Title).Split(' ').Any(t => t.Length >= 5 && !stop.Contains(t) && tokens.Contains(t));
    }
    public static string StripTrailingJunkNumber(string rawTitle, string cleaned)
    {
        if (!Match(rawTitle, @"[\])]\s*\d{1,4}\s*$").Success) return cleaned;
        var result = Replace(cleaned, @"\s+\d{1,4}$", "").Trim();
        return result.Length > 0 ? result : cleaned;
    }
    private static string TrackerPrefix(string title)
    {
        const string host = @"(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:com|org|net|info|to|me|tv|cc|io|is|se|su|ru|mx|xyz|site|online|club)(?::\d{2,5})?";
        var result = title.Trim();
        for (var i = 0; i < 3; i++)
        {
            var next = Replace(result, $@"^\s*[\[(]\s*{host}\s*[\])](?:\s*[-–—:|]+\s*)?|^\s*{host}\s*[-–—:|]+\s*", "").Trim();
            if (next == result || next.Length == 0) break;
            result = next;
        }
        return result;
    }
    private static string FilmName(string title, int? year)
    {
        var t = Replace(Replace(Replace(title, @"[._]+"), @"[\[(][^\])]{0,48}[\])]"), @"\s+").Trim();
        List<int> cuts = [];
        if (year != null && Match(t, $@"(?<![\d.]){year}(?![\d.])") is { Success: true, Index: > 0 } y) cuts.Add(y.Index);
        var quality = Match(t, @"\b(?:\d{3,4}p|4k|uhd|web-?dl|web-?rip|web|blu-?ray|bd-?rip|bd-?remux|remux|hdtv|dvd-?rip|hd-?rip|cam|ts|x26[45]|h\.?26[45]|hevc|avc|xvid|divx|hdr10\+?|hdr|dv|sdr|10bit|8bit|aac|ac3|eac3|ddp?5|dts(?:-hd)?|truehd|atmos|flac|mp3|imax|proper|repack|extended|unrated|remastered|directors?\.?cut)\b");
        var audio = Match(t, @"\b(?:dual[\s.-]?audio|multi[\s.-]?audio|dual|multi|e-?subs?|m-?subs?|hard-?subs?|soft-?subs?|dubbed|subbed|hindi|tamil|telugu|kannada|malayalam)\b");
        if (quality.Success && quality.Index > 0) cuts.Add(quality.Index);
        if (audio.Success && audio.Index > 0) cuts.Add(audio.Index);
        if (cuts.Count > 0) t = t[..cuts.Min()];
        t = Replace(t, @"[-–—_]+[a-z0-9]{2,20}$", "");
        t = Replace(t, @"\s*[\[({]\s*$", "");
        t = Replace(Replace(t, @"[\s\-–—_:|.]+$", ""), @"\s+").Trim();
        return StripTrailingJunkNumber(title, t);
    }
    public static WorkIdentity Parse(string title, MediaMetadata? metadata = null)
    {
        var release = TrackerPrefix(title);
        var ep = EpisodeParser.Parse(release);
        var series = ep.Season != null || ep.Episode != null || ep.IsSeasonPack || ep.IsMultiSeason == true;
        var year = series ? null : ReleaseRanking.ReleaseYear(release);
        var name = series ? ContentClassifier.ShowFolder(release) : FilmName(release, year);
        if (series)
        {
            if (name.Length == 0) name = ContentClassifier.CutAtStructure(release).Trim();
            if (ReleaseRanking.ReleaseYear(release) is { } y)
            {
                var stripped = Replace(Replace(name, $@"\b{y}\b"), @"\s+").Trim();
                if (stripped.Length > 0) name = stripped;
            }
        }
        if (name.Length == 0) name = release.Trim();
        var display = MetadataAgrees(name, metadata) ? metadata!.Title.Trim() : name;
        var normalized = Normalize(display);
        return new(series ? $"series:{normalized}" : $"film:{normalized}:{year}", display, year, series);
    }
    public static bool Matches(string releaseTitle, WorkMatchTarget target)
    {
        if (string.IsNullOrWhiteSpace(target.Title) || target.IsSeries || string.IsNullOrWhiteSpace(releaseTitle)) return true;
        var identity = Parse(releaseTitle.Trim());
        if (identity.IsSeries) return false;
        if (target.Year is >= 1900 and <= 2200 && identity.Year != null && Math.Abs(identity.Year.Value - target.Year.Value) > 1) return false;
        if (CatalogAgrees(identity.Name, target.Title)) return true;
        var a = Normalize(identity.Name); var b = Normalize(target.Title);
        if (a.Length == 0 || b.Length == 0 || !a.StartsWith(b)) return false;
        if (a.Length == b.Length) return true;
        var rest = identity.Name.Trim()[Math.Min(target.Title.Trim().Length, identity.Name.Trim().Length)..];
        return (rest.Length == 0 || Match(rest, @"^[\s:._\-–—]").Success) && !Match(rest, @"^\s*(?::|[-–—]\s)").Success;
    }
}
