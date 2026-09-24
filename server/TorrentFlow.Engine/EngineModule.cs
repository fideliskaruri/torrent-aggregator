using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace TorrentFlow.Engine;

public static class EngineModule
{
    /// <summary>Registers the Engine module's services. Controllers in this assembly are discovered by the API host.</summary>
    public static IServiceCollection AddEngineModule(this IServiceCollection services, IConfiguration configuration)
    {
        return services;
    }
}
