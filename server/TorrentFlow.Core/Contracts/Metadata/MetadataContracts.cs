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
    /// <summary>The provider's labelled names (English, Romaji, Native...) when it labels them; read through <see cref="WorkNames.Of(MediaMetadata)"/>.</summary>
    public IReadOnlyList<WorkName>? Names { get; init; }
    /// <summary>The ids other providers know this title by, when the provider says.</summary>
    public WorkIds? Ids { get; init; }
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
    /// <summary>The source's own format when it has one (AniList: "MOVIE", "TV", "OVA"...), so an anime film is still a film.</summary>
    public string? Format { get; init; }
    [System.Text.Json.Serialization.JsonExtensionData]
    public Dictionary<string, System.Text.Json.JsonElement>? AdditionalProperties { get; init; }
}

/// <summary>One release to enrich. Only the raw release title participates in the TS logic.</summary>
public sealed record MetadataEnrichmentInput(string Title);

/// <summary>
/// Whether a catalog provider is refusing requests right now (it answered 429 or its allowance is spent), so a lookup
/// that came back empty is "rate-limited, ask later" rather than "not found".
/// </summary>
public interface IProviderPacing
{
    /// <summary>When <paramref name="provider"/> takes requests again; null when it takes them now.</summary>
    DateTimeOffset? BlockedUntil(string provider);
}

/// <summary>
/// Whose turn a provider request is. Requests are foreground (a title page, a search, a grab) unless the code that
/// makes them runs inside <see cref="Background"/>: backfills, link jobs, the hunter and other reconciliation. A rate
/// gate lets background requests spend only a fixed share of the provider's allowance, so foreground requests never
/// wait behind them and background ones still progress.
/// </summary>
public static class ProviderPriority
{
    private static readonly AsyncLocal<bool> Current = new();

    /// <summary>True inside a <see cref="Background"/> scope.</summary>
    public static bool IsBackground => Current.Value;

    /// <summary>Marks every provider request made by this flow (and what it awaits) as background until disposed.</summary>
    public static IDisposable Background()
    {
        var prior = Current.Value;
        Current.Value = true;
        return new Scope(prior);
    }

    private sealed class Scope(bool prior) : IDisposable
    {
        public void Dispose() => Current.Value = prior;
    }
}

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

    /// <summary>Catalog sources the product accepts for title identity (search, title page, requests).</summary>
    public static readonly string[] Providers = ["tmdb", "anilist", "tvmaze", "cinemeta", "itunes"];

    static bool SupportsProvider(string provider) =>
        provider is "tmdb" or "anilist" or "tvmaze" or "cinemeta" or "itunes";

    Task<MediaMetadata?> GetByIdAsync(string provider, string mediaType, string id, CancellationToken cancellationToken = default) =>
        provider switch
        {
            "anilist" => GetAniListByIdAsync(id, cancellationToken),
            "tmdb" => GetTmdbByIdAsync(mediaType, id, cancellationToken),
            _ => Task.FromResult<MediaMetadata?>(null)
        };

    /// <summary>
    /// <see cref="GetByIdAsync"/> with how it went, so a provider that refused or failed to answer is never read as
    /// "not found". Only <see cref="ProviderLookup.Found"/> and <see cref="ProviderLookup.NotFound"/> are real answers.
    /// </summary>
    async Task<(ProviderLookup Outcome, MediaMetadata? Metadata)> LookupByIdAsync(string provider, string mediaType, string id,
        CancellationToken cancellationToken = default) =>
        await GetByIdAsync(provider, mediaType, id, cancellationToken) is { } found ? (ProviderLookup.Found, found) : (ProviderLookup.NotFound, null);
}

/// <summary>How a by-id provider lookup went: <see cref="RateLimited"/> and <see cref="Failed"/> are not answers.</summary>
public enum ProviderLookup { Found, NotFound, RateLimited, Failed }

/// <summary>
/// A catalog row as used by the title page and browse rails. <paramref name="RatingSource"/> names who supplied <paramref name="Rating"/>,
/// or null when unknown; <paramref name="Provider"/> and <paramref name="ProviderId"/> name the title at a metadata provider when the chart knew it.
/// </summary>
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
    string? WorkId,
    string? RatingSource = null,
    string? Provider = null,
    string? ProviderId = null);

/// <summary>Catalog / work lookups for the title page.</summary>
public interface ICatalogLookup
{
    /// <summary>Latest catalog entry for a work key (an identity key, a title route key or a legacy key alias), or null.</summary>
    Task<CatalogWork?> FindByWorkKeyAsync(string workKey, CancellationToken cancellationToken = default);
}
