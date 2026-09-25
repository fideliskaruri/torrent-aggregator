using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Data;

namespace TorrentFlow.Media.Features.Prewarm;

/// <summary>
/// The background pre-probe scheduler (src/lib/prewarm/preprobe-scheduler.ts): rank then probe on a
/// self-scheduling timer, so runs never overlap and a failing pass reschedules instead of stopping.
/// </summary>
public sealed class PreProbeScheduler(PreRanker ranker, PreProber prober, PreProbeLock gate, ForegroundTracker foreground,
    ILogger<PreProbeScheduler> logger, TimeProvider? time = null) : BackgroundService
{
    public static readonly TimeSpan Interval = TimeSpan.FromMinutes(30);
    public static readonly TimeSpan ForegroundRetry = TimeSpan.FromSeconds(60);
    public static readonly TimeSpan DisabledPoll = TimeSpan.FromMinutes(5);
    public static readonly TimeSpan StartupDelay = TimeSpan.FromSeconds(45);

    private readonly TimeProvider _time = time ?? TimeProvider.System;

    public sealed record TickDeps
    {
        public string? UserId { get; init; }
        public Func<string, Task<string>>? ResolveScope { get; init; }
        public Func<bool>? IsForeground { get; init; }
        public Func<string, Task>? PreRank { get; init; }
        public Func<string, Task<PreProber.Result>>? PreProbe { get; init; }
    }

    /// <summary>off | foreground | settings-error | busy</summary>
    public sealed record TickOutcome(TimeSpan Delay, bool Ran, string? Skipped = null, PreProber.Result? Result = null);

    /// <summary>One tick: decide whether to run, run rank+probe if so, and report the delay before the next.</summary>
    public async Task<TickOutcome> RunTickAsync(TickDeps? deps = null, CancellationToken ct = default)
    {
        deps ??= new TickDeps();
        var userId = deps.UserId ?? LocalUser.Id;
        var resolveScope = deps.ResolveScope ?? (u => prober.ResolveScopeAsync(u, ct));
        var isForeground = deps.IsForeground ?? (() => foreground.IsActive());
        var preRank = deps.PreRank ?? (u => ranker.PreRankUpcomingAsync(u, ct: ct));
        var preProbe = deps.PreProbe ?? (u => prober.PreProbeUpcomingAsync(u, ct: ct));

        string scope;
        try
        {
            scope = await resolveScope(userId);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            logger.LogError(e, "[preprobe-scheduler] could not read scope");
            return new TickOutcome(DisabledPoll, false, "settings-error");
        }

        if (scope == "off") return new TickOutcome(DisabledPoll, false, "off");
        if (isForeground()) return new TickOutcome(ForegroundRetry, false, "foreground");

        try
        {
            var pass = await gate.TryRunPassAsync<PreProber.Result?>(userId, async () =>
            {
                await preRank(userId);
                // Ranking may contact several indexers; yield before opening a swarm if playback began meanwhile.
                if (isForeground()) return null;
                return await preProbe(userId);
            });
            if (!pass.Started) return new TickOutcome(ForegroundRetry, false, "busy");
            var result = pass.Value;
            if (result is null || result.Skipped == "foreground") return new TickOutcome(ForegroundRetry, false, "foreground");
            logger.LogInformation("[preprobe-scheduler] scope {Scope} · probed {Probed} · fresh {Fresh} · live {Live}{Capped}",
                result.Scope, result.Probed.Count, result.SkippedFresh.Count, result.SkippedLive.Count, result.Capped ? " · capped" : "");
            return new TickOutcome(Interval, true, null, result);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            logger.LogError(e, "[preprobe-scheduler] pass failed");
            return new TickOutcome(Interval, false);
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("[preprobe-scheduler] pre-probe scheduler armed");
        var delay = StartupDelay;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(delay, _time, stoppingToken);
                delay = (await RunTickAsync(ct: stoppingToken)).Delay;
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }
}
