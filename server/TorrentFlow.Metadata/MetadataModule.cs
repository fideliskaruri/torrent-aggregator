using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Metadata.Artwork;
using TorrentFlow.Metadata.Browse;
using TorrentFlow.Metadata.Catalog;
using TorrentFlow.Metadata.Recommend;
using TorrentFlow.Metadata.Title;
using TorrentFlow.Metadata.Enrichment;
using TorrentFlow.Metadata.Providers;
using TorrentFlow.Metadata.Search;

namespace TorrentFlow.Metadata;

public static class MetadataModule
{
    /// <summary>Registers the Metadata module's services. Controllers in this assembly are discovered by the API host.</summary>
    public static IServiceCollection AddMetadataModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<MetadataOptions>()
            .Bind(configuration.GetSection(MetadataOptions.SectionName))
            .PostConfigure(o => ApplyLegacyEnvironmentNames(o, configuration))
            .ValidateDataAnnotations()
            .ValidateOnStart();

        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<TorrentFlow.Core.Sources.SourceRegistry>();
        services.AddTransient<Providers.SourceRoutingHandler>();
        services.AddHttpClient("TorrentFlow.SourceHealth", c => c.Timeout = TimeSpan.FromSeconds(15)).RemoveAllLoggers();
        // Per-call timeouts use linked CancellationTokenSources matching the TS AbortSignal.timeout values.
        services.AddHttpClient(TmdbClient.HttpClientName, c => c.Timeout = Timeout.InfiniteTimeSpan).RemoveAllLoggers()
            .AddHttpMessageHandler<Providers.SourceRoutingHandler>();

        services.AddSingleton<Settings.TmdbSettingsStore>();
        services.AddSingleton<ITmdbCredentialProvider>(sp => sp.GetRequiredService<Settings.TmdbSettingsStore>());
        services.AddSingleton<TmdbClient>();
        services.AddSingleton<AniListClient>();
        services.Replace(ServiceDescriptor.Singleton<TorrentFlow.Core.Contracts.Library.ILibraryAnimeLookup, LibraryAnimeLookup>());
        services.AddSingleton<KeylessClients>();
        services.AddSingleton<IKeylessSeriesLookup>(sp => sp.GetRequiredService<KeylessClients>());
        services.AddSingleton<CinemetaClient>();
        services.AddSingleton<RateLimiter>();
        services.AddSingleton<WorkSearchService>();
        services.AddSingleton<SuggestService>();
        services.AddSingleton<ArtworkResolver>();
        services.Replace(ServiceDescriptor.Singleton<TorrentFlow.Core.Contracts.Library.ILibraryArtworkResolver, LibraryArtworkResolver>());
        services.AddSingleton<MetadataResolver>();
        services.AddSingleton<IMetadataResolver>(sp => sp.GetRequiredService<MetadataResolver>());
        services.AddSingleton<CatalogService>();
        services.AddSingleton<ICatalogLookup>(sp => sp.GetRequiredService<CatalogService>());
        services.AddHostedService<CatalogRefreshWorker>();
        services.AddSingleton<RecommendationService>();
        // Default when no module supplies live engine state: presence is Unknown, so file evidence decides readiness.
        services.TryAddSingleton<ITorrentPresenceProbe, UnknownTorrentPresenceProbe>();
        services.AddSingleton<LocalFilePresenceCache>();
        services.AddSingleton<AvailabilityResolver>();
        services.AddSingleton<HomeReleaseCache>();
        services.AddSingleton<BrowseService>();
        services.AddSingleton<TitleExtrasService>();
        services.Replace(ServiceDescriptor.Singleton<TorrentFlow.Core.Contracts.Search.ISearchResultEnricher, SearchResultEnricher>());
        return services;
    }

    /// <summary>Honours the flat env/config names the TS app reads (TMDB_API_KEY, …) when TorrentFlow:Metadata does not set them.</summary>
    internal static void ApplyLegacyEnvironmentNames(MetadataOptions o, IConfiguration configuration)
    {
        var section = configuration.GetSection(MetadataOptions.SectionName);
        string? Flat(string name, string key) => section[key] is { Length: > 0 } ? null : configuration[name];

        if (Flat("TMDB_API_KEY", nameof(MetadataOptions.TmdbApiKey)) is { } key) o.TmdbApiKey = key;
        if (Flat("TMDB_BASE_URL", nameof(MetadataOptions.TmdbBaseUrl)) is { Length: > 0 } b) o.TmdbBaseUrl = b.TrimEnd('/');
        if (Flat("TMDB_IMAGE_BASE_URL", nameof(MetadataOptions.TmdbImageBaseUrl)) is { Length: > 0 } i) o.TmdbImageBaseUrl = i.TrimEnd('/');
        if (Flat("APIBAY_BASE_URL", nameof(MetadataOptions.ApibayBaseUrl)) is { Length: > 0 } a) o.ApibayBaseUrl = a.TrimEnd('/');
        if (Flat("CATALOG_TIMER", nameof(MetadataOptions.CatalogTimer)) is { } t) o.CatalogTimer = t;
        if (Flat("ARTWORK_TIMEOUT_MS", nameof(MetadataOptions.ArtworkTimeoutMs)) is { } ms &&
            double.TryParse(ms, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var v) && v > 0 && v <= 600_000)
            o.ArtworkTimeoutMs = (int)v;
    }
}
