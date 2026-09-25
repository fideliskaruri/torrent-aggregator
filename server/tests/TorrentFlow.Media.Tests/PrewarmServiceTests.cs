using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Media.Features.Prewarm;
using static TorrentFlow.Media.Tests.PrewarmHarness;

namespace TorrentFlow.Media.Tests;

/// <summary>Ports src/lib/prewarm/prewarm.test.ts and prerank.test.ts.</summary>
public class PrewarmServiceTests
{
    private const string Show = "Prewarm Test Show";

    private static NextEpisode Next(int season = 1, int episode = 4) =>
        new() { Title = Show, MediaType = "tv", Season = season, Episode = episode, Source = "playing-episode" };

    private static PrewarmService.RunOptions Run(NextEpisode? next = null, bool force = false) =>
        new() { UserId = LocalUser.Id, Next = next ?? Next(), Force = force, ForegroundActive = false, ForegroundProgress = () => null };

    // ── trigger ────────────────────────────────────────────────────────────

    [Fact]
    public void TheTriggerFiresAtFifteenPercentAndNotBefore()
    {
        Assert.Equal(0.15, PrewarmService.TriggerFraction);
        Assert.False(PrewarmService.ShouldTrigger(149, 1000));
        Assert.True(PrewarmService.ShouldTrigger(150, 1000));
        Assert.True(PrewarmService.ShouldTrigger(900, 1000));
    }

    [Fact]
    public void APingWithNoUsableDurationNeverTriggers()
    {
        Assert.False(PrewarmService.ShouldTrigger(500, null));
        Assert.False(PrewarmService.ShouldTrigger(500, 0));
        Assert.False(PrewarmService.ShouldTrigger(500, -1));
        Assert.False(PrewarmService.ShouldTrigger(500, double.NaN));
        Assert.False(PrewarmService.ShouldTrigger(double.NaN, 1000));
        Assert.False(PrewarmService.ShouldTrigger(-1, 1000));
    }

    // ── which episode is next ──────────────────────────────────────────────

    [Fact]
    public async Task TheNextEpisodeIsOnePastWhatIsPlaying()
    {
        await using var h = await CreateAsync();
        var item = await h.SeedItemAsync(Show, cursorSeason: 1, cursorEpisode: 9);
        var next = await h.Prewarm.ResolveNextEpisodeAsync(new() { UserId = LocalUser.Id, InfoHash = Hash(1), Title = "x", Season = 1, Episode = 3, WatchListItemId = item.Id });
        Assert.NotNull(next);
        Assert.Equal((1, 4), (next.Season, next.Episode));
        Assert.Equal("playing-episode", next.Source);
        Assert.Equal(Show, next.Title);
        Assert.Equal(item.Id, next.WatchListItemId);
    }

    [Fact]
    public async Task WithoutAnEpisodeOnScreenItFallsBackToTheHuntCursor()
    {
        await using var h = await CreateAsync();
        var item = await h.SeedItemAsync(Show, cursorSeason: 2, cursorEpisode: 5);
        var next = await h.Prewarm.ResolveNextEpisodeAsync(new() { UserId = LocalUser.Id, InfoHash = Hash(1), Title = "x", WatchListItemId = item.Id });
        Assert.NotNull(next);
        Assert.Equal("hunt-cursor", next.Source);
        Assert.Equal((2, 5), (next.Season, next.Episode));
    }

    [Fact]
    public async Task WithNoLibraryRowTheShowNameIsDerivedAndAFilmHasNoNextEpisode()
    {
        await using var h = await CreateAsync();
        var next = await h.Prewarm.ResolveNextEpisodeAsync(new() { UserId = LocalUser.Id, InfoHash = Hash(1), Title = "Prewarm.Test.Show.S01E02.1080p.WEB-DL.x264-GRP", Season = 1, Episode = 2 });
        Assert.NotNull(next);
        Assert.Equal(Show, next.Title);
        Assert.Null(next.MediaType);
        Assert.Equal((1, 3), (next.Season, next.Episode));

        var film = await h.SeedItemAsync($"{Show} The Movie", mediaType: "movie");
        Assert.Null(await h.Prewarm.ResolveNextEpisodeAsync(new() { UserId = LocalUser.Id, InfoHash = Hash(1), Title = "x", Season = 1, Episode = 1, WatchListItemId = film.Id }));
        Assert.Null(await h.Prewarm.ResolveNextEpisodeAsync(new() { UserId = LocalUser.Id, InfoHash = Hash(1), Title = "x" }));
    }

    // ── the pre-warm itself ────────────────────────────────────────────────

    private static void Pool(PrewarmHarness h, params TorrentResult[] results) =>
        h.Search.Respond = o => new SearchResponse { Query = o.Query, Results = results, Cached = h.Search.Calls.Count > 1 };

    [Fact]
    public async Task APrewarmSendsTheExactPreRankedReleaseLabelledAndAuditableWithoutMovingTheCursor()
    {
        await using var h = await CreateAsync();
        var item = await h.SeedItemAsync(Show, cursorSeason: 1, cursorEpisode: 4);
        var wrong = Result($"{Show} S01E05 1080p WEB-DL", 5);
        var right = Result($"{Show} S01E04 1080p WEB-DL", 4);
        Pool(h, wrong, right);

        var outcome = await h.Prewarm.PrewarmNextEpisodeAsync(Run(Next() with { WatchListItemId = item.Id }));

        Assert.Equal("sent", outcome.Status);
        Assert.Equal("sent", outcome.Reason);
        Assert.True(outcome.Labelled);
        Assert.True(outcome.FastPath);
        Assert.False(outcome.PreRanked);
        Assert.Equal(Hash(4), outcome.InfoHash);
        Assert.Equal(right.Title, outcome.Title);
        var add = Assert.Single(h.Engine.Adds);
        Assert.Equal(TorrentPurpose.Prewarm, add.Purpose);
        Assert.Equal(right.Magnet, add.Magnet);
        Assert.Equal(1_000_000_000, add.ExpectedSizeBytes);
        // The pre-rank and the grab search with a byte-identical payload.
        Assert.Equal(2, h.Search.Calls.Count);
        Assert.Equal(h.Search.Calls[0], h.Search.Calls[1]);

        await using var db = await h.Db.CreateDbContextAsync();
        Assert.Equal("prewarm", (await db.EngineTorrents.SingleAsync()).Origin);
        Assert.Empty(await db.DownloadHistories.ToListAsync());
        var job = await db.GrabJobs.SingleAsync();
        Assert.Equal(("prewarm", "sent", item.Id, Hash(4)), (job.Kind, job.Status, job.ExternalId, job.InfoHash));
        var after = await db.WatchListItems.SingleAsync();
        Assert.Equal((1, 4), (after.CursorSeason, after.CursorEpisode));

        // A second attempt is refused by the cooldown; forcing past it still refuses: we already have it.
        var again = await h.Prewarm.PrewarmNextEpisodeAsync(Run());
        Assert.Equal(("skipped", "cooldown", "Pre-warmed S01E04 recently"), (again.Status, again.Reason, again.Message));
        var forced = await h.Prewarm.PrewarmNextEpisodeAsync(Run(force: true));
        Assert.Equal("skipped", forced.Status);
        Assert.Contains(forced.Reason, new[] { "at-concurrency-cap", "already-held" });
        Assert.Single(h.Engine.Adds);
    }

    [Fact]
    public async Task AlreadyHeldIsASkipThatTouchesLru()
    {
        await using var h = await CreateAsync();
        var right = Result($"{Show} S01E04 1080p WEB-DL", 4);
        Pool(h, right);
        await h.SeedTorrentAsync(4, "user", "held", progress: 1, status: "parked", lastUsedAt: h.Time.GetUtcNow().UtcDateTime.AddDays(-1));
        var outcome = await h.Prewarm.PrewarmNextEpisodeAsync(Run());
        Assert.Equal(("skipped", "already-held", "S01E04 is already here"), (outcome.Status, outcome.Reason, outcome.Message));
        Assert.Equal(Hash(4), outcome.InfoHash);
        Assert.Empty(h.Engine.Adds);
        Assert.Equal($"{Show} S01E04", outcome.Title);
    }

    [Fact]
    public async Task NothingStartsWhileTheTorrentOnScreenIsStillFilling()
    {
        await using var h = await CreateAsync();
        Pool(h, Result($"{Show} S01E04 1080p", 4));
        await h.SeedTorrentAsync(1, "user", "on-screen", progress: 0.2);
        var outcome = await h.Prewarm.PrewarmNextEpisodeAsync(Run() with { ForegroundProgress = null, ProtectHashes = [Hash(1)] });
        Assert.Equal(("skipped", "foreground-busy", "Playing torrent is only 20% fetched"), (outcome.Status, outcome.Reason, outcome.Message));
        Assert.Empty(h.Engine.Adds);
    }

    [Fact]
    public async Task PlaybackActiveIsForegroundBusy()
    {
        await using var h = await CreateAsync();
        var outcome = await h.Prewarm.PrewarmNextEpisodeAsync(Run() with { ForegroundActive = true });
        Assert.Equal(("skipped", "foreground-busy", "Playback is active"), (outcome.Status, outcome.Reason, outcome.Message));
    }

    [Fact]
    public async Task AChangedPredictionIsRefusedWhileOnePrewarmIsActive()
    {
        await using var h = await CreateAsync();
        Pool(h, Result($"{Show} S01E04 1080p", 4));
        await h.SeedTorrentAsync(9, "prewarm", "running", progress: 0.3, status: "downloading");
        var outcome = await h.Prewarm.PrewarmNextEpisodeAsync(Run());
        Assert.Equal(("skipped", "at-concurrency-cap", "1 pre-warm(s) already active"), (outcome.Status, outcome.Reason, outcome.Message));
        Assert.Single(await h.RowsAsync());
    }

    [Fact]
    public async Task TheEpisodeOnScreenBeingStreamOnlySkipsThePrewarm()
    {
        await using var h = await CreateAsync();
        await h.SeedTorrentAsync(1, "stream", "streaming");
        var outcome = await h.Prewarm.PrewarmNextEpisodeAsync(Run() with { ProtectHashes = [Hash(1)] });
        Assert.Equal(("skipped", "streaming-source"), (outcome.Status, outcome.Reason));
        Assert.Equal("Playing a stream, not a download — next episode stays on demand", outcome.Message);
        Assert.Empty(h.Search.Calls);
    }

    [Fact]
    public async Task AnExternalClientIsNeverPrewarmedAndNoClientIsAQuietSkip()
    {
        await using var h = await CreateAsync();
        var external = await h.Prewarm.PrewarmNextEpisodeAsync(Run() with { Config = () => new PrewarmService.ClientConfig("qbittorrent") });
        Assert.Equal(("skipped", "unlabelable-client", "Pre-warm needs the built-in engine (client is qbittorrent)"), (external.Status, external.Reason, external.Message));
        var none = await h.Prewarm.PrewarmNextEpisodeAsync(Run() with { Config = () => null });
        Assert.Equal(("skipped", "no-client", "No client configured"), (none.Status, none.Reason, none.Message));
        Assert.Empty(h.Engine.Adds);
    }

    [Fact]
    public async Task NotDeterminedAndNoReleaseAreDifferent()
    {
        await using var h = await CreateAsync();
        h.Search.Respond = _ => throw new HttpRequestException("throttled");
        var unknown = await h.Prewarm.PrewarmNextEpisodeAsync(Run());
        Assert.Equal(("not-applicable", "not-determined", "Could not pre-rank S01E04"), (unknown.Status, unknown.Reason, unknown.Message));

        Pool(h, Result($"{Show} S01E05 1080p", 5), Result($"{Show} S01 COMPLETE 1080p", 6));
        var nothing = await h.Prewarm.PrewarmNextEpisodeAsync(Run(Next(1, 4) with { Title = Show }, force: true));
        Assert.Equal(("not-applicable", "no-release", "No usable release for S01E04 in 2 results"), (nothing.Status, nothing.Reason, nothing.Message));
        Assert.True(nothing.PreRanked);
    }

    [Fact]
    public async Task OverBudgetThePrewarmEvictsOnlyPrewarmsAndRefusesWhenStillFull()
    {
        await using var h = await CreateAsync();
        Pool(h, Result($"{Show} S01E04 1080p", 4));
        await h.SeedTorrentAsync(20, "user", "precious", size: 10_000);
        await h.SeedTorrentAsync(21, "prewarm", "old-guess", size: 10_000, status: "parked");
        h.Engine.OnAdd = _ => new EngineAddResult(false, "Not enough space for this download") { StorageLimit = "cap" };

        var squeezed = await h.Prewarm.PrewarmNextEpisodeAsync(Run());
        Assert.Equal(("failed", "no-space"), (squeezed.Status, squeezed.Reason));
        Assert.Equal("Not enough space for this download", squeezed.Message);
        Assert.Equal(1, squeezed.EvictedCount);
        Assert.Equal(10_000, squeezed.FreedBytes);
        Assert.Equal([Hash(21)], h.Engine.Removed);
        Assert.Equal(2, h.Engine.Adds.Count);
        var rows = await h.RowsAsync();
        Assert.Equal("precious", Assert.Single(rows).Name);
        await using var db = await h.Db.CreateDbContextAsync();
        Assert.Empty(await db.DownloadHistories.ToListAsync());
        Assert.Equal("failed", (await db.GrabJobs.SingleAsync()).Status);
    }

    [Fact]
    public async Task NoEvictableSpaceIsNoSpaceWithoutARetry()
    {
        await using var h = await CreateAsync();
        Pool(h, Result($"{Show} S01E04 1080p", 4));
        h.Engine.OnAdd = _ => new EngineAddResult(false, "Storage cap reached") { StorageLimit = "cap" };
        var outcome = await h.Prewarm.PrewarmNextEpisodeAsync(Run());
        Assert.Equal(("failed", "no-space", 0), (outcome.Status, outcome.Reason, outcome.EvictedCount));
        Assert.Single(h.Engine.Adds);
    }

    [Fact]
    public async Task ASendFailureIsReportedAsSuch()
    {
        await using var h = await CreateAsync();
        Pool(h, Result($"{Show} S01E04 1080p", 4));
        h.Engine.OnAdd = _ => new EngineAddResult(false, "Metadata timed out");
        var outcome = await h.Prewarm.PrewarmNextEpisodeAsync(Run());
        Assert.Equal(("failed", "send-failed", "Metadata timed out"), (outcome.Status, outcome.Reason, outcome.Message));
    }

    [Fact]
    public async Task BelowFifteenPercentNothingIsSpeculatedButLruIsStillTouched()
    {
        await using var h = await CreateAsync();
        var old = h.Time.GetUtcNow().UtcDateTime.AddDays(-2);
        await h.SeedTorrentAsync(1, "prewarm", "watching", lastUsedAt: old);
        var outcome = await h.Prewarm.OnPlaybackProgressAsync(new() { UserId = LocalUser.Id, InfoHash = Hash(1), Title = "x", PositionSec = 10, DurationSec = 1000 });
        Assert.Equal(("not-applicable", "below-trigger", "Below 15% watched"), (outcome.Status, outcome.Reason, outcome.Message));
        Assert.True((await h.RowsAsync()).Single().LastUsedAt > old);
        Assert.Empty(h.Search.Calls);

        var none = await h.Prewarm.OnPlaybackProgressAsync(new() { UserId = LocalUser.Id, InfoHash = Hash(1), Title = "x", PositionSec = 500, DurationSec = 1000 });
        Assert.Equal(("not-applicable", "no-next-episode", "No next episode to pre-warm"), (none.Status, none.Reason, none.Message));
    }

    // ── pre-rank ───────────────────────────────────────────────────────────

    [Fact]
    public void SearchOptionsAreDeterministicAndUseTheBackgroundBudget()
    {
        var target = new PreRankTarget { Title = Show, MediaType = "tv", Season = 1, Episode = 2 };
        Assert.Equal($"{Show} S01E02", PreRanker.Query(target));
        Assert.Equal("Dune Part Two", PreRanker.Query(new PreRankTarget { Title = "Dune Part Two", MediaType = "movie" }));
        var a = PreRanker.SearchOptionsFor(target);
        Assert.Equal(a, PreRanker.SearchOptionsFor(target));
        Assert.True(a.Background);
        Assert.False(a.Enrich);
        Assert.False(a.SkipCache);
        Assert.Equal(15, a.Limit);
        Assert.Equal("tv", a.Category);
        Assert.Equal(new SearchFilters { HasMagnet = true, MinSeeders = 1, Season = 1, Episode = 2 }, a.Filters);
    }

    [Fact]
    public void SelectBestReleaseRules()
    {
        var target = new PreRankTarget { Title = Show, MediaType = "tv", Season = 1, Episode = 4 };
        var a = Result($"{Show} S01E04 1080p WEB-DL", 1);
        var b = Result($"{Show} S01E04 720p WEB-DL", 2);
        Assert.Same(a, PreRanker.SelectBestRelease([a, b], target));
        Assert.Same(b, PreRanker.SelectBestRelease([Result($"{Show} S01E04 1080p", 3, seeders: 0), Result($"{Show} S01E04 1080p", 4, magnet: false), b], target));
        Assert.Null(PreRanker.SelectBestRelease([Result($"{Show} S01E05 1080p WEB-DL", 5)], target));
        Assert.Null(PreRanker.SelectBestRelease([Result($"{Show} S01 COMPLETE 1080p WEB-DL", 6)], target));
        var unlabelable = Result($"{Show} S01E04 1080p", 7) with { InfoHash = null, Magnet = "magnet:?dn=nohash" };
        Assert.Null(PreRanker.SelectBestRelease([unlabelable], target));
        // A preferred resolution is a hard floor.
        Assert.Same(a, PreRanker.SelectBestRelease([b, a], target with { PreferredResolution = 1080 }));
        Assert.Null(PreRanker.SelectBestRelease([b], target with { PreferredResolution = 1080 }));
        // A measured-good swarm beats an advertised claim; dead is demoted.
        Assert.Same(b, PreRanker.SelectBestRelease([a, b], target, r => r == b ? "good" : "dead"));
        var film = new PreRankTarget { Title = "Dune Part Two", MediaType = "movie" };
        var dune = Result("Dune Part Two 2024 1080p WEB-DL", 8);
        Assert.Same(dune, PreRanker.SelectBestRelease([dune], film));
    }

    [Fact]
    public async Task ACachedSearchIsFoundWithoutReconstructingItsKeyThenServedFromMemo()
    {
        await using var h = await CreateAsync();
        var target = new PreRankTarget { Title = Show, MediaType = "tv", Season = 1, Episode = 4 };
        var right = Result($"{Show} S01E04 1080p", 4);
        await SeedCacheAsync(h, $"someone-elses-key-{Guid.NewGuid()}", Show, [right]);

        var choice = await h.Ranker.GetPreRankedAsync(target);
        Assert.NotNull(choice);
        Assert.Equal("search-cache", choice.Source);
        Assert.Equal(right.Title, choice.Candidate?.Title);
        var memo = await h.Ranker.GetPreRankedAsync(target);
        Assert.Equal("memo", memo?.Source);
        var ranked = await h.Ranker.PreRankAsync(target);
        Assert.Equal("memo", ranked?.Source);
        Assert.Empty(h.Search.Calls);
    }

    [Fact]
    public async Task ASearchThatBlowsUpYieldsNullNeverAnError()
    {
        await using var h = await CreateAsync();
        h.Search.Respond = _ => throw new InvalidOperationException("boom");
        Assert.Null(await h.Ranker.PreRankAsync(new PreRankTarget { Title = Show, Season = 1, Episode = 1 }));
        Assert.Null(await h.Ranker.PreRankAsync(new PreRankTarget { Title = "  " }));
    }

    [Fact]
    public async Task UpcomingTargetsPrioritiseTrackedShowsThenWatchlistThenContinueWatching()
    {
        await using var h = await CreateAsync();
        await h.SeedItemAsync("Tracked Show", cursorSeason: 1, cursorEpisode: 3);
        h.Time.Advance(TimeSpan.FromSeconds(1));
        var saved = await h.SeedItemAsync("Saved Film", mediaType: "movie", monitored: false, status: "plan");
        var watching = await h.SeedItemAsync("Watching Show", monitored: false, cursorSeason: null);
        await using (var db = await h.Db.CreateDbContextAsync())
        {
            db.PlaybackProgresses.Add(new PlaybackProgress
            {
                Id = Ids.New(), UserId = LocalUser.Id, InfoHash = Hash(1), FilePath = "e.mkv", Title = "Watching Show", Season = 2, Episode = 6,
                WatchListItemId = watching.Id, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
            });
            await db.SaveChangesAsync();
        }

        var targets = await h.Ranker.UpcomingTargetsAsync(LocalUser.Id, 10, ["monitored", "watchlist", "watching"]);
        Assert.Equal("Tracked Show", targets[0].Title);
        Assert.Equal((1, 3), (targets[0].Season!.Value, targets[0].Episode!.Value));
        Assert.Contains(targets, t => t.Title == saved.Title && t.Season is null);
        var next = Assert.Single(targets, t => t.Title == "Watching Show" && t.Season == 2);
        Assert.Equal(7, next.Episode);

        var onlyWatching = await h.Ranker.UpcomingTargetsAsync(LocalUser.Id, 10, ["watching"]);
        Assert.Equal(["Watching Show"], onlyWatching.Select(t => t.Title));
    }

    internal static async Task SeedCacheAsync(PrewarmHarness h, string key, string title, TorrentResult[] results)
    {
        await using var db = await h.Db.CreateDbContextAsync();
        db.SearchCaches.Add(new SearchCache
        {
            Id = Ids.New(),
            CacheKey = key,
            NormalizedQuery = ReleaseText.NormalizeTitle(title),
            Payload = System.Text.Json.JsonSerializer.Serialize(new SearchResponse { Query = title, Results = results }, PreRanker.CacheJson),
            ExpiresAt = h.Time.GetUtcNow().UtcDateTime.AddMinutes(5),
            CreatedAt = h.Time.GetUtcNow().UtcDateTime,
        });
        await db.SaveChangesAsync();
    }
}

/// <summary>Ports src/lib/prewarm/next-episode-file.test.ts.</summary>
public class NextEpisodeFileTests
{
    private static readonly string Root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "media-root"));
    private static string Abs(string rel) => Path.Combine(Root, rel.Replace('/', Path.DirectorySeparatorChar));

    private static string Files(params (string Rel, long Size)[] files) =>
        System.Text.Json.JsonSerializer.Serialize(files.Select(f => new { path = f.Rel, size = f.Size, mtimeMs = 0, fullPath = Abs(f.Rel) }));

    private static readonly string Pack = Files(("Show.S02/Show.S02E01.mkv", 900), ("Show.S02/Show.S02E02.mkv", 900), ("Show.S02/Show.S02E03.mkv", 900));

    [Fact]
    public void ASeasonPackMapsTheNextEpisodeToItsTorrentRelativeFile()
    {
        Assert.Equal("Show.S02/Show.S02E02.mkv", NextEpisodeFile.EpisodeFileInTorrent(Root, Pack, 2, 2));
        Assert.Null(NextEpisodeFile.EpisodeFileInTorrent(Root, Pack, 2, 9));
        Assert.Null(NextEpisodeFile.EpisodeFileInTorrent(Root, Pack, 3, 1));
        Assert.Null(NextEpisodeFile.EpisodeFileInTorrent(Root, Pack, null, 1));
        Assert.Null(NextEpisodeFile.EpisodeFileInTorrent(Root, null, 2, 1));
        Assert.Null(NextEpisodeFile.EpisodeFileInTorrent(null, Pack, 2, 1));
    }

    [Fact]
    public void JunkNeverMapsOntoARealEpisodeAndTheLargerFileWins()
    {
        var extras = Files(("Show.S02/Featurettes/Show.S02E01.Behind.mkv", 5000), ("Show.S02/Show.S02E01.mkv", 900));
        Assert.Equal("Show.S02/Show.S02E01.mkv", NextEpisodeFile.EpisodeFileInTorrent(Root, extras, 2, 1));
        var subs = Files(("Show.S02/Show.S02E01.srt", 10));
        Assert.Null(NextEpisodeFile.EpisodeFileInTorrent(Root, subs, 2, 1));
        var both = Files(("Show.S02E01.720p.mkv", 500), ("Show.S02E01.1080p.mkv", 1500));
        Assert.Equal("Show.S02E01.1080p.mkv", NextEpisodeFile.EpisodeFileInTorrent(Root, both, 2, 1));
    }

    [Fact]
    public void NoPathEscapesTheTorrentAndNestedPathsUseForwardSlashes()
    {
        Assert.Null(NextEpisodeFile.TorrentRelativeFilePath(Root, Path.GetFullPath(Path.Combine(Root, "..", "outside.mkv"))));
        Assert.Null(NextEpisodeFile.TorrentRelativeFilePath(Root, "x.mkv"));
        Assert.Equal("a/b/c.mkv", NextEpisodeFile.TorrentRelativeFilePath(Root, Abs("a/b/c.mkv")));
        // The Next.js verified-file shape (absolute path, no fullPath) is read too.
        var legacy = System.Text.Json.JsonSerializer.Serialize(new[] { new { path = Abs("Show.S02E04.mkv"), size = 1 } });
        Assert.Equal("Show.S02E04.mkv", NextEpisodeFile.EpisodeFileInTorrent(Root, legacy, 2, 4));
    }
}
