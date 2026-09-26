namespace TorrentFlow.Core.Contracts.Library;

/// <summary>Links recovered engine rows to the existing Library without starting monitored acquisition.</summary>
public interface ILibraryDownloadRecovery
{
    Task RegisterAsync(IReadOnlyCollection<string> hashes, CancellationToken ct = default);
}
