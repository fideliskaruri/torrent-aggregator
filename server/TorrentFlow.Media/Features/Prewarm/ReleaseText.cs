using System.Globalization;
using System.Text.RegularExpressions;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Media.Features.Prewarm;

/// <summary>
/// Release-name helpers the pre-warm code needs. Modules never reference each other, so these mirror the
/// TypeScript helpers (episodes.ts, utils.normalizeTitle, infohash.ts, media-type.ts, library/cursor.ts,
/// pack-episode-files.ts) that TorrentFlow.Search also ports. Keep them in step with those sources.
/// </summary>
internal static class ReleaseText
{
    private static readonly TimeSpan RegexTimeout = TimeSpan.FromSeconds(1);

    private static Match M(string value, string pattern) => Regex.Match(value, pattern, RegexOptions.IgnoreCase, RegexTimeout);
    private static string R(string value, string pattern, string replacement = " ") =>
        Regex.Replace(value, pattern, replacement, RegexOptions.IgnoreCase, RegexTimeout);
    private static int N(Match m, int group = 1) => int.Parse(m.Groups[group].Value, CultureInfo.InvariantCulture);

    // ---------------------------------------------------------------- titles

    /// <summary>utils.normalizeTitle — the SearchCache.normalizedQuery column.</summary>
    public static string NormalizeTitle(string title)
    {
        var t = R(title.ToLowerInvariant(), @"[\[\](){}【】]");
        t = R(t, @"\b(s\d{1,2}e\d{1,3}|ep?\s*\d{1,3}|season\s*\d+)\b");
        t = R(t, @"\b(1080p|720p|480p|2160p|4k|hevc|x265|x264|web-?dl|webrip|bluray|bdrip|hdtv|aac|flac|10bit|dual|multi|sub|dub|vostfr|raw)\b");
        return R(R(t, @"[._\-–—|]+"), @"\s+").Trim();
    }

    public static int? ParseResolution(string title) => TorrentFlow.Core.ReleaseResolution.Parse(title);

    public static bool MeetsResolutionFloor(string title, int? floor) => floor is null or < 1 || ParseResolution(title) >= floor;

    /// <summary>quality.verdictTier: good first, unknown ahead of weak, dead last.</summary>
    public static int VerdictTier(string verdict) => verdict switch { "good" => 0, "unknown" => 1, "weak" => 2, _ => 3 };

    public static int? ReleaseYear(string title)
    {
        var t = R(title, @"[._]+");
        t = R(t, @"\b(?:\d{3,4}p|x?26[45]|h\.?26[45]|10bit|8bit|5\.1|7\.1|2\.0|ddp?5|dts|aac2|mp3|hdr10\+?|\d+(?:\.\d+)?\s*(?:gb|mb|gib|mib))\b");
        var max = DateTime.UtcNow.Year + 2;
        int? last = null;
        foreach (Match m in Regex.Matches(t, @"(?<![\d.])(?:19|20)\d{2}(?![\d.])", RegexOptions.None, RegexTimeout))
        {
            var y = int.Parse(m.Value, CultureInfo.InvariantCulture);
            if (y >= 1900 && y <= max) last = y;
        }
        return last;
    }

    private static string CutAtStructure(string title)
    {
        var m = M(title, @"\bS\d{1,3}\s*E\d{1,4}\b|\b\d{1,2}x\d{1,4}\b|\bSeasons?\s*\d{1,3}\b|\bS\d{1,3}\b|\b(?:episode|ep)\s*\.?\s*\d{1,4}\b|(?<![A-Za-z])\bE\d{1,4}\b|[-–—]\s*\d{1,4}(?=\s|[\[(]|$)");
        return m.Success && m.Index > 0 ? title[..m.Index] : title;
    }

    /// <summary>
    /// The work name of a release (work-identity.ts): for a series, the show name before the episode marker, with
    /// release junk and the year removed; for a film, the title before the year/quality tokens. A raw release
    /// name is never a search query.
    /// </summary>
    public static string WorkName(string title)
    {
        var release = R(title.Trim(), @"^\s*[\[(]\s*(?:www\.)?[a-z0-9.-]+\.(?:com|org|net|info|to|me|tv|cc|io)\s*[\])]\s*[-–—:|]*\s*", "").Trim();
        var ep = ParseEpisode(release);
        var series = ep.Season != null || ep.Episode != null || ep.IsSeasonPack || ep.IsMultiSeason == true;
        var t = R(R(release, @"[._]+"), @"[\[(][^\])]{0,48}[\])]");
        if (series) t = CutAtStructure(t);
        var year = ReleaseYear(release);
        List<int> cuts = [];
        if (year != null && M(t, $@"(?<![\d.]){year}(?![\d.])") is { Success: true, Index: > 0 } y) cuts.Add(y.Index);
        var quality = M(t, @"\b(?:\d{3,4}p|4k|uhd|web-?dl|web-?rip|web|blu-?ray|bd-?rip|remux|hdtv|dvd-?rip|x26[45]|h\.?26[45]|hevc|avc|hdr|10bit|aac|ac3|ddp?5|dts|proper|repack|complete|batch)\b");
        if (quality.Success && quality.Index > 0) cuts.Add(quality.Index);
        if (cuts.Count > 0) t = t[..cuts.Min()];
        t = R(R(t, @"[\s\-–—_:|.+]+$", ""), @"\s+").Trim();
        return t.Length > 0 ? t : release;
    }

    /// <summary>work-match.filterReleasesForWork for a film: same title (prefix-safe) and a year within one.</summary>
    public static bool FilmMatches(string releaseTitle, string title, int? year)
    {
        if (string.IsNullOrWhiteSpace(title) || string.IsNullOrWhiteSpace(releaseTitle)) return true;
        var ep = ParseEpisode(releaseTitle);
        if (ep.Season != null || ep.Episode != null || ep.IsSeasonPack) return false;
        var releaseYear = ReleaseYear(releaseTitle);
        if (year is >= 1900 and <= 2200 && releaseYear != null && Math.Abs(releaseYear.Value - year.Value) > 1) return false;
        var a = Comparable(WorkName(releaseTitle));
        var b = Comparable(title);
        if (a.Length == 0 || b.Length == 0) return false;
        return a == b || a.StartsWith(b + " ", StringComparison.Ordinal);
    }

    private static string Comparable(string value) =>
        R(R(R(value.ToLowerInvariant(), "['’`]", ""), @"[^\p{L}\p{N}]+"), @"\s+").Trim();

    // ---------------------------------------------------------------- info hashes

    public static string? NormalizeInfoHash(string? raw)
    {
        var value = raw?.Trim();
        if (value == null) return null;
        if (Regex.IsMatch(value, "^[0-9a-fA-F]{40}$")) return value.ToLowerInvariant();
        if (!Regex.IsMatch(value, "^[a-zA-Z2-7]{32}$")) return null;
        const string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
        Span<byte> bytes = stackalloc byte[20];
        uint buffer = 0;
        int bits = 0, index = 0;
        foreach (var c in value.ToUpperInvariant())
        {
            buffer = (buffer << 5) | (uint)alphabet.IndexOf(c);
            bits += 5;
            if (bits >= 8) { bits -= 8; bytes[index++] = (byte)(buffer >> bits); }
        }
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    public static string? InfoHashFromMagnet(string? magnet)
    {
        foreach (Match m in Regex.Matches(magnet ?? "", @"[?&]xt=([^&]+)", RegexOptions.IgnoreCase, RegexTimeout))
        {
            var value = Uri.UnescapeDataString(m.Groups[1].Value);
            value = Regex.Replace(value, "^urn:btih:", "", RegexOptions.IgnoreCase);
            if (NormalizeInfoHash(value) is { } hash) return hash;
        }
        return null;
    }

    /// <summary>prerank.releaseInfoHash: the explicit hash first, the magnet's otherwise.</summary>
    public static string? ReleaseInfoHash(TorrentResult r) =>
        (r.InfoHash is { Length: > 0 } h ? NormalizeInfoHash(h) : null) ?? InfoHashFromMagnet(r.Magnet);

    // ---------------------------------------------------------------- media types

    public static string? NormalizeMediaType(string? raw) => raw?.Trim().ToLowerInvariant() switch
    {
        "anime" => "anime",
        "movie" or "movies" or "film" => "movie",
        "tv" or "series" or "show" or "tvshow" => "tv",
        _ => null,
    };

    public static string? SearchCategoryForMediaType(string? raw) => NormalizeMediaType(raw) switch
    {
        "anime" => "anime",
        "movie" => "movies",
        "tv" => "tv",
        _ => null,
    };

    public static bool IsSeriesMediaType(string? raw) => NormalizeMediaType(raw) is "tv" or "anime";

    // ---------------------------------------------------------------- cursor

    public static string FormatEpisodeLabel(int season, int episode) =>
        string.Create(CultureInfo.InvariantCulture, $"S{season:00}E{episode:00}");

    public static string EpisodeSearchQuery(string title, int season, int episode) => $"{title.Trim()} {FormatEpisodeLabel(season, episode)}";

    public static (int Season, int Episode) AdvanceCursor(int season, int episode) => (season, episode + 1);

    /// <summary>
    /// library/cursor.resolveHuntCursor: the cursor only; reading it never moves it. The rule itself is
    /// <see cref="TorrentFlow.Core.Scheduling.HuntCursor"/>, the same one the automation hunt uses, so prewarm
    /// never readies an episode the hunt would not fetch.
    /// </summary>
    public static (int Season, int Episode)? ResolveHuntCursor(string mediaType, string? monitorMode, int? cursorSeason, int? cursorEpisode,
        int? fromSeason, int? fromEpisode, string? lastEpisode, string? nextEpisodeHint) =>
        IsSeriesMediaType(mediaType)
            ? TorrentFlow.Core.Scheduling.HuntCursor.ResolveSeries(monitorMode, cursorSeason, cursorEpisode, lastEpisode, fromSeason, fromEpisode, nextEpisodeHint)
            : null;

    // ---------------------------------------------------------------- episodes

    public static EpisodeInfo ParseEpisode(string title) => TorrentFlow.Core.ReleaseEpisodeParser.Parse(title);

    // ---------------------------------------------------------------- pack files

    private static readonly Regex VideoExt = new(@"\.(?:mkv|mp4|avi|m4v|mov|wmv|flv|webm|ts|m2ts|mpg|mpeg|vob)$", RegexOptions.IgnoreCase, RegexTimeout);
    private static readonly Regex ExtrasSegment = new(@"\b(?:featurettes?|extras?|specials?|samples?|behind[ ]the[ ]scenes|animatics?)\b", RegexOptions.IgnoreCase, RegexTimeout);

    public static bool IsSupportedVideoFileName(string name) => VideoExt.IsMatch(name.Replace('\\', '/'));

    /// <summary>pack-episode-files.packEpisodeFiles: episode → path of the largest real episode file for that season.</summary>
    public static Dictionary<int, string> PackEpisodeFiles(IEnumerable<(string Path, long Size)> files, int season)
    {
        var best = new Dictionary<int, (string Path, long Size)>();
        foreach (var (path, rawSize) in files)
        {
            if (string.IsNullOrEmpty(path) || !IsSupportedVideoFileName(path)) continue;
            var segments = path.Split(['\\', '/'], StringSplitOptions.RemoveEmptyEntries);
            if (segments.Any(s => ExtrasSegment.IsMatch(Regex.Replace(s, "[._-]+", " ")))) continue;
            var ep = ParseEpisode(segments.Length > 0 ? segments[^1] : path);
            if (ep.Season != season || ep.Episode is not { } episode || ep.IsSeasonPack || ep.IsMultiSeason == true) continue;
            var size = rawSize > 0 ? rawSize : 0;
            if (!best.TryGetValue(episode, out var existing) || size > existing.Size) best[episode] = (path, size);
        }
        return best.ToDictionary(kv => kv.Key, kv => kv.Value.Path);
    }
}
