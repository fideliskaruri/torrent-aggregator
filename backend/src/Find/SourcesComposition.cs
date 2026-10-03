using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Sources;

namespace TorrentFlow.Find;

public static class SourcesComposition
{
    public static IServiceCollection AddFindSources(this IServiceCollection services) => services.AddSources();
}
