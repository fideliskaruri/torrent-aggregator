using TorrentFlow.Domain;

namespace TorrentFlow.Engine;

/// <summary>Check supplies the stopping policy; Engine retains probe ownership and cleanup.</summary>
public interface IProgressiveProbeEngine
{
    Task<SwarmEvidence> ObserveProbeAsync(ProbeHandle handle, TimeSpan window,
        Func<ProbeProgress, bool> canComplete, CancellationToken ct);
}

public readonly record struct ProbeProgress(bool FilesKnown, long BytesDelivered, TimeSpan Window,
    int ByteSendingPeers, int HashFailures);
