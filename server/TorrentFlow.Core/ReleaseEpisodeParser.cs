using System.Globalization;
using System.Text.RegularExpressions;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Core;

public static class ReleaseEpisodeParser
{
    private static readonly Lock Gate = new();
    private static readonly Dictionary<string, Regex> Patterns = new(StringComparer.Ordinal);
    private static Regex Pattern(string pattern)
    {
        lock (Gate)
        {
            if (Patterns.TryGetValue(pattern, out var regex)) return regex;
            regex = new(pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
            if (Patterns.Count >= 128) Patterns.Remove(Patterns.Keys.First());
            Patterns.Add(pattern, regex);
            return regex;
        }
    }
    private static Match M(string title, string pattern) => Pattern(pattern).Match(title);
    private static int N(Match m, int group = 1) => int.Parse(m.Groups[group].Value, CultureInfo.InvariantCulture);

    public static string? SpecialType(string title)
    {
        var t = Pattern(@"[._-]+").Replace(title, " ");
        foreach (var (pattern, name) in new[] { (@"\b(?:ova|oad)\b", "ova"), (@"\brecap\b", "recap"), (@"\bmovie\b", "movie"), (@"\bspecials?\b", "special") })
            if (M(t, pattern).Success) return name;
        return null;
    }

    public static EpisodeInfo Parse(string? title)
    {
        var t = title ?? "";
        var parsed = ParseBase(t);
        return parsed with { SpecialType = SpecialType(t), IsMultiSeason = parsed.IsMultiSeason ?? false };
    }
    private static EpisodeInfo Single(int? season, int episode, bool scene = false) => new()
    {
        Season = season, Episode = episode,
        Label = season == null ? $"Ep {episode}" : scene ? $"S{season:00}E{episode:00}" : $"S{season:00} Ep {episode}"
    };
    private static EpisodeInfo Pack(int? season, int? end = null) => new()
    {
        Season = season, IsBatch = true, IsSeasonPack = true, IsMultiSeason = end != null && end != season,
        Label = season == null ? "Batch" : end != null && end != season ? $"S{season:00}-S{end:00} pack" : $"S{season:00} pack"
    };

    private static EpisodeInfo ParseBase(string t)
    {
        var complete = M(t, @"\b(complete|batch|season\s*pack)\b").Success;
        var m = M(t, @"\b(\d{1,3})(?:st|nd|rd|th)\s+Season\s*[-–—]\s*(\d{1,4})(?:v\d+)?\b");
        if (!m.Success)
            m = M(t, @"\b(?:S|Season)\s*(\d{1,3})\s+[-–—]\s+(\d{1,4})(?:v\d+)?(?=\s|[\[(.]|$)");
        if (m.Success && !complete)
        {
            var result = Single(N(m), N(m, 2), true);
            var absolute = M(t, @"\b(?:absolute\s*)?(?:episode|ep)\s*\.?\s*(\d{1,4})\b");
            return absolute.Success && N(absolute) != result.Episode
                ? result with { AbsoluteEpisode = N(absolute), Label = $"{result.Label} · absolute {N(absolute)}" } : result;
        }
        m = M(t, @"\bS(?:easons?|eries)?[\s._]*\d{1,3}(?:\s*(?:[-–—~+&,]|\band\b|\bto\b|\bplus\b)\s*(?:S(?:easons?|eries)?[\s._]*)?\d{1,3}(?!\d))+");
        if (!m.Success) m = M(t, @"\b(?:Seasons?|Series)\s+(\d{1,3}(?:\s+\d{1,3}){2,})\b");
        if (m.Success)
        {
            var nums = Pattern(@"\d{1,3}").Matches(m.Value).Select(x => int.Parse(x.Value, CultureInfo.InvariantCulture)).ToArray();
            return Pack(nums[0], nums[^1]);
        }
        if (complete)
        {
            var number = M(t, @"\bS(?:eason)?\s*(\d{1,3})\b");
            return Pack(number.Success ? N(number) : null);
        }
        var season = M(t, @"\bS(?:eason)?\s*(\d{1,3})\b");
        int? s = season.Success ? N(season) : null;
        // Check before dash singles: otherwise "01-12" is read as episode 12.
        var range = M(t, @"(?<![\p{L}\p{N}])(\d{1,4})(?:v\d+)?\s*[-–—~]\s*(\d{1,4})(?:v\d+)?(?=\s|[\])]|$|\.(?:mkv|mp4|avi|m4v|ts)\b)");
        if (range.Success && N(range) > 0 && N(range, 2) > N(range)
            && N(range) is not (>= 1900 and <= 2100))
            return Pack(s);
        m = M(t, @"\bS(\d{1,3})[\s._]*E(\d{1,4})(?:v\d+)?\b");
        if (!m.Success) m = M(t, @"\b(\d{1,2})x(\d{1,4})(?:v\d+)?\b");
        if (m.Success) return Single(N(m), N(m, 2), true);
        m = M(t, @"\b(?:episode|ep|e)\s*\.?\s*(\d{1,4})(?:v\d+)?\b");
        if (m.Success) return Single(s, N(m));
        // Bracket numbers and spaced dash numbers are episodes, not the unspaced S01-S03 season range.
        m = M(t, @"[-–—]\s*(\d{1,4})(?:v\d+)?\s*(?=\.(?:mkv|mp4|avi|m4v|ts)\s*$|[\[(]|$|\b(?:480p|720p|1080p|2160p|4k|web-?dl|webrip|bluray|hdtv)\b)");
        if (!m.Success) m = M(t, @"\[(\d{1,4})(?:v\d+)?\](?=\s*(?:[\[(]|\.(?:mkv|mp4|avi)|$))");
        if (m.Success && N(m) > 0 && N(m) is not (>= 1900 and <= 2100)) return Single(s, N(m));
        if (M(t, @"^\s*\[[^\]]+\]").Success)
        {
            var after = Pattern(@"^\s*\[[^\]]+\]\s*").Replace(t, "");
            m = M(after, @"\s(\d{3,4})(?:v\d+)?(?=\s|$|[\[(.])");
            if (m.Success && N(m) > 0 && N(m) is not (>= 1900 and <= 2100)
                && !M(after[(m.Index + m.Length)..], @"^\s*(?:years?|yrs?|nen|ans?|days?)\b").Success
                && !(N(m) == 300 && M(after, @"\bslime[\s._-]*300\b").Success))
                return Single(s, N(m));
        }
        m = M(t, @"\bS(\d{1,3})\b(?!\s*E\d)");
        if (!m.Success) m = M(t, @"\b(?:Seasons?|Series)[\s._]*(\d{1,3})\b");
        return m.Success ? Pack(N(m)) : new();
    }
}
