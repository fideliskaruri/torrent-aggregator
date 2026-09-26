using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Search.Adapters;

namespace TorrentFlow.Search.Tests;

public sealed class TmdbCredentialTests
{
    private sealed class Credentials : ITmdbCredentialProvider
    {
        public string? ApiKey { get; set; }
        public long Revision { get; set; }
    }

    [Fact]
    public async Task Eztv_reads_shared_provider_and_bypasses_old_negative_cache()
    {
        var credentials = new Credentials();
        using var fake = new FakeHttp(request => FakeHttp.Json(request.RequestUri!.AbsolutePath.Contains("external_ids")
            ? """{"imdb_id":"tt12345"}""" : request.RequestUri.AbsolutePath.Contains("search/tv")
                ? credentials.Revision == 1 ? """{"results":[]}""" : """{"results":[{"id":1,"name":"Show"}]}"""
                : """{"torrents":[]}"""));
        var adapter = new EztvAdapter(fake.Http(), Options.Create(new SearchModuleOptions()), credentials);
        await adapter.SearchAsync(new() { Query = "Show S01E01", Category = "tv" });
        Assert.Empty(fake.Requests);
        credentials.ApiKey = "1234567890abcdef1234567890abcdef";
        credentials.Revision = 1;
        await adapter.SearchAsync(new() { Query = "Show S01E01", Category = "tv" });
        Assert.Single(fake.Requests);
        credentials.Revision = 2;
        await adapter.SearchAsync(new() { Query = "Show S01E01", Category = "tv" });
        Assert.Contains(fake.Requests, r => r.Contains("imdb_id=12345"));
        credentials.ApiKey = null;
        var count = fake.Requests.Count;
        await adapter.SearchAsync(new() { Query = "Show S01E01", Category = "tv" });
        Assert.Equal(count, fake.Requests.Count);
    }
}
