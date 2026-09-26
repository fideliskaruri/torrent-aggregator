namespace TorrentFlow.Core.Contracts.Metadata;

public interface ITmdbCredentialProvider
{
    string? ApiKey { get; }
    long Revision { get; }
}
