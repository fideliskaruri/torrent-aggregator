namespace TorrentFlow.Core.Contracts.Metadata;

public interface IKeylessSeriesLookup
{
    Task<string?> FindImdbIdAsync(string title, CancellationToken cancellationToken = default);
}
