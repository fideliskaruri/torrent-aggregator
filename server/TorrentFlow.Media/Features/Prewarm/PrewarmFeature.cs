using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Media.Features.Prewarm;

namespace TorrentFlow.Media;

public static class PrewarmFeature
{
    /// <summary>Pre-warm, pre-rank, speculative swarm probing and the background pre-probe scheduler.</summary>
    public static IServiceCollection AddPrewarmFeature(this IServiceCollection services, IConfiguration configuration)
    {
        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton<ForegroundTracker>();
        services.AddSingleton<PrewarmEviction>();
        services.AddSingleton<SwarmMeasurements>();
        services.AddSingleton<PreRanker>();
        services.AddSingleton<PreProber>();
        services.AddSingleton<PreProbeLock>();
        services.AddSingleton<PrewarmService>();
        // Prewarm and swarm probes add torrents in streaming mode; with streaming off, Search and Library keep their
        // no-op defaults and the background pre-probe scheduler never runs.
        if (!string.Equals(configuration["TorrentFlow:Engine:Streaming"], "true", StringComparison.OrdinalIgnoreCase)) return services;
        // Search registers a no-op default; the built-in engine can actually attach to a swarm.
        services.Replace(ServiceDescriptor.Singleton<ISwarmProbeEngine, EngineSwarmProbeEngine>());
        // Library registers a no-op playback observer; progress pings drive prewarm here.
        services.Replace(ServiceDescriptor.Singleton<ILibraryPlaybackObserver, PrewarmPlaybackObserver>());
        services.AddHostedService<PreProbeScheduler>();
        return services;
    }
}
