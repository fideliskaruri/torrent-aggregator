namespace TorrentFlow.Core.Contracts.Engine;

public sealed record TransferHealth(int? ConnectedSeeders, int? ConnectedPeers, long DownloadBytesPerSecond,
    long StalledForSeconds, string State);

/// <summary>Session-local observations, shared by manual release selection and future automatic recovery.</summary>
public sealed class TransferHealthTracker
{
    private readonly Dictionary<string, (double Progress, DateTime Since)> _observations = new(StringComparer.Ordinal);

    public TransferHealth Observe(EngineTorrentInfo torrent, DateTime now)
    {
        lock (_observations)
        {
            var waiting = torrent.State is "stalledDL" or "metaDL" or "downloading" && torrent.Dlspeed == 0;
            if (!waiting || !_observations.TryGetValue(torrent.Hash, out var previous) || torrent.Progress > previous.Progress)
                _observations[torrent.Hash] = (torrent.Progress, now);
            var since = _observations[torrent.Hash].Since;
            return new(torrent.Seeders, torrent.Peers, torrent.Dlspeed,
                waiting ? Math.Max(0, (long)(now - since).TotalSeconds) : 0, torrent.State);
        }
    }

    public void Forget(string hash) { lock (_observations) _observations.Remove(hash); }
}
