using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Sources;
using TorrentFlow.Domain;
using TorrentFlow.Parser;

namespace TorrentFlow.Find;

public static class SourcesComposition
{
    public static IServiceCollection AddFindSources(this IServiceCollection services)
    {
        services.AddSources();
        services.AddSingleton<IParser>(_ => new ReleaseParser(DateTime.UtcNow.Year + 1));
        services.AddSingleton<SourceFlights>();
        services.AddSingleton<SearchCache>();
        services.AddSingleton<SearchBudget>();
        services.AddSingleton<IFind, FindService>();
        return services;
    }
}
