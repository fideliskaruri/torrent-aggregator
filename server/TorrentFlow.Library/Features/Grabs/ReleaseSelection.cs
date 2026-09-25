using System.Text.RegularExpressions;
using System.Globalization;
using System.Text;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Features.Grabs;

public static class ReleaseSelection
{
    public static string CleanTitle(string raw)
    {
        raw = Regex.Replace(raw, @"^\[[^\]]+\]\s*", "");
        raw = Regex.Replace(raw, @"(?i)^(?:www\.)?[\w.-]+\.(?:com|org|net|to|me|tv)\s*[-:]\s*", "");
        raw = Regex.Split(raw, @"(?i)\b(?:S\d{1,3}(?:[ ._-]*E\d+)*|\d{1,2}x\d{1,3}|Season\s+\d+|(?:480|720|1080|2160)p|WEB[ .-]?DL|WEBRip|BluRay|HDTV|HEVC|x26[45])\b|\s-\s\d{1,4}(?:\s|$|\[)")[0];
        foreach (Match match in Regex.Matches(raw, @"\b(?:19|20)\d{2}\b"))
        {
            if (match.Index > 0 && int.Parse(match.Value) <= DateTime.UtcNow.Year + 5) { raw = raw[..match.Index]; break; }
        }
        return Regex.Replace(raw.Replace('.', ' ').Replace('_', ' '), @"\s+", " ").Trim(' ', '-', '[', '(');
    }
    public static string Normalize(string raw) => Regex.Replace(raw.ToLowerInvariant(), @"[^\p{L}\p{N}]+", "");
    public static string WorkKey(string title, int? year = null)
    {
        var folded = string.Concat(title.Normalize(NormalizationForm.FormKD)
            .Where(c => CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark));
        // The host uses invariant globalization, where Normalize can be a no-op.
        const string accented = "ÀÁÂÃÄÅàáâãäåÈÉÊËèéêëÌÍÎÏìíîïÒÓÔÕÖòóôõöÙÚÛÜùúûüÝŸýÿÇçÑñ";
        const string ascii =    "AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuYYyyCcNn";
        folded = string.Concat(folded.Select(c => accented.IndexOf(c) is var i && i >= 0 ? ascii[i] : c));
        folded = Regex.Replace(folded, "['’`]", "").ToLowerInvariant();
        var slug = Regex.Replace(folded, "[^a-z0-9]+", "-").Trim('-');
        if (slug.Length == 0) slug = Uri.EscapeDataString(Regex.Replace(title.Trim().ToLowerInvariant(), @"\s+", "-"));
        return slug + (year == null ? "" : $"-{year}");
    }
    public static bool MatchesWork(string key, string title, int? year = null)
    {
        var plain = WorkKey(title);
        return key == WorkKey(title, year) || key == plain || (year == null && Regex.IsMatch(key, $"^{Regex.Escape(plain)}-(?:19|20)\\d{{2}}$"));
    }
    public static int? Resolution(string title)
    {
        var match = Regex.Match(title, @"(?i)\b(480|720|1080|2160)p\b");
        return match.Success ? int.Parse(match.Groups[1].Value) : Regex.IsMatch(title, @"(?i)\b4k\b") ? 2160 : null;
    }
    public static bool MeetsFloor(string title, int? floor) => floor == null || Resolution(title) >= floor;
    public static int? Year(string title)
    {
        var years = Regex.Matches(title, @"\b((?:19|20)\d{2})\b").Where(x => x.Index > 0 && int.Parse(x.Value) <= DateTime.UtcNow.Year + 5).ToArray();
        return years.Length > 0 ? int.Parse(years[^1].Value) : null;
    }
    public static bool ExactEpisode(TorrentResult result, EpisodeCursor cursor)
    {
        if (result.Episode?.IsSeasonPack == true || result.Episode?.IsBatch == true || result.Episode?.IsMultiSeason == true) return false;
        var parsed = EpisodeCursor.Parse(result.Title);
        var alternate = Regex.Match(result.Title, @"(?i)\b(\d{1,2})x(\d{1,3})\b");
        if (parsed == null && alternate.Success) parsed = new(int.Parse(alternate.Groups[1].Value), int.Parse(alternate.Groups[2].Value));
        if (parsed != null) return parsed == cursor && !Regex.IsMatch(result.Title, @"(?i)E\d+\s*(?:-E?|E)\d+");
        if (result.Episode?.Episode is { } ep) return ep == cursor.Episode && (result.Episode.Season ?? 1) == cursor.Season;
        var absolute = Regex.Match(result.Title, @"\s-\s(\d{1,4})(?:\s|\.|\[)");
        return cursor.Season == 1 && absolute.Success && int.Parse(absolute.Groups[1].Value) == cursor.Episode;
    }
    public static bool SameWork(TorrentResult result, string title, IReadOnlyList<string> aliases)
    {
        var name = Normalize(CleanTitle(result.Title));
        var names = aliases.Prepend(title).Select(x => Normalize(CleanTitle(x))).ToHashSet();
        return names.Contains(name);
    }
}
