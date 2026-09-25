using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Storage;
using TorrentFlow.Library.Features.Titles;

namespace TorrentFlow.Library.Tests;

/// <summary>Regression tests for code-review findings in the Library port.</summary>
public sealed class ReviewFixTests
{
    private static async Task<JsonElement> Json(HttpResponseMessage response) =>
        JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();
    private static async Task<TorrentFlowDbContext> Db(LibraryHost host) =>
        await host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();

    /// <summary>
    /// The .NET engine's manifest (TorrentEngineService.BuildManifest): torrent-relative path, absolute fullPath. After the
    /// content layout (CompletedLayoutFinalizer) fullPath is the moved location and null for discarded duplicate junk,
    /// while path keeps the original torrent-relative name.
    /// </summary>
    private static string DotNetManifest(params (string Relative, string? Full, long Size)[] files) =>
        JsonSerializer.Serialize(files.Select(f => new { path = f.Relative, size = f.Size, mtimeMs = 1758780000000L, fullPath = f.Full }));
    private const string Spam = "Torrent Downloaded From ExtraTorrent.cc.txt";

    private static EngineTorrent Engine(string name, string? files = null, string hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", DateTime? updated = null) => new()
    {
        Id = Guid.NewGuid().ToString("N"), UserId = LocalUser.Id, Hash = hash, Name = name, Status = "parked", Origin = "user", Progress = 1,
        VerifiedBitfield = "verified", VerifiedFilesJson = files, SizeBytes = 1000, CreatedAt = updated ?? DateTime.UtcNow, UpdatedAt = updated ?? DateTime.UtcNow,
        LastUsedAt = updated ?? DateTime.UtcNow
    };

    [Fact]
    public void LaidOutFileListIsCheckedAtItsMovedPath()
    {
        var directory = Path.Combine(AppContext.BaseDirectory, "test-data", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            // The layout moved the episode out of its release folder and discarded a duplicate tracker-spam file.
            var present = Path.Combine(directory, "Example.Show.S01E02.mkv");
            File.WriteAllText(present, "media");
            var kept = Engine("Example.Show.S01E02.1080p.WEB", DotNetManifest(
                ("Example.Show.S01E02.1080p.WEB/Example.Show.S01E02.mkv", present, 5), ($"Example.Show.S01E02.1080p.WEB/{Spam}", null, 9)));
            Assert.False(TitleService.FilesAbsent(kept));
            var gone = Engine("Example.Show.S01E02.1080p.WEB", DotNetManifest(
                ("Example.Show.S01E02.1080p.WEB/Example.Show.S01E02.mkv", Path.Combine(directory, "gone.mkv"), 5), ($"Example.Show.S01E02.1080p.WEB/{Spam}", null, 9)));
            Assert.True(TitleService.FilesAbsent(gone));

            // Only the located file counts; the discarded duplicate is neither present nor missing.
            var plan = DeletionController.Plan([kept], new("episode", 1, 2));
            var release = Assert.Single(plan.Releases);
            Assert.Equal(1, release.FileCount);
            Assert.Equal(5, release.Bytes);
            Assert.Equal(0, plan.MissingFileCount);
        }
        finally { Directory.Delete(directory, true); }
    }

    [Fact]
    public async Task LaidOutPackEpisodeExposesItsMovedFilePath()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        // A double-wrapped pack the layout flattened into the season folder (LayoutFinalizerTests.DoubleWrappedPack...).
        const string outer = "Example Show S01 1080p BDRip x265-EMBER", inner = "Season 01";
        var season = Path.Combine(host.DataDirectory, "TV", "Example Show", "Season 01");
        var episodePath = Path.Combine(season, "Example Show S01E02.mkv");
        Directory.CreateDirectory(season);
        await File.WriteAllTextAsync(episodePath, "test-media");
        await host.Seed(db =>
        {
            db.WatchListItems.Add(LibraryHost.Watch());
            db.EngineTorrents.Add(Engine(outer, DotNetManifest(($"{outer}/{inner}/Example Show S01E02.mkv", episodePath, 100), ($"{outer}/{Spam}", null, 9))));
        });
        var episodes = (await Json(await client.GetAsync("/api/title/example-show"))).GetProperty("episodes");
        Assert.Equal(2, episodes.GetArrayLength());
        Assert.Equal(episodePath, episodes[1].GetProperty("filePath").GetString());
        Assert.Equal("ready", episodes[1].GetProperty("availability").GetString());
    }

    [Fact]
    public async Task PackEpisodeRangeCheckIgnoresFolderNames()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        // Absolute paths expose folder names (temp GUIDs, batch folders) that must not read as an episode range.
        var folder = Path.Combine(host.DataDirectory, "3f2e1d0c-e3-4a Batch E01-E12");
        var episodePath = Path.Combine(folder, "Example Show S01E02.mkv");
        Directory.CreateDirectory(folder);
        await File.WriteAllTextAsync(episodePath, "test-media");
        await host.Seed(db =>
        {
            db.WatchListItems.Add(LibraryHost.Watch());
            db.EngineTorrents.Add(Engine("Example Show S01 1080p", DotNetManifest(("Example Show S01E02.mkv", episodePath, 100))));
        });
        var episodes = (await Json(await client.GetAsync("/api/title/example-show"))).GetProperty("episodes");
        Assert.Equal(2, episodes.GetArrayLength());
        Assert.Equal(episodePath, episodes[1].GetProperty("filePath").GetString());
    }

    [Fact]
    public void EngineQueuedTransferStaysQueuedNotAZeroPercentDownload()
    {
        // Port of TS acquisition-target.test.ts "an engine-queued transfer stays queued, not a 0% download" (446bff0).
        var hash = new string('c', 40);
        var target = new AcquisitionTarget { Id = "t", UserId = LocalUser.Id, TargetKey = "k", WorkKey = "example-show", Scope = "episode", Status = "queued", InfoHash = hash };
        var row = Engine("Example Show S01E02 1080p", hash: hash);
        row.Status = "queued"; row.Progress = 0; row.VerifiedBitfield = null;
        TitleService.Reconcile(target, row);
        Assert.Equal(("queued", 0.0), (target.Status, target.Progress));

        // Promotion (or Download now) moves it on by itself on the next read.
        row.Status = "downloading"; row.Progress = .01;
        TitleService.Reconcile(target, row);
        Assert.Equal(("downloading", .01), (target.Status, target.Progress));
    }

    [Fact]
    public async Task TitlePageShowsAnEngineQueuedEpisodeAsQueued()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        var hash = new string('c', 40);
        await host.Seed(db =>
        {
            db.WatchListItems.Add(LibraryHost.Watch());
            var row = Engine("Example Show S01E01 1080p", hash: hash);
            row.Status = "queued"; row.Progress = 0; row.VerifiedBitfield = null;
            db.EngineTorrents.Add(row);
            db.AcquisitionTargets.Add(new() { Id = "t1", UserId = LocalUser.Id, TargetKey = "example-show:episode:1:1", WorkKey = "example-show",
                Scope = "episode", Season = 1, Episode = 1, Status = "downloading", InfoHash = hash, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
        });
        var episode = (await Json(await client.GetAsync("/api/title/example-show"))).GetProperty("episodes")[0];
        Assert.Equal("queued", episode.GetProperty("transfer").GetProperty("status").GetString());
        await using var db = await Db(host);
        Assert.Equal("queued", (await db.AcquisitionTargets.SingleAsync()).Status);
    }

    [Fact]
    public async Task TitlePageDownloadReturnsTheResolvedSavePath()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        host.Search.Respond = o => new() { Query = o.Query, Results = [FakeSearch.Release("Example Show S01E01 1080p")] };

        var response = await client.PostAsJsonAsync("/api/title/example-show", new
        {
            scope = "episode",
            season = 1,
            episode = 1,
            title = "Example Show",
            mediaType = "tv",
        });

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var json = await Json(response);
        Assert.True(json.GetProperty("ok").GetBoolean());
        var savePath = json.GetProperty("savePath").GetString();
        Assert.False(string.IsNullOrWhiteSpace(savePath));
        Assert.StartsWith(host.DataDirectory, savePath);
    }

    [Fact]
    public async Task LinkedTorrentOutsideScanWindowIsNotMarkedFailed()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        var linked = new string('c', 40);
        await host.Seed(db =>
        {
            var old = Engine("Example Show S01E01 1080p", hash: linked, updated: DateTime.UtcNow.AddDays(-30));
            old.Progress = .5; old.VerifiedBitfield = null;
            db.EngineTorrents.Add(old);
            for (var i = 0; i < 400; i++) db.EngineTorrents.Add(Engine($"Other Show {i} 1080p", hash: i.ToString("x40")));
            db.AcquisitionTargets.Add(new() { Id = "target", UserId = LocalUser.Id, TargetKey = "example-show:episode:1:1", WorkKey = "example-show", Scope = "episode",
                Season = 1, Episode = 1, Status = "downloading", InfoHash = linked, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
        });
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/title/example-show")).StatusCode);
        await using var db = await Db(host);
        var target = await db.AcquisitionTargets.SingleAsync();
        Assert.Equal("downloading", target.Status);
        Assert.Equal(linked, target.InfoHash);
        Assert.Equal(.5, target.Progress);
    }

    [Fact]
    public async Task SeasonRetryResetsOnlyFailedTargetsAndNeverDowngradesSettledOnes()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        var done = new string('d', 40);
        await host.Seed(db =>
        {
            db.WatchListItems.Add(LibraryHost.Watch());
            db.EngineTorrents.Add(new() { Id = "done", UserId = LocalUser.Id, Hash = done, Name = "Example Show S01E01 1080p", Status = "parked",
                Origin = "user", Progress = 1, VerifiedBitfield = "verified", CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow, LastUsedAt = DateTime.UtcNow });
            foreach (var (episode, status, hash) in new[] { (1, "downloaded", done), (2, "failed", null) })
                db.AcquisitionTargets.Add(new() { Id = $"t{episode}", UserId = LocalUser.Id, TargetKey = $"example-show:episode:1:{episode}", WorkKey = "example-show",
                    Scope = "episode", Season = 1, Episode = episode, Status = status, InfoHash = hash, Progress = episode == 1 ? 1 : 0,
                    FilePath = episode == 1 ? "D:\\media\\Example Show S01E01.mkv" : null, Error = episode == 2 ? "old failure" : null,
                    CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow });
        });
        // Only episode 2 finds a release, so episode 1's attempt fails — and must not overwrite its downloaded row.
        host.Search.Respond = o => new() { Query = o.Query, Results = o.Query.Contains("E02") ? [FakeSearch.Release("Example Show S01E02 1080p")] : [] };
        var response = await client.PostAsJsonAsync("/api/title/example-show", new { scope = "season", season = 1, episodes = new[] { 1, 2, 3 }, title = "Example Show", mediaType = "tv" });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        await using var db = await Db(host);
        var targets = await db.AcquisitionTargets.OrderBy(x => x.Episode).ToListAsync();
        Assert.Equal(3, targets.Count);
        Assert.Equal(("downloaded", done, 1.0), (targets[0].Status, targets[0].InfoHash, targets[0].Progress));
        Assert.Equal("D:\\media\\Example Show S01E01.mkv", targets[0].FilePath);
        Assert.Equal("downloading", targets[1].Status);
        Assert.Null(targets[1].Error);
        Assert.Equal("failed", targets[2].Status);
    }

    [Fact]
    public async Task ClientDisconnectStillSettlesTheAcquisition()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        await host.Seed(db => db.WatchListItems.Add(LibraryHost.Watch()));
        var searching = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var gate = new ManualResetEventSlim();
        host.Search.Respond = o =>
        {
            searching.TrySetResult();
            gate.Wait(TimeSpan.FromSeconds(20));
            return new() { Query = o.Query, Results = [FakeSearch.Release("Example Show S01E01 1080p")] };
        };
        using var disconnect = new CancellationTokenSource();
        var request = client.PostAsJsonAsync("/api/title/example-show", new { scope = "episode", season = 1, episode = 1, title = "Example Show", mediaType = "tv" }, disconnect.Token);
        await searching.Task.WaitAsync(TimeSpan.FromSeconds(20));
        await disconnect.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => request);
        gate.Set();
        AcquisitionTarget? target = null;
        for (var i = 0; i < 100 && target?.Status is null or "queued"; i++)
        {
            await Task.Delay(100);
            await using var db = await Db(host);
            target = await db.AcquisitionTargets.AsNoTracking().SingleOrDefaultAsync();
        }
        Assert.Equal("downloading", target!.Status);
        Assert.Equal(new string('a', 40), target.InfoHash);
        Assert.Single(host.Engine.Adds);
    }

    [Fact]
    public async Task WatchlistPatchWithoutResolutionKeepsIt()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Seed(db => { var item = LibraryHost.Watch(); item.PreferredResolution = 2160; db.WatchListItems.Add(item); });
        Assert.Equal(HttpStatusCode.OK, (await client.PatchAsJsonAsync("/api/watchlist", new { id = "watch", status = "planned" })).StatusCode);
        await using (var db = await Db(host)) Assert.Equal(2160, (await db.WatchListItems.SingleAsync()).PreferredResolution);
        Assert.Equal(HttpStatusCode.OK, (await client.PatchAsJsonAsync("/api/watchlist", new { id = "watch", preferredResolution = (int?)null })).StatusCode);
        await using (var db = await Db(host)) Assert.Null((await db.WatchListItems.SingleAsync()).PreferredResolution);
    }

    [Theory]
    [InlineData("episode", "Example Show S01E01 1080p", new[] { "Example Show S01E01.mkv", "sample.mkv", "poster.jpg" }, "deletes", null)]
    [InlineData("episode", "Example Show S01E01 1080p", new[] { "Example Show S01E01.mkv", "Example Show S01E02.mkv" }, "blocked", "covers-more")]
    [InlineData("episode", "Example Show S01E01 1080p", new[] { "Example Show 1x01.mkv", "Example Show 1x02.mkv" }, "blocked", "covers-more")]
    [InlineData("episode", "Example Show S01E01 1080p", new[] { "Example Show S01E01.mkv", "[Group] Example Show - 02 (1080p).mkv" }, "blocked", "covers-more")]
    [InlineData("episode", "[Group] Example Show", new[] { "[Group] Example Show - 01 (1080p).mkv" }, "blocked", "unrecognised")]
    [InlineData("episode", "Example Show S01E01 1080p", new[] { "Example Show S01E01.mkv", "Example.Show.S01.Complete.mkv" }, "blocked", "covers-more")]
    [InlineData("season", "Example Show S01 1080p", new[] { "Example Show S01E01.mkv", "Example Show S02E01.mkv" }, "blocked", "covers-more")]
    [InlineData("season", "Example Show S01 1080p", new[] { "Example Show S01E01.mkv", "Example Show S01E02.mkv" }, "deletes", null)]
    [InlineData("season", "Example Show Complete 1080p", new[] { "Example Show S01E01.mkv" }, "blocked", "covers-more")]
    public void DeletionReadsCoverageFromEveryFileName(string kind, string release, string[] files, string outcome, string? reason)
    {
        var json = JsonSerializer.Serialize(files.Select(f => new { path = f, size = 10 }));
        var plan = DeletionController.Plan([Engine(release, json)], kind == "episode" ? new("episode", 1, 1) : new("season", 1));
        Assert.Equal(outcome, plan.Outcome);
        if (reason != null) Assert.Equal(reason, Assert.Single(plan.Blocked).Reason);
    }

    [Fact]
    public async Task TitleDetailFindsCatalogRowByComputedKey()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        // The catalog pipeline keys rows its own way; a browse link's slug must still reach the row's metadata.
        await host.Seed(db => db.CatalogEntries.Add(new()
        {
            Id = Guid.NewGuid().ToString("N"), WorkKey = "film:example film:2026", Title = "Example: Film", Year = 2026, MediaType = "movie",
            Overview = "A blurb.", PosterUrl = "https://example.test/poster.jpg", Source = "trending", Rank = 1, RefreshedAt = DateTime.UtcNow, CreatedAt = DateTime.UtcNow
        }));
        var detail = await Json(await client.GetAsync("/api/title/example-film?t=Example%3A+Film&type=movie"));
        Assert.Equal("Example: Film", detail.GetProperty("title").GetString());
        Assert.Equal(2026, detail.GetProperty("year").GetInt32());
        Assert.Equal("A blurb.", detail.GetProperty("overview").GetString());
        Assert.True(detail.GetProperty("known").GetBoolean());
        // A dated key never reaches a row from a different year.
        var other = await Json(await client.GetAsync("/api/title/example-film-1999"));
        Assert.False(other.GetProperty("known").GetBoolean());
    }
}
