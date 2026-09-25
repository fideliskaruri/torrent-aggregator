using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Media.Common;
using TorrentFlow.Media.Hls;

namespace TorrentFlow.Media;

public static class MediaModule
{
    /// <summary>Registers the Media module's services. Controllers in this assembly are discovered by the API host.</summary>
    public static IServiceCollection AddMediaModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddMediaCore(configuration);
        services.AddMediaProbing();
        services.AddMediaStreaming();
        services.AddMediaPlayback();
        services.AddMediaSessions();
        services.AddSubtitlesFeature();
        services.AddPrewarmFeature(configuration);
        return services;
    }
}
