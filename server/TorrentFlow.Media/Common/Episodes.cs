using System.Globalization;
using System.Text.RegularExpressions;

namespace TorrentFlow.Media.Common;

internal sealed record ParsedEpisode(int? Season, int? Episode, string? Label, bool IsBatch, bool IsSeasonPack, bool IsMultiSeason,
    int? AbsoluteEpisode = null, string? SpecialType = null);

/// <summary>Port of parseEpisode in src/lib/torrents/episodes.ts (branch order is load-bearing).</summary>
internal static partial class Episodes
{
    private static string Pad(int n) => n.ToString("00", CultureInfo.InvariantCulture);
    private static int I(Group g) => int.Parse(g.Value, CultureInfo.InvariantCulture);

    public static ParsedEpisode Parse(string title)
    {
        var parsed = ParseBase(title);
        var special = ClassifySpecial(title);
        return special is null ? parsed : parsed with { SpecialType = special };
    }

    public static string? ClassifySpecial(string title)
    {
        var n = SpecialSepRe().Replace(title, " ").ToLowerInvariant();
        if (OvaRe().IsMatch(n)) return "ova";
        if (RecapRe().IsMatch(n)) return "recap";
        if (MovieRe().IsMatch(n)) return "movie";
        if (SpecialRe().IsMatch(n)) return "special";
        return null;
    }

    private static ParsedEpisode ParseBase(string t)
    {
        var m = OrdinalSeasonRe().Match(t);
        if (m.Success)
        {
            int s = I(m.Groups[1]), e = I(m.Groups[2]);
            var abs = AbsoluteRe().Match(t);
            if (abs.Success && I(abs.Groups[1]) != e)
                return new(s, e, $"S{Pad(s)}E{Pad(e)} · absolute {I(abs.Groups[1])}", false, false, false, I(abs.Groups[1]));
            return new(s, e, $"S{Pad(s)}E{Pad(e)}", false, false, false);
        }

        m = SeasonRangeRe().Match(t);
        if (m.Success)
        {
            var nums = DigitsRe().Matches(m.Value).Select(x => int.Parse(x.Value, CultureInfo.InvariantCulture)).ToList();
            int from = nums[0], to = nums[^1];
            var multi = nums.Any(n => n != from);
            return new(from, null, multi ? $"S{Pad(from)}-S{Pad(to)} pack" : $"S{Pad(from)} pack", true, true, multi);
        }

        m = SeasonListRe().Match(t);
        if (m.Success)
        {
            var nums = WhitespaceRe().Split(m.Groups[1].Value.Trim()).Select(x => int.Parse(x, CultureInfo.InvariantCulture)).ToList();
            if (nums.Count >= 3) return new(nums[0], null, $"S{Pad(nums[0])}-S{Pad(nums[^1])} pack", true, true, true);
        }

        if (CompleteRe().IsMatch(t))
        {
            var sm = LooseSeasonRe().Match(t);
            return new(sm.Success ? I(sm.Groups[1]) : null, null, sm.Success ? $"S{Pad(I(sm.Groups[1]))} pack" : "Batch", true, true, false);
        }

        m = SxxExxRe().Match(t);
        if (m.Success) return new(I(m.Groups[1]), I(m.Groups[2]), $"S{Pad(I(m.Groups[1]))}E{Pad(I(m.Groups[2]))}", false, false, false);

        m = XFormRe().Match(t);
        if (m.Success) return new(I(m.Groups[1]), I(m.Groups[2]), $"S{Pad(I(m.Groups[1]))}E{Pad(I(m.Groups[2]))}", false, false, false);

        m = EpThenSeasonRe().Match(t);
        if (m.Success) return new(I(m.Groups[2]), I(m.Groups[1]), $"S{Pad(I(m.Groups[2]))} Ep {I(m.Groups[1])}", false, false, false);

        m = SeasonThenEpRe().Match(t);
        if (m.Success) return new(I(m.Groups[1]), I(m.Groups[2]), $"S{Pad(I(m.Groups[1]))} Ep {I(m.Groups[2])}", false, false, false);

        m = BareEpisodeRe().Match(t);
        if (m.Success) return WithLooseSeason(t, I(m.Groups[1]));

        m = DashAbsoluteRe().Match(t);
        if (m.Success)
        {
            var e = I(m.Groups[1]);
            if (e > 0 && e < 10000 && !(e >= 1900 && e <= 2100)) return WithLooseSeason(t, e);
        }

        if (FansubTagRe().IsMatch(t))
        {
            var after = FansubStripRe().Replace(t, "", 1);
            var bare = FansubBareRe().Match(after);
            if (bare.Success)
            {
                var e = I(bare.Groups[1]);
                var following = TitleUnitRe().IsMatch(after[(bare.Index + bare.Length)..]);
                var known = e == 300 && Slime300Re().IsMatch(after);
                if (e > 0 && !(e >= 1900 && e <= 2100) && !following && !known) return WithLooseSeason(after, e);
            }
        }

        m = StandaloneSeasonRe().Match(t);
        if (m.Success) return new(I(m.Groups[1]), null, $"S{Pad(I(m.Groups[1]))} pack", true, true, false);

        m = SeasonWordRe().Match(t);
        if (m.Success) return new(I(m.Groups[1]), null, $"S{Pad(I(m.Groups[1]))} pack", true, true, false);

        return new(null, null, null, false, false, false);
    }

    private static ParsedEpisode WithLooseSeason(string source, int episode)
    {
        var sm = LooseSeasonRe().Match(source);
        return sm.Success
            ? new(I(sm.Groups[1]), episode, $"S{Pad(I(sm.Groups[1]))} Ep {episode}", false, false, false)
            : new(null, episode, $"Ep {episode}", false, false, false);
    }

    [GeneratedRegex(@"\b(\d{1,3})(?:st|nd|rd|th)\s+Season\s*[-–—]\s*(\d{1,4})\b", RegexOptions.IgnoreCase)] private static partial Regex OrdinalSeasonRe();
    [GeneratedRegex(@"\b(?:absolute\s*)?(?:episode|ep)\s*\.?\s*(\d{1,4})\b", RegexOptions.IgnoreCase)] private static partial Regex AbsoluteRe();
    [GeneratedRegex(@"\bS(?:easons?|eries)?[\s._]*\d{1,3}(?:\s*(?:[-–—~+&,]|\band\b|\bto\b|\bplus\b)\s*(?:S(?:easons?|eries)?[\s._]*)?\d{1,3}(?!\d))+", RegexOptions.IgnoreCase)] private static partial Regex SeasonRangeRe();
    [GeneratedRegex(@"\d{1,3}")] private static partial Regex DigitsRe();
    [GeneratedRegex(@"\s+")] private static partial Regex WhitespaceRe();
    [GeneratedRegex(@"\b(?:Seasons?|Series)\s+(\d{1,3}(?:\s+\d{1,3}){2,})\b", RegexOptions.IgnoreCase)] private static partial Regex SeasonListRe();
    [GeneratedRegex(@"\b(complete|batch|season\s*pack|seasons?\s*\d+\s*[-–]\s*\d+)\b", RegexOptions.IgnoreCase)] private static partial Regex CompleteRe();
    [GeneratedRegex(@"\bS(?:eason)?\s*(\d{1,3})\b", RegexOptions.IgnoreCase)] private static partial Regex LooseSeasonRe();
    [GeneratedRegex(@"\bS(\d{1,3})\s*E(\d{1,4})\b", RegexOptions.IgnoreCase)] private static partial Regex SxxExxRe();
    [GeneratedRegex(@"\b(\d{1,2})x(\d{1,4})\b", RegexOptions.IgnoreCase)] private static partial Regex XFormRe();
    [GeneratedRegex(@"\b(?:episode|ep)\s*\.?\s*(\d{1,4})\b[\s._-]*\bS(?:eason)?\s*(\d{1,3})\b", RegexOptions.IgnoreCase)] private static partial Regex EpThenSeasonRe();
    [GeneratedRegex(@"\bS(?:eason)?\s*(\d{1,3})\b[\s._-]*(?:episode|ep)\s*\.?\s*(\d{1,4})\b", RegexOptions.IgnoreCase)] private static partial Regex SeasonThenEpRe();
    [GeneratedRegex(@"\b(?:episode|ep|e)\s*\.?\s*(\d{1,4})\b", RegexOptions.IgnoreCase)] private static partial Regex BareEpisodeRe();
    [GeneratedRegex(@"[-–]\s*(\d{1,4})\s*(?=\.(?:mkv|mp4|avi|m4v|ts)\s*$|[\[(]|$|\b(?:480p|720p|1080p|2160p|4k|web-?dl|webrip|bluray|hdtv)\b)", RegexOptions.IgnoreCase)] private static partial Regex DashAbsoluteRe();
    [GeneratedRegex(@"^\s*\[[^\]]+\]")] private static partial Regex FansubTagRe();
    [GeneratedRegex(@"^\s*\[[^\]]+\]\s*")] private static partial Regex FansubStripRe();
    [GeneratedRegex(@"\s(\d{3,4})(?=\s|$|[\[(.])")] private static partial Regex FansubBareRe();
    [GeneratedRegex(@"^\s*(?:years?|yrs?|nen|ans?|days?)\b", RegexOptions.IgnoreCase)] private static partial Regex TitleUnitRe();
    [GeneratedRegex(@"\bslime[\s._-]*300\b", RegexOptions.IgnoreCase)] private static partial Regex Slime300Re();
    [GeneratedRegex(@"\bS(\d{1,3})\b(?!\s*E\d)", RegexOptions.IgnoreCase)] private static partial Regex StandaloneSeasonRe();
    [GeneratedRegex(@"\b(?:Seasons?|Series)[\s._]*(\d{1,3})\b", RegexOptions.IgnoreCase)] private static partial Regex SeasonWordRe();
    [GeneratedRegex(@"[._-]+")] private static partial Regex SpecialSepRe();
    [GeneratedRegex(@"\b(?:ova|oad)\b")] private static partial Regex OvaRe();
    [GeneratedRegex(@"\brecap\b")] private static partial Regex RecapRe();
    [GeneratedRegex(@"\bmovie\b")] private static partial Regex MovieRe();
    [GeneratedRegex(@"\bspecials?\b")] private static partial Regex SpecialRe();
}
