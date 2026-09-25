using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Media.Features.Prewarm;
using static TorrentFlow.Media.Tests.PrewarmHarness;

namespace TorrentFlow.Media.Tests;

public sealed class PrewarmApiFactory : WebApplicationFactory<Program>
{
    public string Root { get; } = NewRoot();
    internal FakeEngine Engine { get; } = new();
    internal FakeSearch Search { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseSetting("TorrentFlow:DataDirectory", Root);
        builder.UseSetting("TorrentFlow:Engine:RefreshTrackers", "false");
        builder.UseSetting("TorrentFlow:Engine:Streaming", "true");
        builder.UseSetting("TorrentFlow:WebRoot", Path.Combine(Root, "no-web"));
        builder.ConfigureTestServices(s =>
        {
            // No background work in route tests: no engine monitor, no catalog refresh, no scheduler.
            s.RemoveAll<IHostedService>();
            s.RemoveAll<ITorrentEngine>();
            s.AddSingleton<ITorrentEngine>(sp =>
            {
                Engine.Db = sp.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>();
                return Engine;
            });
            s.RemoveAll<ITorrentSearchService>();
            s.AddSingleton<ITorrentSearchService>(Search);
        });
    }

    public IDbContextFactory<TorrentFlowDbContext> Db => Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>();

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try { Directory.Delete(Root, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

/// <summary>Route parity for /api/prewarm and /api/prewarm/swarm-probe (src/app/api/prewarm/**/route.ts).</summary>
public class PrewarmRouteTests(PrewarmApiFactory factory) : IClassFixture<PrewarmApiFactory>
{
    private readonly HttpClient _http = factory.CreateClient();

    private static async Task<JsonElement> Json(HttpResponseMessage r) => JsonDocument.Parse(await r.Content.ReadAsStringAsync()).RootElement;

    private Task<HttpResponseMessage> Post(object body) => _http.PostAsJsonAsync("/api/prewarm", body);

    private Task<HttpResponseMessage> PostRaw(string body, params (string Name, string Value)[] headers)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/prewarm") { Content = new StringContent(body, Encoding.UTF8, "application/json") };
        foreach (var (name, value) in headers) request.Headers.TryAddWithoutValidation(name, value);
        return _http.SendAsync(request);
    }

    private static async Task AssertError(HttpResponseMessage r, HttpStatusCode status, string error)
    {
        Assert.Equal(status, r.StatusCode);
        var body = await Json(r);
        Assert.Equal(error, body.GetProperty("error").GetString());
    }

    [Fact]
    public void TheFeatureReplacesTheNoOpSwarmProbeAndArmsTheScheduler()
    {
        var services = new ServiceCollection();
        services.AddSingleton<ISwarmProbeEngine, NoSwarm>();
        services.AddPrewarmFeature(new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["TorrentFlow:Engine:Streaming"] = "true" }).Build());
        Assert.Equal(typeof(EngineSwarmProbeEngine), Assert.Single(services, d => d.ServiceType == typeof(ISwarmProbeEngine)).ImplementationType);
        Assert.Contains(services, d => d.ServiceType == typeof(IHostedService) && d.ImplementationType == typeof(PreProbeScheduler));
        Assert.IsType<EngineSwarmProbeEngine>(factory.Services.GetRequiredService<ISwarmProbeEngine>());
    }

    [Fact]
    public void WithStreamingOffTheFeatureKeepsTheNoOpsAndNeverSchedules()
    {
        var services = new ServiceCollection();
        services.AddSingleton<ISwarmProbeEngine, NoSwarm>();
        services.AddPrewarmFeature(new ConfigurationBuilder().Build());
        Assert.Equal(typeof(NoSwarm), Assert.Single(services, d => d.ServiceType == typeof(ISwarmProbeEngine)).ImplementationType);
        Assert.DoesNotContain(services, d => d.ServiceType == typeof(IHostedService) && d.ImplementationType == typeof(PreProbeScheduler));
    }

    [Fact]
    public async Task GetReportsPrewarmsEvictablesUpcomingAndForeground()
    {
        await using (var db = await factory.Db.CreateDbContextAsync())
        {
            var now = DateTime.UtcNow;
            db.EngineTorrents.Add(new EngineTorrent
            {
                Id = Ids.New(), UserId = LocalUser.Id, Hash = Hash(501), Name = "Route Guess", Status = "parked", Origin = "prewarm", SizeBytes = 1234,
                Progress = 1, CreatedAt = now, UpdatedAt = now, LastUsedAt = new DateTime(2026, 1, 2, 3, 4, 5, 6, DateTimeKind.Utc),
            });
            await db.SaveChangesAsync();
        }
        var r = await _http.GetAsync("/api/prewarm");
        Assert.Equal(HttpStatusCode.OK, r.StatusCode);
        var body = await Json(r);
        var row = body.GetProperty("prewarms").EnumerateArray().Single(p => p.GetProperty("hash").GetString() == Hash(501));
        Assert.Equal("Route Guess", row.GetProperty("name").GetString());
        Assert.Equal(1234, row.GetProperty("sizeBytes").GetInt64());
        Assert.Equal("2026-01-02T03:04:05.006Z", row.GetProperty("lastUsedAt").GetString());
        Assert.True(body.GetProperty("evictableCount").GetInt32() >= 1);
        Assert.Equal(JsonValueKind.Array, body.GetProperty("protectedFromEviction").ValueKind);
        Assert.Equal(JsonValueKind.Array, body.GetProperty("upcoming").ValueKind);
        var fg = body.GetProperty("foreground");
        foreach (var key in new[] { "active", "idleMs", "hash", "parked", "graceMs" }) Assert.True(fg.TryGetProperty(key, out _), key);
        Assert.Equal(20000, fg.GetProperty("graceMs").GetInt64());
    }

    [Fact]
    public async Task PostRefusesCrossSiteAndMismatchedBrowserOrigins()
    {
        await AssertError(await PostRaw("{\"action\":\"evict\",\"bytes\":1}", ("Sec-Fetch-Site", "cross-site")), HttpStatusCode.Forbidden, "Cross-site browser requests are not allowed");
        await AssertError(await PostRaw("{}", ("Sec-Fetch-Site", "same-site"), ("Origin", "http://evil.localhost")), HttpStatusCode.Forbidden, "Browser request origin does not match this application");
        await AssertError(await PostRaw("{}", ("Sec-Fetch-Site", "weird")), HttpStatusCode.Forbidden, "Unrecognised browser request origin");
        await AssertError(await PostRaw("{\"action\":\"nope\"}", ("Sec-Fetch-Site", "same-site"), ("Origin", "http://localhost")), HttpStatusCode.BadRequest, "Unknown action");
    }

    [Fact]
    public async Task PostValidatesItsInput()
    {
        await AssertError(await PostRaw("{not json"), HttpStatusCode.BadRequest, "Invalid JSON");
        await AssertError(await Post(new { action = "nope" }), HttpStatusCode.BadRequest, "Unknown action");
        await AssertError(await Post(new { action = "evict", bytes = 0 }), HttpStatusCode.BadRequest, "bytes must be positive");
        await AssertError(await Post(new { action = "evict", bytes = "abc" }), HttpStatusCode.BadRequest, "bytes must be positive");
        await AssertError(await Post(new { action = "next", title = "x" }), HttpStatusCode.BadRequest, "infoHash and title are required");
        await AssertError(await Post(new { action = "next", infoHash = "zz", title = "x" }), HttpStatusCode.BadRequest, "infoHash and title are required");
        await AssertError(await Post(new { action = "progress", infoHash = Hash(1) }), HttpStatusCode.BadRequest, "infoHash and title are required");
        await AssertError(await Post(new { action = "trigger", next = new { title = " ", season = 1, episode = 2 } }), HttpStatusCode.BadRequest, "next requires title, season and episode");
        await AssertError(await Post(new { action = "trigger", next = new { title = "Show", season = "1", episode = 2 } }), HttpStatusCode.BadRequest, "next requires title, season and episode");
        await AssertError(await Post(new { action = "trigger" }), HttpStatusCode.BadRequest, "next requires title, season and episode");
    }

    [Fact]
    public async Task EvictReportsWhatItFreed()
    {
        var body = await Json(await Post(new { action = "evict", bytes = 1 }));
        Assert.True(body.GetProperty("ok").GetBoolean());
        foreach (var key in new[] { "satisfied", "freedBytes", "evicted", "skipped" }) Assert.True(body.TryGetProperty(key, out _), key);
    }

    [Fact]
    public async Task ForegroundBeaconMarksAndReleaseExpires()
    {
        var marked = await Json(await Post(new { action = "foreground", infoHash = Hash(777), beacon = true }));
        Assert.True(marked.GetProperty("ok").GetBoolean());
        Assert.True(marked.GetProperty("snapshot").GetProperty("active").GetBoolean());
        Assert.Equal(Hash(777), marked.GetProperty("snapshot").GetProperty("hash").GetString());
        foreach (var key in new[] { "foreground", "suspended", "resumed", "parked" }) Assert.True(marked.TryGetProperty(key, out _), key);

        var released = await Json(await Post(new { action = "foreground", released = Hash(777) }));
        Assert.False(released.GetProperty("snapshot").GetProperty("active").GetBoolean());
    }

    [Fact]
    public async Task NextWithoutAnyEpisodeIsAnExplicitNull()
    {
        var r = await Post(new { action = "next", infoHash = Hash(2), title = "Some Film 2020" });
        Assert.Equal("{\"ok\":true,\"next\":null}", await r.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task NextFindsTheEpisodeInsideTheSeasonPackAlreadyPlaying()
    {
        var root = Path.Combine(factory.Root, "downloads");
        var files = JsonSerializer.Serialize(new[]
        {
            new { path = "Pack/Route.Show.S01E01.mkv", size = 100, mtimeMs = 0, fullPath = Path.Combine(root, "Pack", "Route.Show.S01E01.mkv") },
            new { path = "Pack/Route.Show.S01E02.mkv", size = 100, mtimeMs = 0, fullPath = Path.Combine(root, "Pack", "Route.Show.S01E02.mkv") },
        });
        await using (var db = await factory.Db.CreateDbContextAsync())
        {
            var now = DateTime.UtcNow;
            db.EngineTorrents.Add(new EngineTorrent
            {
                Id = Ids.New(), UserId = LocalUser.Id, Hash = Hash(600), Name = "Route.Show.S01.1080p", Status = "downloading", Origin = "user",
                SizeBytes = 200, Progress = 0.4, CreatedAt = now, UpdatedAt = now, LastUsedAt = now, SavePath = root, VerifiedFilesJson = files,
            });
            await db.SaveChangesAsync();
        }
        var body = await Json(await Post(new { action = "next", infoHash = Hash(600).ToUpperInvariant(), title = "Route.Show.S01E01.1080p", season = 1, episode = 1 }));
        var next = body.GetProperty("next");
        Assert.Equal("Route Show", next.GetProperty("title").GetString());
        Assert.Equal("S01E02", next.GetProperty("label").GetString());
        Assert.Equal("ready", next.GetProperty("availability").GetString());
        Assert.Equal(Hash(600), next.GetProperty("infoHash").GetString());
        Assert.Equal("Pack/Route.Show.S01E02.mkv", next.GetProperty("filePath").GetString());
        Assert.Equal(0.4, next.GetProperty("progress").GetDouble());
        Assert.Equal("playing-episode", next.GetProperty("source").GetString());
    }

    [Fact]
    public async Task NextNotFetchedCarriesExplicitNulls()
    {
        var body = await Json(await Post(new { action = "next", infoHash = Hash(3), title = "Unheld.Show.S02E05.720p", season = 2, episode = 5 }));
        var next = body.GetProperty("next");
        Assert.Equal("not-fetched", next.GetProperty("availability").GetString());
        Assert.Equal(JsonValueKind.Null, next.GetProperty("infoHash").ValueKind);
        Assert.Equal(JsonValueKind.Null, next.GetProperty("filePath").ValueKind);
        Assert.Equal(JsonValueKind.Null, next.GetProperty("progress").ValueKind);
        Assert.Equal(6, next.GetProperty("episode").GetInt32());
    }

    [Fact]
    public async Task TriggerReturnsTheOutcomeShape()
    {
        factory.Search.Respond = o => new SearchResponse { Query = o.Query };
        var body = await Json(await Post(new { action = "trigger", next = new { title = "Trigger Show", season = 3, episode = 1, source = "hunt-cursor" } }));
        Assert.True(body.GetProperty("ok").GetBoolean());
        var outcome = body.GetProperty("outcome");
        Assert.Equal("not-applicable", outcome.GetProperty("status").GetString());
        Assert.Equal("no-release", outcome.GetProperty("reason").GetString());
        Assert.Equal("No usable release for S03E01 in 0 results", outcome.GetProperty("message").GetString());
        Assert.Equal("Trigger Show S03E01", outcome.GetProperty("title").GetString());
        Assert.Equal(JsonValueKind.Null, outcome.GetProperty("infoHash").ValueKind);
        Assert.True(outcome.GetProperty("preRanked").GetBoolean());
        Assert.Equal(0, outcome.GetProperty("evictedCount").GetInt32());
        var next = outcome.GetProperty("next");
        Assert.Equal("hunt-cursor", next.GetProperty("source").GetString());
        Assert.Equal(JsonValueKind.Null, next.GetProperty("mediaType").ValueKind);
        Assert.Equal(JsonValueKind.Null, next.GetProperty("watchListItemId").ValueKind);
    }

    [Fact]
    public async Task ProgressBelowTheTriggerIsASkipWithNullNext()
    {
        var body = await Json(await Post(new { action = "progress", infoHash = Hash(4), title = "x", positionSec = 1, durationSec = 1000 }));
        var outcome = body.GetProperty("outcome");
        Assert.Equal("below-trigger", outcome.GetProperty("reason").GetString());
        Assert.Equal(JsonValueKind.Null, outcome.GetProperty("next").ValueKind);
        Assert.Equal(JsonValueKind.Null, outcome.GetProperty("title").ValueKind);
    }

    [Fact]
    public async Task PrerankDispatchesTheProbePass()
    {
        var body = await Json(await Post(new { action = "prerank", limit = 2 }));
        Assert.True(body.GetProperty("ok").GetBoolean());
        Assert.Contains(body.GetProperty("preProbe").GetString(), new[] { "scheduled", "unavailable", "busy" });
        Assert.Equal(JsonValueKind.Array, body.GetProperty("preRanked").ValueKind);
    }

    [Fact]
    public async Task PrerankIsBusyWhileAPassHoldsTheLease()
    {
        var gate = factory.Services.GetRequiredService<PreProbeLock>();
        var release = gate.TryAcquire(LocalUser.Id);
        try
        {
            Assert.NotNull(release);
            var r = await Post(new { action = "prerank" });
            Assert.Equal("{\"ok\":true,\"preProbe\":\"busy\",\"preRanked\":[],\"message\":\"A bounded pre-rank/probe pass is already running.\"}", await r.Content.ReadAsStringAsync());
        }
        finally
        {
            release?.Invoke();
        }
    }

    [Fact]
    public async Task SwarmProbeScopeRoundTrips()
    {
        var get = await Json(await _http.GetAsync("/api/prewarm/swarm-probe"));
        Assert.Equal("monitored", get.GetProperty("defaultScope").GetString());
        Assert.Equal(["off", "watching", "monitored"], get.GetProperty("choices").EnumerateArray().Select(c => c.GetProperty("value").GetString()));
        Assert.Equal("Only what I'm watching", get.GetProperty("choices")[1].GetProperty("label").GetString());
        Assert.Equal(JsonValueKind.Array, get.GetProperty("measurements").ValueKind);

        var bad = await _http.PutAsync("/api/prewarm/swarm-probe", new StringContent("{oops", Encoding.UTF8, "application/json"));
        await AssertError(bad, HttpStatusCode.BadRequest, "Invalid JSON");

        var put = await _http.PutAsJsonAsync("/api/prewarm/swarm-probe", new { scope = "watching" });
        Assert.Equal("{\"ok\":true,\"scope\":\"watching\"}", await put.Content.ReadAsStringAsync());
        Assert.Equal("watching", (await Json(await _http.GetAsync("/api/prewarm/swarm-probe"))).GetProperty("scope").GetString());

        var clamped = await Json(await _http.PutAsJsonAsync("/api/prewarm/swarm-probe", new { scope = "everything" }));
        Assert.Equal("monitored", clamped.GetProperty("scope").GetString());
    }

    [Fact]
    public async Task SwarmProbeListsMeasurementsWithFreshness()
    {
        await using (var db = await factory.Db.CreateDbContextAsync())
        {
            db.SwarmMeasurements.Add(new SwarmMeasurement
            {
                Id = Ids.New(), InfoHash = Hash(900), Name = "Measured", Verdict = "good", PeersConnected = 4, PeersUnchoked = 2, EffectiveBps = 1e6,
                RequiredBps = 5e5, MeasuredAt = DateTime.UtcNow, ExpiresAt = DateTime.UtcNow.AddHours(6), CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
            });
            await db.SaveChangesAsync();
        }
        var get = await Json(await _http.GetAsync("/api/prewarm/swarm-probe"));
        var m = get.GetProperty("measurements").EnumerateArray().Single(x => x.GetProperty("infoHash").GetString() == Hash(900));
        Assert.Equal("good", m.GetProperty("verdict").GetString());
        Assert.False(m.GetProperty("expired").GetBoolean());
        Assert.EndsWith("Z", m.GetProperty("expiresAt").GetString());
    }
}
