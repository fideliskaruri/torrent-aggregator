using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Media.Features.Prewarm;

/// <summary>Constants shared by the pre-warm subsystem (src/lib/prewarm/types.ts).</summary>
public static class PrewarmOrigins
{
    /// <summary>EngineTorrent.origin values. Only prewarm rows may ever be evicted.</summary>
    public const string Prewarm = "prewarm";
    public const string User = "user";
    public const string Stream = "stream";
    /// <summary>Transient lease origin worn only while an eviction exclusively owns the row.</summary>
    public const string Evicting = "evicting";
    /// <summary>GrabJob.kind for a speculative grab, so Activity can label it honestly.</summary>
    public const string GrabKind = "prewarm";
}

internal static class PrewarmJson
{
    /// <summary>
    /// The Next.js routes write explicit nulls (<c>next: null</c>, <c>idleMs: null</c>), so the pre-warm routes
    /// serialise with nulls kept; optional fields that TypeScript leaves undefined opt out per property.
    /// </summary>
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };
}

/// <summary>A thing we might want to have ready. Season/episode are absent for films.</summary>
public sealed record PreRankTarget
{
    public required string Title { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public string? MediaType { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? Year { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? Season { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? Episode { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public int? PreferredResolution { get; init; }
}

/// <summary>
/// The outcome of pre-ranking one target. <c>Candidate == null</c> is a determined "nothing usable"; a null
/// choice (not this record) means "not yet determined".
/// </summary>
public sealed record PreRankedChoice
{
    public required string Key { get; init; }
    public required string Query { get; init; }
    public required string NormalizedQuery { get; init; }
    public required string Category { get; init; }
    public int? Season { get; init; }
    public int? Episode { get; init; }
    public TorrentResult? Candidate { get; init; }
    public int ResultCount { get; init; }
    /// <summary>memo | search-cache | search</summary>
    public required string Source { get; init; }
    public long RankedAt { get; init; }
    public long ExpiresAt { get; init; }
}

/// <summary>The episode a pre-warm would fetch, and how it was worked out.</summary>
public sealed record NextEpisode
{
    public required string Title { get; init; }
    public string? MediaType { get; init; }
    public int Season { get; init; }
    public int Episode { get; init; }
    public string? WatchListItemId { get; init; }
    /// <summary>playing-episode | hunt-cursor</summary>
    public required string Source { get; init; }
}

public sealed record PrewarmOutcome
{
    /// <summary>sent | skipped | failed | not-applicable</summary>
    public required string Status { get; init; }
    public required string Reason { get; init; }
    /// <summary>Diagnostic text for the server log. Never rendered as a user error.</summary>
    public required string Message { get; init; }
    public NextEpisode? Next { get; init; }
    public string? Title { get; init; }
    public string? InfoHash { get; init; }
    public bool PreRanked { get; init; }
    public bool FastPath { get; init; }
    public bool Labelled { get; init; }
    public int EvictedCount { get; init; }
    public long FreedBytes { get; init; }
}

public sealed record EvictionCandidate(string Id, string Hash, string Name, string Origin, long SizeBytes, double Progress, string Status, DateTime LastUsedAt);

public sealed record EvictionSkip(string Hash, string Reason);

public sealed record EvictionResult
{
    public List<EvictionCandidate> Evicted { get; } = [];
    public long FreedBytes { get; set; }
    public long NeededBytes { get; init; }
    public bool Satisfied { get; set; }
    public List<EvictionSkip> Skipped { get; } = [];
}
