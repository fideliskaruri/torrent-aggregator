namespace TorrentFlow.Core.Contracts.Library;

/// <summary>A work's identity as the title page knows it, and the season it asks about.</summary>
public sealed record SeasonShapeQuery(string WorkKey, string Title, int? Year, string? MediaType, string? Provider, string? ProviderId,
    int Season);

/// <summary>
/// One regular episode of a season, numbered the way the page shows it (<see cref="Season"/>, <see cref="Episode"/>),
/// with the franchise numbering releases use: <see cref="Absolute"/> counts every regular episode from the start of the
/// show (specials excluded), and <see cref="AniListId"/> numbers it as its own episode <see cref="AniListEpisode"/>.
/// </summary>
public sealed record SeasonShapeEpisode(int Season, int Episode, bool Aired, int? Absolute = null, string? AniListId = null,
    int? AniListEpisode = null);

/// <param name="Source">Where the episode list came from: tmdb, tvmaze or anilist.</param>
/// <param name="ShowTitle">For an anime sequel entry numbered as its show: the show's English name, the folder its files land in.</param>
/// <param name="ShowYear">That show's first year.</param>
/// <param name="Provisional">The anime numbering came from a franchise walk AniList cut short; it may change on the next ask.</param>
/// <param name="Chained">The anime numbering is the show's (sequel chain or show listing), not an entry's own Season 1 kept for lack of one.</param>
public sealed record SeasonShape(int Season, IReadOnlyList<SeasonShapeEpisode> Episodes, string Source, string? ShowTitle = null,
    int? ShowYear = null, bool Provisional = false, bool Chained = false)
{
    public IReadOnlyList<int> AiredEpisodes => Episodes.Where(e => e.Aired).Select(e => e.Episode).Distinct().Order().ToArray();
}

/// <summary>
/// One episode of an anime work as numbered now (<see cref="Season"/>, <see cref="Episode"/>) and as the title page
/// numbered it before seasons followed the sequel chain (<see cref="LegacySeason"/>, <see cref="LegacyEpisode"/>).
/// </summary>
public sealed record NumberedEpisode(int Absolute, int Season, int Episode, int LegacySeason, int LegacyEpisode);

/// <param name="Provisional">AniList cut the franchise walk short: nothing should be renumbered from it.</param>
/// <param name="ShowTitle">The root show's title when the work is a later entry of it (its episodes are filed under it); null for the root itself.</param>
public sealed record AnimeNumbering(IReadOnlyList<NumberedEpisode> Episodes, bool Provisional, string? ShowTitle = null, int? ShowYear = null);

/// <summary>
/// The one server-side answer to "which episodes does this season have": the season download, requests and the episode
/// search mapping all read it, so no caller trusts a list the browser rendered. Library's default knows nothing;
/// Metadata provides the provider-backed resolver.
/// </summary>
public interface ISeasonShapeLookup
{
    Task<SeasonShape?> GetSeasonAsync(SeasonShapeQuery query, CancellationToken cancellationToken);

    /// <summary>Every episode of an anime work's page with its current and pre-chain numbering; null when it has no franchise view.</summary>
    Task<AnimeNumbering?> GetNumberingAsync(SeasonShapeQuery query, CancellationToken cancellationToken) =>
        Task.FromResult<AnimeNumbering?>(null);
}
