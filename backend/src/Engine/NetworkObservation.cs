using System.Collections.Immutable;
using MonoTorrent.Client;

namespace TorrentFlow.Engine;

internal sealed class NetworkObservation : IDisposable
{
    private readonly TorrentManager manager;
    private readonly object sync = new();
    private readonly Dictionary<string, int> discoveries = [];
    private int connected, failed;

    public NetworkObservation(TorrentManager manager)
    {
        this.manager = manager;
        manager.PeersFound += Found;
        manager.PeerConnected += Connected;
        manager.ConnectionAttemptFailed += Failed;
    }

    private void Found(object? sender, PeersAddedEventArgs args)
    {
        var source = args switch
        {
            TrackerPeersAdded tracker => tracker.Tracker.Uri.ToString(),
            DhtPeersAdded => "dht",
            PeerExchangePeersAdded => "pex",
            LocalPeersAdded => "local",
            _ => "other",
        };
        lock (sync) discoveries[source] = discoveries.GetValueOrDefault(source) + args.NewPeers;
    }

    private void Connected(object? sender, PeerConnectedEventArgs args)
    { lock (sync) connected++; }

    private void Failed(object? sender, ConnectionAttemptFailedEventArgs args)
    { lock (sync) failed++; }

    public (ImmutableDictionary<string, int> Discoveries, int Connected, int Failed) Snapshot()
    { lock (sync) return (discoveries.ToImmutableDictionary(), connected, failed); }

    public void Dispose()
    {
        manager.PeersFound -= Found;
        manager.PeerConnected -= Connected;
        manager.ConnectionAttemptFailed -= Failed;
    }
}
