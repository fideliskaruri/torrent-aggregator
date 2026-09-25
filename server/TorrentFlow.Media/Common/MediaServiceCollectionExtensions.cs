using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TorrentFlow.Media.Ffmpeg;
using TorrentFlow.Media.Playback;
using TorrentFlow.Media.Probing;
using TorrentFlow.Media.Streaming;
using TorrentFlow.Media.Tools;

namespace TorrentFlow.Media.Common;

public static class MediaServiceCollectionExtensions
{
    /// <summary>
    /// Services shared by several media features (options, clock, process runner, ffmpeg locator, paths,
    /// settings). ForegroundTracker and SwarmMeasurements come from the prewarm feature. All TryAdd, so any feature may call it.
    /// </summary>
    public static IServiceCollection AddMediaCore(this IServiceCollection services, IConfiguration configuration)
    {
        if (services.Any(d => d.ServiceType == typeof(MediaPaths))) return services;
        services.AddOptions<MediaOptions>()
            .Bind(configuration.GetSection(MediaOptions.SectionName))
            .ValidateDataAnnotations()
            .ValidateOnStart();
        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<IProcessRunner, SystemProcessRunner>();
        services.AddFfmpegLocator();
        services.TryAddSingleton<MediaPaths>();
        services.TryAddSingleton<MediaSettings>();
        services.TryAddSingleton<CompletedMedia>();
        return services;
    }

    /// <summary>ffprobe media probes and the probe cache used by playback planning.</summary>
    public static IServiceCollection AddMediaProbing(this IServiceCollection services)
    {
        services.TryAddSingleton<MediaProber>();
        return services;
    }

    /// <summary>/api/stream range serving and file selection.</summary>
    public static IServiceCollection AddMediaStreaming(this IServiceCollection services)
    {
        services.TryAddSingleton<StreamService>();
        return services;
    }

    /// <summary>/api/playback plan, candidates, failover, status and switch.</summary>
    public static IServiceCollection AddMediaPlayback(this IServiceCollection services)
    {
        services.TryAddSingleton<SwarmWatch>();
        return services;
    }
}
