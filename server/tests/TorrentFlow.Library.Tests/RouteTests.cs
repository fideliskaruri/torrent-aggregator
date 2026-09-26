using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Activity;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Library.Features.Storage;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Tests;

public sealed class RouteTests
{
    private static async Task<JsonElement> Json(HttpResponseMessage response) =>
        JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();
    [Theory]
    [InlineData("/api/watchlist", "items")]
    [InlineData("/api/history", "items")]
    [InlineData("/api/rules", "rules")]
    [InlineData("/api/progress", "entries")]
    [InlineData("/api/activity", "items")]
    public async Task ReadEndpointsKeepEnvelope(string path, string property)
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        var response = await client.GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(0, (await Json(response)).GetProperty(property).GetArrayLength());
    }
    [Fact]
    public async Task WatchlistUpsertPreservesPosterAndMonitoringAndDeleteKeepsFiles()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        var add = await client.PostAsJsonAsync("/api/watchlist", new { mediaType = "tv", externalId = "example", title = "Example Show",
            posterUrl = "https://example.invalid/poster", monitored = false, fromSeason = 2 });
        Assert.Equal(HttpStatusCode.OK, add.StatusCode);
        var id = (await Json(add)).GetProperty("item").GetProperty("id").GetString();
        var update = await client.PostAsJsonAsync("/api/watchlist", new { mediaType = "tv", externalId = "example", title = "Example Show", fromSeason = 3 });
        var item = (await Json(update)).GetProperty("item");
        Assert.False(item.GetProperty("monitored").GetBoolean());
        Assert.Equal("https://example.invalid/poster", item.GetProperty("posterUrl").GetString());
        Assert.Equal(3, item.GetProperty("cursorSeason").GetInt32());
        Assert.Equal(JsonValueKind.Null, item.GetProperty("preferredResolution").ValueKind);
        var removed = await client.DeleteAsync($"/api/watchlist?id={id}");
        Assert.True((await Json(removed)).GetProperty("filesKept").GetBoolean());
        Assert.Empty(host.Engine.Removed);
    }
    [Theory]
    [InlineData("{", "Request body is not valid JSON")]
    [InlineData("[]", "JSON body must be an object")]
    [InlineData("{\"mediaType\":\"book\"}", "mediaType must be anime, movie, or tv")]
    [InlineData("{\"mediaType\":\"tv\",\"externalId\":\"x\",\"title\":\"x\",\"preferredResolution\":1440}", "preferredResolution must be one of 480, 720, 1080, 2160")]
    public async Task WatchlistValidationMatches(string body, string error)
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        var response = await client.PostAsync("/api/watchlist", new StringContent(body, Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(error, (await Json(response)).GetProperty("error").GetString());
    }
    [Fact]
    public async Task BrowserCrossSiteMutationIsRefused()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        client.DefaultRequestHeaders.Add("Sec-Fetch-Site", "cross-site");
        var response = await client.DeleteAsync("/api/watchlist?id=absent");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }
    [Fact]
    public async Task ProgressNormalizesHashAndCompletionNeverRewinds()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        var hash = new string('A', 40);
        async Task<HttpResponseMessage> Post(double position) => await client.PostAsJsonAsync("/api/progress", new
        { infoHash = hash, filePath = "Example\\S01E01.mkv", title = "Example Show", positionSec = position, durationSec = 100 });
        var first = await Json(await Post(95));
        var second = await Json(await Post(10));
        Assert.Equal(first.GetProperty("id").GetString(), second.GetProperty("id").GetString());
        Assert.Equal(first.GetProperty("completedAt").GetString(), second.GetProperty("completedAt").GetString());
        var rows = (await Json(await client.GetAsync($"/api/progress?infoHash={hash}"))).GetProperty("entries");
        Assert.Single(rows.EnumerateArray());
        Assert.Equal(hash.ToLowerInvariant(), rows[0].GetProperty("infoHash").GetString());
        Assert.Equal("Example/S01E01.mkv", rows[0].GetProperty("filePath").GetString());
        Assert.Empty((await Json(await client.GetAsync("/api/progress?active=1"))).GetProperty("entries").EnumerateArray());
    }
    [Theory]
    [InlineData("../video.mkv")]
    [InlineData("/video.mkv")]
    [InlineData("C:\\video.mkv")]
    public async Task ProgressRejectsUnsafePaths(string path)
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        var response = await client.PostAsJsonAsync("/api/progress", new { infoHash = new string('a', 40), filePath = path, title = "Example", positionSec = 1, durationSec = 10 });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("filePath must be a safe path inside the torrent", (await Json(response)).GetProperty("error").GetString());
    }
    [Fact]
    public async Task ActivityPagesDenseTimestampsWithoutSkippingOrRepeating()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        var now = DateTime.UtcNow;
        await host.Seed(db =>
        {
            for (var i = 0; i < 127; i++) db.GrabJobs.Add(new() { Id = $"job{i:000}", UserId = LocalUser.Id, Title = "Example",
                Query = "Example", Status = "sent", CreatedAt = now, UpdatedAt = now });
            db.GrabJobs.Add(new() { Id = "stream", UserId = LocalUser.Id, Title = "Stream", Query = "Stream", Status = "sent", Retention = "stream", CreatedAt = now, UpdatedAt = now });
        });
        var ids = new List<string>(); string? cursor = null;
        for (var i = 0; i < 20; i++)
        {
            var page = await Json(await client.GetAsync("/api/activity?limit=10" + (cursor == null ? "" : $"&cursor={cursor}")));
            ids.AddRange(page.GetProperty("items").EnumerateArray().Select(x => x.GetProperty("id").GetString()!));
            cursor = page.GetProperty("nextCursor").GetString();
            if (cursor == null) break;
        }
        Assert.Equal(127, ids.Count);
        Assert.Equal(ids.Count, ids.Distinct().Count());
        var unread = await Json(await client.GetAsync("/api/activity/unread"));
        Assert.Equal(100, unread.GetProperty("count").GetInt32());
        Assert.True(unread.GetProperty("capped").GetBoolean());
    }
    [Fact]
    public void ActivityReconcilesOnlyOneTimeBoundedTwin()
    {
        var now = DateTime.UtcNow;
        ActivityRow Row(string id, string type, int seconds) => new(id, type, "Example", "sent", null, null, null, null, null, new string('a', 40), null, null, null, null, null, now.AddSeconds(seconds));
        var result = ActivityService.Reconcile([Row("grab-1", "grab", 0), Row("hist-1", "history", 0), Row("hist-2", "history", 10)]);
        Assert.Equal(2, result.Count);
        Assert.Equal("hist-2", result[0].Id);
        Assert.Equal("grab-1", result[1].Id);
        Assert.Equal(result[0].Id, ActivityService.Parse(ActivityService.Encode(result[0]))!.Id);
    }
    [Fact]
    public async Task OnDemandSendsExactEpisodeThroughQueueAndAdvancesOnlyMatchingCursor()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        await host.Seed(db => db.WatchListItems.Add(LibraryHost.Watch(episode: 2)));
        host.Search.Respond = o => new() { Query = o.Query, Results = [FakeSearch.Release("Example Show S01 1080p"), FakeSearch.Release("Example Show S01E02 1080p")] };
        host.Engine.Result = new(true, "Queued", new("queued", 0, 0, 3), new string('a', 40));
        var response = await client.PostAsJsonAsync("/api/library/ondemand", new { watchListItemId = "watch", season = 1, episode = 2 });
        var body = await Json(response);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(body.GetProperty("queued").GetBoolean());
        Assert.True(body.GetProperty("advanced").GetBoolean());
        var add = Assert.Single(host.Engine.Adds);
        Assert.Equal("s00001e00002", add.QueueKey);
        Assert.Equal(1000000, add.ExpectedSizeBytes);
        Assert.False(add.Forced);
        Assert.Equal(TorrentLane.Owner, add.Lane);
        await using var db = await host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        Assert.Equal(3, (await db.WatchListItems.SingleAsync()).CursorEpisode);
        Assert.False(await GrabService.Advance(db, "watch", new(1, 2), "late E2", default));
        Assert.Equal(3, (await db.WatchListItems.AsNoTracking().SingleAsync()).CursorEpisode);
    }
    [Theory]
    [InlineData("cap", true)]
    [InlineData("reserve", true)]
    [InlineData("wont-fit", false)]
    [InlineData("setup", false)]
    public async Task StorageRefusalIs507AndDoesNotAdvance(string limit, bool overridable)
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings(); await host.Seed(db => db.WatchListItems.Add(LibraryHost.Watch()));
        host.Search.Respond = o => new() { Query = o.Query, Results = [FakeSearch.Release("Example Show S01E01 1080p")] };
        host.Engine.Result = new(false, "Storage refused") { StorageLimit = limit };
        var response = await client.PostAsJsonAsync("/api/library/ondemand", new { watchListItemId = "watch", season = 1, episode = 1 });
        Assert.Equal((HttpStatusCode)507, response.StatusCode);
        Assert.Equal(overridable, (await Json(response)).GetProperty("storage").GetProperty("overridable").GetBoolean());
        await using var db = await host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        Assert.Equal(1, (await db.WatchListItems.SingleAsync()).CursorEpisode);
    }
    [Fact]
    public async Task RulesCrudAndNoMatchRun()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        var created = await Json(await client.PostAsJsonAsync("/api/rules", new { name = "Weekly", query = "Example", sources = "nyaa,nyaa", run = false }));
        var rule = created.GetProperty("rule"); var id = rule.GetProperty("id").GetString();
        Assert.Equal(10, rule.GetProperty("minSeeders").GetInt32());
        Assert.Equal("nyaa", rule.GetProperty("sources").GetString());
        Assert.Equal(JsonValueKind.Null, created.GetProperty("runResult").ValueKind);
        var run = await Json(await client.PostAsync("/api/rules/run", null));
        Assert.Equal("skipped", run.GetProperty("summary")[0].GetProperty("status").GetString());
        var patch = await client.PatchAsJsonAsync("/api/rules", new { id, enabled = false });
        Assert.False((await Json(patch)).GetProperty("rule").GetProperty("enabled").GetBoolean());
        Assert.Equal(HttpStatusCode.OK, (await client.DeleteAsync($"/api/rules?id={id}")).StatusCode);
    }
    [Fact]
    public async Task TitleSeasonPersistsOneExactTargetPerEpisode()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings(); await host.Seed(db => db.WatchListItems.Add(LibraryHost.Watch()));
        host.Search.Respond = o => new() { Query = o.Query, Results = [FakeSearch.Release(o.Query + " 1080p")] };
        var response = await client.PostAsJsonAsync("/api/title/example-show", new { scope = "season", season = 1, episodes = new[] { 1, 2, 3, 4 } });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await Json(response);
        Assert.Equal(4, body.GetProperty("report").GetProperty("coveredEpisodes").GetInt32());
        Assert.False(body.TryGetProperty("episodeTransfers", out _));
        Assert.Equal(["s00001e00001", "s00001e00002", "s00001e00003", "s00001e00004"], host.Engine.Adds.Select(x => x.QueueKey));
        Assert.All(host.Engine.Adds, x => Assert.NotNull(x.WorkId));
        await using var db = await host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        Assert.Equal(4, await db.AcquisitionTargets.CountAsync(x => x.Scope == "episode" && x.Status == "downloading"));
        Assert.Equal(0, await db.AcquisitionTargets.CountAsync(x => x.Scope == "season"));
    }
    [Theory]
    [InlineData("Example Show S01 1080p")]
    [InlineData("Example Show S01E01-E03 1080p")]
    [InlineData("Example Show S01E01E02 1080p")]
    public async Task DeletionRequiresConfirmationAndNeverDeletesAnEpisodeOutOfPack(string releaseName)
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Seed(db =>
        {
            db.WatchListItems.Add(LibraryHost.Watch());
            db.EngineTorrents.Add(new() { Id = "engine", UserId = LocalUser.Id, Hash = new string('a', 40), Name = releaseName, Origin = "user", Status = "parked", Progress = 1, SizeBytes = 1000,
                CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow, LastUsedAt = DateTime.UtcNow });
        });
        var unconfirmed = await client.PostAsJsonAsync("/api/library/delete", new { watchListItemId = "watch", scope = "show" });
        Assert.Equal(HttpStatusCode.BadRequest, unconfirmed.StatusCode);
        var blocked = await client.PostAsJsonAsync("/api/library/delete", new { watchListItemId = "watch", scope = "episode", season = 1, episode = 1, confirm = true });
        Assert.Equal(HttpStatusCode.Conflict, blocked.StatusCode);
        Assert.Equal("blocked", (await Json(blocked)).GetProperty("reason").GetString());
        Assert.Empty(host.Engine.Removed);
    }
    [Fact]
    public async Task BackfillEstimateNeverStartsDownloads()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        var response = await Json(await client.PostAsJsonAsync("/api/library/backfill-estimate", new { fromSeason = 1, toSeason = 3 }));
        Assert.Equal(66, response.GetProperty("episodes").GetInt32());
        Assert.Equal(99000000000, response.GetProperty("estimatedBytes").GetDouble());
        Assert.False(response.GetProperty("canFit").GetBoolean());
        Assert.Equal(BackfillController.SetupMessage, response.GetProperty("message").GetString());
        Assert.Empty(host.Engine.Adds);
    }
    [Theory]
    [InlineData(1, "verified", true)]
    [InlineData(1, null, false)]
    [InlineData(.5, "verified", false)]
    public async Task PackEpisodesRequireCompletedVerifiedEvidence(double progress, string? bitfield, bool covered)
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        var episodePath = Path.Combine(host.DataDirectory, "Example Show S01E02.mkv");
        var extraPath = Path.Combine(host.DataDirectory, "Extras", "Example Show S01E09.mkv");
        Directory.CreateDirectory(Path.GetDirectoryName(extraPath)!);
        await File.WriteAllTextAsync(episodePath, "test-media");
        await File.WriteAllTextAsync(extraPath, "extra");
        await host.Seed(db =>
        {
            db.WatchListItems.Add(LibraryHost.Watch());
            db.EngineTorrents.Add(new() { Id = "pack", UserId = LocalUser.Id, Hash = new string('a', 40),
                Name = "Example Show S01 1080p", Status = "parked", Origin = "user", Progress = progress,
                VerifiedBitfield = bitfield, VerifiedFilesJson = JsonSerializer.Serialize(new[] {
                    new { path = episodePath, size = 100 }, new { path = extraPath, size = 20 } }),
                CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow, LastUsedAt = DateTime.UtcNow });
        });
        var detail = await Json(await client.GetAsync("/api/title/example-show"));
        var episodes = detail.GetProperty("episodes");
        Assert.Equal(covered ? 2 : 1, episodes.GetArrayLength());
        var pack = detail.GetProperty("seasons")[0].GetProperty("pack");
        Assert.Equal(progress == 1 ? "ready" : "warm", pack.GetProperty("availability").GetString());
        if (covered)
        {
            Assert.True(episodes[1].GetProperty("fromPack").GetBoolean());
            Assert.Equal(episodePath, episodes[1].GetProperty("filePath").GetString());
            Assert.Equal("ready", episodes[1].GetProperty("availability").GetString());
            Assert.Equal(JsonValueKind.Null, episodes[1].GetProperty("transfer").ValueKind);
        }
    }
    [Theory]
    [InlineData(0)]
    [InlineData(.3)]
    public async Task SeasonSinglesExposeTheirOwnLiveTransferWithoutTargetRow(double progress)
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Seed(db =>
        {
            db.WatchListItems.Add(LibraryHost.Watch());
            db.EngineTorrents.Add(new() { Id = "single", UserId = LocalUser.Id, Hash = new string('a', 40),
                Name = "Example Show S01E01 1080p", Status = "queued", Origin = "user", Progress = progress,
                CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow, LastUsedAt = DateTime.UtcNow });
        });
        var episode = (await Json(await client.GetAsync("/api/title/example-show"))).GetProperty("episodes")[0];
        Assert.Equal("downloading", episode.GetProperty("transfer").GetProperty("status").GetString());
        Assert.Equal(progress, episode.GetProperty("downloadFraction").GetDouble());
        Assert.False(episode.GetProperty("fromPack").GetBoolean());
        if (progress == 0) Assert.Equal(JsonValueKind.Null, episode.GetProperty("availability").ValueKind);
    }
}
