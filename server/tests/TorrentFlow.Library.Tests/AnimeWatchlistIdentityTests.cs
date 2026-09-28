using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Library.Features.Automation;
using TorrentFlow.Library.Features.Grabs;

namespace TorrentFlow.Library.Tests;

public sealed class AnimeWatchlistIdentityTests
{
    [Theory]
    [InlineData(50, true)]
    [InlineData(0, false)]
    public async Task AnimeHuntUsesEntryAliasLadderAndRetainsSeederGrace(int seeders, bool shouldSend)
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        await host.Settings();
        const string title = "BLEACH: Thousand-Year Blood War - The Separation";
        const string romaji = "BLEACH: Sennen Kessen-hen - Ketsubetsu-tan";
        const string release = "[Erai-raws] Bleach - Sennen Kessen Hen - Ketsubetsu Tan - 03 [1080p][Multiple Subtitle]";
        await host.Seed(db =>
        {
            var watch = LibraryHost.Watch(episode: 3);
            watch.Title = title; watch.MediaType = "anime";
            db.WatchListItems.Add(watch);
        });
        host.Search.Respond = o => new()
        {
            Query = o.Query, Results = o.Query == "BLEACH Sennen Kessen hen Ketsubetsu tan - 03" ? [FakeSearch.Release(release, seeders)] : []
        };
        var result = await host.Services.GetRequiredService<GrabService>().Grab(new(title, "anime", new(1, 3),
            WatchListItemId: "watch", Background: true,
            EpisodeMapping: new(null, 379, [title, romaji], ["Bleach"],
                PrequelTitles: ["BLEACH TYBW"], IsSequel: true)), default);
        Assert.Equal(shouldSend, result.Ok);
        Assert.Equal(shouldSend ? 1 : 0, host.Engine.Adds.Count);
        Assert.InRange(host.Search.Requests.Count, 1, 7);
        Assert.All(host.Search.Requests, r =>
        {
            Assert.True(r.Background);
            Assert.Null(r.Filters!.MinSeeders);
            Assert.Equal(EpisodeLadder.SearchLimit, r.PageSize);
        });
        if (!shouldSend) Assert.Contains("Waiting for seeders", result.Message);
    }

    [Theory]
    [InlineData("Frieren: Beyond Journey's End Season 2", "182255", 2, 3, 28,
        "[Anime Time] Frieren Beyond Journeys End (Sousou no Frieren) - S02E03 [1080p][HEVC 10bit x265][AAC][Dual-Audio] [Multi Sub] [Weekly]", false)]
    [InlineData("Mushoku Tensei: Jobless Reincarnation Season 3", "178789", 3, 14, 47,
        "Mushoku Tensei Jobless Reincarnation S03E14 SUBFRENCH 1080p CR WEB-DL AAC2.0 H.264-Tsundere-Raws", false)]
    [InlineData("Mushoku Tensei: Jobless Reincarnation Season 3", "178789", 3, 14, 47,
        "Mushoku Tensei Jobless Reincarnation S03E14 SUBFRENCH 1080p CR WEB-DL AAC2.0 H.264-Tsundere-Raws", true)]
    public async Task WatchlistUsesVerifiedAniListIdentityFromTheProviderOrAnExistingWork(
        string title, string id, int season, int episode, int offset, string release, bool existingWork)
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        await host.Settings();
        var franchise = title[..title.IndexOf(" Season", StringComparison.Ordinal)];
        host.Metadata.ById = (_, _, _) => existingWork ? null : new()
        {
            Source = "anilist", ExternalId = id, MediaType = "anime", Title = title, Aliases = [title], Year = 2026
        };
        if (existingWork)
            await host.Seed(db => db.Works.Add(new()
            {
                Id = "known", WorkKey = ReleaseNames.WorkKeyFor(title), CanonicalTitle = title, MediaType = "anime",
                Provider = "anilist", ProviderId = id, Year = 2026, AliasesJson = "[]"
            }));
        host.Anime.Mapping = new(season, offset, [title], [franchise, franchise, "Fū"], IsSequel: true);
        host.Search.Respond = o => new()
        {
            Query = o.Query, Results = o.Query.EndsWith($"S{season:00}E{episode:00}") ? [FakeSearch.Release(release)] : []
        };
        (await client.PostAsJsonAsync("/api/watchlist", new
        {
            mediaType = "anime", externalId = id, title, posterUrl = "https://example.invalid/poster",
            monitored = true, fromSeason = 1, fromEpisode = episode, preferredResolution = 1080
        })).EnsureSuccessStatusCode();

        await host.Services.GetRequiredService<AutomationService>().Run(default);

        Assert.Equal(release, Assert.Single(host.Engine.Adds).Name);
        Assert.StartsWith(franchise, Assert.Single(host.Search.Requests).Query);
        Assert.All(host.Search.Requests, r => Assert.True(r.Background));
        await host.Seed(db =>
        {
            Assert.Equal(existingWork ? 1 : 0, db.Works.Count());
            Assert.Equal(episode + 1, db.WatchListItems.Single().CursorEpisode);
        });
    }
}
