using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using TorrentFlow.Api.Requests;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Automation;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Metadata;
using TorrentFlow.Metadata.Artwork;
using TorrentFlow.Metadata.Providers;
using TorrentFlow.Metadata.Recommend;
using TorrentFlow.Metadata.Title;

namespace TorrentFlow.Library.Tests;

public sealed class OnePipelineTests
{
    private const string Title = "My Hero Academia";
    private static void AnimeIdentity(LibraryHost host) => host.Anime.Respond = _ => [new()
    {
        Source = "anilist", ExternalId = "21459", Title = Title, MediaType = "anime", Year = 2016,
        Aliases = ["Boku no Hero Academia"]
    }];

    [Theory]
    [InlineData("owner", false)]
    [InlineData("request", false)]
    [InlineData("automation", true)]
    public async Task EveryLaneRecoversAnimeAndRetriesMetadataFailureWithoutSelectingDub(string lane, bool background)
    {
        using var host = new LibraryHost(); using var http = host.CreateClient();
        await host.Settings();
        AnimeIdentity(host);
        var dub = Release(1, $"{Title} S06E25 DUBBED 1080p");
        var dead = Release(2, $"{Title} S06E25 1080p MultiSub");
        var good = Release(3, $"{Title} S06E25 1080p MultiSub");
        host.Search.Respond = o => new() { Query = o.Query, Results = [dub, dead, good] };
        host.Engine.AddResult = r => r.InfoHash == dead.InfoHash ? new(false, "Metadata timeout") : new(true, "Started", Hash: r.InfoHash);
        var outcome = await host.Services.GetRequiredService<GrabService>().Grab(
            new(Title, "tv", new(6, 25), Year: 2016, Lane: lane, Background: background), default);
        Assert.True(outcome.Ok, outcome.Message);
        Assert.Equal(good.InfoHash, outcome.InfoHash);
        Assert.Equal([dead.InfoHash, good.InfoHash], host.Engine.Adds.Select(r => r.InfoHash));
        Assert.All(host.Engine.Adds, r => { Assert.True(r.RequireMetadata); Assert.Equal("anime", r.SearchCategory); Assert.Equal(lane, r.Lane); });
        Assert.Equal($"{Title} S06E25 1080p", Assert.Single(host.Search.Requests).Query);
        Assert.All(host.Search.Requests, r => { Assert.Equal("anime", r.Category); Assert.True(r.WaitForBudget); });
    }

    [Theory]
    [InlineData("My Hero Academia S05E01 DUBBED 1080p", false, false)]
    [InlineData("Kaiju No. 8 S01E04 [English Dub] 1080p", false, false)]
    [InlineData("One Piece - 1100 1080p Dual-Audio English Dubbed", false, true)]
    [InlineData("Frieren - 05 1080p MultiSub", false, true)]
    [InlineData("My Hero Academia S05E01 DUBBED 1080p", true, true)]
    public void AnimeDubPreferenceIsExplicit(string release, bool preferDub, bool expected) =>
        Assert.Equal(expected, AnimeAudio.Allowed(release, "anime", preferDub));

    [Theory]
    [InlineData("My Hero Academia", 2016, "anime")]
    [InlineData("My Hero Academia Season 2", 2017, "tv")]
    [InlineData("Different show", 2016, "tv")]
    public async Task TrustedCatalogGenreRecoversAnimeWhenAniListIsUnavailable(string catalogTitle, int year, string expected)
    {
        var metadata = new FakeMetadata { ById = (_, _, _) => new()
        { Source = "tvmaze", ExternalId = "13615", Title = catalogTitle, Year = year, MediaType = "tv", Genres = ["Anime"] } };
        var anime = new FakeAnimeLookup { Respond = _ => throw new HttpRequestException("AniList unavailable") };
        var identity = await new EpisodeSearchIdentity(anime, metadata).ResolveAsync(Title, 2016, "tv", [], default, "tvmaze", "13615");
        Assert.Equal(expected, identity.MediaType);
    }

    [Fact]
    public async Task RuleEpisodeUsesCommonPipelineWithoutDroppingSourceSizeAndResolutionRestrictions()
    {
        using var host = new LibraryHost(); using var http = host.CreateClient();
        await host.Settings();
        AnimeIdentity(host);
        var created = await http.PostAsJsonAsync("/api/rules", new { name = "MHA", query = Title, category = "anime",
            sources = "nyaa", resolution = "1080p", minSeeders = 5, maxSizeBytes = 2_000_000L });
        created.EnsureSuccessStatusCode();
        var acceptable = Release(5, $"{Title} S06E25 1080p MultiSub") with { SizeBytes = 1_000_000 };
        var trigger = Release(6, acceptable.Title) with { SizeBytes = 1_000_000 };
        host.Search.Respond = o => new() { Query = o.Query, Results = o.Filters?.Season == null ? [trigger] :
            [acceptable with { InfoHash = 2.ToString("x40"), Source = "eztv", Seeders = 100 },
             acceptable with { InfoHash = 3.ToString("x40"), SizeBytes = 3_000_000, Seeders = 100 },
             acceptable with { InfoHash = 4.ToString("x40"), Title = $"{Title} S06E25 720p", Seeders = 100 }, acceptable] };
        var result = await host.Services.GetRequiredService<AutomationService>().Rules(default);
        Assert.Equal("sent", Assert.Single(result).Status);
        var sent = Assert.Single(host.Engine.Adds);
        Assert.Equal(acceptable.InfoHash, sent.InfoHash);
        Assert.True(sent.RequireMetadata);
        Assert.Equal("anime", sent.SearchCategory);
        var acquisition = Assert.Single(host.Search.Requests, r => r.Filters?.Season != null);
        Assert.Equal(["nyaa"], acquisition.Sources!);
        Assert.Equal(2_000_000, acquisition.Filters!.MaxSizeBytes);
        Assert.Equal(5, acquisition.Filters.MinSeeders);
        Assert.Equal("1080p", acquisition.Filters.Resolution);
        Assert.Equal("skipped", Assert.Single(await host.Services.GetRequiredService<AutomationService>().Rules(default)).Status);
        Assert.Single(host.Engine.Adds);
        await using var db = await host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>().CreateDbContextAsync();
        Assert.Single(await db.DownloadHistories.ToListAsync());
    }

    [Fact]
    public async Task FilmRequestAlsoRetriesNextCandidateAfterMetadataFailure()
    {
        using var host = new LibraryHost(); using var http = host.CreateClient();
        await host.Settings();
        var dead = Release(1, "Example Film 2020 1080p");
        var good = Release(2, "Example Film 2020 1080p");
        host.Search.Respond = o => new() { Query = o.Query, Results = [dead, good] };
        host.Engine.AddResult = r => r.InfoHash == dead.InfoHash ? new(false, "Metadata timeout") : new(true, "Started", Hash: r.InfoHash);
        var result = await host.Services.GetRequiredService<GrabService>().Grab(new("Example Film", "movie", Year: 2020), default);
        Assert.True(result.Ok, result.Message);
        Assert.Equal(good.InfoHash, result.InfoHash);
        Assert.Equal(2, host.Engine.Adds.Count);
        Assert.All(host.Engine.Adds, add => Assert.True(add.RequireMetadata));
    }

    [Fact]
    public async Task SwapOfLegacyTvWorkUsesPersistedCoordinateAnimeSourcesAndRejectsDub()
    {
        using var host = new LibraryHost(); using var http = host.CreateClient();
        AnimeIdentity(host);
        var hash = 10.ToString("x40");
        await host.Seed(db => {
            db.Works.Add(new() { Id = "mha", WorkKey = "my-hero-academia", CanonicalTitle = Title, MediaType = "tv", Year = 2016 });
            db.EngineTorrents.Add(new() { Id = "transfer", UserId = LocalUser.Id, Hash = hash, Name = $"{Title} S02E25 1080p",
                Origin = "user", Status = "error", WorkId = "mha", QueueKey = "s00006e00025" });
        });
        host.Engine.Info = _ => new() { Hash = hash, Name = $"{Title} S02E25 1080p", State = "error" };
        host.Search.Respond = o => new() { Query = o.Query, Results =
            [Release(1, $"{Title} S06E25 DUBBED 1080p"), Release(2, $"{Title} S06E25 1080p MultiSub")] };
        var response = await http.GetFromJsonAsync<JsonElement>($"/api/client/torrents/{hash}/alternatives");
        Assert.Contains(response.GetProperty("sources").EnumerateArray(), s => s.GetProperty("id").GetString() == "nyaa");
        Assert.Single(response.GetProperty("alternatives").EnumerateArray());
        Assert.All(host.Search.Requests, r => { Assert.Equal("anime", r.Category); Assert.Equal(6, r.Filters!.Season); });
    }

    [Fact]
    public async Task RequestSeasonsFiveAndSixUseEpisodePipelineAndRetryOnlyMissingCoordinate()
    {
        using var host = new LibraryHost(); using var http = host.CreateClient();
        await host.Settings();
        AnimeIdentity(host);
        var missing = true;
        host.Search.Respond = o => new() { Query = o.Query, Results = o.Filters is { Season: 6, Episode: 25 } && missing ? [] :
            [Release(o.Filters!.Season!.Value * 100 + o.Filters.Episode!.Value, $"{Title} S{o.Filters.Season:00}E{o.Filters.Episode:00} 1080p MultiSub")] };
        host.Engine.AddResult = add => new(true, "Started", Hash: add.InfoHash);
        var factory = host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>();
        var httpFactory = new HttpFactory();
        var options = Options.Create(new MetadataOptions());
        var tmdb = new TmdbClient(httpFactory, options, TimeProvider.System);
        var anime = new AniListClient(httpFactory, TimeProvider.System);
        var keyless = new KeylessClients(httpFactory);
        var extras = new TitleExtrasService(tmdb, anime, keyless,
            new ArtworkResolver(tmdb, anime, keyless, options, TimeProvider.System),
            new RecommendationService(httpFactory, tmdb, null!, TimeProvider.System, NullLogger<RecommendationService>.Instance),
            TimeProvider.System, NullLogger<TitleExtrasService>.Instance);
        var grabber = new RequestGrabber(host.Services.GetRequiredService<GrabService>(), extras, TimeProvider.System, factory);
        var request = new MediaRequest { Id = "request", Title = Title, WorkKey = "my-hero-academia", Provider = "tvmaze",
            ProviderId = "13615", Year = 2016, MediaType = "tv", Scope = "seasons", Seasons = "5,6" };
        var first = await grabber.GrabAsync(request, default);
        Assert.True(first.Partial);
        Assert.Equal(49, first.Hashes.Count);
        Assert.Equal(49, host.Engine.Adds.Count);
        Assert.DoesNotContain(host.Engine.Adds, r => r.QueueKey!.StartsWith("s00002"));
        Assert.All(host.Engine.Adds, r => { Assert.Equal("anime", r.SearchCategory); Assert.True(r.RequireMetadata); });
        await host.Seed(db => {
            Assert.Equal("anime", db.Works.Single().MediaType);
            foreach (var add in host.Engine.Adds)
                db.EngineTorrents.Add(new() { Id = Ids.New(), Hash = add.InfoHash!, UserId = LocalUser.Id, Name = add.Name!,
                    Origin = "user", Status = "queued", WorkId = add.WorkId, QueueKey = add.QueueKey });
        });
        missing = false;
        host.Search.Requests.Clear();
        var retry = await grabber.GrabAsync(request, default);
        Assert.False(retry.Partial);
        Assert.Equal(50, retry.Hashes.Count);
        Assert.Equal(50, host.Engine.Adds.Count);
        var only = Assert.Single(host.Search.Requests);
        Assert.Equal($"{Title} S06E25 1080p", only.Query);
        Assert.Equal("anime", only.Category);
    }

    private static TorrentResult Release(int n, string title) => FakeSearch.Release(title) with
    { Id = n.ToString(), InfoHash = n.ToString("x40"), Magnet = $"magnet:?xt=urn:btih:{n:x40}" };

    private sealed class HttpFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(new Handler());
    }
    private sealed class Handler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            object body = request.RequestUri!.AbsolutePath.EndsWith("/episodes")
                ? new[] { 5, 6 }.SelectMany(season => Enumerable.Range(1, 25).Select(episode =>
                    new { id = season * 100 + episode, season, number = episode, name = $"Episode {episode}", airdate = "2023-03-01" })).ToArray()
                : new { id = 13615, name = Title, type = "Animation", premiered = "2016-04-03", genres = new[] { "Anime" } };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(body)) });
        }
    }
}
