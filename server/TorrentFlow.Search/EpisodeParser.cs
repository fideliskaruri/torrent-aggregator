using System.Text.RegularExpressions;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Search;

public static class EpisodeParser
{
    internal static Match Match(string value, string pattern) => Regex.Match(value, pattern, RegexOptions.IgnoreCase, TimeSpan.FromSeconds(1));
    internal static string Replace(string value, string pattern, string replacement = " ") => Regex.Replace(value, pattern, replacement, RegexOptions.IgnoreCase, TimeSpan.FromSeconds(1));
    private static int N(Match m, int group = 1) => int.Parse(m.Groups[group].Value);
    public static string? SpecialType(string title)
    {
        var t = Replace(title, @"[._-]+");
        foreach (var (pattern, name) in new[] { (@"\b(?:ova|oad)\b", "ova"), (@"\brecap\b", "recap"), (@"\bmovie\b", "movie"), (@"\bspecials?\b", "special") })
            if (Match(t, pattern).Success) return name;
        return null;
    }
    public static EpisodeInfo Parse(string title)
    {
        var parsed = ParseBase(title);
        return parsed with { SpecialType = SpecialType(title), IsMultiSeason = parsed.IsMultiSeason ?? false };
    }
    private static EpisodeInfo Single(int? season, int episode, bool scene = false) => new()
    {
        Season = season, Episode = episode,
        Label = season is null ? $"Ep {episode}" : scene ? $"S{season:00}E{episode:00}" : $"S{season:00} Ep {episode}"
    };
    private static EpisodeInfo Pack(int? season, int? end = null) => new()
    {
        Season = season, IsBatch = true, IsSeasonPack = true, IsMultiSeason = end != null && end != season,
        Label = season == null ? "Batch" : end != null && end != season ? $"S{season:00}-S{end:00} pack" : $"S{season:00} pack"
    };
    private static EpisodeInfo ParseBase(string t)
    {
        var m = Match(t, @"\b(\d{1,3})(?:st|nd|rd|th)\s+Season\s*[-–—]\s*(\d{1,4})\b");
        if (m.Success)
        {
            var result = Single(N(m), N(m, 2), true);
            var absolute = Match(t, @"\b(?:absolute\s*)?(?:episode|ep)\s*\.?\s*(\d{1,4})\b");
            return absolute.Success && N(absolute) != result.Episode
                ? result with { AbsoluteEpisode = N(absolute), Label = $"{result.Label} · absolute {N(absolute)}" } : result;
        }
        m = Match(t, @"\bS(?:easons?|eries)?[\s._]*\d{1,3}(?:\s*(?:[-–—~+&,]|\band\b|\bto\b|\bplus\b)\s*(?:S(?:easons?|eries)?[\s._]*)?\d{1,3}(?!\d))+");
        if (!m.Success) m = Match(t, @"\b(?:Seasons?|Series)\s+(\d{1,3}(?:\s+\d{1,3}){2,})\b");
        if (m.Success)
        {
            var nums = Regex.Matches(m.Value, @"\d{1,3}").Select(x => int.Parse(x.Value)).ToArray();
            return Pack(nums[0], nums[^1]);
        }
        if (Match(t, @"\b(complete|batch|season\s*pack)\b").Success)
        {
            m = Match(t, @"\bS(?:eason)?\s*(\d{1,3})\b");
            return Pack(m.Success ? N(m) : null);
        }
        m = Match(t, @"\bS(\d{1,3})\s*E(\d{1,4})\b");
        if (!m.Success) m = Match(t, @"\b(\d{1,2})x(\d{1,4})\b");
        if (m.Success) return Single(N(m), N(m, 2), true);
        var season = Match(t, @"\bS(?:eason)?\s*(\d{1,3})\b");
        int? s = season.Success ? N(season) : null;
        m = Match(t, @"\b(?:episode|ep|e)\s*\.?\s*(\d{1,4})\b");
        if (m.Success) return Single(s, N(m));
        m = Match(t, @"[-–]\s*(\d{1,4})\s*(?=\.(?:mkv|mp4|avi|m4v|ts)\s*$|[\[(]|$|\b(?:480p|720p|1080p|2160p|4k|web-?dl|webrip|bluray|hdtv)\b)");
        if (m.Success && N(m) > 0 && N(m) is not (>= 1900 and <= 2100)) return Single(s, N(m));
        if (Match(t, @"^\s*\[[^\]]+\]").Success)
        {
            var after = Replace(t, @"^\s*\[[^\]]+\]\s*", "");
            m = Match(after, @"\s(\d{3,4})(?=\s|$|[\[(.])");
            if (m.Success && N(m) > 0 && N(m) is not (>= 1900 and <= 2100)
                && !Match(after[(m.Index + m.Length)..], @"^\s*(?:years?|yrs?|nen|ans?|days?)\b").Success
                && !(N(m) == 300 && Match(after, @"\bslime[\s._-]*300\b").Success))
                return Single(s, N(m));
        }
        m = Match(t, @"\bS(\d{1,3})\b(?!\s*E\d)");
        if (!m.Success) m = Match(t, @"\b(?:Seasons?|Series)[\s._]*(\d{1,3})\b");
        return m.Success ? Pack(N(m)) : new();
    }
    public static string? SeasonFolder(EpisodeInfo episode) => episode.Season is null || episode.IsMultiSeason == true ? null : $"Season {episode.Season:00}";
    public static string NextQuery(string title, string? lastEpisode)
    {
        var parsed = Parse(lastEpisode ?? "");
        return parsed.Episode is null ? title : parsed.Season is null ? $"{title} {parsed.Episode + 1}" : $"{title} S{parsed.Season:00}E{parsed.Episode + 1:00}";
    }
}
