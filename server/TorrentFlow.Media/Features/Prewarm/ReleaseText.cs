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

    public static int? ParseResolution(string title)
    {
        var t = R(title, @"[._]");
        (string Pattern, int Value)[] patterns =
        [
            (@"\b4kto1080p\b", 1080),
            (@"\b(?:2160p|3840x2160|uhd|4k[-_. ]?(?:uhd|hevc|bd|h ?265)|(?:uhd|hevc|bd|h ?265)[-_. ]4k)\b|\[4k\]", 2160),
            (@"\b(?:1080p|1920x1080|1440p|fhd|1080i)\b", 1080),
            (@"\b(?:720p|1280x720|960p)\b", 720),
            (@"\b(?:576p|576i)\b", 576),
            (@"\b(?:480p|480i|640x480|848x480)\b", 480),
            (@"\b(?:360p|240p)\b", 360),
        ];
        foreach (var (pattern, value) in patterns)
            if (M(t, pattern).Success) return value;
        return null;
    }

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

    /// <summary>library/cursor.resolveHuntCursor — the cursor only; reading it never moves it.</summary>
    public static (int Season, int Episode)? ResolveHuntCursor(string mediaType, int? cursorSeason, int? cursorEpisode,
        int? fromSeason, int? fromEpisode, string? lastEpisode, string? nextEpisodeHint)
    {
        if (!IsSeriesMediaType(mediaType)) return null;
        if (cursorSeason is >= 1 && cursorEpisode is >= 1) return (cursorSeason.Value, cursorEpisode.Value);
        if (!string.IsNullOrWhiteSpace(lastEpisode) && M(lastEpisode, @"S(\d{1,3})E(\d{1,4})") is { Success: true } se)
            return AdvanceCursor(N(se), N(se, 2));
        if (fromSeason is >= 1) return (Math.Max(1, fromSeason.Value), Math.Max(1, fromEpisode is > 0 ? fromEpisode.Value : 1));
        if (!string.IsNullOrWhiteSpace(nextEpisodeHint))
        {
            var parsed = ParseEpisode(nextEpisodeHint.Trim());
            if (parsed.Season != null && parsed.Episode != null) return (parsed.Season.Value, parsed.Episode.Value);
        }
        return null;
    }

    // ---------------------------------------------------------------- episodes

    /// <summary>episodes.parseEpisode (season/episode/pack shape only; labels are not needed here).</summary>
    public static EpisodeInfo ParseEpisode(string title)
    {
        var parsed = ParseBase(title);
        return parsed with { IsMultiSeason = parsed.IsMultiSeason ?? false };
    }

    private static EpisodeInfo Single(int? season, int episode) => new() { Season = season, Episode = episode };

    private static EpisodeInfo Pack(int? season, int? end = null) =>
        new() { Season = season, IsBatch = true, IsSeasonPack = true, IsMultiSeason = end != null && end != season };

    private static EpisodeInfo ParseBase(string t)
    {
        var m = M(t, @"\b(\d{1,3})(?:st|nd|rd|th)\s+Season\s*[-–—]\s*(\d{1,4})\b");
        if (m.Success) return Single(N(m), N(m, 2));
        m = M(t, @"\bS(?:easons?|eries)?[\s._]*\d{1,3}(?:\s*(?:[-–—~+&,]|\band\b|\bto\b|\bplus\b)\s*(?:S(?:easons?|eries)?[\s._]*)?\d{1,3}(?!\d))+");
        if (!m.Success) m = M(t, @"\b(?:Seasons?|Series)\s+(\d{1,3}(?:\s+\d{1,3}){2,})\b");
        if (m.Success)
        {
            var nums = Regex.Matches(m.Value, @"\d{1,3}").Select(x => int.Parse(x.Value, CultureInfo.InvariantCulture)).ToArray();
            return Pack(nums[0], nums[^1]);
        }
        if (M(t, @"\b(complete|batch|season\s*pack)\b").Success)
        {
            m = M(t, @"\bS(?:eason)?\s*(\d{1,3})\b");
            return Pack(m.Success ? N(m) : null);
        }
        m = M(t, @"\bS(\d{1,3})\s*E(\d{1,4})\b");
        if (!m.Success) m = M(t, @"\b(\d{1,2})x(\d{1,4})\b");
        if (m.Success) return Single(N(m), N(m, 2));
        var season = M(t, @"\bS(?:eason)?\s*(\d{1,3})\b");
        int? s = season.Success ? N(season) : null;
        m = M(t, @"\b(?:episode|ep|e)\s*\.?\s*(\d{1,4})\b");
        if (m.Success) return Single(s, N(m));
        m = M(t, @"[-–]\s*(\d{1,4})\s*(?=\.(?:mkv|mp4|avi|m4v|ts)\s*$|[\[(]|$|\b(?:480p|720p|1080p|2160p|4k|web-?dl|webrip|bluray|hdtv)\b)");
        if (m.Success && N(m) > 0 && N(m) is not (>= 1900 and <= 2100)) return Single(s, N(m));
        if (M(t, @"^\s*\[[^\]]+\]").Success)
        {
            var after = R(t, @"^\s*\[[^\]]+\]\s*", "");
            m = M(after, @"\s(\d{3,4})(?=\s|$|[\[(.])");
            if (m.Success && N(m) > 0 && N(m) is not (>= 1900 and <= 2100)
                && !M(after[(m.Index + m.Length)..], @"^\s*(?:years?|yrs?|nen|ans?|days?)\b").Success
                && !(N(m) == 300 && M(after, @"\bslime[\s._-]*300\b").Success))
                return Single(s, N(m));
        }
        m = M(t, @"\bS(\d{1,3})\b(?!\s*E\d)");
        if (!m.Success) m = M(t, @"\b(?:Seasons?|Series)[\s._]*(\d{1,3})\b");
        return m.Success ? Pack(N(m)) : new();
    }

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
