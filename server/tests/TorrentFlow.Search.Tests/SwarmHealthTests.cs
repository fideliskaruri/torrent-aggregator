using Microsoft.Extensions.Logging.Abstractions;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Search.Tests;

public sealed class SwarmHealthTests
{
    [Theory]
    [InlineData(false, 10, 1000, 2000000, "unknown")]
    [InlineData(true, 0, 1000, 2000000, "unknown")]
    [InlineData(true, 2, 0, 2000000, "dead")]
    [InlineData(true, 2, 1000, 1499999, "weak")]
    [InlineData(true, 2, 1000, 1500000, "good")]
    [InlineData(true, 2, 1000, 2000000, "good")]
    public void Verdict_threshold_preserves_unknown(bool reached, int peers, long bytes, double speed, string expected) =>
        Assert.Equal(expected, SwarmHealth.Classify(new(reached, peers, bytes, speed, 1000000)));
    [Fact]
    public void Required_bitrate_and_name_are_honest()
    {
        Assert.Equal(1000000, SwarmHealth.RequiredBitrate(null, null));
        Assert.Equal(2000000, SwarmHealth.RequiredBitrate(20000000, 10));
        Assert.Equal(1000000, SwarmHealth.RequiredBitrate(double.NaN, 10));
        Assert.Equal("Some Film", SwarmHealth.DisplayName("magnet:?xt=urn:btih:abc&dn=Some+Film"));
        Assert.Null(SwarmHealth.DisplayName("magnet:?dn=%ZZ"));
    }
    private sealed class Engine(string state, SwarmSnapshot? snapshot = null) : ISwarmProbeEngine
    {
        public int Added;
        public int Disposed;
        public Task<SwarmLiveState> FindLiveAsync(string hash, CancellationToken token) => state == "throws"
            ? throw new IOException("Liveness unavailable") : Task.FromResult(new SwarmLiveState(state, snapshot));
        public Task<IIsolatedSwarmProbe> OpenIsolatedAsync(string magnet, CancellationToken token)
        {
            Added++;
            return Task.FromResult<IIsolatedSwarmProbe>(new Probe(this));
        }
        private sealed class Probe(Engine owner) : IIsolatedSwarmProbe
        {
            public SwarmSnapshot Snapshot => new(true, 3, 0, 0, 0);
            public ValueTask DisposeAsync() { owner.Disposed++; return ValueTask.CompletedTask; }
        }
    }
    private const string Hash = "aabbccdd00112233445566778899aabbccddeeff";
    [Theory]
    [InlineData("unknown")]
    [InlineData("throws")]
    public async Task Uncertain_liveness_never_adds_or_destroys(string state)
    {
        using var h = new SearchHarness();
        var engine = new Engine(state);
        var health = new SwarmHealth(engine, h, NullLogger<SwarmHealth>.Instance);
        Assert.Equal("unknown", (await health.ProbeAsync(null, Hash)).Verdict);
        Assert.Equal(0, engine.Added); Assert.Equal(0, engine.Disposed);
    }
    [Fact]
    public async Task Live_download_is_read_only_and_not_persisted()
    {
        using var h = new SearchHarness();
        var engine = new Engine("live", new(true, 4, 3, 10000000, 2000000));
        var health = new SwarmHealth(engine, h, NullLogger<SwarmHealth>.Instance);
        var result = await health.ProbeAsync(null, Hash);
        Assert.True(result.FromLiveDownload); Assert.Equal("good", result.Verdict);
        await health.RecordAsync(result);
        Assert.Null(await health.GetAsync(Hash)); Assert.Equal(0, engine.Added); Assert.Equal(0, engine.Disposed);
    }
    [Fact]
    public async Task Isolated_probe_is_disposed_and_expired_dead_is_unknown()
    {
        using var h = new SearchHarness();
        var engine = new Engine("absent");
        var health = new SwarmHealth(engine, h, NullLogger<SwarmHealth>.Instance);
        var result = await health.ProbeAsync($"magnet:?xt=urn:btih:{Hash}&dn=Film", window: TimeSpan.Zero);
        Assert.Equal("dead", result.Verdict); Assert.Equal(1, engine.Added); Assert.Equal(1, engine.Disposed);
        await health.RecordAsync(result, TimeSpan.FromSeconds(-1));
        var stored = await health.GetAsync(Hash);
        Assert.Equal("unknown", stored!.Verdict); Assert.True(stored.Expired);
        await health.RecordAsync(result with { Name = null }, TimeSpan.FromHours(1));
        stored = await health.GetAsync(Hash);
        Assert.Equal("Film", stored!.Name); Assert.Equal("dead", stored.Verdict);
    }
}
