using System.Collections.Immutable;
using MonoTorrent.Client;

namespace TorrentFlow.Engine;

internal sealed class ProbeSampling : IDisposable
{
    private readonly TorrentManager manager;
    private readonly long baseline;
    private readonly object sync = new();
    private readonly Dictionary<PeerId, long> connections = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<string, long> bytes = new(StringComparer.Ordinal);
    private long received;

    public ProbeSampling(TorrentManager manager)
    {
        this.manager = manager;
        baseline = manager.Monitor.DataBytesReceived;
        manager.PeerConnected += Connected;
        manager.PeerDisconnected += Disconnected;
    }

    private void Connected(object? sender, PeerConnectedEventArgs args) => Capture(args.Peer);
    private void Disconnected(object? sender, PeerDisconnectedEventArgs args) => Capture(args.Peer);

    private void Capture(PeerId peer)
    {
        lock (sync)
        {
            var current = peer.Monitor.DataBytesReceived;
            var delta = Math.Max(0, current - connections.GetValueOrDefault(peer));
            connections[peer] = current;
            var uri = peer.Uri.ToString();
            bytes[uri] = bytes.GetValueOrDefault(uri) + delta;
        }
    }

    public (long Bytes, ImmutableDictionary<string, long> Peers) Sample(IEnumerable<PeerId> peers)
    {
        foreach (var peer in peers) Capture(peer);
        lock (sync)
        {
            foreach (var peer in connections.Keys.ToArray()) Capture(peer);
            // Preserve observed payload if MonoTorrent enters ErrorMode and resets its monitor.
            received = Math.Max(received, Math.Max(bytes.Values.Sum(), manager.Monitor.DataBytesReceived - baseline));
            return (received,
                bytes.Where(p => p.Value > 0).ToImmutableDictionary(StringComparer.Ordinal));
        }
    }

    public void Dispose()
    {
        manager.PeerConnected -= Connected;
        manager.PeerDisconnected -= Disconnected;
    }
}
