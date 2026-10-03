using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Find;

namespace TorrentFlow.Targets;

public static class SourcesComposition
{
    public static IServiceCollection AddSourceModules(this IServiceCollection services) => services.AddFindSources();
}
