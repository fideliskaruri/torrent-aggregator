using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace TorrentFlow.Library;

public static class LibraryModule
{
    /// <summary>Registers the Library module's services. Controllers in this assembly are discovered by the API host.</summary>
    public static IServiceCollection AddLibraryModule(this IServiceCollection services, IConfiguration configuration)
    {
        return services;
    }
}
