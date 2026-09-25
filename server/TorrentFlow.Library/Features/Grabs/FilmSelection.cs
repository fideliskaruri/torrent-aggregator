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
        return $"Could not reach any torrent source ({string.Join(", ", failed.Select(s => s.Id))}) — nothing was searched, so this is an outage, not a missing release. Try again in a moment.";
    }

    public static string NoMatchMessage(string title, int? minimumResolution, int count, IReadOnlyList<SourceStatus>? sources, FilmRejection? rejection)
    {
        if (SourceOutageMessage(sources) is { } outage) return $"{outage} ({title})";
        var floor = minimumResolution is > 0 ? $"{minimumResolution}p-or-higher " : "";
        if (count == 0) return $"No seeded {floor}torrent for {title}";
        var because = new List<string>();
        if (rejection is { } r)
        {
            if (r.OtherWork > 0) because.Add($"{r.OtherWork} were a different work");
            if (r.BelowFloor > 0 && minimumResolution is > 0) because.Add($"{r.BelowFloor} below {minimumResolution}p or of unknown quality");
            if (r.PackOrEpisode > 0) because.Add($"{r.PackOrEpisode} were packs or episodes");
            if (r.Unseeded > 0) because.Add($"{r.Unseeded} had no seeders");
        }
        var why = because.Count > 0 ? $" — {string.Join(", ", because)}" : "";
        return $"No {floor}release for {title} in {count} results{why}";
    }
}
