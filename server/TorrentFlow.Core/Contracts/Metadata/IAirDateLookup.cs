namespace TorrentFlow.Core.Contracts.Metadata;

public interface IAirDateLookup
{
    Task<DateTime?> GetAirDateAsync(string title, string mediaType, string externalId, int season, int episode, CancellationToken ct);
}

public sealed class UnknownAirDateLookup : IAirDateLookup
{
    public Task<DateTime?> GetAirDateAsync(string title, string mediaType, string externalId, int season, int episode, CancellationToken ct) =>
        Task.FromResult<DateTime?>(null);
}
