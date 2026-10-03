using TorrentFlow.Targets;

namespace TorrentFlow.Api;

internal static class DevSources
{
    internal static IServiceCollection AddDevSources(this IServiceCollection services) => services.AddSourceModules();
}
