namespace TorrentFlow.Core.Contracts.Media;

/// <summary>A work the user is likely to play next (TS PreRankTarget). Title is a work name, never a raw release name.</summary>
public sealed record UpcomingPlaybackTarget(
    string Title,
    string? MediaType = null,
    int? Year = null,
    int? Season = null,
    int? Episode = null,
    int? PreferredResolution = null);

/// <summary>
/// Source of the "upcoming" pre-rank/pre-probe targets (TS upcomingTargets). Sources are "watching", "monitored" and
/// "watchlist"; the Media module registers a continue-watching default via TryAddSingleton, and a library-aware
/// module may replace it.
/// </summary>
public interface IUpcomingPlaybackTargets
{
    Task<IReadOnlyList<UpcomingPlaybackTarget>> ListAsync(int limit, IReadOnlyList<string> sources, CancellationToken cancellationToken = default);
}
