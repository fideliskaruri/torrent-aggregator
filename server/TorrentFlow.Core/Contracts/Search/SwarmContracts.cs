namespace TorrentFlow.Core.Contracts.Search;

public sealed record SwarmSnapshot(bool HasMetadata, int PeersConnected, int PeersUnchoked, long BytesReceived, double DownloadSpeed, long? SizeBytes = null);
public sealed record SwarmLiveState(string State, SwarmSnapshot? Snapshot = null);

/// <summary>Engine-owned handles distinguish absence from failed liveness checks and never expose user downloads for destruction.</summary>
public interface ISwarmProbeEngine
{
    Task<SwarmLiveState> FindLiveAsync(string infoHash, CancellationToken cancellationToken);
    Task<IIsolatedSwarmProbe> OpenIsolatedAsync(string magnet, CancellationToken cancellationToken);
}

/// <summary>Disposal must remove only the isolated probe and its partial data, never an existing download.</summary>
public interface IIsolatedSwarmProbe : IAsyncDisposable
{
    SwarmSnapshot Snapshot { get; }
}
