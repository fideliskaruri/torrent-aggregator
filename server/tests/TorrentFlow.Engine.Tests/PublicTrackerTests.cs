using System.Net;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Torrents;

namespace TorrentFlow.Engine.Tests;

/// <summary>The shared public tracker list: refresh from ngosang (with a disk cache) and the shareable row magnet.</summary>
[Collection(nameof(PublicTrackerTests))]
public sealed class PublicTrackerTests : IDisposable
{
    private static readonly string[] Fetched = Enumerable.Range(1, 8).Select(i => $"udp://fresh{i}.example.org:{6900 + i}/announce").ToArray();
    private readonly string _root = EngineHarness.NewRoot();

    public void Dispose()
    {
        PublicTrackers.Reset();
        try { Directory.Delete(_root, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private sealed class StubHandler(Func<HttpResponseMessage> respond) : HttpMessageHandler
    {
        public int Calls;
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Interlocked.Increment(ref Calls);
            return Task.FromResult(respond());
        }
    }

    private sealed class StubFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private TrackerListRefreshService Service(HttpMessageHandler handler, bool enabled = true) => new(new StubFactory(handler),
        Options.Create(new EngineOptions { DataDirectory = _root, RefreshTrackers = enabled }), TimeProvider.System,
        NullLogger<TrackerListRefreshService>.Instance);

    private static HttpResponseMessage Ok(string body) => new(HttpStatusCode.OK) { Content = new StringContent(body) };

    [Fact]
    public async Task RefreshAppliesTheFetchedListAndCachesIt()
    {
        var handler = new StubHandler(() => Ok("\n" + string.Join("\n\n", Fetched) + "\n"));

        Assert.True(await Service(handler).RefreshAsync(CancellationToken.None));

        Assert.Equal(Fetched, PublicTrackers.Current);
        var cached = await File.ReadAllLinesAsync(Path.Combine(_root, TrackerListRefreshService.CacheFileName));
        Assert.Equal(Fetched, cached.Where(l => l.Length > 0));
    }

    [Fact]
    public async Task OfflineStartupFallsBackToTheCacheThenTheDefault()
    {
        var offline = new StubHandler(() => throw new HttpRequestException("offline"));

        Assert.False(await Service(offline).RefreshAsync(CancellationToken.None));
        Assert.Equal(PublicTrackers.Default, PublicTrackers.Current);

        await File.WriteAllTextAsync(Path.Combine(_root, TrackerListRefreshService.CacheFileName), string.Join("\n", Fetched));
        using var service = Service(offline);
        await service.StartAsync(CancellationToken.None);
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (offline.Calls < 2 && DateTime.UtcNow < deadline) await Task.Delay(20);
        await service.StopAsync(CancellationToken.None);

        Assert.Equal(Fetched, PublicTrackers.Current);
    }

    [Fact]
    public async Task GarbageResponsesKeepTheCurrentList()
    {
        var handler = new StubHandler(() => Ok("<html>rate limited</html>\nudp://only.example.org:1/announce"));
        Assert.False(await Service(handler).RefreshAsync(CancellationToken.None));
        Assert.Equal(PublicTrackers.Default, PublicTrackers.Current);
    }

    [Fact]
    public async Task DisabledRefreshNeverFetches()
    {
        var handler = new StubHandler(() => Ok(string.Join("\n", Fetched)));
        using var service = Service(handler, enabled: false);
        await service.StartAsync(CancellationToken.None);
        await Task.Delay(100);
        await service.StopAsync(CancellationToken.None);
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task ListedRowsCarryAShareableMagnetWithOwnAndPublicTrackers()
    {
        await using var h = await EngineHarness.CreateAsync();
        const string own = "udp://own.example.org:1/announce";
        var magnet = EngineHarness.Magnet(1) + "&tr=" + Uri.EscapeDataString(own);
        Assert.True((await h.Engine.AddAsync(new EngineAddRequest { Magnet = magnet, Purpose = TorrentPurpose.Keep })).Ok);

        var row = Assert.Single(await h.Engine.ListAsync());

        Assert.StartsWith($"magnet:?xt=urn:btih:{EngineHarness.Hash(1)}&dn=", row.Magnet, StringComparison.Ordinal);
        var trackers = PublicTrackers.TrackersOf(row.Magnet);
        Assert.Equal(own, trackers[0]);
        Assert.Superset(PublicTrackers.Current.ToHashSet(), trackers.ToHashSet());
        Assert.Equal(row.Magnet, (await h.Engine.GetAsync(EngineHarness.Hash(1)))!.Magnet);
    }

    [Fact]
    public async Task LocalOnlyTrackerRowsShareOnlyTheirOwnTrackers()
    {
        await using var h = await EngineHarness.CreateAsync();
        const string local = "http://192.168.1.10:8080/announce";
        var magnet = EngineHarness.Magnet(2) + "&tr=" + Uri.EscapeDataString(local);
        Assert.True((await h.Engine.AddAsync(new EngineAddRequest { Magnet = magnet, Purpose = TorrentPurpose.Keep })).Ok);

        var row = Assert.Single(await h.Engine.ListAsync());

        Assert.Equal([local], PublicTrackers.TrackersOf(row.Magnet));
    }
}
