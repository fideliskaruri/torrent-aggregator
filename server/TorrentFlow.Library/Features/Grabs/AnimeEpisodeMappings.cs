using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Features.Grabs;

/// <summary>
/// The one place an anime episode's release numbering is chosen. The season shape says which AniList entry numbers the
/// page episode as its own (TVmaze S2E1 or TMDB S1E29 is the second season's episode 1); that entry's mapping then
/// searches "Season 2 - 01", "2nd Season - 01" and absolute "- 29". AniList pages without a shape keep their entry's
/// own Season 1 mapping.
/// </summary>
public sealed class AnimeEpisodeMappings(ILibraryAnimeLookup anime, ISeasonShapeLookup? shapes = null)
{
    public async Task<AnimeEpisodeMapping?> ForAsync(string? workKey, string title, int? year, string? mediaType, string? provider,
        string? providerId, EpisodeCursor cursor, CancellationToken ct)
    {
        if (provider != "anilist" && mediaType != "anime") return null;
        if (shapes != null && workKey != null &&
            await shapes.GetSeasonAsync(new(workKey, title, year, mediaType, provider, providerId, cursor.Season), ct) is { } shape &&
            shape.Episodes.FirstOrDefault(e => e.Episode == cursor.Episode) is { AniListId: { } entry, AniListEpisode: { } local })
            return await anime.GetEpisodeMappingAsync(entry, ct) is { } mapping
                ? mapping with { TargetSeason = cursor.Season, EntryEpisodeOffset = cursor.Episode - local, ShowTitle = shape.ShowTitle,
                    ShowYear = shape.ShowYear }
                : null;
        return provider == "anilist" && providerId != null && cursor.Season == 1
            ? await anime.GetEpisodeMappingAsync(providerId, ct) : null;
    }
}
