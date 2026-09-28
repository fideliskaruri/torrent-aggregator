using System.Net;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using TorrentFlow.Search.Adapters;

namespace TorrentFlow.Search.Tests;

/// <summary>Opt-in live Internet Archive smoke (TF_NETWORK_TESTS=1).</summary>
public sealed class SourceAdaptersArchiveTorznabTests
{
    private static IOptions<SearchModuleOptions> Config(params (string Key, string Value)[] values) =>
        Options.Create(new ConfigurationBuilder()
            .AddInMemoryCollection(values.Select(x => new KeyValuePair<string, string?>(x.Key, x.Value)))
            .Build()
            .Get<SearchModuleOptions>() ?? new());

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
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }
}