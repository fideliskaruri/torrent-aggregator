using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Search.Adapters;

namespace TorrentFlow.Search.Tests;

internal sealed class FakeHttp(Func<HttpRequestMessage, HttpResponseMessage> handler) : HttpMessageHandler, IHttpClientFactory
{
    public List<string> Requests { get; } = [];
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        lock (Requests) Requests.Add(request.RequestUri!.ToString());
        return Task.FromResult(handler(request));
    }
    public HttpClient CreateClient(string name) => new(this, false);
    public static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    public IndexerHttp Http() => new(this, NullLogger<IndexerHttp>.Instance);
}

public sealed class AdapterTests
{
    private static IOptions<SearchModuleOptions> Config(params (string Key, string Value)[] values) => Options.Create(new ConfigurationBuilder()
        .AddInMemoryCollection(values.Select(x => new KeyValuePair<string, string?>(x.Key, x.Value))).Build().Get<SearchModuleOptions>() ?? new());
    [Theory]
    [InlineData("tv", 3)]
    [InlineData("movies", 6)]
    [InlineData("all", 17)]
    [InlineData("anime", 17)]
    public async Task ApiBay_filters_category_before_limit(string category, int expected)
    {
        var categories = new[] { "101", "201", "202", "203", "204", "205", "206", "207", "208", "209", "210", "211", "212", "299", "501", "507", "" };
        var fixture = JsonSerializer.Serialize(categories.Select((c, i) => new { id = $"{i}", name = $"Fixture {c}", info_hash = $"{i:0000000000000000000000000000000000000000}", seeders = "30", leechers = "2", size = "1000000000", category = c }));
        using var fake = new FakeHttp(_ => FakeHttp.Json(fixture));
        var adapter = new ApiBayAdapter(fake.Http(), Config());
        var results = await adapter.SearchAsync(new() { Query = "Fixture", Category = category });
        Assert.Equal(expected, results.Count);
        Assert.Contains("cat=0", Assert.Single(fake.Requests));
        Assert.All(results, r => Assert.Contains(r.InfoHash!, r.Magnet!));
        if (category == "tv") Assert.Equal(["205", "208"], (await adapter.SearchAsync(new() { Query = "Fixture", Category = category, Limit = 2 })).Select(r => r.Category));
    }
    [Fact]
    public async Task ApiBay_empty_and_dummy_are_empty_but_failure_throws()
    {
        using var fake = new FakeHttp(_ => FakeHttp.Json("""[{"id":"0","name":"No results returned"}]"""));
        var adapter = new ApiBayAdapter(fake.Http(), Config());
        Assert.Empty(await adapter.SearchAsync(new() { Query = " " }));
        Assert.Empty(fake.Requests);
        Assert.Empty(await adapter.SearchAsync(new() { Query = "nothing" }));
        using var down = new FakeHttp(_ => FakeHttp.Json("{}", HttpStatusCode.ServiceUnavailable));
        await Assert.ThrowsAsync<HttpRequestException>(() => new ApiBayAdapter(down.Http(), Config()).SearchAsync(new() { Query = "x" }));
    }
    [Fact]
    public async Task Csv_maps_null_size_and_bounds_limit()
    {
        using var fake = new FakeHttp(_ => FakeHttp.Json("""{"torrents":[{"infohash":"ABC","name":"Movie 1080p","seeders":5,"completed":7}]}"""));
        var rows = await new TorrentsCsvAdapter(fake.Http(), Config()).SearchAsync(new() { Query = "Movie", Limit = 200 });
        var r = Assert.Single(rows);
        Assert.Null(r.SizeBytes); Assert.Equal("abc", r.InfoHash); Assert.Equal(7, r.Completed);
        Assert.Contains("size=50", Assert.Single(fake.Requests));
    }
    [Fact]
    public async Task Nyaa_parses_namespaces_entities_and_binary_size()
    {
        const string xml = """
            <rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel><item><title><![CDATA[Show & Film - 05 (1080p)]]></title>
            <link>https://nyaa.si/download/1.torrent</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
            <nyaa:infoHash>ABC</nyaa:infoHash><nyaa:seeders>31</nyaa:seeders><nyaa:leechers>4</nyaa:leechers>
            <nyaa:downloads>11</nyaa:downloads><nyaa:size>1.5 GiB</nyaa:size><nyaa:category>Anime</nyaa:category></item></channel></rss>
            """;
        using var fake = new FakeHttp(_ => new(HttpStatusCode.OK) { Content = new StringContent(xml) });
        var r = Assert.Single(await new NyaaAdapter(fake.Http(), Config()).SearchAsync(new() { Query = "Show", Category = "anime" }));
        Assert.Equal(1610612736, r.SizeBytes); Assert.Equal(31, r.Seeders); Assert.Equal("https://nyaa.si", r.SourceUrl);
        Assert.Equal("2024-01-01T00:00:00.000Z", r.PublishedAt); Assert.Contains("Show & Film", r.Title);
        Assert.Contains("c=1_0", Assert.Single(fake.Requests));
    }
    [Fact]
    public async Task Yts_sorts_all_movie_torrents_before_slicing()
    {
        using var fake = new FakeHttp(_ => FakeHttp.Json("""
            {"data":{"movies":[{"id":1,"title":"Movie","title_long":"Movie (2024)","torrents":[
            {"hash":"ABC","quality":"720p","type":"bluray","size":"1 GB","seeds":1},
            {"hash":"DEF","quality":"1080p","type":"bluray","size":"2 GB","seeds":99}]}]}}
            """));
        var adapter = new YtsAdapter(fake.Http(), Config());
        Assert.Empty(await adapter.SearchAsync(new() { Query = "Movie", Category = "tv" }));
        Assert.Empty(fake.Requests);
        var best = Assert.Single(await adapter.SearchAsync(new() { Query = "Movie", Limit = 1 }));
        Assert.Equal("def", best.InfoHash); Assert.Equal(2000000000, best.SizeBytes);
    }
    [Fact]
    public async Task Magnets_and_source_urls_escape_like_encodeURIComponent()
    {
        using var fake = new FakeHttp(_ => FakeHttp.Json("""{"torrents":[{"infohash":"ABC","name":"Dune (2021) [1080p] it's *good*!","seeders":5}]}"""));
        var r = Assert.Single(await new TorrentsCsvAdapter(fake.Http(), Config()).SearchAsync(new() { Query = "Dune (2021)" }));
        Assert.Equal("magnet:?xt=urn:btih:abc&dn=Dune%20(2021)%20%5B1080p%5D%20it's%20*good*!", r.Magnet);
        Assert.Equal("https://torrents-csv.com/#/search/torrent/Dune%20(2021)%20%5B1080p%5D%20it's%20*good*!/1", r.SourceUrl);
    }
    [Fact]
    public async Task Yts_published_at_uses_the_unix_instant_not_the_zoneless_wall_clock()
    {
        using var fake = new FakeHttp(_ => FakeHttp.Json("""
            {"data":{"movies":[{"id":1,"title":"The Sand Dune","title_long":"The Sand Dune (2018)","torrents":[
            {"hash":"ABC","quality":"720p","type":"web","size":"1 GB","seeds":1,"date_uploaded":"2020-02-06 23:13:24","date_uploaded_unix":1581027204},
            {"hash":"DEF","quality":"1080p","type":"web","size":"2 GB","seeds":0,"date_uploaded":"2020-02-06 23:13:24"}]}]}}
            """));
        var rows = await new YtsAdapter(fake.Http(), Config()).SearchAsync(new() { Query = "The Sand Dune" });
        Assert.Equal("2020-02-06T22:13:24.000Z", rows.Single(r => r.InfoHash == "abc").PublishedAt);
        Assert.Equal("2020-02-06T23:13:24.000Z", rows.Single(r => r.InfoHash == "def").PublishedAt);
    }
    [Theory]
    [InlineData("Family Guy S03E03", "Family Guy")]
    [InlineData("Family Guy Season 3 complete", "Family Guy")]
    [InlineData("The.Bear.S03E01.1080p", "The Bear")]
    [InlineData("S.W.A.T.S.05.E.10", "S W A T")]
    [InlineData("1883", "1883")]
    [InlineData("86 S01E01", "86")]
    [InlineData("Stranger Things", "Stranger Things")]
    public void Eztv_show_query(string query, string expected) => Assert.Equal(expected, EztvAdapter.ShowTitle(query));
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Eztv_resolves_exact_title_and_filters_episode(bool exact)
    {
        using var fake = new FakeHttp(r =>
        {
            var url = r.RequestUri!.ToString();
            if (url.Contains("/search/tv")) return FakeHttp.Json($$"""{"results":[{"id":10,"name":"{{(exact ? "Family Guy" : "Different Show")}}"}]}""");
            if (url.Contains("/external_ids")) return FakeHttp.Json("""{"imdb_id":"tt0182576"}""");
            Assert.Contains("imdb_id=0182576", url);
            return FakeHttp.Json("""{"torrents":[{"id":1,"title":"Family Guy S03E03","hash":"ABC","season":"3","episode":"3","seeds":8},{"id":2,"title":"Family Guy S03 pack","hash":"DEF","season":"0","episode":"0"}]}""");
        });
        var adapter = new EztvAdapter(fake.Http(), Config(("TMDB_API_KEY", "test-key")));
        var result = await adapter.SearchAsync(new() { Query = "Family Guy S03E03" });
        if (exact) { Assert.Single(result); Assert.Equal("abc", result[0].InfoHash); }
        else { Assert.Empty(result); Assert.Single(fake.Requests); }
    }
    [Fact]
    public async Task Html_1337_uses_table_and_detail_magnet()
    {
        using var fake = new FakeHttp(r => new(HttpStatusCode.OK) { Content = new StringContent(r.RequestUri!.AbsolutePath.Contains("/torrent/") ?
            """<a href="magnet:?xt=urn:btih:ABC&amp;dn=Movie">Magnet</a>""" :
            """<table class="table-list"><tbody><tr><td class="coll-1 name"><a>Icon</a><a href="/torrent/12/movie/">Movie 1080p</a></td><td class="coll-2 seeds">20</td><td class="coll-3 leeches">3</td><td class="coll-4">1.5 GB<span>uploader</span></td></tr></tbody></table>""") });
        var result = Assert.Single(await new X1337Adapter(fake.Http(), Config()).SearchAsync(new() { Query = "Movie", Category = "movies" }));
        Assert.Equal("abc", result.InfoHash); Assert.Equal(1500000000, result.SizeBytes); Assert.Equal(20, result.Seeders);
        Assert.Contains("/category-search/Movie/Movies/1/", fake.Requests[0]);
    }
    [Fact]
    public void Mirrors_override_leads_but_keeps_defaults() =>
        Assert.Equal(["https://mine", "https://other", "https://a"], IndexerHttp.MirrorList("https://mine/ , https://other//", "https://a", "https://mine"));
    [Theory]
    [InlineData(403)]
    [InlineData(429)]
    [InlineData(503)]
    [InlineData(404)]
    public async Task Mirrors_failover_and_remember_winner(int status)
    {
        using var fake = new FakeHttp(r => FakeHttp.Json("{}", r.RequestUri!.Host == "dead" ? (HttpStatusCode)status : HttpStatusCode.OK));
        var http = fake.Http();
        await http.MirrorsAsync("test", ["https://dead", "https://live"], h => h + "/q", "test", default);
        Assert.Equal(["https://dead/q", "https://live/q"], fake.Requests);
        fake.Requests.Clear();
        await http.MirrorsAsync("test", ["https://dead", "https://live"], h => h + "/q", "test", default);
        Assert.Equal(["https://live/q"], fake.Requests);
    }
    [Fact]
    public async Task Mirror_demotion_is_never_exclusion()
    {
        var fail = true;
        using var fake = new FakeHttp(_ => FakeHttp.Json("{}", fail ? HttpStatusCode.ServiceUnavailable : HttpStatusCode.OK));
        var http = fake.Http();
        await Assert.ThrowsAsync<HttpRequestException>(() => http.MirrorsAsync("test", ["https://a", "https://b"], h => h, "test", default));
        fail = false;
        Assert.Equal("{}", await http.MirrorsAsync("test", ["https://a", "https://b"], h => h, "test", default));
    }
    [Theory]
    [InlineData(400)]
    [InlineData(401)]
    public async Task Request_error_does_not_burn_every_mirror(int status)
    {
        using var fake = new FakeHttp(_ => FakeHttp.Json("{}", (HttpStatusCode)status));
        await Assert.ThrowsAsync<HttpRequestException>(() => fake.Http().MirrorsAsync("test", ["https://a", "https://b"], h => h, "test", default));
        Assert.Single(fake.Requests);
    }
    [Fact]
    public async Task Html_challenge_is_not_a_healthy_api()
    {
        using var fake = new FakeHttp(r => r.RequestUri!.Host == "bad"
            ? new(HttpStatusCode.OK) { Content = new StringContent("<html>Just a moment</html>", Encoding.UTF8, "text/html") }
            : FakeHttp.Json("{}"));
        await fake.Http().MirrorsAsync("test", ["https://bad", "https://good"], h => h, "test", default);
        Assert.Equal(2, fake.Requests.Count);
    }
    private sealed class Browser : IIndexerBrowserFetcher
    {
        public int Calls;
        public Task<BrowserPage?> FetchAsync(string url, int timeoutMs, string selector, CancellationToken token)
        {
            Calls++; Assert.Equal(40000, timeoutMs); Assert.Equal("table.table-list tbody tr", selector);
            return Task.FromResult<BrowserPage?>(new(200, "<html><table class='table-list'><tbody></tbody></table></html>", url));
        }
    }
    [Fact]
    public async Task Browser_fallback_is_opt_in_and_never_hides_non_challenge_failure()
    {
        using var fake = new FakeHttp(_ => FakeHttp.Json("{}", HttpStatusCode.Forbidden));
        var browser = new Browser();
        await Assert.ThrowsAsync<HttpRequestException>(() => new X1337Adapter(fake.Http(), Config(("X1337_USE_PLAYWRIGHT", "0")), browser).SearchAsync(new() { Query = "Movie" }));
        Assert.Equal(0, browser.Calls);
        Assert.Empty(await new X1337Adapter(fake.Http(), Config(("X1337_USE_PLAYWRIGHT", "1")), browser).SearchAsync(new() { Query = "Movie" }));
        Assert.Equal(1, browser.Calls);
        using var failure = new FakeHttp(_ => FakeHttp.Json("{}", HttpStatusCode.InternalServerError));
        await Assert.ThrowsAsync<HttpRequestException>(() => new X1337Adapter(failure.Http(), Config(("X1337_USE_PLAYWRIGHT", "1")), browser).SearchAsync(new() { Query = "Movie" }));
        Assert.Equal(1, browser.Calls);
    }
}
