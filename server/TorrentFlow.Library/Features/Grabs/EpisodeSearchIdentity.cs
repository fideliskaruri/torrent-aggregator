using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Core.Contracts.Metadata;

namespace TorrentFlow.Library.Features.Grabs;

internal sealed class DefaultAnimeLookup : ILibraryAnimeLookup
{
    public Task<IReadOnlyList<MediaMetadata>> SearchAsync(string title, int limit, CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<MediaMetadata>>([]);
}

internal sealed class DefaultSeasonShapeLookup : ISeasonShapeLookup
{
    public Task<SeasonShape?> GetSeasonAsync(SeasonShapeQuery query, CancellationToken cancellationToken) =>
        Task.FromResult<SeasonShape?>(null);
}

/// <summary>Port of TS resolveEpisodeSearchIdentity (app/api/title/[workKey]/grab.ts).</summary>
public sealed class EpisodeSearchIdentity(ILibraryAnimeLookup lookup, IMetadataResolver? metadata = null)
{
    /// <summary>
    /// Recovers AniList aliases for an episode search. TMDB-backed pages describe anime as plain TV and may carry
    /// only a native-script alias, which leaves the ladder searching a name no indexer carries. Recovery is guarded:
    /// an AniList result counts only when one of its names equals the resolved title and its year does not
    /// contradict the resolved year. A failed lookup degrades to exactly what was known.
    /// </summary>
    public async Task<(string MediaType, IReadOnlyList<string> Aliases)> ResolveAsync(string title, int? year, string? mediaType,
        IReadOnlyList<string>? aliases, CancellationToken ct, string? provider = null, string? providerId = null)
    {
        var existing = UniqueNames(aliases ?? [], title);
        var known = (AnimeIdentity.IsAnime(provider, mediaType, providerId) ? "anime" : mediaType ?? "tv", (IReadOnlyList<string>)existing);
        if (known.Item1 == "anime" && existing.Count > 0) return known;
        if (string.IsNullOrWhiteSpace(title)) return known;
        var wanted = EpisodeLadder.NormalizeTitle(title);
        if (metadata != null && provider != null && providerId != null && known.Item1 != "anime")
        {
            try
            {
                var catalog = await metadata.GetByIdAsync(provider, known.Item1 == "movie" ? "movie" : "tv", providerId, ct);
                IReadOnlyList<string> catalogNames = catalog == null ? [] : WorkNames.Of(catalog).MatchNames();
                if (catalog != null && (year == null || catalog.Year == null || catalog.Year == year) &&
                    catalogNames.Prepend(catalog.Title).Any(n => EpisodeLadder.NormalizeTitle(n) == wanted))
                {
                    // Requests and automation carry no page aliases; the provider's own names are the same ones the title page sends.
                    if (existing.Count == 0) existing = UniqueNames(catalogNames, title);
                    known = (AnimeIdentity.IsAnime(catalog) ? "anime" : known.Item1, existing);
                }
            }
            catch (Exception) when (!ct.IsCancellationRequested) { }
        }
        IReadOnlyList<MediaMetadata> matches;
        try { matches = await lookup.SearchAsync(title, 5, ct); }
        catch (Exception) when (!ct.IsCancellationRequested) { return known; }
        var anime = matches.FirstOrDefault(c => AnimeIdentity.IsAnime(c) && (year == null || c.Year == null || c.Year == year) &&
            WorkNames.Of(c).MatchNames().Prepend(c.Title).Any(name => EpisodeLadder.NormalizeTitle(name) == wanted));
        return anime == null ? known : ("anime", UniqueNames(WorkNames.Of(anime).MatchNames().Prepend(anime.Title).ToList(), title));
    }

    internal static List<string> UniqueNames(IReadOnlyList<string> names, string canonicalTitle)
    {
        var canonical = EpisodeLadder.NormalizeTitle(canonicalTitle);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var output = new List<string>();
        foreach (var name in names)
        {
            var trimmed = (name ?? "").Trim();
            var normalized = EpisodeLadder.NormalizeTitle(trimmed);
            if (trimmed.Length == 0 || normalized == canonical || !seen.Add(normalized)) continue;
            output.Add(trimmed);
        }
        return output;
    }
}
