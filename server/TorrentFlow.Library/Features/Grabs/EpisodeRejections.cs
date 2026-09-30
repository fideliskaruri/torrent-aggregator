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

    /// <summary>The episode's failure sentence: what happened and one next step (see <see cref="GrabFailure.FromCandidates"/>).</summary>
    public static string Message(EpisodeCursor cursor, int? floor, IEnumerable<CandidateRejection> candidates,
        bool searchFailed = false) =>
        GrabFailure.FromCandidates(GrabFailure.Subject(null, cursor.Season, cursor.Episode), floor, candidates, searchFailed).Sentence;
}
