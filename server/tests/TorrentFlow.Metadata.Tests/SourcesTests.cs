using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using TorrentFlow.Core.Sources;
using TorrentFlow.Metadata.Providers;
using TorrentFlow.Metadata.Search;
using TorrentFlow.Metadata.Settings;

namespace TorrentFlow.Metadata.Tests;

public sealed class SourcesTests : IDisposable
{
    private readonly string root = Path.Combine(Directory.GetCurrentDirectory(), "test-artifacts", Guid.NewGuid().ToString("N"));
    private IConfiguration Config => new ConfigurationBuilder().AddInMemoryCollection(
        new Dictionary<string, string?> { ["TorrentFlow:DataDirectory"] = root }).Build();
    private SourceRegistry Registry() => new(Config);

    [Fact]
    public void Defaults_are_keyless_and_partial_overlay_preserves_fields()
    {
        var registry = Registry();
        Assert.DoesNotContain(registry.Active("metadata"), e => e.Type == "tmdb");
        Assert.Contains(registry.Active("metadata", "movies"), e => e.Type == "cinemeta");
        var original = registry.Find("tvmaze")!;
        var revision = registry.Revision;
        registry.Update("tvmaze", new JsonObject { ["priority"] = 2 });
        var saved = registry.Find("tvmaze")!;
        Assert.Equal(original.BaseUrl, saved.BaseUrl);
        Assert.Equal(original.Categories, saved.Categories);
        Assert.Equal(2, saved.Priority);
        Assert.True(registry.Revision > revision);
        Assert.Equal(2, Registry().Find("tvmaze")!.Priority);
    }

    [Fact]
    public void External_edits_reload_and_invalid_edits_keep_last_good()
    {
        var registry = Registry();
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, "sources.json");
        File.WriteAllText(path, """[{"id":"tvmaze","enabled":false}]""");
        Assert.DoesNotContain(registry.Active("metadata"), e => e.Id == "tvmaze");
        File.WriteAllText(path, "{broken");
        Assert.DoesNotContain(registry.Active("metadata"), e => e.Id == "tvmaze");
        Assert.NotNull(registry.LoadError);
        File.Delete(path);
        Assert.Contains(registry.Active("metadata"), e => e.Id == "tvmaze");
    }

    [Theory]
    [InlineData("""{"baseUrl":"file:///secret"}""")]
    [InlineData("""{"baseUrl":"https://example.test?apikey=secret"}""")]
    [InlineData("""{"timeoutMs":0}""")]
    [InlineData("""{"categories":[]}""")]
    [InlineData("""{"options":{"apiKey":"secret"}}""")]
    [InlineData("""{"type":"unknown"}""")]
    public void Invalid_source_updates_do_not_replace_valid_snapshot(string json)
    {
        var registry = Registry();
        Assert.ThrowsAny<Exception>(() => registry.Update("tvmaze", JsonNode.Parse(json)!.AsObject()));
        Assert.Equal("https://api.tvmaze.com", registry.Find("tvmaze")!.BaseUrl);
    }

    [Fact]
    public void Torznab_entries_are_addable_removable_and_secret_safe()
    {
        var registry = Registry();
        registry.Update("private-indexer", JsonNode.Parse("""
            {"kind":"torrent","type":"torznab","baseUrl":"http://localhost:9117/api","categories":["movie"],"credential":"1234567890abcdef"}
            """)!.AsObject());
        var item = registry.Find("private-indexer")!;
        var json = JsonSerializer.Serialize(registry.Public(item));
        Assert.DoesNotContain("1234567890abcdef", json);
        Assert.Contains("cdef", json);
        Assert.Contains(registry.Active("torrent", "movies"), e => e.Id == "private-indexer");
        registry.Remove(item.Id);
        Assert.Null(registry.Find(item.Id));
        Assert.Throws<ArgumentException>(() => registry.Remove("tvmaze"));
    }

    [Fact]
    public void Tmdb_saved_key_migrates_and_removal_falls_back_to_options()
    {
        Directory.CreateDirectory(root);
        File.WriteAllText(Path.Combine(root, "tmdb-settings.json"), JsonSerializer.Serialize(new { apiKey = Fixtures.TmdbKey }));
        var registry = Registry();
        var store = new TmdbSettingsStore(Config, Fixtures.Options("abcdef1234567890abcdef1234567890"), registry);
        Assert.Equal(Fixtures.TmdbKey, registry.Find("tmdb")!.Credential);
        Assert.False(File.Exists(Path.Combine(root, "tmdb-settings.json")));
        store.Remove();
        Assert.Equal("environment", store.Status().Source);
    }

    [Fact]
    public async Task Tvmaze_preserves_external_ids_airstamp_and_caches()
    {
        using var handler = new FakeHandler(request => Task.FromResult(FakeHandler.Json(request.RequestUri!.AbsolutePath.EndsWith("episodes")
            ? """[{"season":1,"number":1,"name":"Pilot","airdate":"2013-12-02","airstamp":"2013-12-03T03:30:00+00:00"}]"""
            : """[{"score":1,"show":{"id":216,"name":"Rick and Morty","externals":{"imdb":"tt2861424","thetvdb":275274},"premiered":"2013-12-02"}}]""")));
        var client = new KeylessClients(new FakeHttpFactory(handler));
        var show = Assert.Single(await client.SearchTvmazeAsync("Rick and Morty"));
        Assert.Equal("tt2861424", show.ImdbId);
        Assert.Equal(275274, show.TvdbId);
        Assert.Single(await client.SearchTvmazeAsync("Rick and Morty"));
        Assert.Single(handler.Requests);
        var episode = Assert.Single(await client.GetTvmazeEpisodesAsync(216));
        Assert.Equal("2013-12-03T03:30:00+00:00", episode.AirStamp);
    }

    [Fact]
    public async Task Cinemeta_search_catalog_and_meta_map_imdb_and_images()
    {
        const string metadata = """{"id":"tt0038650","name":"It's a Wonderful Life","poster":"https://img.test/poster.jpg","background":"https://img.test/bg.jpg","releaseInfo":"1946","description":"An angel visits.","imdbRating":"8.6"}""";
        using var handler = new FakeHandler(request => Task.FromResult(FakeHandler.Json(
            request.RequestUri!.AbsolutePath.StartsWith("/meta/") ? "{\"meta\":" + metadata + "}" : "{\"metas\":[" + metadata + "]}")));
        var client = new CinemetaClient(new FakeHttpFactory(handler));
        var search = Assert.Single(await client.SearchAsync("It's a Wonderful Life", "movie"));
        Assert.Equal("tt0038650", search.ExternalId); Assert.Equal(1946, search.Year);
        Assert.Equal("https://img.test/bg.jpg", search.BackdropUrl);
        Assert.Single(await client.CatalogAsync("movie"));
        Assert.Equal("An angel visits.", (await client.GetByIdAsync("tt0038650", "movie"))!.Synopsis);
    }

    [Fact]
    public async Task No_key_search_returns_series_and_movies_then_respects_disable_without_restart()
    {
        var registry = Registry();
        using var handler = new FakeHandler(request => Task.FromResult(FakeHandler.Json(request.RequestUri!.Host switch
        {
            "api.tvmaze.com" => """[{"show":{"id":216,"name":"Rick and Morty","externals":{"imdb":"tt2861424"}}}]""",
            "v3-cinemeta.strem.io" => """{"metas":[{"id":"tt0038650","name":"It's a Wonderful Life","releaseInfo":"1946"}]}""",
            _ => """{"data":{"Page":{"media":[]}}}"""
        })));
        var http = new FakeHttpFactory(handler);
        var service = new WorkSearchService(new(http, Fixtures.Options(), TimeProvider.System), new(http, TimeProvider.System),
            new(http, registry), TimeProvider.System, registry, new(http, registry));
        Assert.Equal("tvmaze", Assert.Single((await service.SearchAsync("series", "Rick and Morty", 12)).Results).Provider);
        Assert.Equal("cinemeta", Assert.Single((await service.SearchAsync("movies", "It's a Wonderful Life", 12)).Results).Provider);
        registry.Update("tvmaze", new JsonObject { ["enabled"] = false });
        var before = handler.Requests.Count(r => r.RequestUri!.Host == "api.tvmaze.com");
        await service.SearchAsync("series", "Rick and Morty", 12);
        Assert.Equal(before, handler.Requests.Count(r => r.RequestUri!.Host == "api.tvmaze.com"));
        Assert.DoesNotContain(handler.Requests, r => r.RequestUri!.Host == "api.themoviedb.org");
    }

    [Fact]
    public async Task Metadata_transport_uses_configured_mirror_and_blocks_disabled_source()
    {
        var registry = Registry();
        registry.Update("cinemeta", JsonNode.Parse("""{"baseUrl":"https://primary.test","mirrors":["https://mirror.test"]}""")!.AsObject());
        using var handler = new FakeHandler(request => Task.FromResult(FakeHandler.Json("{}",
            request.RequestUri!.Host == "primary.test" ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK)));
        using var routing = new SourceRoutingHandler(registry) { InnerHandler = handler };
        using var client = new HttpClient(routing);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(CinemetaClient.Base + "/catalog/movie/top.json")).StatusCode);
        Assert.Equal("mirror.test", handler.Requests.Last().RequestUri!.Host);
        registry.Update("cinemeta", new JsonObject { ["enabled"] = false });
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await client.GetAsync(CinemetaClient.Base + "/catalog/movie/top.json")).StatusCode);
    }

    [Theory]
    [InlineData("<caps><server title=\"Indexer\" /></caps>", true)]
    [InlineData("<html><body>Login</body></html>", false)]
    [InlineData("<error code=\"100\" description=\"Invalid API key\" />", false)]
    [InlineData("<caps>", false)]
    [InlineData("{\"ok\":true}", false)]
    [InlineData("<!DOCTYPE caps [<!ENTITY test SYSTEM \"file:///private\">]><caps>&test;</caps>", false)]
    public async Task Torznab_health_requires_caps_xml(string payload, bool expected)
    {
        var registry = Registry();
        registry.Update("test-indexer", JsonNode.Parse("""
            {"kind":"torrent","type":"torznab","baseUrl":"https://indexer.test/api","categories":["movie"]}
            """)!.AsObject());
        using var handler = new FakeHandler(request =>
        {
            Assert.Equal("?t=caps", request.RequestUri!.Query);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(payload) });
        });
        var controller = new SourcesController(registry, new FakeHttpFactory(handler))
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
        };
        var result = Assert.IsType<OkObjectResult>(await controller.Test("test-indexer", CancellationToken.None));
        var body = JsonSerializer.SerializeToElement(result.Value);
        Assert.Equal(expected, body.GetProperty("ok").GetBoolean());
        Assert.Equal(expected ? "ok" : "unavailable", body.GetProperty("status").GetString());
    }

    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }
}
