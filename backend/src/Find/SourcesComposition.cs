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
        services.AddSingleton(new SourceSearches<SourceResult>(result =>
            result.Outcome is not (SourceOutcome.Failed or SourceOutcome.TimedOut)));
        services.AddSingleton<ReleaseFacts>();
        services.AddSingleton<IFind, FindService>();
        return services;
    }
}
