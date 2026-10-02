using TorrentFlow.Core.Contracts.Library;

namespace TorrentFlow.Metadata.Title;

/// <summary>
/// The season shape every acquisition path reads (season download, requests, the episode search mapping), built from
/// the same sources as the title page: an anime work's franchise view, otherwise the page's own episode list.
/// </summary>
public sealed class SeasonShapeService(AnimeFranchiseService franchises, TitleExtrasService extras, TimeProvider time) : ISeasonShapeLookup
{
    public async Task<SeasonShape?> GetSeasonAsync(SeasonShapeQuery q, CancellationToken cancellationToken)
    {
        if (q.Season < 1) return null;
        if (await franchises.ResolveAsync(new(q.Title, q.Year, q.MediaType, q.Provider, q.ProviderId), cancellationToken)
                .ConfigureAwait(false) is { } view)
            return new(q.Season, view.EpisodesOf(q.Season)
                .Select(e => new SeasonShapeEpisode(e.Season, e.Episode, e.Aired, e.Absolute, e.AniListId, e.AniListEpisode)).ToList(), view.Source,
                view.Show?.Title, view.Show?.Year, view.Provisional, view.Chained, view.Show?.AniListId);
        var payload = await extras.GetAsync(new(q.WorkKey, q.Title, q.Year, q.MediaType, q.Season, q.Provider, q.ProviderId, null,
            SeriesHint: true), cancellationToken).ConfigureAwait(false);
        if (!payload.Resolved || payload.Season != q.Season) return null;
        var now = time.GetUtcNow();
        return new(q.Season, payload.Episodes.Where(e => e.Episode >= 1).DistinctBy(e => e.Episode).OrderBy(e => e.Episode)
            .Select(e => new SeasonShapeEpisode(q.Season, e.Episode,
                FranchiseView.HasAired(e.AirDate, e.AirStamp, now) || e.AirDate is null && e.HasAired == true)).ToList(), "extras");
    }

    public async Task<AnimeNumbering?> GetNumberingAsync(SeasonShapeQuery q, CancellationToken cancellationToken)
    {
        if (await franchises.ResolveAsync(new(q.Title, q.Year, q.MediaType, q.Provider, q.ProviderId), cancellationToken)
                .ConfigureAwait(false) is not { Chained: true } view) return null;
        // Before seasons followed the chain, a first season's page used the show listing's numbers and a sequel entry's
        // page its own Season 1.
        return new(view.Episodes.Where(e => e.Absolute is not null).Select(e => new NumberedEpisode(e.Absolute!.Value, e.Season, e.Episode,
            view.Show is not null ? 1 : e.ListedSeason ?? e.Season,
            view.Show is not null ? e.AniListEpisode ?? e.Episode : e.ListedEpisode ?? e.Episode, e.AniListId, e.AniListEpisode)).ToList(),
            view.Provisional, view.Show?.Title, view.Show?.Year, view.Show?.AniListId, view.Listing, view.Uncertain ?? []);
    }
}
