namespace TorrentFlow.Core.Contracts.Metadata;

/// <summary>Catalog metadata for one work (port of TS <c>MediaMetadata</c> in src/lib/torrents/types.ts).</summary>
public sealed record MediaMetadata
{
    /// <summary>Metadata adapter implementation ID.</summary>
    public required string Source { get; init; }
    /// <summary>"anime" | "movie" | "tv".</summary>
    public required string MediaType { get; init; }
    public required string ExternalId { get; init; }
    public required string Title { get; init; }
    public IReadOnlyList<string>? Aliases { get; init; }
    public string? PosterUrl { get; init; }
    public string? BackdropUrl { get; init; }
    public string? Synopsis { get; init; }
    public double? Rating { get; init; }
    public int? Year { get; init; }
    /// <summary>ISO yyyy-MM-dd.</summary>
    public string? ReleaseDate { get; init; }
    public IReadOnlyList<string>? Genres { get; init; }
    public string? OriginalLanguage { get; init; }
    public IReadOnlyList<string>? OriginCountry { get; init; }
    [System.Text.Json.Serialization.JsonExtensionData]
    public Dictionary<string, System.Text.Json.JsonElement>? AdditionalProperties { get; init; }
}

/// <summary>One release to enrich. Only the raw release title participates in the TS logic.</summary>
public sealed record MetadataEnrichmentInput(string Title);

/// <summary>Resolves catalog metadata for free-text / release titles. Implemented by the Metadata module.</summary>
public interface IMetadataResolver
{
    /// <summary>Port of <c>resolveMetadata(rawTitle, category)</c>: cleans a release title, walks the candidate ladder, attaches artwork, persists to CachedMetadata.</summary>
    Task<MediaMetadata?> ResolveMetadataAsync(string rawTitle, string? category, CancellationToken cancellationToken = default);

    /// <summary>
    /// Port of <c>enrichResultsWithMetadata(results, query, category, primaryLookup)</c>: returns one entry per input index
    /// (null when no identity-compatible metadata). <paramref name="primary"/> is the already-resolved query metadata, if any;
    /// when null it is resolved from <paramref name="query"/>.
    /// </summary>
    Task<IReadOnlyList<MediaMetadata?>> EnrichAsync(IReadOnlyList<MetadataEnrichmentInput> inputs, string query, string? category,
        MediaMetadata? primary = null, CancellationToken cancellationToken = default);

    Task<MediaMetadata?> GetAniListByIdAsync(string id, CancellationToken cancellationToken = default);

    /// <param name="mediaType">"movie" | "tv".</param>
    Task<MediaMetadata?> GetTmdbByIdAsync(string mediaType, string id, CancellationToken cancellationToken = default);

    static bool SupportsProvider(string provider) => provider is "tmdb" or "anilist" or "tvmaze" or "cinemeta" or "itunes";

    Task<MediaMetadata?> GetByIdAsync(string provider, string mediaType, string id, CancellationToken cancellationToken = default) =>
        provider switch
        {
            "anilist" => GetAniListByIdAsync(id, cancellationToken),
            "tmdb" => GetTmdbByIdAsync(mediaType, id, cancellationToken),
            _ => Task.FromResult<MediaMetadata?>(null)
        };
}

/// <summary>A catalog row as used by the title page and browse rails.</summary>
public sealed record CatalogWork(
    string Id,
    string WorkKey,
    string Title,
    int? Year,
    string MediaType,
    string? PosterUrl,
    string? BackdropUrl,
    string? Overview,
    double? Rating,
    string Source,
    int Rank,
    string? ReleaseDate,
    string? WorkId);

/// <summary>Catalog / work lookups for the title page.</summary>
public interface ICatalogLookup
{
    /// <summary>Latest catalog entry for a work key (accepts legacy key aliases), or null.</summary>
    Task<CatalogWork?> FindByWorkKeyAsync(string workKey, CancellationToken cancellationToken = default);
}
