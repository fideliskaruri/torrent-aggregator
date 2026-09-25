using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
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
        // Search registers a no-op default; the built-in engine can actually attach to a swarm.
        services.Replace(ServiceDescriptor.Singleton<ISwarmProbeEngine, EngineSwarmProbeEngine>());
        services.AddHostedService<PreProbeScheduler>();
        return services;
    }
}
