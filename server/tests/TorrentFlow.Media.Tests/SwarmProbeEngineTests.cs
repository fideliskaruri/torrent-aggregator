using Microsoft.Extensions.Logging.Abstractions;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Media.Features.Prewarm;

namespace TorrentFlow.Media.Tests;

public sealed class SwarmProbeEngineTests
{
    private const string Hash = "150922bce30a1091e347741ebbf96072593a69b4";
    private const string Magnet = "magnet:?xt=urn:btih:" + Hash;

    [Fact]
    public async Task AFailedProbeRemovesTheErrorRowItCreated()
    {
        var engine = new FakeEngine { OnAdd = _ => new EngineAddResult(false, "Timed out waiting for torrent metadata", null, Hash) };
        var probes = new EngineSwarmProbeEngine(engine, NullLogger<EngineSwarmProbeEngine>.Instance);

        await Assert.ThrowsAsync<InvalidOperationException>(() => probes.OpenIsolatedAsync(Magnet, CancellationToken.None));

        Assert.Equal([Hash], engine.Removed);
    }

    [Fact]
    public async Task AFailedProbeNeverRemovesATransferTheEngineAlreadyHeld()
    {
        var engine = new FakeEngine { OnAdd = _ => new EngineAddResult(false, "Timed out waiting for torrent metadata", null, Hash) };
        engine.Torrents.Add(new EngineTorrentInfo { Hash = Hash, Name = "Sintel", State = "error" });
        var probes = new EngineSwarmProbeEngine(engine, NullLogger<EngineSwarmProbeEngine>.Instance);

        await Assert.ThrowsAsync<InvalidOperationException>(() => probes.OpenIsolatedAsync(Magnet, CancellationToken.None));

        Assert.Empty(engine.Removed);
    }
}
