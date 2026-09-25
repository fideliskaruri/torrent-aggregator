using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Media.Features.Prewarm;
using static TorrentFlow.Media.Tests.PrewarmHarness;

namespace TorrentFlow.Media.Tests;

/// <summary>Ports src/lib/prewarm/preprobe.test.ts, preprobe-scheduler.test.ts and preprobe-lock.test.ts.</summary>
public class PrewarmPreProbeTests
{
    private static readonly PreRankTarget Target = new() { Title = "Probe Show", MediaType = "tv", Season = 1, Episode = 2 };

    private static SwarmReading Reading(string hash, string verdict) =>
        new(hash, null, 5, 2, 1000, 100, 1000, 500, verdict, DateTime.UtcNow, false);

    [Fact]
    public async Task AForegroundStreamStopsThePassDead()
    {
        await using var h = await CreateAsync();
        var probes = 0;
        var result = await h.Prober.PreProbeUpcomingAsync(LocalUser.Id, new PreProber.Options
        {
            Scope = "monitored",
            ForegroundActive = () => true,
            Targets = [Target],
            ProbeFn = (_, _, _, _, _) => { probes++; return Task.FromResult<SwarmReading?>(null); },
        });
        Assert.Equal("foreground", result.Skipped);
        Assert.Equal(0, probes);
    }

    [Fact]
    public async Task ForegroundPlaybackAbortsAnActiveSpeculativeProbe()
    {
        await using var h = await CreateAsync();
        var candidate = Result("Probe Show S01E02 1080p", 1);
        var result = await h.Prober.PreProbeUpcomingAsync(LocalUser.Id, new PreProber.Options
        {
            Scope = "monitored",
            Targets = [Target],
            PoolFor = _ => Task.FromResult<IReadOnlyList<TorrentResult>>([candidate]),
            ForegroundActive = () => false,
            FindLive = _ => Task.FromResult(false),
            ProbeFn = async (_, hash, _, _, ct) =>
            {
                h.Foreground.MarkActive(Hash(99));
                Assert.True(ct.IsCancellationRequested);
                await Task.Yield();
                return Reading(hash, "unknown");
            },
        });
        Assert.Equal("foreground", result.Skipped);
        Assert.Empty(result.Probed);
    }

    [Fact]
    public async Task TopCandidatesGetProbedLiveOnesSkippedAndCapped()
    {
        await using var h = await CreateAsync();
        var live = Result("Live download", 1);
        var a = Result("A S01E02", 2);
        var b = Result("B S01E02", 3);
        var pack = Result("C S01 COMPLETE", 4) with { Episode = new EpisodeInfo { Season = 1, IsSeasonPack = true } };
        var dead = Result("D S01E02", 5, seeders: 0);
        List<string> probed = [];
        var result = await h.Prober.PreProbeUpcomingAsync(LocalUser.Id, new PreProber.Options
        {
            Scope = "monitored",
            Targets = [Target],
            LimitCandidates = 5,
            LimitProbes = 1,
            PoolFor = _ => Task.FromResult<IReadOnlyList<TorrentResult>>([live, dead, pack, a, b]),
            ForegroundActive = () => false,
            FindLive = hash => Task.FromResult(hash == Hash(1)),
            ProbeFn = (_, hash, _, _, _) => { probed.Add(hash); return Task.FromResult<SwarmReading?>(Reading(hash, "good")); },
        });
        Assert.Equal([Hash(1)], result.SkippedLive);
        Assert.Equal([Hash(2)], result.Probed);
        Assert.Equal([Hash(2)], probed);
        Assert.True(result.Capped);
        Assert.Equal("good", result.Verdicts[Hash(2)]);
    }

    [Fact]
    public async Task FreshMeasurementsEvenUnknownAreSkipped()
    {
        await using var h = await CreateAsync();
        await using (var db = await h.Db.CreateDbContextAsync())
        {
            db.SwarmMeasurements.Add(new SwarmMeasurement
            {
                Id = Ids.New(), InfoHash = Hash(1), Verdict = "unknown", MeasuredAt = DateTime.UtcNow, ExpiresAt = DateTime.UtcNow.AddHours(1),
            });
            await db.SaveChangesAsync();
        }
        var probes = 0;
        var result = await h.Prober.PreProbeUpcomingAsync(LocalUser.Id, new PreProber.Options
        {
            Scope = "watching",
            Targets = [Target],
            PoolFor = _ => Task.FromResult<IReadOnlyList<TorrentResult>>([Result("Fresh S01E02", 1)]),
            ForegroundActive = () => false,
            FindLive = _ => Task.FromResult(false),
            ProbeFn = (_, _, _, _, _) => { probes++; return Task.FromResult<SwarmReading?>(null); },
        });
        Assert.Equal([Hash(1)], result.SkippedFresh);
        Assert.Equal("unknown", result.Verdicts[Hash(1)]);
        Assert.Equal(0, probes);
    }

    [Fact]
    public async Task ScopeIsReadFromClientSettingsAndDefaultsToMonitored()
    {
        Assert.Equal("monitored", PreProber.NormalizeScope(null));
        Assert.Equal("monitored", PreProber.NormalizeScope("everything"));
        Assert.Equal("watching", PreProber.NormalizeScope("watching"));
        Assert.Empty(PreProber.SourcesForScope("off"));
        Assert.Equal(["watching"], PreProber.SourcesForScope("watching"));
        Assert.Equal(["monitored", "watchlist", "watching"], PreProber.SourcesForScope("monitored"));

        await using var h = await CreateAsync();
        Assert.Equal("monitored", await h.Prober.ResolveScopeAsync(LocalUser.Id));
        await using (var db = await h.Db.CreateDbContextAsync())
        {
            db.ClientSettings.Add(new ClientSetting
            {
                Id = Ids.New(), UserId = LocalUser.Id, ClientType = "builtin", Host = "h", DefaultRetentionPolicy = "EPHEMERAL", PreProbeScope = "off",
                CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow,
            });
            await db.SaveChangesAsync();
        }
        Assert.Equal("off", await h.Prober.ResolveScopeAsync(LocalUser.Id));
        var probes = 0;
        var off = await h.Prober.PreProbeUpcomingAsync(LocalUser.Id, new PreProber.Options
        {
            ProbeFn = (_, _, _, _, _) => { probes++; return Task.FromResult<SwarmReading?>(null); },
        });
        Assert.Equal(("disabled", "off", 0), (off.Skipped, off.Scope, probes));
    }

    [Fact]
    public async Task NoTargetsIsReported()
    {
        await using var h = await CreateAsync();
        var result = await h.Prober.PreProbeUpcomingAsync(LocalUser.Id, new PreProber.Options { Scope = "monitored", ForegroundActive = () => false });
        Assert.Equal("no-targets", result.Skipped);
    }

    // ── scheduler ─────────────────────────────────────────────────────────

    private sealed class ListLogger : ILogger<PreProbeScheduler>
    {
        public readonly List<string> Lines = [];
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) =>
            Lines.Add(formatter(state, exception));
    }

    private static (PreProbeScheduler Scheduler, ListLogger Log) Scheduler(PrewarmHarness h, PreProbeLock? gate = null)
    {
        var log = new ListLogger();
        return (new PreProbeScheduler(h.Ranker, h.Prober, gate ?? new PreProbeLock(), h.Foreground, log), log);
    }

    private static PreProber.Result Pass(string scope = "monitored", string? skipped = null)
    {
        var r = new PreProber.Result { Scope = scope, Skipped = skipped };
        r.Probed.Add("a");
        r.SkippedFresh.Add("b");
        r.SkippedFresh.Add("c");
        return r;
    }

    [Fact]
    public async Task ScopeOffDoesNothingAndPollsAgainLater()
    {
        await using var h = await CreateAsync();
        var (s, _) = Scheduler(h);
        int ranks = 0, probes = 0;
        var o = await s.RunTickAsync(new() { ResolveScope = _ => Task.FromResult("off"), PreRank = _ => { ranks++; return Task.CompletedTask; }, PreProbe = _ => { probes++; return Task.FromResult(Pass()); } });
        Assert.Equal((PreProbeScheduler.DisabledPoll, false, "off", 0, 0), (o.Delay, o.Ran, o.Skipped, ranks, probes));
    }

    [Fact]
    public async Task AForegroundStreamSkipsTheWholePass()
    {
        await using var h = await CreateAsync();
        var (s, _) = Scheduler(h);
        var ranks = 0;
        var o = await s.RunTickAsync(new() { ResolveScope = _ => Task.FromResult("monitored"), IsForeground = () => true, PreRank = _ => { ranks++; return Task.CompletedTask; } });
        Assert.Equal((PreProbeScheduler.ForegroundRetry, false, "foreground", 0), (o.Delay, o.Ran, o.Skipped, ranks));
    }

    [Fact]
    public async Task AnIdleInScopeTickRanksThenProbesAndLogsTheSummary()
    {
        await using var h = await CreateAsync();
        var (s, log) = Scheduler(h);
        List<string> order = [];
        var o = await s.RunTickAsync(new()
        {
            ResolveScope = _ => Task.FromResult("monitored"),
            IsForeground = () => false,
            PreRank = _ => { order.Add("rank"); return Task.CompletedTask; },
            PreProbe = _ => { order.Add("probe"); return Task.FromResult(Pass()); },
        });
        Assert.Equal(["rank", "probe"], order);
        Assert.Equal((PreProbeScheduler.Interval, true), (o.Delay, o.Ran));
        Assert.Contains("[preprobe-scheduler] scope monitored · probed 1 · fresh 2 · live 0", log.Lines);
    }

    [Fact]
    public async Task PlaybackStartingDuringRankingCancelsBeforeProbingAndInsideProbingRetriesSoon()
    {
        await using var h = await CreateAsync();
        var (s, _) = Scheduler(h);
        var foreground = false;
        var probes = 0;
        var o = await s.RunTickAsync(new()
        {
            ResolveScope = _ => Task.FromResult("monitored"),
            IsForeground = () => foreground,
            PreRank = _ => { foreground = true; return Task.CompletedTask; },
            PreProbe = _ => { probes++; return Task.FromResult(Pass()); },
        });
        Assert.Equal((PreProbeScheduler.ForegroundRetry, "foreground", 0), (o.Delay, o.Skipped, probes));

        var inside = await s.RunTickAsync(new()
        {
            ResolveScope = _ => Task.FromResult("monitored"),
            IsForeground = () => false,
            PreRank = _ => Task.CompletedTask,
            PreProbe = _ => Task.FromResult(Pass(skipped: "foreground")),
        });
        Assert.Equal((PreProbeScheduler.ForegroundRetry, false, "foreground"), (inside.Delay, inside.Ran, inside.Skipped));
    }

    [Fact]
    public async Task AThrowingPassReschedulesAndASettingsErrorBacksOff()
    {
        await using var h = await CreateAsync();
        var (s, log) = Scheduler(h);
        var failed = await s.RunTickAsync(new()
        {
            ResolveScope = _ => Task.FromResult("monitored"),
            IsForeground = () => false,
            PreRank = _ => throw new InvalidOperationException("indexers down"),
        });
        Assert.Equal((PreProbeScheduler.Interval, false), (failed.Delay, failed.Ran));
        Assert.Contains("[preprobe-scheduler] pass failed", log.Lines);

        var settings = await s.RunTickAsync(new() { ResolveScope = _ => throw new InvalidOperationException("db") });
        Assert.Equal((PreProbeScheduler.DisabledPoll, "settings-error"), (settings.Delay, settings.Skipped));
    }

    [Fact]
    public async Task ABusyLeaseSkipsTheTick()
    {
        await using var h = await CreateAsync();
        var gate = new PreProbeLock();
        var (s, _) = Scheduler(h, gate);
        var release = gate.TryAcquire(LocalUser.Id);
        Assert.NotNull(release);
        var o = await s.RunTickAsync(new() { ResolveScope = _ => Task.FromResult("monitored"), IsForeground = () => false, PreRank = _ => Task.CompletedTask });
        Assert.Equal((PreProbeScheduler.ForegroundRetry, "busy"), (o.Delay, o.Skipped));
        release();
    }

    [Fact]
    public async Task TheSchedulerAnnouncesItselfWhenArmed()
    {
        await using var h = await CreateAsync();
        var (s, log) = Scheduler(h);
        using var cts = new CancellationTokenSource();
        await s.StartAsync(cts.Token);
        // ExecuteAsync runs on the thread pool, so wait for it to log before stopping.
        for (var i = 0; i < 200 && !log.Lines.Contains("[preprobe-scheduler] pre-probe scheduler armed"); i++)
            await Task.Delay(10);
        await s.StopAsync(CancellationToken.None);
        Assert.Contains("[preprobe-scheduler] pre-probe scheduler armed", log.Lines);
    }

    // ── lock ──────────────────────────────────────────────────────────────

    [Fact]
    public async Task TheLeaseIsPerUserExclusiveAndIdempotentlyReleased()
    {
        var gate = new PreProbeLock();
        var first = gate.TryAcquire("u1");
        Assert.NotNull(first);
        Assert.Null(gate.TryAcquire("u1"));
        var other = gate.TryAcquire("u2");
        Assert.NotNull(other);
        first();
        first();
        var again = gate.TryAcquire("u1");
        Assert.NotNull(again);
        Assert.False((await gate.TryRunPassAsync("u1", () => Task.FromResult(1))).Started);
        again();
        var pass = await gate.TryRunPassAsync("u1", () => Task.FromResult(42));
        Assert.Equal((true, 42), (pass.Started, pass.Value));
        await Assert.ThrowsAsync<InvalidOperationException>(() => gate.TryRunPassAsync<int>("u1", () => throw new InvalidOperationException()));
        Assert.NotNull(gate.TryAcquire("u1"));
    }
}
