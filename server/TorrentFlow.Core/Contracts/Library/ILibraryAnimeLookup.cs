using TorrentFlow.Core.Contracts.Metadata;

namespace TorrentFlow.Core.Contracts.Library;

/// <summary>
/// Optional anime catalog search used by Library's guarded alias recovery for episode grabs.
/// Library's default returns nothing; Metadata overrides it with AniList.
/// </summary>
public interface ILibraryAnimeLookup
{
    Task<IReadOnlyList<MediaMetadata>> SearchAsync(string title, int limit, CancellationToken cancellationToken);
    Task<AnimeEpisodeMapping?> GetEpisodeMappingAsync(string providerId, CancellationToken cancellationToken) =>
        Task.FromResult<AnimeEpisodeMapping?>(null);
}

/// <summary>Release coordinates for an AniList entry's local Season 1; never changes catalog or queue coordinates.</summary>
public sealed record AnimeEpisodeMapping(int? FranchiseSeason, int? AbsoluteOffset,
    IReadOnlyList<string> EntryTitles, IReadOnlyList<string> FranchiseTitles,
    string Provenance = "anilist-prequel-v1", int SeasonEpisodeOffset = 0);
