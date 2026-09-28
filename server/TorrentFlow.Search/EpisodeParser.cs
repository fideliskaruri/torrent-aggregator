using System.Globalization;
using System.Text.RegularExpressions;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Search;

public static class EpisodeParser
{
    private const int MaxPatterns = 256;
    private static readonly Lock RegexGate = new();
    private static readonly Dictionary<(string Pattern, string Culture), Regex> Patterns = new();

    // Ranking uses more patterns than the runtime's small static Regex cache can retain.
    private static Regex Pattern(string pattern)
    {
        lock (RegexGate)
        {
            var key = (pattern, CultureInfo.CurrentCulture.Name);
            if (Patterns.TryGetValue(key, out var regex)) return regex;
            regex = new Regex(pattern, RegexOptions.IgnoreCase, TimeSpan.FromSeconds(1));
            if (Patterns.Count >= MaxPatterns) Patterns.Remove(Patterns.Keys.First());
            Patterns.Add(key, regex);
            return regex;
        }
    }

    internal static Match Match(string value, string pattern) => Pattern(pattern).Match(value);
    internal static string Replace(string value, string pattern, string replacement = " ") => Pattern(pattern).Replace(value, replacement);
    public static string? SpecialType(string title) => TorrentFlow.Core.ReleaseEpisodeParser.SpecialType(title);
    public static EpisodeInfo Parse(string title) => TorrentFlow.Core.ReleaseEpisodeParser.Parse(title);
    public static string? SeasonFolder(EpisodeInfo episode) => episode.Season is null || episode.IsMultiSeason == true ? null : $"Season {episode.Season:00}";
    public static string NextQuery(string title, string? lastEpisode)
    {
        var parsed = Parse(lastEpisode ?? "");
        return parsed.Episode is null ? title : parsed.Season is null ? $"{title} {parsed.Episode + 1}" : $"{title} S{parsed.Season:00}E{parsed.Episode + 1:00}";
    }
}
