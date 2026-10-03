using MonoTorrent.Dht;

namespace TorrentFlow.Engine;

// ClientEngine starts DHT again on its first torrent. In 3.0.2 that resets
// outstanding query tracking; make that start idempotent without a second client.
internal sealed class ReliableDhtEngine : DhtEngine, IDhtEngine
{
    private readonly SemaphoreSlim lifecycle = new(1, 1);
    private bool running;
    public Func<Task>? BeforeStop { get; set; }

    public new async Task StartAsync(ReadOnlyMemory<byte> nodes = default)
    {
        await lifecycle.WaitAsync();
        try
        {
            if (running) return;
            await base.StartAsync(nodes);
            running = true;
        }
        finally { lifecycle.Release(); }
    }

    Task IDhtEngine.StartAsync(ReadOnlyMemory<byte> nodes) => StartAsync(nodes);

    public new async Task StopAsync()
    {
        await lifecycle.WaitAsync();
        try
        {
            if (!running) return;
            if (BeforeStop is not null) await BeforeStop();
            await base.StopAsync();
            running = false;
        }
        finally { lifecycle.Release(); }
    }

    Task IDhtEngine.StopAsync() => StopAsync();
}
