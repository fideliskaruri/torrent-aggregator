using System.Text.Json;
using System.Text.Json.Serialization;

namespace TorrentFlow.Core.Contracts.Search;

public interface ITorrentSearchService
{
    Task<SearchResponse> SearchAsync(SearchOptions options, CancellationToken cancellationToken = default);
}

public interface ISearchResultEnricher
{
    Task<IReadOnlyList<TorrentResult>> EnrichAsync(string query, IReadOnlyList<TorrentResult> results, CancellationToken cancellationToken = default);
}

public sealed record SearchOptions
{
    public required string Query { get; init; }
    public string Category { get; init; } = "all";
    public int? Limit { get; init; }
    public int Page { get; init; } = 1;
    public int PageSize { get; init; } = 20;
    public string[]? Sources { get; init; }
    public int? TargetResolution { get; init; }
    public SearchFilters? Filters { get; init; }
    public bool SkipCache { get; init; }
    public bool Enrich { get; init; } = true;
    public bool Background { get; init; }
    public int? AdapterDeadlineMs { get; init; }
    public SearchRoutingPreferences? Routing { get; init; }
}

public sealed record SearchRoutingPreferences(string[]? Categories = null, string? BaseDownloadPath = null,
    IReadOnlyDictionary<string, string>? PathRules = null, string? SavePath = null);

public sealed record SearchFilters
{
    public string[]? Sources { get; init; }
    public long? MinSeeders { get; init; }
    public long? MaxSeeders { get; init; }
    public long? MinSizeBytes { get; init; }
    public long? MaxSizeBytes { get; init; }
    public string? Resolution { get; init; }
    public string? Codec { get; init; }
    public bool? HasMagnet { get; init; }
    public int? Season { get; init; }
    public int? Episode { get; init; }
    public string? ReleaseKind { get; init; }
}

public sealed record TorrentResult
{
    public required string Id { get; init; }
    public required string Title { get; init; }
    public string? Magnet { get; init; }
    public string? TorrentUrl { get; init; }
    public string? InfoHash { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public long? SizeBytes { get; init; }
    public string? SizeLabel { get; init; }
    public int Seeders { get; init; }
    public int Leechers { get; init; }
    public int? Completed { get; init; }
    public string? Category { get; init; }
    public required string Source { get; init; }
    public required string SourceUrl { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? PublishedAt { get; init; }
    public string[] Tags { get; init; } = [];
    public double? Score { get; init; }
    public int? Health { get; init; }
    public bool? BestPick { get; init; }
    public string? GroupKey { get; init; }
    public EpisodeInfo? Episode { get; init; }
    public string? ReleaseGroup { get; init; }
    public MediaMetadata? Metadata { get; init; }
    public DownloadRoute? Route { get; init; }
}

public sealed record EpisodeInfo
{
    public int? Season { get; init; }
    public int? Episode { get; init; }
    public int? AbsoluteEpisode { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    public string? Label { get; init; }
    public bool IsBatch { get; init; }
    public bool IsSeasonPack { get; init; }
    public bool? IsMultiSeason { get; init; }
    public string? SpecialType { get; init; }
}

public sealed record MediaMetadata
{
    public required string Source { get; init; }
    public required string MediaType { get; init; }
    public required string ExternalId { get; init; }
    public required string Title { get; init; }
    public string[]? Aliases { get; init; }
    public string? PosterUrl { get; init; }
    public string? BackdropUrl { get; init; }
    public string? Synopsis { get; init; }
    public double? Rating { get; init; }
    public int? Year { get; init; }
    public string? ReleaseDate { get; init; }
    public string[]? Genres { get; init; }
    public string? OriginalLanguage { get; init; }
    public string[]? OriginCountry { get; init; }
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? AdditionalProperties { get; init; }
}

public sealed record DownloadRoute(string Kind, string Category, string Confidence,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? CleanTitle = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? SavePath = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? RelativePath = null);
public sealed record SourceStatus(string Id, int Count, string? Error = null);
public sealed record AvailableSource(string Id, string Name, bool EnabledByDefault);
public sealed record ReleaseGroup(string Key, string Label, TorrentResult Best, IReadOnlyList<TorrentResult> Alternatives);

public sealed record SearchResponse
{
    public required string Query { get; init; }
    public IReadOnlyList<TorrentResult> Results { get; init; } = [];
    public IReadOnlyList<ReleaseGroup> Groups { get; init; } = [];
    public long TookMs { get; init; }
    public bool? Cached { get; init; }
    public int TotalCount { get; init; }
    public int Page { get; init; } = 1;
    public int PageSize { get; init; } = 20;
    public int TotalPages { get; init; }
    public IReadOnlyList<SourceStatus> Sources { get; init; } = [];
    public IReadOnlyList<AvailableSource>? AvailableSources { get; init; }
}
