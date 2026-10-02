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
    /// An AniList episode whose show numbering is not known because AniList (or the show listing) did not answer, or cut
    /// the franchise walk short. Sending it now could file it under the wrong season. Anything AniList did answer is
    /// used as it is: an OVA, special or TV short has no sequel chain and searches with its plain numbering, as before.
    /// </exception>
    public async Task<AnimeEpisodeMapping?> ForAsync(string? workKey, string title, int? year, string? mediaType, string? provider,
        string? providerId, EpisodeCursor cursor, CancellationToken ct)
    {
        if (provider != "anilist" && mediaType != "anime") return null;
        // A valid AniList id is enough to number the episode as its show does: a library row not linked to its work yet
        // reads the same franchise by that id. Only the provider-backed shape can vouch for a chain; with none at all (a
        // bare Library host) nothing is held.
        var aniList = provider == "anilist" && int.TryParse(providerId, System.Globalization.NumberStyles.None,
            System.Globalization.CultureInfo.InvariantCulture, out var id) && id > 0;
        workKey ??= aniList ? $"anilist-{providerId}" : null;
        var confident = aniList && shapes is not null and not DefaultSeasonShapeLookup;
        try
        {
            SeasonShape? shape = null;
            if (shapes != null && workKey != null)
                shape = await shapes.GetSeasonAsync(new(workKey, title, year, mediaType, provider, providerId, cursor.Season), ct);
            if (confident && (shape is null || shape.Provisional))
                throw new SeasonListPendingException("AniList has not answered with the show's season list.");
            if (shape?.Episodes.FirstOrDefault(e => e.Episode == cursor.Episode) is { AniListId: { } entry, AniListEpisode: { } local })
            {
                // No chain (an OVA, special or short): its plain numbering, as before seasons followed the chain.
                if (await anime.GetEpisodeMappingAsync(entry, ct) is not { } mapping) return null;
                return mapping with { TargetSeason = cursor.Season, EntryEpisodeOffset = cursor.Episode - local, ShowTitle = shape.ShowTitle,
                    ShowYear = shape.ShowYear, ShowId = shape.ShowId };
            }
            // A sequel entry's page knows only its own episodes as the show numbers them; any other number is stale.
            if (confident && shape!.ShowTitle != null)
                throw new SeasonListPendingException($"Season {cursor.Season} episode {cursor.Episode} is not one of this entry's episodes.");
            return provider == "anilist" && providerId != null && cursor.Season == 1
                ? await anime.GetEpisodeMappingAsync(providerId, ct) : null;
        }
        catch (Exception e) when (e is not SeasonListPendingException && !ct.IsCancellationRequested)
        {
            // AniList failing mid-walk is no answer: an AniList episode waits for it; anything else searches unmapped.
            if (confident) throw new SeasonListPendingException("AniList has not answered with the show's season list.", e);
            return null;
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
        if (workKey == null && provider == "anilist" && providerId != null) workKey = $"anilist-{providerId}";
        if (shapes == null || workKey == null || provider != "anilist" && mediaType != "anime") return next;
        try
        {
            var shape = await shapes.GetSeasonAsync(new(workKey, title, year, mediaType, provider, providerId, current.Season), ct);
            // Only the season's real last episode crosses: an episode the shape does not list (an absolute number past a
            // listing, One Piece S01E1122) just counts on.
            if (shape is not { Chained: true, Provisional: false } || shape.Episodes.Count == 0 ||
                shape.Episodes.All(e => e.Episode != current.Episode) || current.Episode < shape.Episodes.Max(e => e.Episode)) return next;
            var following = await shapes.GetSeasonAsync(new(workKey, title, year, mediaType, provider, providerId, current.Season + 1), ct);
            return following is { Episodes.Count: > 0, Provisional: false } ? new(current.Season + 1, following.Episodes.Min(e => e.Episode)) : next;
        }
        catch (Exception) when (!ct.IsCancellationRequested) { return next; }
    }
}
