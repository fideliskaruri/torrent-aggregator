using TorrentFlow.Targets;

namespace TorrentFlow.Api;

internal static class SourcesModule
{
    internal static IServiceCollection AddSources(this IServiceCollection services) => services.AddSourceModules();
}
