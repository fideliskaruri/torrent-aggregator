using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Library.Features.Grabs;

namespace TorrentFlow.Library.Tests;

public sealed class LadderRouteTests
{
    private const string Slime = "That Time I Got Reincarnated as a Slime";
    private static async Task<JsonElement> Json(HttpResponseMessage response) =>
        JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();
    private static MediaMetadata Anime(string title, int? year, params string[] aliases) =>
        new() { Source = "anilist", MediaType = "anime", ExternalId = "1", Title = title, Year = year, Aliases = aliases };

    [Fact]
    public async Task TitleEpisodeGrabRecoversAniListAliasAndSendsFromAnimeRung()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        host.Anime.Respond = _ => [Anime("Tensei Shitara Slime Datta Ken", 2018, Slime, "転生したらスライムだった件")];
        host.Search.Respond = o => new()
        {
            Query = o.Query,
            Results = o.Query.StartsWith("Tensei", StringComparison.Ordinal) && o.Category == "anime"
                ? [FakeSearch.Release("Tensei.Shitara.Slime.Datta.Ken.S01E03.1080p.WEB.H264"), FakeSearch.Release("[Judas] Tensei Shitara Slime Datta Ken (Season 1) [1080p] (Batch)")]
                : [],
        };
        var response = await client.PostAsJsonAsync("/api/title/that-time-i-got-reincarnated-as-a-slime",
            new { scope = "episode", season = 1, episode = 3, title = Slime, year = 2018, mediaType = "tv" });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True((await Json(response)).GetProperty("ok").GetBoolean());
        var add = Assert.Single(host.Engine.Adds);
        Assert.Equal("s00001e00003", add.QueueKey);
        // The canonical English rung runs first, then the recovered romaji name on the anime category wins.
        Assert.Equal([$"{Slime} S01E03|anime", "Tensei Shitara Slime Datta Ken S01E03|anime"], host.Search.Requests.Select(r => $"{r.Query}|{r.Category}"));
        Assert.All(host.Search.Requests, r => Assert.Equal(EpisodeLadder.SearchLimit, r.PageSize));
    }

    [Theory]
    [InlineData(2010, "Tensei Shitara Slime Datta Ken")]
    [InlineData(2018, "Slime Taoshite 300-nen")]
    public async Task AniListRecoveryIsGuardedByYearAndExactName(int anilistYear, string anilistTitle)
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        host.Anime.Respond = _ => [Anime(anilistTitle, anilistYear, anilistYear == 2010 ? [Slime] : [])];
        var response = await client.PostAsJsonAsync("/api/title/that-time-i-got-reincarnated-as-a-slime",
            new { scope = "episode", season = 1, episode = 3, title = Slime, year = 2018, mediaType = "tv" });
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Empty(host.Engine.Adds);
        Assert.DoesNotContain(host.Search.Requests, r => r.Query.StartsWith("Tensei", StringComparison.Ordinal) || r.Query.StartsWith("Slime", StringComparison.Ordinal));
        Assert.Equal("tv", host.Search.Requests[0].Category);
    }

    [Fact]
    public async Task FailingLookupDegradesToKnownIdentity()
    {
        var identity = new EpisodeSearchIdentity(new ThrowingLookup());
        var (type, aliases) = await identity.ResolveAsync(Slime, 2018, "tv", ["転生したらスライムだった件", Slime, " "], default);
        Assert.Equal("tv", type);
        Assert.Equal(["転生したらスライムだった件"], aliases);
    }

    [Fact]
    public async Task OnDemandLadderFallsBackToRelaxedRungForZeroSeederSingle()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        await host.Seed(db => db.WatchListItems.Add(LibraryHost.Watch()));
        host.Search.Respond = o => new() { Query = o.Query, Results = [FakeSearch.Release("Example Show S01 1080p", 90), FakeSearch.Release("Example.Show.S01E01.1080p.WEB-DL", 0)] };
        var response = await client.PostAsJsonAsync("/api/library/ondemand", new { watchListItemId = "watch", season = 1, episode = 1 });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True((await Json(response)).GetProperty("advanced").GetBoolean());
        Assert.Equal("Example.Show.S01E01.1080p.WEB-DL", Assert.Single(host.Engine.Adds).Name);
        Assert.Equal(0, host.Search.Requests[^1].Filters!.MinSeeders);
    }

    [Fact]
    public async Task OnDemandLadderReportsEveryDistinctRungWhenNothingMatches()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        await host.Settings();
        await host.Seed(db => db.WatchListItems.Add(LibraryHost.Watch()));
        host.Search.Respond = o => new() { Query = o.Query, Results = [FakeSearch.Release("Example Show S01 1080p"), FakeSearch.Release("Other Show S01E01 1080p")] };
        await client.PostAsJsonAsync("/api/library/ondemand", new { watchListItemId = "watch", season = 1, episode = 1 });
        Assert.Empty(host.Engine.Adds);
        var expected = EpisodeLadder.BuildEpisodeRungs("Example Show", new(1, 1), "tv", minimumResolution: 1080).Select(r => r.SearchKey).Distinct().Count();
        Assert.Equal(expected, host.Search.Requests.Count);
    }

    [Fact]
    public async Task ArtworkFallbackFillsBothFieldsOnlyWhenNothingLocal()
    {
        using var host = new LibraryHost(); using var client = host.CreateClient();
        host.Artwork.Result = new("https://img.example/poster.jpg", "https://img.example/backdrop.jpg");
        var detail = await Json(await client.GetAsync("/api/title/example-show"));
        Assert.Equal("https://img.example/poster.jpg", detail.GetProperty("posterUrl").GetString());
        Assert.Equal("https://img.example/backdrop.jpg", detail.GetProperty("backdropUrl").GetString());
        Assert.Equal(["Example Show"], host.Artwork.Requests);

        await host.Seed(db => db.CachedMetadata.Add(new()
        {
            Id = "meta", CacheKey = "example", Source = "tmdb", MediaType = "tv", ExternalId = "1", Title = "Example Show",
            BackdropUrl = "https://cache.example/backdrop.jpg", ExpiresAt = DateTime.UtcNow.AddDays(1), CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow
        }));
        detail = await Json(await client.GetAsync("/api/title/example-show"));
        Assert.Equal(JsonValueKind.Null, detail.GetProperty("posterUrl").ValueKind);
        Assert.Equal("https://cache.example/backdrop.jpg", detail.GetProperty("backdropUrl").GetString());
        Assert.Single(host.Artwork.Requests);
    }

    [Fact]
    public void MetadataModuleOverridesLibraryDefaults()
    {
        var configuration = new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build();
        var services = new ServiceCollection();
        services.AddLibraryModule(configuration);
        TorrentFlow.Metadata.MetadataModule.AddMetadataModule(services, configuration);
        Assert.Equal("LibraryArtworkResolver", Assert.Single(services, d => d.ServiceType == typeof(ILibraryArtworkResolver)).ImplementationType?.Name);
        Assert.Equal("LibraryAnimeLookup", Assert.Single(services, d => d.ServiceType == typeof(ILibraryAnimeLookup)).ImplementationType?.Name);
    }

    private sealed class ThrowingLookup : ILibraryAnimeLookup
    {
        public Task<IReadOnlyList<MediaMetadata>> SearchAsync(string title, int limit, CancellationToken cancellationToken) =>
            throw new HttpRequestException("AniList down");
    }
}
