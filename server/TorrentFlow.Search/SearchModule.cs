using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace TorrentFlow.Search;

public static class SearchModule
{
    /// <summary>Registers the Search module's services. Controllers in this assembly are discovered by the API host.</summary>
    public static IServiceCollection AddSearchModule(this IServiceCollection services, IConfiguration configuration)
    {
        return services;
    }
}
