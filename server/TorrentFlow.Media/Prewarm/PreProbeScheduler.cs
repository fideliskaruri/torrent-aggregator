using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using TorrentFlow.Data;
using TorrentFlow.Media.Hls;
using TorrentFlow.Media.Vod;

namespace TorrentFlow.Media.Prewarm;

public sealed record PreProbeTick(int DelayMs, bool Ran, string? Skipped = null, PreProbeResult? Result = null);

/// <summary>Port of preprobe-scheduler.ts: a self-scheduling, never-overlapping rank-then-probe pass.</summary>
public sealed class PreProbeScheduler(
    PreRanker ranker,
    PreProbeLease lease,
    ForegroundTracker foreground,
    IOptions<MediaOptions> options,
    TimeProvider clock,
    ILogger<PreProbeScheduler> logger) : BackgroundService
{
    public const int IntervalMs = 30 * 60 * 1000;
    public const int ForegroundRetryMs = 60 * 1000;
    public const int DisabledPollMs = 5 * 60 * 1000;
    public const int StartupDelayMs = 45 * 1000;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.PreProbeSchedulerEnabled) return;
        logger.LogInformation("[preprobe-scheduler] pre-probe scheduler armed");
        var delay = StartupDelayMs;
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromMilliseconds(delay), clock, stoppingToken); }
            catch (OperationCanceledException) { return; }
            delay = (await RunTickAsync(stoppingToken)).DelayMs;
        }
    }

    public async Task<PreProbeTick> RunTickAsync(CancellationToken ct)
    {
        string scope;
        try { scope = await ranker.ResolveScopeAsync(ct); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "[preprobe-scheduler] could not read scope");
            return new(DisabledPollMs, false, "settings-error");
        }
        if (scope == "off") return new(DisabledPollMs, false, "off");
        if (foreground.Active()) return new(ForegroundRetryMs, false, "foreground");
        using var held = lease.TryAcquire(LocalUser.Id);
        if (held is null) return new(ForegroundRetryMs, false, "busy");
        try
        {
            await ranker.PreRankUpcomingAsync(null, ct);
            if (foreground.Active()) return new(ForegroundRetryMs, false, "foreground");
            var result = await ranker.PreProbeUpcomingAsync(ct);
            if (result.Skipped == "foreground") return new(ForegroundRetryMs, false, "foreground");
            logger.LogInformation("[preprobe-scheduler] scope {Scope} · probed {Probed} · fresh {Fresh} · live {Live}{Capped}",
                result.Scope, result.Probed.Count, result.SkippedFresh.Count, result.SkippedLive.Count, result.Capped ? " · capped" : "");
            return new(IntervalMs, true, null, result);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "[preprobe-scheduler] pass failed");
            return new(IntervalMs, false);
        }
    }
}

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
