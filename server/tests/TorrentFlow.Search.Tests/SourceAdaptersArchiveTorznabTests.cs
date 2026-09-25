using System.Net;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Search.Adapters;

namespace TorrentFlow.Search.Tests;

public sealed class SourceAdaptersArchiveTorznabTests
{
    private static IOptions<SearchModuleOptions> Config(params (string Key, string Value)[] values) => Options.Create(new ConfigurationBuilder()
        .AddInMemoryCollection(values.Select(x => new KeyValuePair<string, string?>(x.Key, x.Value))).Build().Get<SearchModuleOptions>() ?? new());
    private static HttpResponseMessage Xml(string xml) => new(HttpStatusCode.OK) { Content = new StringContent(xml, Encoding.UTF8, "application/rss+xml") };

    private const string ArchiveFixture = """
        {"responseHeader":{"status":0},"response":{"numFound":3,"start":0,"docs":[
          {"btih":"6B30EB5C382658906451C0FFD435436CC61CD317","downloads":943363,"identifier":"Sita_Sings_the_Blues","item_size":251213276370,"mediatype":"movies","publicdate":"2009-03-02T21:45:29Z","title":"Sita Sings the Blues","year":2008},
          {"downloads":10,"identifier":"no_hash_yet","item_size":5,"mediatype":"movies","title":"Missing Torrent"},
          {"btih":"6bc1af23a17fd62156ab2f0e41d3c86769c2c66c","downloads":"303850","identifier":"night_of_the_living_dead_dvd","item_size":5003733941,"publicdate":"2007-04-23T23:34:45Z","title":["Night of the Living Dead (1968)","Alt"],"year":"1968"}
        ]}}
        """;

    [Fact]
    public async Task Archive_parses_advancedsearch_and_builds_webseeded_magnets()
    {
        using var fake = new FakeHttp(_ => FakeHttp.Json(ArchiveFixture));
        var rows = await new ArchiveAdapter(fake.Http(), Config()).SearchAsync(new() { Query = "Sita Sings the Blues", Category = "movies" });
        Assert.Equal(2, rows.Count);
        var sita = rows[0];
        Assert.Equal("Sita Sings the Blues (2008)", sita.Title);
        Assert.Equal("6b30eb5c382658906451c0ffd435436cc61cd317", sita.InfoHash);
        Assert.Equal("archive", sita.Source); Assert.Equal("movies", sita.Category);
        Assert.Equal(251213276370, sita.SizeBytes); Assert.Equal(1, sita.Seeders); Assert.Equal(943363, sita.Completed);
        Assert.Equal("https://archive.org/details/Sita_Sings_the_Blues", sita.SourceUrl);
        Assert.Equal("https://archive.org/download/Sita_Sings_the_Blues/Sita_Sings_the_Blues_archive.torrent", sita.TorrentUrl);
        Assert.Equal("2009-03-02T21:45:29.000Z", sita.PublishedAt);
        Assert.Contains("Webseed", sita.Tags);
        Assert.StartsWith("magnet:?xt=urn:btih:6b30eb5c382658906451c0ffd435436cc61cd317&dn=Sita%20Sings%20the%20Blues%20(2008)", sita.Magnet);
        Assert.Contains("&tr=http%3A%2F%2Fbt1.archive.org%3A6969%2Fannounce&tr=http%3A%2F%2Fbt2.archive.org%3A6969%2Fannounce", sita.Magnet);
        Assert.EndsWith("&ws=https%3A%2F%2Farchive.org%2Fdownload%2F", sita.Magnet);
        // Array-valued title takes the first entry and does not repeat a year already present.
        Assert.Equal("Night of the Living Dead (1968)", rows[1].Title);
        var request = Uri.UnescapeDataString(Assert.Single(fake.Requests));
        Assert.Contains("title:(Sita Sings the Blues) AND mediatype:movies", request);
        Assert.Contains("fl[]=btih", request); Assert.Contains("sort[]=downloads+desc", request);
    }

    [Theory]
    [InlineData("Night of the Living Dead 1968 1080p", "all", "title:(Night of the Living Dead) AND mediatype:movies AND (year:1968 OR title:1968)")]
    [InlineData("popeye: \"sailor\" (color)", "anime", "title:(popeye sailor color) AND mediatype:movies AND collection:(animationandcartoons OR classic_cartoons OR anime)")]
    [InlineData("Twilight Zone", "tv", "title:(Twilight Zone) AND mediatype:movies AND collection:(television OR classic_tv OR tvarchive OR television_inbox)")]
    public void Archive_query_escapes_lucene_and_scopes_category(string query, string category, string expected) =>
        Assert.Equal(expected, ArchiveAdapter.BuildQuery(query, category));

    [Fact]
    public async Task Archive_skips_unsupported_categories_and_empty_queries()
    {
        using var fake = new FakeHttp(_ => FakeHttp.Json(ArchiveFixture));
        var adapter = new ArchiveAdapter(fake.Http(), Config());
        Assert.Empty(await adapter.SearchAsync(new() { Query = "Sita", Category = "music" }));
        Assert.Empty(await adapter.SearchAsync(new() { Query = " :: ", Category = "all" }));
        Assert.Empty(fake.Requests);
        var tv = await adapter.SearchAsync(new() { Query = "Sita", Category = "tv" });
        Assert.All(tv, r => Assert.Equal("tv", r.Category));
    }

    private const string TorznabFixture = """
        <?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:torznab="http://torznab.com/schemas/2015/feed">
        <channel><title>Jackett</title>
          <item>
            <title>Big Buck Bunny 2008 1080p BluRay x264</title>
            <guid>https://tracker.example/details/1</guid>
            <jackettindexer id="example">ExampleTracker</jackettindexer>
            <comments>https://tracker.example/details/1</comments>
            <link>http://127.0.0.1:9117/dl/example/?jackett_apikey=k&amp;path=abc</link>
            <size>2147483648</size>
            <pubDate>Mon, 01 Jan 2024 10:00:00 +0000</pubDate>
            <enclosure url="http://127.0.0.1:9117/dl/example/?jackett_apikey=k&amp;path=abc" length="2147483648" type="application/x-bittorrent"/>
            <torznab:attr name="category" value="2000"/>
            <torznab:attr name="category" value="2040"/>
            <torznab:attr name="seeders" value="40"/>
            <torznab:attr name="peers" value="55"/>
            <torznab:attr name="infohash" value="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"/>
            <torznab:attr name="grabs" value="12"/>
          </item>
          <item>
            <title>Show S01E02 720p</title>
            <guid>magnet-guid-2</guid>
            <link>magnet:?xt=urn:btih:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB&amp;dn=Show</link>
            <torznab:attr name="category" value="5000"/>
            <torznab:attr name="seeders" value="3"/>
            <torznab:attr name="peers" value="2"/>
          </item>
          <item>
            <title>Anime - 01</title>
            <guid>g3</guid>
            <link>https://tracker.example/get/3.torrent</link>
            <torznab:attr name="category" value="5000"/>
            <torznab:attr name="category" value="5070"/>
            <torznab:attr name="magneturl" value="magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&amp;dn=Anime"/>
            <torznab:attr name="seeders" value="9"/>
            <torznab:attr name="leechers" value="4"/>
          </item>
          <item>
            <title>Torrent Only</title>
            <guid>g4</guid>
            <link>https://tracker.example/get/4.torrent</link>
            <torznab:attr name="seeders" value="1"/>
          </item>
          <item><title>No Source</title><guid>g5</guid></item>
        </channel></rss>
        """;

    [Fact]
    public async Task Torznab_parses_rss_attrs_and_magnet_fallbacks()
    {
        using var fake = new FakeHttp(_ => Xml(TorznabFixture));
        // Bound from the TorrentFlow:Search section exactly as SearchModule does.
        var section = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["TorrentFlow:Search:TORZNAB_URL"] = "http://127.0.0.1:9117/api/v2.0/indexers/all/results/torznab/api",
            ["TorrentFlow:Search:TORZNAB_API_KEY"] = "secret key"
        }).Build().GetSection("TorrentFlow:Search").Get<SearchModuleOptions>()!;
        var adapter = new TorznabAdapter(fake.Http(), Options.Create(section));
        var rows = await adapter.SearchAsync(new() { Query = "Big Buck Bunny", Category = "all", Limit = 10 });
        Assert.Equal(4, rows.Count);

        var bunny = rows[0];
        Assert.Equal("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", bunny.InfoHash);
        Assert.StartsWith("magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&dn=Big%20Buck%20Bunny", bunny.Magnet);
        Assert.Equal("http://127.0.0.1:9117/dl/example/?jackett_apikey=k&path=abc", bunny.TorrentUrl);
        Assert.Equal(40, bunny.Seeders); Assert.Equal(15, bunny.Leechers); Assert.Equal(12, bunny.Completed);
        Assert.Equal(2147483648, bunny.SizeBytes); Assert.Equal("movies", bunny.Category);
        Assert.Equal("https://tracker.example/details/1", bunny.SourceUrl);
        Assert.Equal("2024-01-01T10:00:00.000Z", bunny.PublishedAt);
        Assert.Equal("torznab", bunny.Source); Assert.Contains("ExampleTracker", bunny.Tags);

        var show = rows[1];
        Assert.Equal("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", show.InfoHash);
        Assert.StartsWith("magnet:?xt=urn:btih:BBBB", show.Magnet);
        Assert.Null(show.TorrentUrl); Assert.Equal(0, show.Leechers); Assert.Equal("tv", show.Category);

        var anime = rows[2];
        Assert.Equal("cccccccccccccccccccccccccccccccccccccccc", anime.InfoHash);
        Assert.StartsWith("magnet:?xt=urn:btih:cccc", anime.Magnet);
        Assert.Equal("https://tracker.example/get/3.torrent", anime.TorrentUrl);
        Assert.Equal(4, anime.Leechers); Assert.Equal("anime", anime.Category);

        var only = rows[3];
        Assert.Null(only.Magnet); Assert.Null(only.InfoHash);
        Assert.Equal("https://tracker.example/get/4.torrent", only.TorrentUrl);
        Assert.StartsWith("torznab-", only.Id);

        var request = Uri.UnescapeDataString(Assert.Single(fake.Requests));
        Assert.StartsWith("http://127.0.0.1:9117/api/v2.0/indexers/all/results/torznab/api?t=search&q=Big Buck Bunny&limit=10", request);
        Assert.EndsWith("&apikey=secret key", request);
        Assert.DoesNotContain("cat=", request);
    }

    [Fact]
    public async Task Torznab_uses_typed_search_and_falls_back_when_unsupported()
    {
        using var fake = new FakeHttp(r => Xml(r.RequestUri!.Query.Contains("t=movie")
            ? """<?xml version="1.0"?><error code="201" description="Incorrect parameter"/>""" : TorznabFixture));
        var adapter = new TorznabAdapter(fake.Http(), Config(("TORZNAB_URL", "https://prowlarr.example/1/api?extra=1")));
        var rows = await adapter.SearchAsync(new() { Query = "Bunny", Category = "movies" });
        Assert.NotEmpty(rows);
        Assert.Equal(2, fake.Requests.Count);
        Assert.StartsWith("https://prowlarr.example/1/api?extra=1&t=movie&q=Bunny", fake.Requests[0]);
        Assert.Contains("&t=search&", fake.Requests[1]); Assert.Contains("cat=2000", fake.Requests[1]);
        Assert.DoesNotContain("apikey", fake.Requests[1]);

        using var errors = new FakeHttp(_ => Xml("""<error code="100" description="Invalid API Key"/>"""));
        await Assert.ThrowsAsync<HttpRequestException>(() => new TorznabAdapter(errors.Http(), Config(("TORZNAB_URL", "https://j.example/api"))).SearchAsync(new() { Query = "x" }));
    }

    [Fact]
    public async Task Torznab_is_inert_and_not_default_selected_when_unconfigured()
    {
        using var fake = new FakeHttp(_ => Xml(TorznabFixture));
        var adapter = new TorznabAdapter(fake.Http(), Config());
        Assert.False(adapter.Configured);
        Assert.Empty(await adapter.SearchAsync(new() { Query = "Bunny" }));
        Assert.Empty(fake.Requests);

        using var h = new SearchHarness();
        var torznab = new FakeAdapter("torznab", () => Task.FromResult<IReadOnlyList<TorrentResult>>([]));
        var archive = new FakeAdapter("archive", () => Task.FromResult<IReadOnlyList<TorrentResult>>([]));
        var service = h.Service(torznab, archive);
        Assert.False(service.AvailableSources.Single(s => s.Id == "torznab").EnabledByDefault);
        Assert.False(service.AvailableSources.Single(s => s.Id == "archive").EnabledByDefault);
        await service.SearchAsync(new() { Query = "Bunny", SkipCache = true });
        Assert.Equal(0, torznab.Calls); Assert.Equal(0, archive.Calls);

        var withArchive = new TorrentSearchService([archive], h.Cache, new NoOpSearchResultEnricher(), h,
            Config(("ENABLE_ARCHIVE", "1")), NullLogger<TorrentSearchService>.Instance);
        Assert.True(withArchive.AvailableSources.Single(s => s.Id == "archive").EnabledByDefault);
        await withArchive.SearchAsync(new() { Query = "Bunny", SkipCache = true });
        Assert.Equal(1, archive.Calls);

        var configured = new TorrentSearchService([torznab], h.Cache, new NoOpSearchResultEnricher(), h,
            Config(("TORZNAB_URL", "http://127.0.0.1:9117/api")), NullLogger<TorrentSearchService>.Instance);
        Assert.True(configured.AvailableSources.Single(s => s.Id == "torznab").EnabledByDefault);
        await configured.SearchAsync(new() { Query = "Bunny", SkipCache = true });
        Assert.Equal(1, torznab.Calls);
    }

    /// <summary>Live Internet Archive smoke; opt in with TF_NETWORK_TESTS=1.</summary>
    [Fact]
    public async Task Archive_live_smoke()
    {
        if (Environment.GetEnvironmentVariable("TF_NETWORK_TESTS") != "1") return;
        using var handler = new SocketsHttpHandler { AutomaticDecompression = DecompressionMethods.All };
        var http = new IndexerHttp(new RealClients(handler), NullLogger<IndexerHttp>.Instance);
        var adapter = new ArchiveAdapter(http, Config());
        var report = new StringBuilder();
        foreach (var query in new[] { "Night of the Living Dead", "Sita Sings the Blues", "Popeye", "Charlie Chaplin" })
        {
            var watch = System.Diagnostics.Stopwatch.StartNew();
            var rows = await adapter.SearchAsync(new() { Query = query, Category = "all", Limit = 40 });
            watch.Stop();
            Assert.NotEmpty(rows);
            Assert.All(rows, r => Assert.Matches("^[0-9a-f]{40}$", r.InfoHash!));
            report.AppendLine($"{query}: {rows.Count} results, hashes {rows.Count(r => r.InfoHash?.Length == 40)}/{rows.Count}, {watch.ElapsedMilliseconds} ms; "
                + string.Join(" | ", rows.Take(3).Select(r => r.Title)));
        }
        File.WriteAllText(Path.Combine(AppContext.BaseDirectory, "archive-smoke.txt"), report.ToString());
    }

    private sealed class RealClients(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, false);
    }
}
