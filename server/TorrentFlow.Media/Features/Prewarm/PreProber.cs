using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;

namespace TorrentFlow.Media.Features.Prewarm;

/// <summary>
/// B. Speculative pre-probing (src/lib/prewarm/preprobe.ts): measure the swarms of the top candidates for the next
/// things the user will likely watch, before the click. Never while a viewer is watching; bounded; sequential.
/// </summary>
public sealed class PreProber
{
    public const string DefaultScope = "monitored";
    public const int MaxTargets = 2;
    public const int MaxCandidates = 3;
    public const int MaxProbes = 6;

    private readonly IDbContextFactory<TorrentFlowDbContext> _factory;
    private readonly PreRanker _ranker;
    private readonly SwarmMeasurements _swarm;
    private readonly ISwarmProbeEngine _probeEngine;
    private readonly ForegroundTracker _foreground;
    private readonly ILogger _logger;

    public PreProber(IDbContextFactory<TorrentFlowDbContext> factory, PreRanker ranker, SwarmMeasurements swarm,
        ISwarmProbeEngine probeEngine, ForegroundTracker foreground, ILogger<PreProber>? logger = null)
    {
        _factory = factory;
        _ranker = ranker;
        _swarm = swarm;
        _probeEngine = probeEngine;
        _foreground = foreground;
        _logger = (ILogger?)logger ?? NullLogger.Instance;
    }

    /// <summary>Clamp any stored/incoming value to a known scope; unknown → the default.</summary>
    public static string NormalizeScope(string? value) => value is "off" or "watching" or "monitored" ? value : DefaultScope;

    public static IReadOnlyList<string> SourcesForScope(string scope) => scope switch
    {
        "off" => [],
        "watching" => ["watching"],
        _ => ["monitored", "watchlist", "watching"],
    };

    /// <summary>The user's stored scope; null (or an unreadable row) reads as the monitored default.</summary>
    public async Task<string> ResolveScopeAsync(string userId, CancellationToken ct = default)
    {
        try
        {
            await using var db = await _factory.CreateDbContextAsync(ct);
            var stored = await db.ClientSettings.AsNoTracking().Where(s => s.UserId == userId).Select(s => s.PreProbeScope).FirstOrDefaultAsync(ct);
            return NormalizeScope(stored);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            _logger.LogDebug(e, "[preprobe] scope unreadable");
            return DefaultScope;
        }
    }

    public sealed record Options
    {
        public int? LimitTargets { get; init; }
        public int? LimitCandidates { get; init; }
        public int? LimitProbes { get; init; }
        public string? Scope { get; init; }
        public Func<string?, string, double?, string?, CancellationToken, Task<SwarmReading?>>? ProbeFn { get; init; }
        public Func<string, Task<bool>>? FindLive { get; init; }
        public Func<bool>? ForegroundActive { get; init; }
        public Func<PreRankTarget, Task<IReadOnlyList<TorrentResult>>>? PoolFor { get; init; }
        public IReadOnlyList<PreRankTarget>? Targets { get; init; }
    }

    public sealed record Result
    {
        /// <summary>foreground | no-targets | disabled</summary>
        public string? Skipped { get; set; }
        public required string Scope { get; init; }
        public List<string> Probed { get; } = [];
        public List<string> SkippedFresh { get; } = [];
        public List<string> SkippedLive { get; } = [];
        public bool Capped { get; set; }
        public Dictionary<string, string> Verdicts { get; } = new(StringComparer.Ordinal);
    }

    /// <summary>The newest SearchCache pool for a target, keyed by normalised title. Empty on any failure.</summary>
    private async Task<IReadOnlyList<TorrentResult>> PoolForTargetAsync(PreRankTarget target, CancellationToken ct)
    {
        var normalized = ReleaseText.NormalizeTitle(target.Title);
        if (normalized.Length == 0) return [];
        try
        {
            await using var db = await _factory.CreateDbContextAsync(ct);
            var payload = await db.SearchCaches.AsNoTracking().Where(r => r.NormalizedQuery == normalized)
                .OrderByDescending(r => r.ExpiresAt).Select(r => r.Payload).FirstOrDefaultAsync(ct);
            if (payload is null) return [];
            return JsonSerializer.Deserialize<SearchResponse>(payload, PreRanker.CacheJson)?.Results ?? [];
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            _logger.LogDebug(e, "[preprobe] search cache unreadable");
            return [];
        }
    }

    /// <summary>Usable releases (magnet + hash + a seeder, not a season pack) in ranker order, capped.</summary>
    internal static List<TorrentResult> TopCandidates(IReadOnlyList<TorrentResult> results, int limit)
    {
        List<TorrentResult> output = [];
        foreach (var r in results)
        {
            if (string.IsNullOrEmpty(r.Magnet) || r.Seeders <= 0 || ReleaseText.ReleaseInfoHash(r) is null) continue;
            if (r.Episode?.IsSeasonPack == true) continue;
            output.Add(r);
            if (output.Count >= limit) break;
        }
        return output;
    }

    private async Task<bool> DefaultFindLiveAsync(string hash)
    {
        try
        {
            return (await _probeEngine.FindLiveAsync(hash, CancellationToken.None)).State != "absent";
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Probe the top candidates' swarms for the next few targets and store verdicts. Never throws for probe failure.</summary>
    public async Task<Result> PreProbeUpcomingAsync(string userId, Options? options = null, CancellationToken ct = default)
    {
        options ??= new Options();
        var isForeground = options.ForegroundActive ?? (() => _foreground.IsActive());
        var probe = options.ProbeFn ?? ((magnet, hash, size, name, token) => _swarm.ProbeAndRecordAsync(magnet, hash, size, name, token));
        var findLive = options.FindLive ?? DefaultFindLiveAsync;
        var poolFor = options.PoolFor ?? (t => PoolForTargetAsync(t, ct));

        var scope = options.Scope ?? await ResolveScopeAsync(userId, ct);
        var result = new Result { Scope = scope };

        if (scope == "off") { result.Skipped = "disabled"; return result; }
        if (isForeground()) { result.Skipped = "foreground"; return result; }

        var maxTargets = Math.Max(1, options.LimitTargets ?? MaxTargets);
        var maxCandidates = Math.Max(1, options.LimitCandidates ?? MaxCandidates);
        var maxProbes = Math.Max(1, options.LimitProbes ?? MaxProbes);

        var targets = options.Targets ?? await _ranker.UpcomingTargetsAsync(userId, maxTargets, SourcesForScope(scope), ct);
        if (isForeground()) { result.Skipped = "foreground"; return result; }
        if (targets.Count == 0) { result.Skipped = "no-targets"; return result; }

        HashSet<string> done = new(StringComparer.Ordinal);
        foreach (var target in targets.Take(maxTargets))
        {
            if (isForeground()) { result.Skipped = "foreground"; return result; }
            var pool = await poolFor(target);
            if (isForeground()) { result.Skipped = "foreground"; return result; }

            foreach (var candidate in TopCandidates(pool, maxCandidates))
            {
                var hash = ReleaseText.ReleaseInfoHash(candidate);
                if (hash is null || !done.Add(hash)) continue;

                // Never probe (or risk destroying) a real download.
                if (await findLive(hash)) { result.SkippedLive.Add(hash); continue; }

                // Anything measured within TTL — even "unknown" — is not re-measured.
                var existing = await _swarm.GetAsync(hash, ct);
                if (isForeground()) { result.Skipped = "foreground"; return result; }
                if (existing is { Expired: false })
                {
                    result.SkippedFresh.Add(hash);
                    result.Verdicts[hash] = existing.Verdict;
                    continue;
                }

                if (result.Probed.Count >= maxProbes) { result.Capped = true; return result; }
                if (isForeground()) { result.Skipped = "foreground"; return result; }

                SwarmReading? measurement;
                bool aborted;
                using (var cancellation = _foreground.CancellationSignal())
                using (var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation.Token, ct))
                {
                    measurement = await probe(candidate.Magnet, hash, candidate.SizeBytes, candidate.Title, linked.Token);
                    aborted = cancellation.IsCancellationRequested;
                }
                if (aborted || isForeground()) { result.Skipped = "foreground"; return result; }
                result.Probed.Add(hash);
                if (measurement is not null) result.Verdicts[hash] = measurement.Verdict;
            }
        }
        return result;
    }
}
