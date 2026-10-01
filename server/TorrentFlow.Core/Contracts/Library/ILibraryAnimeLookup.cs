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

/// <summary>
/// Release coordinates for an AniList entry's local Season 1; never changes catalog or queue coordinates.
/// <see cref="TargetSeason"/> and <see cref="EntryEpisodeOffset"/> place the entry on the page that asks: page episode
/// <c>E</c> of season <see cref="TargetSeason"/> is the entry's local episode <c>E - EntryEpisodeOffset</c> (a TMDB
/// "S01E29" is the 2nd season entry's episode 1). The defaults are the entry's own page. <see cref="ShowTitle"/> and
/// <see cref="ShowYear"/> name the show a sequel entry's page belongs to: its files land in that show's folder.
/// </summary>
public sealed record AnimeEpisodeMapping(int? FranchiseSeason, int? AbsoluteOffset,
    IReadOnlyList<string> EntryTitles, IReadOnlyList<string> FranchiseTitles,
    string Provenance = "anilist-prequel-v1", int SeasonEpisodeOffset = 0,
    IReadOnlyList<string>? PrequelTitles = null, bool IsSequel = false,
    int TargetSeason = 1, int EntryEpisodeOffset = 0, string? ShowTitle = null, int? ShowYear = null)
{
    /// <summary>The entry's local episode for a page episode of <see cref="TargetSeason"/>.</summary>
    public int Local(int pageEpisode) => pageEpisode - EntryEpisodeOffset;
}
