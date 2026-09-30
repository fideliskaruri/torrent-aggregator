using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Library.Features.Grabs;

/// <summary>Why the film selector rejected everything it was given. Counts only (TS FilmRejectionSummary).</summary>
public readonly record struct FilmRejection(int Total, int NoMagnet, int Unseeded, int BelowFloor, int OtherWork, int PackOrEpisode);

/// <summary>Port of the film half of app/api/title/[workKey]/grab.ts: selectWorkCandidate and its failure sentences.</summary>
public static class FilmSelection
{
    private static EpisodeInfo Episode(TorrentResult r) => r.Episode ?? ReleaseNames.ParseEpisode(r.Title);
    private static bool IsFilmShaped(TorrentResult r) => Episode(r) is var ep && !ep.IsSeasonPack && ep.IsMultiSeason != true && ep.Episode == null;
    private static bool IsMine(TorrentResult r, string workKey) => ReleaseNames.IdentityFor(r.Title) is var id && ReleaseNames.WorkKeyMatches(workKey, id.Name, id.Year);

    /// <summary>
    /// The best result that genuinely belongs to this work. Results arrive ranked, so the first survivor is the best one:
    /// identity first (a "Dune" search also returns Children of Dune), then shape (a film is never a pack or an episode).
    /// </summary>
    public static TorrentResult? Select(IEnumerable<TorrentResult> results, string workKey, int? minimumResolution) =>
        results.Where(r => !string.IsNullOrEmpty(r.Magnet) && r.Seeders > 0 && ReleaseSelection.MeetsFloor(r.Title, minimumResolution))
            .Where(r => IsMine(r, workKey)).FirstOrDefault(IsFilmShaped);

    /// <summary>Mirrors <see cref="Select"/>'s order so the counts describe the run that happened.</summary>
    public static FilmRejection Summarize(IReadOnlyList<TorrentResult> results, string workKey, int? minimumResolution)
    {
        int noMagnet = 0, unseeded = 0, belowFloor = 0, otherWork = 0, packOrEpisode = 0;
        foreach (var r in results)
        {
            if (string.IsNullOrEmpty(r.Magnet)) { noMagnet++; continue; }
            if (r.Seeders <= 0) { unseeded++; continue; }
            if (!ReleaseSelection.MeetsFloor(r.Title, minimumResolution)) { belowFloor++; continue; }
            if (!IsMine(r, workKey)) { otherWork++; continue; }
            var ep = Episode(r);
            if (ep.IsSeasonPack || ep.IsMultiSeason == true || ep.Episode != null) packOrEpisode++;
        }
        return new(results.Count, noMagnet, unseeded, belowFloor, otherWork, packOrEpisode);
    }

    /// <summary>"Every source failed" is not "there is no release"; one working empty source is an honest empty answer.</summary>
    public static string? SourceOutageMessage(IReadOnlyList<SourceStatus>? sources)
    {
        if (sources is not { Count: > 0 }) return null;
        var failed = sources.Where(s => !string.IsNullOrWhiteSpace(s.Error)).ToList();
        if (failed.Count != sources.Count) return null;
        return $"{GrabFailure.Sources.Message} {GrabFailure.Sources.Action}";
    }

    /// <summary>Why nothing started, in plain words with one next step (the reason counts stay in the diagnostics).</summary>
    public static GrabFailure NoMatch(string title, int? minimumResolution, IReadOnlyList<SourceStatus>? sources, FilmRejection? rejection)
    {
        if (SourceOutageMessage(sources) != null) return GrabFailure.Sources;
        if (rejection is { } r && r.Total > 0)
        {
            if (r.BelowFloor > 0 && r.OtherWork == 0 && r.Unseeded == 0 && minimumResolution is > 0)
                return GrabFailure.BelowQuality(title, minimumResolution.Value);
            if (r.Unseeded > 0 && r.OtherWork == 0 && r.BelowFloor == 0) return GrabFailure.NoSeeders(title);
        }
        return GrabFailure.NotFound(title, minimumResolution);
    }

    public static string NoMatchMessage(string title, int? minimumResolution, IReadOnlyList<SourceStatus>? sources, FilmRejection? rejection) =>
        NoMatch(title, minimumResolution, sources, rejection).Sentence;
}
