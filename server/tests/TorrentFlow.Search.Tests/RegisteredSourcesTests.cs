using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Core.Sources;
using TorrentFlow.Search.Adapters;
using System.Text.Json.Nodes;

namespace TorrentFlow.Search.Tests;

public sealed class RegisteredSourcesTests : IDisposable
{
    private readonly string root = Path.Combine(Directory.GetCurrentDirectory(), "test-artifacts", Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task Custom_torznab_instances_keep_configuration_isolated_and_apply_without_restart()
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["TorrentFlow:DataDirectory"] = root }).Build();
        var registry = new SourceRegistry(config);
        using var fake = new FakeHttp(_ => new(System.Net.HttpStatusCode.OK)
        { Content = new StringContent("""<rss><channel><item><title>Public Domain Film</title><link>magnet:?xt=urn:btih:0123456789012345678901234567890123456789</link></item></channel></rss>""") });
        var services = new ServiceCollection().AddSingleton(registry).AddSingleton(fake.Http()).BuildServiceProvider();
        var factory = new RegisteredTorrentSources(services, registry);
        foreach (var id in new[] { "first-indexer", "second-indexer" })
            registry.Update(id, JsonNode.Parse($$"""{"kind":"torrent","type":"torznab","baseUrl":"https://{{id}}.test/api","categories":["movie"],"credential":"{{id}}-credential"}""")!.AsObject());
        var selected = factory.For("movies").Where(e => e.Id.EndsWith("-indexer")).ToArray();
        Assert.Equal(2, selected.Length);
        foreach (var adapter in selected)
        {
            var rows = await adapter.SearchAsync(new() { Query = "Public Domain Film", Category = "movies" });
            Assert.Equal(adapter.Id, Assert.Single(rows).Source);
            Assert.Contains(fake.Requests, r => r.Contains(adapter.Id + ".test") && r.Contains(adapter.Id + "-credential"));
        }
        registry.Update("first-indexer", new JsonObject { ["enabled"] = false });
        Assert.DoesNotContain(factory.For("movies"), s => s.Id == "first-indexer");
        Assert.DoesNotContain(factory.For("tv"), s => s.Id == "second-indexer");
        services.Dispose();
    }

    [Fact]
    public async Task Eztv_uses_keyless_external_lookup_without_a_tmdb_credential()
    {
        using var fake = new FakeHttp(_ => FakeHttp.Json("""{"torrents":[]}"""));
        var adapter = new EztvAdapter(fake.Http(), Microsoft.Extensions.Options.Options.Create(new SearchModuleOptions()), seriesLookup: new Lookup());
        await adapter.SearchAsync(new() { Query = "Rick and Morty S01E01", Category = "tv" });
        Assert.Contains(fake.Requests, url => url.Contains("imdb_id=2861424"));
        Assert.DoesNotContain(fake.Requests, url => url.Contains("themoviedb"));
    }

    private sealed class Lookup : TorrentFlow.Core.Contracts.Metadata.IKeylessSeriesLookup
    {
        public Task<string?> FindImdbIdAsync(string title, CancellationToken cancellationToken = default) => Task.FromResult<string?>("tt2861424");
    }
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }
}
