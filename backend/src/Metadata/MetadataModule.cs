using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

public static class MetadataModule
{
    public static IServiceCollection AddMetadata(this IServiceCollection services, string dataDirectory)
    {
        services.AddSingleton(new MetadataPaths(Path.GetFullPath(dataDirectory)));
        services.AddSingleton<CatalogStore>();
        services.AddSingleton<ProviderHttp>();
        services.AddSingleton<FribbMap>();
        services.AddSingleton<TmdbClient>();
        services.AddSingleton<AniListClient>();
        services.AddSingleton<CinemetaClient>();
        services.AddSingleton<IMetadata, MetadataService>();
        return services;
    }
}

internal sealed record MetadataPaths(string DataDirectory);
