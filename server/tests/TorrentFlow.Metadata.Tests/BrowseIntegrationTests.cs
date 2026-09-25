using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Metadata.Browse;
using TorrentFlow.Metadata.Catalog;

namespace TorrentFlow.Metadata.Tests;

/// <summary>BuildAsync end-to-end over a temp SQLite DB: personal rails, seed.ts, and the home-release cache.</summary>
public sealed class BrowseIntegrationTests : IDisposable
{
    private readonly string _media = Path.Combine(Path.GetTempPath(), $"tf-browse-media-{Guid.NewGuid():N}");
    private static readonly DateTime T0 = new(2026, 4, 30, 12, 0, 0, DateTimeKind.Utc);

    public BrowseIntegrationTests() => Directory.CreateDirectory(_media);

    public void Dispose()
    {
        LocalFiles.ResetCache();
        try { Directory.Delete(_media, true); } catch (IOException) { }
    }

    private string MediaFile(string name)
    {
        var path = Path.Combine(_media, name);
        File.WriteAllText(path, "x");
        return path;
    }

    private static EngineTorrent Engine(string id, string hash, string name, double progress, string status, string? file, DateTime updated) => new()
    {
        Id = id, UserId = LocalUser.Id, Hash = hash, Name = name, Progress = progress, Status = status, Origin = "user",
        SavePath = file is null ? null : Path.GetDirectoryName(file), VerifiedBitfield = progress >= 1 ? "AQ==" : null,
        VerifiedFilesJson = file is null ? null : System.Text.Json.JsonSerializer.Serialize(new[] { new { path = file } }),
        CreatedAt = updated, UpdatedAt = updated, LastUsedAt = updated,
    };

    private static Work Work(string id, string key, string title, string mediaType, string? poster = null) => new()
    {
        Id = id, WorkKey = key, CanonicalTitle = title, MediaType = mediaType, PosterUrl = poster, CreatedAt = T0, UpdatedAt = T0,
    };

    [Fact]
    public async Task Personal_rails_are_built_deduped_and_ordered()
    {
        using var db = new TestDb();
        await using (var ctx = db.CreateDbContext())
        {
            ctx.Users.Add(new User { Id = LocalUser.Id });
            ctx.Works.AddRange(Work("w-silo", "series:silo", "Silo", "tv", "https://img.test/silo.jpg"), Work("w-alien", "film:alien:1979", "Alien", "movie"));
            ctx.PlaybackProgresses.Add(new PlaybackProgress
            {
                Id = "p-silo", UserId = LocalUser.Id, InfoHash = "AAA111", FilePath = "Silo/S01E02.mkv", PositionSec = 600, DurationSec = 3000,
                Title = "S01E02", Season = 1, Episode = 2, WorkId = "w-silo", CreatedAt = T0, UpdatedAt = T0.AddMinutes(5),
            });
            ctx.EngineTorrents.AddRange(
                Engine("e-silo2", "aaa111", "Silo.S01E02.1080p.WEB.h264-GROUP", 1, "seeding", MediaFile("Silo.S01E02.mkv"), T0.AddMinutes(4)),
                Engine("e-alien", "bbb222", "Alien.1979.1080p.BluRay.x264-GROUP", 1, "seeding", MediaFile("Alien.1979.mkv"), T0.AddMinutes(3)),
                Engine("e-silo1", "ccc333", "Silo.S01E01.1080p.WEB.h264-GROUP", 1, "seeding", MediaFile("Silo.S01E01.mkv"), T0.AddMinutes(2)),
                Engine("e-gone", "ddd444", "Heat.1995.1080p.BluRay.x264-GROUP", 1, "seeding", Path.Combine(_media, "missing.mkv"), T0.AddMinutes(1)),
                Engine("e-partial", "eee555", "Tenet.2020.1080p.BluRay.x264-GROUP", 0.4, "downloading", null, T0.AddMinutes(6)));
            ctx.AcquisitionTargets.Add(new AcquisitionTarget
            {
                Id = "a-alien", UserId = LocalUser.Id, TargetKey = "t", WorkKey = "film:alien:1979", Scope = "movie", Status = "done", InfoHash = "BBB222",
                WorkId = "w-alien", CreatedAt = T0, UpdatedAt = T0,
            });
            await ctx.SaveChangesAsync();
        }
        var f = new FakeHttpFactory(FakeHandler.Always("[]"));
        var browse = BrowseFixture.Create(db, f, new ManualTime());
        var payload = await browse.BuildAsync(LocalUser.Id);

        Assert.Equal(["continue-watching", "ready-to-play"], payload.Rails.Select(r => r.Id));
        var cw = Assert.IsType<WorkRailItem>(Assert.Single(payload.Rails[0].Items));
        Assert.Equal(("p-silo", "w-silo", "series:silo", "Silo", "S01E02"), (cw.Id, cw.WorkId, cw.WorkKey, cw.Title, cw.Subtitle));
        Assert.Equal(("https://img.test/silo.jpg", "ready", 0.2, "tv"), (cw.PosterUrl, cw.Availability, cw.ProgressFraction, cw.MediaType));

        var rtp = Assert.IsType<WorkRailItem>(Assert.Single(payload.Rails[1].Items));
        Assert.Equal(("e-alien", "w-alien", "film:alien:1979", "Alien", "ready", "bbb222", "movie"),
            (rtp.Id, rtp.WorkId, rtp.WorkKey, rtp.Title, rtp.Availability, rtp.InfoHash, rtp.MediaType));
        Assert.Null(rtp.Subtitle);

        var json = System.Text.Json.JsonSerializer.Serialize<object>(cw, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web)
        {
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        });
        Assert.Contains("\"workKey\":\"series:silo\"", json);
        Assert.Contains("\"filePath\":\"Silo/S01E02.mkv\"", json);
    }

    [Fact]
    public async Task Ready_to_play_splits_movies_and_series_and_counts_files()
    {
        using var db = new TestDb();
        await using (var ctx = db.CreateDbContext())
        {
            ctx.Users.Add(new User { Id = LocalUser.Id });
            ctx.EngineTorrents.AddRange(
                Engine("e1", "h1", "Dune.2021.1080p.BluRay.x264-GROUP", 1, "seeding", MediaFile("Dune.mkv"), T0.AddMinutes(3)),
                Engine("e2", "h2", "The.Bear.S01E01.1080p.WEB.h264-GROUP", 1, "seeding", MediaFile("Bear1.mkv"), T0.AddMinutes(2)),
                Engine("e3", "h3", "The.Bear.S01E02.1080p.WEB.h264-GROUP", 1, "seeding", MediaFile("Bear2.mkv"), T0.AddMinutes(1)));
            await ctx.SaveChangesAsync();
        }
        var browse = BrowseFixture.Create(db, new FakeHttpFactory(FakeHandler.Always("[]")), new ManualTime());
        var payload = await browse.BuildAsync(LocalUser.Id);
        Assert.Equal(["ready-to-play-movies", "ready-to-play-series"], payload.Rails.Select(r => r.Id));
        Assert.Equal("Ready to Play · Series", payload.Rails[1].Title);
        var bear = Assert.Single(payload.Rails[1].Cards);
        Assert.Equal(("The Bear", "2 files", "series"), (bear.Title, bear.Subtitle, bear.MediaType));
        Assert.Null(((WorkRailItem)bear).WorkId);
    }

    [Fact]
    public async Task Watch_seed_prefers_unfinished_progress_then_library()
    {
        using var db = new TestDb();
        var browse = BrowseFixture.Create(db, new FakeHttpFactory(FakeHandler.Always("[]")), new ManualTime());
        await using (var ctx = db.CreateDbContext())
        {
            ctx.Users.Add(new User { Id = LocalUser.Id });
            ctx.WatchListItems.Add(new WatchListItem
            {
                Id = "w1", UserId = LocalUser.Id, MediaType = "movie", ExternalId = "1", Title = "Arrival", Status = "watching", MonitorMode = "all",
                CreatedAt = T0, UpdatedAt = T0, LastChecked = T0,
            });
            await ctx.SaveChangesAsync();
        }
        Assert.Equal(new CatalogSeed("Arrival", "movie"), await browse.ReadWatchSeedAsync(LocalUser.Id));

        await using (var ctx = db.CreateDbContext())
        {
            ctx.PlaybackProgresses.Add(new PlaybackProgress
            {
                Id = "p1", UserId = LocalUser.Id, InfoHash = "ABC", FilePath = "D:\\Media\\Shogun.2024.S01E03.1080p.WEB.mkv", Title = "  ",
                Season = null, Episode = null, WatchListItemId = "w1", CreatedAt = T0, UpdatedAt = T0.AddMinutes(1),
            });
            await ctx.SaveChangesAsync();
        }
        Assert.Equal(new CatalogSeed("Shogun", "movie"), await browse.ReadWatchSeedAsync(LocalUser.Id));

        await using (var ctx = db.CreateDbContext())
        {
            ctx.PlaybackProgresses.Add(new PlaybackProgress
            {
                Id = "p2", UserId = LocalUser.Id, InfoHash = " DEF ", FilePath = "", Title = "", Season = 2, Episode = 1,
                CreatedAt = T0, UpdatedAt = T0.AddMinutes(2),
            });
            ctx.EngineTorrents.Add(Engine("e1", "def", "Severance.S02E01.1080p.WEB.h264-GROUP", 1, "seeding", null, T0));
            await ctx.SaveChangesAsync();
        }
        Assert.Equal(new CatalogSeed("Severance", "tv"), await browse.ReadWatchSeedAsync(LocalUser.Id));
    }

    [Theory]
    [InlineData("The.Bear.S03E01.1080p.WEB.h264", "The Bear")]
    [InlineData("  Dune: Part Two  ", "Dune: Part Two")]
    [InlineData("", null)]
    [InlineData("   ", null)]
    public void Usable_seed_title(string raw, string? expected) => Assert.Equal(expected, BrowseService.UsableSeedTitle(raw));

    [Fact]
    public async Task Home_release_cache_gates_discovery_cards()
    {
        using var db = new TestDb();
        var time = new ManualTime(new DateTimeOffset(2026, 7, 30, 12, 0, 0, TimeSpan.Zero));
        var signal = new HomeReleaseSignal(true, "2026-07-15", null, "2026-09-01");
        await using (var ctx = db.CreateDbContext())
        {
            ctx.CatalogEntries.Add(new CatalogEntry
            {
                Id = "c1", WorkKey = "film:weapons:2026", Title = "Weapons", Year = 2026, MediaType = "movie", Source = "trending", Rank = 0,
                ReleaseDate = new DateTime(2026, 7, 15, 0, 0, 0, DateTimeKind.Utc), RefreshedAt = time.GetUtcNow().UtcDateTime, CreatedAt = time.GetUtcNow().UtcDateTime,
            });
            ctx.CatalogEntries.Add(new CatalogEntry
            {
                Id = "c2", WorkKey = "series:the-bear", Title = "The Bear", Year = 2022, MediaType = "tv", Source = "popular", Rank = 0,
                RefreshedAt = time.GetUtcNow().UtcDateTime, CreatedAt = time.GetUtcNow().UtcDateTime,
            });
            ctx.SearchCaches.Add(new SearchCache
            {
                Id = "s1", CacheKey = HomeReleaseCache.CachePrefix + "film:weapons:2026", Payload = HomeReleaseCache.Encode(signal),
                ExpiresAt = time.GetUtcNow().UtcDateTime.AddHours(1), CreatedAt = time.GetUtcNow().UtcDateTime,
            });
            await ctx.SaveChangesAsync();
        }
        var browse = BrowseFixture.Create(db, new FakeHttpFactory(FakeHandler.Always("[]")), time);
        var rails = await browse.BuildDiscoveryRailsAsync(LocalUser.Id);
        Assert.Equal([BrowseService.TrendingRailId, BrowseService.PopularRailId], rails.Select(r => r.Id));
        var weapons = Assert.IsType<CatalogRailItem>(Assert.Single(rails[0].Items));
        Assert.Equal((true, "2026-09-01", "2026-07-15", "2026"), (weapons.InTheatricalWindow, weapons.NextHomeReleaseAt, weapons.ReleaseDate, weapons.Subtitle));
        var bear = Assert.IsType<CatalogRailItem>(Assert.Single(rails[1].Items));
        Assert.False(bear.InTheatricalWindow);
        Assert.Null(bear.NextHomeReleaseAt);
    }

    [Fact]
    public void Home_release_payload_round_trips_and_rejects_foreign_shapes()
    {
        var signal = new HomeReleaseSignal(true, "2026-07-15", "2026-08-01", null);
        Assert.Equal(signal, HomeReleaseCache.Decode(HomeReleaseCache.Encode(signal)));
        Assert.Contains("\"nextHomeReleaseAt\":null", HomeReleaseCache.Encode(signal));
        Assert.Null(HomeReleaseCache.Decode("""{"kind":"browse-home-release","version":1,"signal":{"checked":true}}"""));
        Assert.Null(HomeReleaseCache.Decode("""{"kind":"other","version":2,"signal":{"checked":true,"theatricalReleasedAt":null,"releasedAt":null,"nextHomeReleaseAt":null}}"""));
        Assert.Null(HomeReleaseCache.Decode("""{"kind":"browse-home-release","version":2,"signal":{"checked":true,"theatricalReleasedAt":"July","releasedAt":null,"nextHomeReleaseAt":null}}"""));
        Assert.Null(HomeReleaseCache.Decode("nope"));
    }

    [Fact]
    public void Availability_index_matches_by_key_then_neighbouring_year()
    {
        var index = new AvailabilityIndex([
            new ChartWork(CatalogText.CatalogWorkKey("Dune", 2021, "movie"), "Dune", 2021, "movie", 500, 300, "Dune.2021.2160p", 2),
        ]);
        Assert.Equal(300, index.Match(CatalogText.CatalogWorkKey("Dune", 2021, "movie"), 2021)?.PeakSeeders);
        Assert.Equal(300, index.Match(CatalogText.CatalogWorkKey("Dune", 2022, "movie"), 2022)?.PeakSeeders);
        Assert.Null(index.Match(CatalogText.CatalogWorkKey("Dune", 1984, "movie"), 1984));
    }
}
