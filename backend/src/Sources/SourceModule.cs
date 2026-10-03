using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;

namespace TorrentFlow.Sources;

public static class SourceModule
{
    public static IServiceCollection AddSources(this IServiceCollection services)
    {
        services.AddSingleton<SourceTransport>();
        services.AddSingleton<ISources, SourcesService>();
        return services;
    }
}
