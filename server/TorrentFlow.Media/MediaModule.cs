using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace TorrentFlow.Media;

public static class MediaModule
{
    /// <summary>Registers the Media module's services. Controllers in this assembly are discovered by the API host.</summary>
    public static IServiceCollection AddMediaModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddSubtitlesFeature();
        services.AddPrewarmFeature(configuration);
        return services;
    }
}
