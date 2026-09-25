using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TorrentFlow.Core.Contracts.Media;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Media.Common;
using TorrentFlow.Media.Ffmpeg;
using TorrentFlow.Media.Hls;
using TorrentFlow.Media.Playback;
using TorrentFlow.Media.Prewarm;
using TorrentFlow.Media.Probing;
using TorrentFlow.Media.Streaming;
using TorrentFlow.Media.Subtitles;
using TorrentFlow.Media.Swarm;
using TorrentFlow.Media.Vod;
using TorrentFlow.Media.Tools;

namespace TorrentFlow.Media;

public static class MediaModule
{
    /// <summary>Registers the Media module's services. Controllers in this assembly are discovered by the API host.</summary>
    public static IServiceCollection AddMediaModule(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<MediaOptions>().Bind(configuration.GetSection(MediaOptions.SectionName));
        services.TryAddSingleton(TimeProvider.System);
        services.TryAddSingleton<IProcessRunner, SystemProcessRunner>();

        services.AddFfmpegLocator();
        services.AddSingleton<MediaPaths>();
        services.AddSingleton<MediaSettings>();
        services.AddSingleton<CompletedMedia>();
        services.AddSingleton<ForegroundTracker>();
        services.AddSingleton<MediaProber>();
        services.AddSingleton<StreamService>();
        services.AddSingleton<HlsSessionManager>();
        services.AddSingleton<VodRuntime>();
        services.AddSingleton<SubtitleExtractor>();
        services.AddSingleton<SwarmMeasurements>();
        services.AddSingleton<SwarmWatch>();
        services.AddSingleton<PrewarmCoordinator>();
        services.AddSingleton<PreRanker>();
        services.AddSingleton<PreProbeLease>();
        services.TryAddSingleton<IUpcomingPlaybackTargets, ContinueWatchingTargets>();
        services.Replace(ServiceDescriptor.Singleton<ISwarmProbeEngine, SwarmProbeEngine>());

        services.AddHostedService<MediaSessionHost>();
        services.AddHostedService<PreProbeScheduler>();
        return services;
    }
}
