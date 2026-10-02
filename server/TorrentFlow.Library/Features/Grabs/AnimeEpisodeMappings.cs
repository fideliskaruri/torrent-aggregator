using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Features.Grabs;

/// <summary>
/// The one place an anime episode's release numbering is chosen. The season shape says which AniList entry numbers the
/// page episode as its own (TVmaze S2E1 or TMDB S1E29 is the second season's episode 1); that entry's mapping then
/// searches "Season 2 - 01", "2nd Season - 01" and absolute "- 29". AniList pages without a shape keep their entry's
/// own Season 1 mapping. It also says which episode follows another, so the hunter steps from a season's last episode
/// to the next season's first.
/// </summary>
public sealed class AnimeEpisodeMappings(ILibraryAnimeLookup anime, ISeasonShapeLookup? shapes = null)
{
    /// <exception cref="SeasonListPendingException">
    /// An AniList episode whose show numbering is not confidently known yet: AniList did not answer or cut the franchise
    /// walk short, or a sequel entry could not be laid over its show. Sending it now would file it under the entry.
    /// </exception>
    public async Task<AnimeEpisodeMapping?> ForAsync(string? workKey, string title, int? year, string? mediaType, string? provider,
        string? providerId, EpisodeCursor cursor, CancellationToken ct)
    {
        if (provider != "anilist" && mediaType != "anime") return null;
        // Only the provider-backed shape can vouch for a chain; with none at all (a bare Library host) nothing is held.
        var confident = provider == "anilist" && shapes is not null and not DefaultSeasonShapeLookup && workKey != null;
        SeasonShape? shape = null;
        AnimeEpisodeMapping? mapping = null;
        try
        {
            if (shapes != null && workKey != null)
                shape = await shapes.GetSeasonAsync(new(workKey, title, year, mediaType, provider, providerId, cursor.Season), ct);
            if (confident && (shape is null || shape.Provisional))
                throw new SeasonListPendingException("AniList has not answered with the show's season list.");
            if (shape?.Episodes.FirstOrDefault(e => e.Episode == cursor.Episode) is { AniListId: { } entry, AniListEpisode: { } local })
            {
                mapping = await anime.GetEpisodeMappingAsync(entry, ct);
                if (mapping is null)
                    return confident ? throw new SeasonListPendingException("AniList has not answered with the entry's numbering.") : null;
                if (confident && mapping.IsSequel && !shape.Chained)
                    throw new SeasonListPendingException("The sequel could not be placed in its show's seasons yet.");
                return mapping with { TargetSeason = cursor.Season, EntryEpisodeOffset = cursor.Episode - local, ShowTitle = shape.ShowTitle,
                    ShowYear = shape.ShowYear };
            }
            // A sequel entry's page knows only its own episodes as the show numbers them; any other number is stale.
            if (confident && shape!.ShowTitle != null)
                throw new SeasonListPendingException($"Season {cursor.Season} episode {cursor.Episode} is not one of this entry's episodes.");
            mapping = provider == "anilist" && providerId != null && cursor.Season == 1
                ? await anime.GetEpisodeMappingAsync(providerId, ct) : null;
            if (confident && mapping is { IsSequel: true })
                throw new SeasonListPendingException("The sequel could not be placed in its show's seasons yet.");
            return mapping;
        }
        catch (Exception e) when (confident && e is not SeasonListPendingException && !ct.IsCancellationRequested)
        {
            throw new SeasonListPendingException("AniList has not answered with the show's season list.", e);
        }
    }

    /// <summary>
    /// The episode after <paramref name="current"/>: an anime show's season ends where its season shape ends, so the
    /// episode after Frieren S01E28 is S02E01. Anything else (or a shape not confidently known) just counts on.
    /// </summary>
    public async Task<EpisodeCursor> NextAsync(string? workKey, string title, int? year, string? mediaType, string? provider,
        string? providerId, EpisodeCursor current, CancellationToken ct)
    {
        var next = current.Next();
        if (shapes == null || workKey == null || provider != "anilist" && mediaType != "anime") return next;
        try
        {
            var shape = await shapes.GetSeasonAsync(new(workKey, title, year, mediaType, provider, providerId, current.Season), ct);
            if (shape is not { Chained: true, Provisional: false } || shape.Episodes.Count == 0 ||
                current.Episode < shape.Episodes.Max(e => e.Episode)) return next;
            var following = await shapes.GetSeasonAsync(new(workKey, title, year, mediaType, provider, providerId, current.Season + 1), ct);
            return following is { Episodes.Count: > 0, Provisional: false } ? new(current.Season + 1, following.Episodes.Min(e => e.Episode)) : next;
        }
        catch (Exception) when (!ct.IsCancellationRequested) { return next; }
    }
}
