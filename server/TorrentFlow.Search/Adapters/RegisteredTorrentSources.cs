using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Core.Sources;

namespace TorrentFlow.Search.Adapters;

public sealed class RegisteredTorrentSources(IServiceProvider services, SourceRegistry registry)
{
    private static readonly IReadOnlyDictionary<string, Type> Implementations = new Dictionary<string, Type>
    {
        ["nyaa"] = typeof(NyaaAdapter), ["apibay"] = typeof(ApiBayAdapter), ["torrentscsv"] = typeof(TorrentsCsvAdapter),
        ["yts"] = typeof(YtsAdapter), ["eztv"] = typeof(EztvAdapter), ["1337x"] = typeof(X1337Adapter),
        ["archive"] = typeof(ArchiveAdapter), ["torznab"] = typeof(TorznabAdapter),
    };
    public IReadOnlyList<ITorrentSourceAdapter> For(string category) => registry.Active("torrent", category)
        .Select(e => (ITorrentSourceAdapter)new Registered(e, services)).ToArray();

    private sealed class Registered(SourceEntry entry, IServiceProvider services) : ITorrentSourceAdapter
    {
        public string Id => entry.Id;
        public Task<IReadOnlyList<TorrentResult>> SearchAsync(SearchOptions options, CancellationToken cancellationToken = default) =>
            SourceExecution.RunAsync<IReadOnlyList<TorrentResult>>(entry, async ct =>
            {
                Exception? last = null;
                foreach (var endpoint in new[] { entry.BaseUrl }.Concat(entry.Mirrors))
                {
                    try
                    {
                var config = new SearchModuleOptions
                {
                    NyaaBaseUrl = endpoint, ApiBayBaseUrl = endpoint, TorrentsCsvBaseUrl = endpoint,
                    YtsBaseUrl = endpoint, EztvBaseUrl = endpoint, X1337BaseUrl = endpoint,
                    ArchiveBaseUrl = endpoint, TorznabUrl = endpoint, TorznabApiKey = entry.Credential,
                    Use1337Browser = entry.Options.TryGetValue("useBrowser", out var browser) && browser.ValueKind == JsonValueKind.True ? "1" : "0",
                };
                var adapter = (ITorrentSourceAdapter)ActivatorUtilities.CreateInstance(services, Implementations[entry.Type], Options.Create(config));
                var result = await adapter.SearchAsync(options, ct).ConfigureAwait(false);
                return result.Select(r => r with { Source = entry.Id, Id = $"{entry.Id}-{r.Id}" }).ToArray();
                    }
                    catch (Exception e) when (!ct.IsCancellationRequested && e is HttpRequestException or System.Xml.XmlException or JsonException) { last = e; }
                }
                throw new HttpRequestException($"Source {entry.Id} did not return a valid response.", last is null ? null : new Exception("Upstream failure."));
            }, cancellationToken);
    }
}
