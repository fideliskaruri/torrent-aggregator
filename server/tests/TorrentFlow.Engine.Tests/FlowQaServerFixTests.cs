using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Engine.Controllers;
using TorrentFlow.Engine.Queue;
using TorrentFlow.Engine.Settings;
using TorrentFlow.Search;

namespace TorrentFlow.Engine.Tests;

/// <summary>Regression coverage for Flow QA server findings FQ-DL-001..007.</summary>
public sealed class FlowQaServerFixTests
{
    private sealed class FakeCategorizer : ISmartCategorizer
    {
        public SmartCategory Categorize(SmartCategoryInput input, IReadOnlyList<string> userCategories) =>
            new(input.SearchCategory is "movies" or "tv" or "anime" ? input.SearchCategory! : "movies", "Movies", "high");

        public string ShowFolder(string title, MediaMetadata? metadata) =>
            ContentClassifier.ShowFolder(title, metadata);

        public string? SeasonFolder(string title) => EpisodeParser.SeasonFolder(EpisodeParser.Parse(title));
    }

    [Theory]
    [InlineData("Big Buck Bunny (2008)", 2008, "Big Buck Bunny (2008)")]
    [InlineData("Sintel", 2010, "Sintel (2010)")]
    [InlineData("Night of the Living Dead (1968)", null, "Night of the Living Dead (1968)")]
    [InlineData("Pokémon (1998)", 1998, "Pokémon (1998)")]
    public void MovieSmartPath_IncludesYearWhenKnown(string name, int? metaYear, string expectedLeaf)
    {
        var cat = new FakeCategorizer();
        var meta = metaYear is { } y
            ? new MediaMetadata { Source = "tmdb", MediaType = "movie", ExternalId = "1", Title = ContentClassifier.ShowFolder(name, null), Year = y }
            : null;
        var path = SmartSendTargets.ResolveSmartPath(cat, @"D:\dl", "movies", "Movies", name, meta, "\\");
        Assert.EndsWith("\\" + expectedLeaf, path, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void MovieYear_PrefersMetadataThenTitleToken()
    {
        Assert.Equal(2010, SmartSendTargets.MovieYear("Sintel", new MediaMetadata
        {
            Source = "tmdb", MediaType = "movie", ExternalId = "1", Title = "Sintel", Year = 2010,
        }));
        Assert.Equal(2008, SmartSendTargets.MovieYear("Big Buck Bunny (2008)", null));
        Assert.Null(SmartSendTargets.MovieYear("No Year Here", null));
    }

    [Fact]
    public async Task ListPrefersQueuedOverLiveWhileDetaching()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 2);
        await h.Engine.AttachLimitsAsync();
        for (var i = 1; i <= 3; i++) await h.Engine.AddAsync(new EngineAddRequest
        {
            Magnet = EngineHarness.Magnet(i), Purpose = TorrentPurpose.Keep, WorkId = "show",
            QueueKey = DownloadQueue.QueueKeyForEpisode(1, i),
        });
        await h.Engine.ForceAsync(EngineHarness.Hash(3));
        Assert.NotNull((await h.RowAsync(3)).ForcedAt);

        // Drop cap so non-forced active rows demote. List must show queued even if backend still holds them briefly.
        h.Limits.SetMaxActive(1);
        for (var i = 0; i < 50 && (await h.RowAsync(1)).Status == "downloading" && (await h.RowAsync(2)).Status == "downloading"; i++)
            await Task.Delay(20);

        var list = await h.Engine.ListAsync();
        var forced = Assert.Single(list, t => t.Hash == EngineHarness.Hash(3));
        Assert.True(forced.Forced);
        Assert.Contains(list, t => t.Hash == EngineHarness.Hash(1) && t.State == "queued" || t.Hash == EngineHarness.Hash(2) && t.State == "queued");

        // Demotion candidates that remain downloading on the backend mid-detach still report queued from DB.
        var demoted = list.First(t => t.Hash != EngineHarness.Hash(3) && t.State == "queued");
        Assert.Equal("queued", demoted.State);
        Assert.False(demoted.Forced);
    }

    [Fact]
    public async Task ForcedAndVerifiedFlagsAppearOnList()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.Engine.AddAsync(new EngineAddRequest { Magnet = EngineHarness.Magnet(1), Purpose = TorrentPurpose.Keep, Forced = true });
        var before = Assert.Single(await h.Engine.ListAsync());
        Assert.True(before.Forced);
        Assert.False(before.Verified);

        h.Backend.Complete(EngineHarness.Hash(1));
        await h.Engine.TickAsync();
        var after = Assert.Single(await h.Engine.ListAsync());
        Assert.Equal("downloaded", after.State);
        Assert.True(after.Verified);
        Assert.Equal(1, after.Progress);
        Assert.False(after.Forced); // completion clears ForcedAt
    }

    [Fact]
    public async Task ErrorStateExposesMessageNotPaused()
    {
        await using var h = await EngineHarness.CreateAsync(cap: 1);
        await h.Engine.AddAsync(new EngineAddRequest { Magnet = EngineHarness.Magnet(1), Purpose = TorrentPurpose.Keep });
        // Simulate monitor error mark via backend error state + tick path: set row error through complete failure by forcing remove path.
        await using (var db = await h.Db.CreateDbContextAsync())
        {
            var row = await db.EngineTorrents.SingleAsync(r => r.Hash == EngineHarness.Hash(1));
            row.Status = EngineTorrentStatus.Error;
            row.Error = "Timed out waiting for torrent metadata (no peers / blocked DHT?). Try another release or check network.";
            await db.SaveChangesAsync();
        }
        // Backend may still hold the transfer; list must prefer durable error.
        var info = Assert.Single(await h.Engine.ListAsync());
        Assert.Equal("error", info.State);
        Assert.Contains("metadata", info.Error, StringComparison.OrdinalIgnoreCase);
        Assert.NotEqual("paused", info.State);
    }

    [Fact]
    public void ScopeFromQueueKey_ParsesSeasonEpisode()
    {
        var (scope, season, episode) = ClientTorrentsController.ScopeFromQueueKey("s00002e00007");
        Assert.Equal("episode", scope);
        Assert.Equal(2, season);
        Assert.Equal(7, episode);
        Assert.Equal(("title", null, null), ClientTorrentsController.ScopeFromQueueKey(null));
    }

    [Fact]
    public void BuildVersion_NeverReportsBareZero()
    {
        var id = BuildVersion.IdFrom(typeof(BuildVersion).Assembly);
        Assert.False(string.IsNullOrWhiteSpace(id));
        Assert.NotEqual("0.0.0.0", id);
    }
}

