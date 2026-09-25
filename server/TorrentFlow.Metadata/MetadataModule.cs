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
        // Per-call timeouts use linked CancellationTokenSources matching the TS AbortSignal.timeout values.
        services.AddHttpClient(TmdbClient.HttpClientName, c => c.Timeout = Timeout.InfiniteTimeSpan);

        services.AddSingleton<TmdbClient>();
        services.AddSingleton<AniListClient>();
        services.AddSingleton<KeylessClients>();
        services.AddSingleton<RateLimiter>();
        services.AddSingleton<WorkSearchService>();
        services.AddSingleton<SuggestService>();
        services.AddSingleton<ArtworkResolver>();
        services.AddSingleton<MetadataResolver>();
        services.AddSingleton<IMetadataResolver>(sp => sp.GetRequiredService<MetadataResolver>());
        services.AddSingleton<CatalogService>();
        services.AddSingleton<ICatalogLookup>(sp => sp.GetRequiredService<CatalogService>());
        services.AddHostedService<CatalogRefreshWorker>();
        services.AddSingleton<RecommendationService>();
        services.AddSingleton<BrowseService>();
        services.AddSingleton<TitleExtrasService>();
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

