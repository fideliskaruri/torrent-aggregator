using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Core.Contracts.Metadata;

namespace TorrentFlow.Library.Tests;

public sealed class TitleProviderIdentityTests
{
    private static MediaMetadata Anime => new()
    {
        Source = "anilist", ExternalId = "52991", Title = "Sousou no Frieren 2nd Season",
        MediaType = "anime", Year = 2026, Aliases = ["Frieren Season 2"]
    };

    [Fact]
    public async Task UnavailableProviderStillAllowsLocalTitleDisplayButNotUnverifiedAcquisition()
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        var get = await client.GetAsync("/api/title/frieren?provider=anilist&providerId=52991&t=Frieren&type=anime");
        Assert.Equal(HttpStatusCode.OK, get.StatusCode);
        var post = await client.PostAsJsonAsync("/api/title/frieren", new
        {
            scope = "episode", season = 1, episode = 1, provider = "anilist", providerId = "52991"
        });
        Assert.Equal(HttpStatusCode.BadRequest, post.StatusCode);
        Assert.Empty(host.Engine.Adds);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task WrongProviderEntryIsRejectedByGetAndPostEvenWithoutDisplayHints(bool hints)
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        host.Metadata.ById = (_, _, _) => new()
        {
            Source = "tvmaze", ExternalId = "1", Title = "Under the Dome", MediaType = "tv", Year = 2013
        };
        var get = await client.GetAsync("/api/title/frieren?provider=tvmaze&providerId=1&type=anime");
        Assert.Equal(HttpStatusCode.BadRequest, get.StatusCode);
        var post = await client.PostAsJsonAsync("/api/title/frieren", new
        {
            scope = "season", season = 1, episodes = new[] { 1, 2 }, provider = "tvmaze", providerId = "1",
            title = hints ? "Frieren" : null, sourceType = hints ? "anime" : null
        });
        Assert.Equal(HttpStatusCode.BadRequest, post.StatusCode);
        Assert.Contains("Provider identity does not match", await post.Content.ReadAsStringAsync());
        Assert.Empty(host.Search.Requests);
        Assert.Empty(host.Engine.Adds);
    }

    [Theory]
    [InlineData("sousou-no-frieren-2nd-season")]
    [InlineData("frieren-season-2")]
    public async Task ValidAniListCanonicalOrAliasIdentityFansOutMappedSeason(string key)
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        await host.Settings();
        host.Metadata.ById = (provider, _, id) => provider == "anilist" && id == "52991" ? Anime : null;
        host.Anime.Mapping = new AnimeEpisodeMapping(2, 28, [Anime.Title, "Frieren Season 2"], ["Frieren"]);
        host.Engine.AddResult = add => new(true, "Started", Hash: add.InfoHash);
        host.Search.Respond = o => new()
        {
            Query = o.Query,
            Results = Enumerable.Range(1, 2).Select(ep => FakeSearch.Release($"Frieren S02E{ep:00} 1080p WEB-DL")
                with { InfoHash = ep.ToString("x40") }).ToArray()
        };
        var get = await client.GetAsync($"/api/title/{key}?provider=anilist&providerId=52991&type=anime");
        Assert.Equal(HttpStatusCode.OK, get.StatusCode);
        var detail = await get.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(Anime.Title, detail.GetProperty("title").GetString());
        var post = await client.PostAsJsonAsync($"/api/title/{key}", new
        {
            scope = "season", season = 1, episodes = new[] { 1, 2 }, provider = "anilist", providerId = "52991",
            mediaType = "anime", preferredResolution = 1080
        });
        Assert.Equal(HttpStatusCode.OK, post.StatusCode);
        var result = await post.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(2, result.GetProperty("report").GetProperty("coveredEpisodes").GetInt32());
        Assert.Equal(2, host.Engine.Adds.Count);
        Assert.All(host.Engine.Adds, add => Assert.Contains("Frieren S02E", add.Name));
        Assert.Equal(new[] { "s00001e00001", "s00001e00002" }, host.Engine.Adds.Select(a => a.QueueKey).Order());
    }
}
