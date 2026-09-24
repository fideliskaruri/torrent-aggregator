using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace TorrentFlow.Metadata;

public static class MetadataModule
{
    /// <summary>Registers the Metadata module's services. Controllers in this assembly are discovered by the API host.</summary>
    public static IServiceCollection AddMetadataModule(this IServiceCollection services, IConfiguration configuration)
    {
        return services;
    }
}
