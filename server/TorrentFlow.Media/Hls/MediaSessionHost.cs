using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Media.Vod;

namespace TorrentFlow.Media.Hls;

/// <summary>ffmpeg lifecycle: clears stale session dirs on start, reaps idle HLS sessions, and kills every child on shutdown.</summary>
public sealed class MediaSessionHost(HlsSessionManager sessions, VodRuntime vod, TimeProvider clock, ILogger<MediaSessionHost> logger) : BackgroundService
{
    public static readonly TimeSpan ReapInterval = TimeSpan.FromSeconds(15);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            var removed = sessions.CleanupStaleDirs();
            if (removed > 0) logger.LogInformation("[hls] removed {Count} stale session dir(s)", removed);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { logger.LogWarning("[hls] stale cleanup failed: {Message}", ex.Message); }
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await Task.Delay(ReapInterval, clock, stoppingToken); }
            catch (OperationCanceledException) { return; }
            try { sessions.ReapIdle(); }
            catch (Exception ex) when (ex is IOException or InvalidOperationException) { logger.LogWarning("[hls] reap failed: {Message}", ex.Message); }
        }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);
        sessions.StopAll();
        vod.KillAll();
    }
}

public static class MediaSessionsServiceCollectionExtensions
{
    /// <summary>HLS and VOD ffmpeg sessions plus their lifecycle host.</summary>
    public static IServiceCollection AddMediaSessions(this IServiceCollection services)
    {
        services.AddSingleton<HlsSessionManager>();
        services.AddSingleton<VodRuntime>();
        services.AddHostedService<MediaSessionHost>();
        return services;
    }
}
