using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Search.Adapters;

namespace TorrentFlow.Search;

public static class SearchModule
{
    /// <summary>Registers the Search module's services. Controllers in this assembly are discovered by the API host.</summary>
    public static IServiceCollection AddSearchModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<SearchModuleOptions>().Bind(configuration.GetSection("TorrentFlow:Search"))
            .ValidateDataAnnotations().ValidateOnStart();
        services.AddHttpClient("TorrentFlow.Indexers", client => client.Timeout = TimeSpan.FromSeconds(40)).RemoveAllLoggers()
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
            {
                AutomaticDecompression = System.Net.DecompressionMethods.All,
                MaxConnectionsPerServer = 8,
                PooledConnectionLifetime = TimeSpan.FromMinutes(5)
            });
        services.AddSingleton<IndexerHttp>();
        services.TryAddSingleton<TorrentFlow.Core.Sources.SourceRegistry>();
        services.AddSingleton<RegisteredTorrentSources>();
        services.TryAddSingleton<IIndexerBrowserFetcher, BrowserFetcher>();
        services.AddSingleton<SearchCacheStore>();
        services.TryAddSingleton<ITrackerScraper, TrackerScraper>();
        services.TryAddSingleton<ISearchResultEnricher, NoOpSearchResultEnricher>();
        services.TryAddSingleton<ISwarmProbeEngine, UnavailableSwarmProbeEngine>();
        services.AddSingleton<SwarmHealth>();
        services.AddSingleton<TorrentSearchService>();
        services.AddSingleton<ITorrentSearchService>(sp => sp.GetRequiredService<TorrentSearchService>());
        services.Replace(ServiceDescriptor.Singleton<TorrentFlow.Core.Contracts.Engine.ISmartCategorizer, SmartCategorizer>());
        return services;
    }
}
