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
public sealed record SeasonShape(int Season, IReadOnlyList<SeasonShapeEpisode> Episodes, string Source)
{
    public IReadOnlyList<int> AiredEpisodes => Episodes.Where(e => e.Aired).Select(e => e.Episode).Distinct().Order().ToArray();
}

/// <summary>
/// The one server-side answer to "which episodes does this season have": the season download, requests and the episode
/// search mapping all read it, so no caller trusts a list the browser rendered. Library's default knows nothing;
/// Metadata provides the provider-backed resolver.
/// </summary>
public interface ISeasonShapeLookup
{
    Task<SeasonShape?> GetSeasonAsync(SeasonShapeQuery query, CancellationToken cancellationToken);
}
