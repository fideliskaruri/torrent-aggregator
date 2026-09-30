namespace TorrentFlow.Core.Contracts.Metadata;

public interface IAirDateLookup
{
    Task<DateTime?> GetAirDateAsync(string title, string mediaType, string externalId, int season, int episode, CancellationToken ct);

    /// <summary>
    /// The first episode that airs after <paramref name="after"/>, from provider air dates. Never a guess: an
    /// episode without an air date, or a provider that cannot answer, is <see cref="NewEpisodeStatus.Unknown"/>.
    /// </summary>
    Task<NewEpisodeLookup> GetFirstEpisodeAfterAsync(string title, string mediaType, string externalId, DateTime after, CancellationToken ct);

    /// <summary>
    /// True only when the provider proves the season has finished: it lists a contiguous run of episodes, every one
    /// has an air date before <paramref name="now"/>, and nothing further is announced. False when it is still airing;
    /// null when the provider cannot tell. Callers must treat anything but true as "not finished" (fail closed).
    /// </summary>
    Task<bool?> SeasonFinishedAsync(string title, string mediaType, string externalId, int season, DateTime now, CancellationToken ct) =>
        Task.FromResult<bool?>(null);
}

public enum NewEpisodeStatus
{
    /// <summary>The next episode and its air date are known.</summary>
    Found,
    /// <summary>The provider answered and lists nothing after the moment asked about.</summary>
    NoneAnnounced,
    /// <summary>The provider could not answer, or the next episode has no air date yet.</summary>
    Unknown,
}

/// <param name="AirsAt">When the episode airs, in UTC. Set only when <see cref="Status"/> is Found.</param>
public sealed record NewEpisodeLookup(NewEpisodeStatus Status, int Season = 0, int Episode = 0, DateTime? AirsAt = null)
{
    public static NewEpisodeLookup Unknown { get; } = new(NewEpisodeStatus.Unknown);
    public static NewEpisodeLookup NoneAnnounced { get; } = new(NewEpisodeStatus.NoneAnnounced);
    public static NewEpisodeLookup Found(int season, int episode, DateTime airsAt) => new(NewEpisodeStatus.Found, season, episode, airsAt);
}

public sealed class UnknownAirDateLookup : IAirDateLookup
{
    public Task<DateTime?> GetAirDateAsync(string title, string mediaType, string externalId, int season, int episode, CancellationToken ct) =>
        Task.FromResult<DateTime?>(null);

    public Task<NewEpisodeLookup> GetFirstEpisodeAfterAsync(string title, string mediaType, string externalId, DateTime after, CancellationToken ct) =>
        Task.FromResult(NewEpisodeLookup.Unknown);
}
