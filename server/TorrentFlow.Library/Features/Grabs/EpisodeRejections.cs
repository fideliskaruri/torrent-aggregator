using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Features.Grabs;

public sealed record CandidateRejection(string Title, string Source, IReadOnlyList<string> Reasons);

internal static class EpisodeRejections
{
    public static CandidateRejection Explain(TorrentResult candidate, IReadOnlyList<string> accepted, EpisodeCursor cursor,
        AnimeEpisodeMapping? mapping, int? floor, bool relaxed, string? searchReason = null, int? premiereYear = null)
    {
        var reasons = new List<string>();
        if (!EpisodeLadder.ReleaseMatchesWork(candidate, accepted, premiereYear)) reasons.Add("other_work");
        var ep = candidate.Episode ?? ReleaseNames.ParseEpisode(candidate.Title);
        if (ep.IsBatch || ep.IsSeasonPack || ep.IsMultiSeason == true || ReleaseNames.IsEpisodeRangeRelease(candidate.Title))
            reasons.Add("pack");
        else if (ep.Episode == null) reasons.Add("unknown_episode");
        else if (!EpisodeLadder.MatchesTargetEpisode(candidate, cursor, mapping)) reasons.Add("different_episode");
        if (floor != null)
        {
            var resolution = ReleaseSelection.Resolution(candidate.Title);
            if (resolution == null) reasons.Add("unknown_quality");
            else if (resolution < floor) reasons.Add("below_floor");
        }
        if (string.IsNullOrEmpty(candidate.Magnet)) reasons.Add("no_link");
        if (!relaxed && candidate.Seeders <= 0) reasons.Add("no_seeders");
        if (searchReason == "unsafe") reasons.Insert(0, "unsafe");
        else if (searchReason != null && reasons.Count == 0) reasons.Add("query_filter");
        return new(candidate.Title, candidate.Source, reasons);
    }

    public static string Message(EpisodeCursor cursor, int? floor, IEnumerable<CandidateRejection> candidates,
        bool searchFailed = false)
    {
        var rows = candidates.ToArray();
        var quality = floor == null ? "" : $" at {floor}p or higher";
        var first = $"Couldn't find a release for {cursor.Label}{quality}.";
        if (rows.Length == 0)
            return first + (searchFailed ? " Search could not finish; try again shortly." : " No results were returned; try again later.");
        var counts = rows.GroupBy(r => r.Reasons.FirstOrDefault() ?? "not_selected")
            .Select(g => (Reason: g.Key, Count: g.Count())).OrderByDescending(g => g.Count).ToArray();
        string Label(string reason) => reason switch
        {
            "other_work" => "were a different title",
            "pack" => "were packs rather than single episodes",
            "unknown_episode" => "had no recognizable episode number",
            "different_episode" => "were a different episode",
            "unknown_quality" => "had no recognizable quality",
            "below_floor" => $"were below {floor}p",
            "no_link" => "had no download link",
            "no_seeders" => "had no seeders",
            "unsafe" => "were unsafe files",
            "query_filter" => "did not fit the search",
            "not_selected" => "were not selected",
            _ => "could not be started"
        };
        var details = string.Join("; ", counts.Take(3).Select(g =>
        {
            var label = Label(g.Reason);
            if (g.Count == 1 && label.StartsWith("were ", StringComparison.Ordinal)) label = "was " + label[5..];
            return $"{g.Count} {label}";
        }));
        if (counts.Length > 3) details += $"; {counts.Skip(3).Sum(g => g.Count)} had other mismatches";
        if (searchFailed) details += "; search could not finish";
        return $"{first} {rows.Length} result{(rows.Length == 1 ? "" : "s")} checked: {details}.";
    }
}
