using System.Text.RegularExpressions;
using System.Text.Json.Serialization;
using TorrentFlow.Core.Contracts.Search;
using static TorrentFlow.Search.EpisodeParser;

namespace TorrentFlow.Search;

public sealed record PackFile(string Path, long? Size = null);
public sealed record SeasonCoverage(string Kind, int? From = null, int? To = null);
public sealed record EpisodeRange(int From, int To);
public sealed record SingleChoice(TorrentResult Release, string Verdict, int Episode);
public sealed record SeasonPlan(int Season, int[] Wanted,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] object? Pack,
    SingleChoice[] Singles, int[] Covered, int[] Missing, string CoverageLabel, bool CoverageConfirmed, string Reason);

public static class EpisodeSelection
{
    public static bool IsEpisodeRange(string title) => Match(title,
        @"\bS\d{1,3}\s*E\d{1,4}\s*[-–—~]\s*(?:S\d{1,3}\s*)?E?\d{1,4}\b|\b\d{1,3}x\d{1,4}\s*[-–—~]\s*(?:\d{1,3}x)?\d{1,4}\b|\b(?:episodes?|eps?|e)\s*\.?\s*\d{1,4}\s*[-–—~]\s*(?:episodes?|eps?|e)?\s*\.?\s*\d{1,4}\b").Success;
    public static SeasonCoverage? Coverage(string title, EpisodeInfo? episode = null)
    {
        var ep = episode ?? Parse(title);
        if (!ep.IsSeasonPack && !ep.IsBatch) return null;
        var m = Match(title, @"\bS(?:easons?|eries)?[\s._]*\d{1,3}(?:\s*(?:[-–—~+&,]|\band\b|\bto\b|\bplus\b)\s*(?:S(?:easons?|eries)?[\s._]*)?\d{1,3}(?!\d))+");
        if (m.Success)
        {
            var nums = Regex.Matches(m.Value, @"\d{1,3}").Select(n => int.Parse(n.Value)).Where(n => n >= 1).ToArray();
            if (nums.Length >= 2) return new("multi", nums.Min(), nums.Max());
        }
        return ep.Season != null ? new("single", ep.Season, ep.Season) : new("unknown-complete");
    }
    public static bool MatchesTarget(TorrentResult result, int season, int episode)
    {
        var ep = result.Episode ?? Parse(result.Title);
        return !ep.IsBatch && !ep.IsSeasonPack && ep.IsMultiSeason != true && !IsEpisodeRange(result.Title)
            && ep.Episode == episode && (ep.Season == season || ep.Season == null && season == 1);
    }
    public static TorrentResult? SelectCandidate(IEnumerable<TorrentResult> results, int season, int episode) =>
        results.FirstOrDefault(r => !string.IsNullOrEmpty(r.Magnet) && r.Seeders > 0 && MatchesTarget(r, season, episode));
    public static EpisodeRange? PackRange(string title)
    {
        foreach (var pattern in new[] { @"E(\d{1,4})\s*[-–—]\s*E?(\d{1,4})\b", @"\bEpisodes?\s*(\d{1,4})\s*[-–—]\s*(\d{1,4})\b" })
        {
            var m = Match(title, pattern);
            if (!m.Success) continue;
            var from = int.Parse(m.Groups[1].Value); var to = int.Parse(m.Groups[2].Value);
            if (from >= 1 && to > from && to - from < 200) return new(from, to);
        }
        return null;
    }
    public static int[] EpisodesFromFilenames(IEnumerable<string> names, int season) => names.Where(TorrentFilters.IsVideo)
        .Select(name => Parse(Regex.Split(name, @"[\\/]").Last()))
        .Where(e => !e.IsSeasonPack && e.Episode != null && (e.Season == null || e.Season == season))
        .Select(e => e.Episode!.Value).Distinct().Order().ToArray();
    public static IReadOnlyDictionary<int, string> PackFiles(IEnumerable<PackFile> files, int season)
    {
        Dictionary<int, (string Path, long Size)> best = [];
        foreach (var file in files)
        {
            if (string.IsNullOrEmpty(file.Path) || !TorrentFilters.IsVideo(file.Path)) continue;
            var segments = Regex.Split(file.Path, @"[\\/]+").Where(s => s.Length > 0).ToArray();
            if (segments.Any(s => Match(Replace(s, @"[._-]+"), @"\b(?:featurettes?|extras?|specials?|samples?|behind the scenes|animatics?)\b").Success)) continue;
            var ep = Parse(segments.LastOrDefault() ?? file.Path);
            if (ep.Season != season || ep.Episode == null || ep.IsSeasonPack || ep.IsMultiSeason == true) continue;
            var size = Math.Max(0, file.Size ?? 0);
            if (!best.TryGetValue(ep.Episode.Value, out var prior) || size > prior.Size) best[ep.Episode.Value] = (file.Path, size);
        }
        return best.ToDictionary(p => p.Key, p => p.Value.Path);
    }
    public static SeasonPlan Plan(int season, IEnumerable<int> wantedEpisodes, IEnumerable<TorrentResult> releases,
        Func<TorrentResult, string> verdictOf, int? preferredResolution = null)
    {
        var wanted = wantedEpisodes.Where(e => e >= 1).Distinct().Order().ToArray();
        SeasonPlan Empty(string reason) => new(season, wanted, null, [], [], wanted, $"0 of {wanted.Length} episodes", true, reason);
        if (wanted.Length == 0) return Empty("No episodes requested");
        var candidates = releases.Select((r, i) => new { Release = r, Index = i, Episode = r.Episode ?? Parse(r.Title) })
            .Where(c => !string.IsNullOrEmpty(c.Release.Magnet) && c.Release.Seeders > 0
                && (InfoHash.Normalize(c.Release.InfoHash) ?? InfoHash.FromMagnet(c.Release.Magnet)) != null
                && !IsEpisodeRange(c.Release.Title) && Coverage(c.Release.Title, c.Episode) == null
                && c.Episode.Season == season && c.Episode.Episode != null && wanted.Contains(c.Episode.Episode.Value))
            .Select(c => new { c.Release, c.Index, Episode = c.Episode.Episode!.Value, Verdict = verdictOf(c.Release) }).ToArray();
        if (candidates.Length == 0) return Empty("No usable releases found for this season");
        var singles = wanted.Select(ep => candidates.Where(c => c.Episode == ep)
            .OrderByDescending(c => ReleaseQuality.ScoreRelease(c.Verdict, c.Release.Title, preferredResolution is > 0 ? preferredResolution : null))
            .ThenBy(c => c.Index).FirstOrDefault()).Where(c => c != null)
            .Select(c => new SingleChoice(c!.Release, c.Verdict, c.Episode)).ToArray();
        var covered = singles.Select(s => s.Episode).ToArray();
        var missing = wanted.Except(covered).ToArray();
        var reason = $"Assembling {singles.Length} episode(s) from individual releases";
        if (missing.Length > 0) reason += "; missing E" + string.Join(", E", missing.Select(e => e.ToString("00")));
        return new(season, wanted, null, singles, covered, missing, $"{covered.Length} of {wanted.Length} episodes", true, reason);
    }
}
